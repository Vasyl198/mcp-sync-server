import * as fs from "node:fs/promises";
import { eventPublish, getInboundCursorPath } from "../events.js";
import {
  hasDedupeKey,
  listConversationMappings,
  markDedupeKey,
  shiftPendingInboundResponseId,
  upsertConversationMapping,
} from "./mapping_store.js";
import { OpenAIClient } from "./openai_client.js";
import { applyAssistantResponse } from "./llm_actions.js";
import {
  CursorState,
  CursorStateSchema,
  normalizeConversationId,
} from "./types.js";

type InboundWorkerOptions = {
  syncDir: string;
  batchSize?: number;
  client?: OpenAIClient;
};

export type InboundRunResult = {
  processed: number;
  skipped: number;
  errors: Array<{ response_id: string; error: string }>;
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

export class InboundSyncWorker {
  private readonly syncDir: string;
  private readonly batchSize: number;
  private readonly client: OpenAIClient;

  constructor(opts: InboundWorkerOptions) {
    this.syncDir = opts.syncDir;
    this.batchSize = Math.max(1, opts.batchSize ?? 50);
    this.client = opts.client ?? new OpenAIClient();
  }

  async runOnce(): Promise<InboundRunResult> {
    const cursorPath = getInboundCursorPath(this.syncDir);
    const cursor = await readCursor(cursorPath);
    const mappings = await listConversationMappings(this.syncDir);

    const queue: Array<{ conversation_id: string; response_id: string }> = [];
    for (const mapping of mappings) {
      const conversationId = normalizeConversationId(mapping.conversation_id);
      for (const responseId of mapping.pending_inbound_response_ids) {
        queue.push({
          conversation_id: conversationId,
          response_id: responseId,
        });
      }
    }

    const slice = queue.slice(0, this.batchSize);
    let processed = 0;
    let skipped = 0;
    const errors: Array<{ response_id: string; error: string }> = [];
    let lastCursor = cursor.cursor;

    for (const item of slice) {
      try {
        const isDup = await hasDedupeKey(this.syncDir, "inbound", item.response_id);
        if (isDup) {
          await shiftPendingInboundResponseId(this.syncDir, item.conversation_id, item.response_id);
          skipped += 1;
          lastCursor = item.response_id;
          await writeCursor(cursorPath, lastCursor);
          continue;
        }

        const response = await this.client.getResponse(item.response_id);
        const conversationId = normalizeConversationId(item.conversation_id);

        const published = await eventPublish({
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

        if (published.ok) {
          await applyAssistantResponse({
            syncDir: this.syncDir,
            responseId: response.response_id,
            conversationId,
            text: response.output_text,
          });
          await markDedupeKey(this.syncDir, "inbound", response.response_id, null);
          await shiftPendingInboundResponseId(this.syncDir, conversationId, response.response_id);
          await upsertConversationMapping(this.syncDir, conversationId, {
            last_inbound_event_id: response.response_id,
            last_response_id: response.response_id,
          });
        }

        processed += 1;
        lastCursor = response.response_id;
        await writeCursor(cursorPath, lastCursor);
      } catch (error: any) {
        errors.push({
          response_id: item.response_id,
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
