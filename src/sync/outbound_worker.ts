import * as fs from "node:fs/promises";
import { eventList, eventPublish, getOutboundCursorPath } from "../events.js";
import { recordOutboundProcessed, reserveOutboundDedupe } from "./mapping_store.js";
import { OpenAIClient } from "./openai_client.js";
import { applyAssistantResponse, buildAgendaJsonInstruction, buildJsonOnlyInstruction, buildPatchJsonInstruction } from "./llm_actions.js";
import {
  CursorState,
  CursorStateSchema,
  EventEnvelope,
  EventEnvelopeSchema,
  normalizeConversationId,
  payloadToInputText,
} from "./types.js";

type OutboundWorkerOptions = {
  syncDir: string;
  batchSize?: number;
  client?: OpenAIClient;
};

export type OutboundRunResult = {
  processed: number;
  skipped: number;
  errors: Array<{ event_id: string; error: string }>;
  last_cursor: string | null;
};

function isoNow() {
  return new Date().toISOString();
}

async function readCursor(cursorPath: string): Promise<CursorState> {
  try {
    const raw = await fs.readFile(cursorPath, "utf8");
    return CursorStateSchema.parse(JSON.parse(raw));
  } catch {
    return {
      version: 1,
      cursor: null,
      updated_at: isoNow(),
    };
  }
}

async function writeCursor(cursorPath: string, cursor: string | null): Promise<void> {
  const next: CursorState = {
    version: 1,
    cursor,
    updated_at: isoNow(),
  };
  await fs.writeFile(cursorPath, JSON.stringify(next, null, 2), "utf8");
}

function sliceAfterCursor(items: EventEnvelope[], cursor: string | null): EventEnvelope[] {
  if (!cursor) return items;
  const idx = items.findIndex((item) => item.event_id === cursor);
  if (idx < 0) return items;
  return items.slice(idx + 1);
}

function deriveConversationId(event: EventEnvelope): string {
  const explicit = (event.conversation_id ?? "").trim();
  if (explicit) return normalizeConversationId(explicit);

  const payload = event.payload as Record<string, unknown> | null;
  const campaignId = typeof payload?.campaign_id === "string" ? payload.campaign_id.trim() : "";
  if (campaignId) return `campaign:${campaignId}`;
  const experimentId = typeof payload?.experiment_id === "string" ? payload.experiment_id.trim() : "";
  if (experimentId) return `experiment:${experimentId}`;
  const taskId = typeof payload?.task_id === "string" ? payload.task_id.trim() : "";
  if (taskId) return `task:${taskId}`;

  const src = (event.source ?? "").trim() || "unknown";
  const typ = (event.type ?? "").trim() || "event";
  return `src:${src}:${typ}`;
}

function buildAssistantInput(payload: unknown, eventType?: string): string {
  const instruction = eventType === "research_agenda.request"
    ? buildAgendaJsonInstruction()
    : eventType === "patch_proposal.request"
      ? buildPatchJsonInstruction()
    : buildJsonOnlyInstruction();
  const body = payloadToInputText(payload);
  return `${instruction}\n\nINPUT:\n${body}`;
}

export class OutboundSyncWorker {
  private readonly syncDir: string;
  private readonly batchSize: number;
  private readonly client: OpenAIClient;

  constructor(opts: OutboundWorkerOptions) {
    this.syncDir = opts.syncDir;
    this.batchSize = Math.max(1, opts.batchSize ?? 50);
    this.client = opts.client ?? new OpenAIClient();
  }

  async runOnce(): Promise<OutboundRunResult> {
    const cursorPath = getOutboundCursorPath(this.syncDir);
    const cursor = await readCursor(cursorPath);

    const listed = await eventList({
      syncDir: this.syncDir,
      direction: "outbound",
      limit: 100_000,
    });

    // Keep append order from events.jsonl window.
    // Sorting by timestamp can break cursor progression when delayed/backfilled
    // events carry older ts but are appended later.
    const events = listed.items.map((item) => EventEnvelopeSchema.parse(item));

    const pending = sliceAfterCursor(events, cursor.cursor).slice(0, this.batchSize);

    let processed = 0;
    let skipped = 0;
    const errors: Array<{ event_id: string; error: string }> = [];
    let lastCursor = cursor.cursor;

    for (const event of pending) {
      try {
        // 1) Dedupe reservation - single store lock.
        if (event.dedupe_key) {
          const reserve = await reserveOutboundDedupe(this.syncDir, event.dedupe_key, event.event_id);

          if (reserve.status === "done") {
            skipped += 1;
            lastCursor = event.event_id;
            await writeCursor(cursorPath, lastCursor);
            continue;
          }

          if (reserve.status === "busy") {
            // Do NOT advance cursor on busy reservation to avoid event loss.
            // Next run will retry; stale reservations are reclaimed by TTL.
            errors.push({ event_id: event.event_id, error: "dedupe_reservation_busy" });
            break;
          }

          // reserved -> continue processing
        }

        const conversationId = deriveConversationId(event);
        const inputText = buildAssistantInput(event.payload, event.type);

        const response = await this.client.createResponse({
          inputText,
          conversationId,
          dedupeKey: event.dedupe_key,
          // Helper mode: keep each outbound request independent.
          previousResponseId: null,
          metadata: {
            local_event_id: event.event_id,
            local_event_type: event.type,
            local_event_source: event.source,
          },
        });

        // 2) Record mapping + dedupe in one store lock.
        await recordOutboundProcessed(this.syncDir, {
          conversationId,
          eventId: event.event_id,
          outboundDedupeKey: event.dedupe_key,
          responseId: response.response_id,
          remoteConversationId: response.conversation_id ?? null,
        });

        await eventPublish({
          syncDir: this.syncDir,
          type: "openai.response",
          payload: {
            response_id: response.response_id,
            text: response.output_text,
          },
          source: "openai",
          conversation_id: conversationId,
          direction: "inbound",
          dedupe_key: response.response_id,
        });

        await applyAssistantResponse({
          syncDir: this.syncDir,
          responseId: response.response_id,
          conversationId,
          text: response.output_text,
        });

        processed += 1;
        lastCursor = event.event_id;
        await writeCursor(cursorPath, lastCursor);
      } catch (error: any) {
        errors.push({
          event_id: event.event_id,
          error: String(error?.message ?? error),
        });
      }
    }

    return {
      processed,
      skipped,
      errors,
      last_cursor: lastCursor,
    };
  }
}
