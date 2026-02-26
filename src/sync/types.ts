import { z } from "zod";

export const SyncDirectionSchema = z.enum(["outbound", "inbound"]);
export type SyncDirection = z.infer<typeof SyncDirectionSchema>;

export const EventEnvelopeSchema = z.object({
  event_id: z.string().min(1),
  ts: z.string().min(1),
  type: z.string().min(1),
  payload: z.unknown().nullable(),
  source: z.string().min(1),
  conversation_id: z.string().nullable(),
  direction: SyncDirectionSchema,
  dedupe_key: z.string().nullable(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const CursorStateSchema = z.object({
  version: z.literal(1),
  cursor: z.string().nullable(),
  updated_at: z.string().min(1),
});
export type CursorState = z.infer<typeof CursorStateSchema>;

export const ConversationMappingSchema = z.object({
  conversation_id: z.string().min(1),
  remote_conversation_id: z.string().nullable().default(null),
  last_outbound_event_id: z.string().nullable().default(null),
  last_inbound_event_id: z.string().nullable().default(null),
  last_response_id: z.string().nullable().default(null),
  pending_inbound_response_ids: z.array(z.string()).default([]),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});
export type ConversationMapping = z.infer<typeof ConversationMappingSchema>;

export const DedupeEntryStateSchema = z.enum(["reserved", "done"]);
export type DedupeEntryState = z.infer<typeof DedupeEntryStateSchema>;

export const DedupeEntrySchema = z.object({
  key: z.string().min(1),
  direction: SyncDirectionSchema,
  event_id: z.string().nullable().default(null),
  ts: z.string().min(1),
  // Backward compatible: older stores won't have it.
  state: DedupeEntryStateSchema.optional().default("done"),
});
export type DedupeEntry = z.infer<typeof DedupeEntrySchema>;

export const MappingStoreSchema = z.object({
  version: z.literal(1),
  updated_at: z.string().min(1),
  conversations: z.record(z.string(), ConversationMappingSchema).default({}),
  dedupe: z.object({
    outbound: z.record(z.string(), DedupeEntrySchema).default({}),
    inbound: z.record(z.string(), DedupeEntrySchema).default({}),
  }),
});
export type MappingStore = z.infer<typeof MappingStoreSchema>;

export const OpenAIResponseSummarySchema = z.object({
  response_id: z.string().min(1),
  conversation_id: z.string().nullable(),
  output_text: z.string(),
  raw: z.unknown(),
});
export type OpenAIResponseSummary = z.infer<typeof OpenAIResponseSummarySchema>;

export function normalizeConversationId(conversationId: string | null | undefined): string {
  const value = (conversationId ?? "").trim();
  return value.length ? value : "default";
}

const MAX_INPUT_CHARS = 3500; // safer default for local 3B models
const MAX_STRING_CHARS = 600;
const MAX_ARRAY_ITEMS = 6;
const MAX_OBJECT_KEYS = 40;
const MAX_DEPTH = 2;

function clampText(s: string, max = MAX_STRING_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `...[+${s.length - max} chars]`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function pickLikelyIds(obj: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    "campaign_id",
    "experiment_id",
    "run_id",
    "task_id",
    "project_id",
    "domain_signature",
    "domain",
    "role",
    "strategy_id",
    "agent_role",
    "agent_version",
    "status",
    "phase",
    "objective",
    "metric",
  ];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

function prune(value: unknown, depth = 0): unknown {
  if (value == null) return value;

  if (typeof value === "string") return clampText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY_ITEMS).map((v) => prune(v, depth + 1));
    const extra = value.length > MAX_ARRAY_ITEMS ? value.length - MAX_ARRAY_ITEMS : 0;
    return extra > 0 ? { items: head, _truncated: extra } : head;
  }

  if (isPlainObject(value)) {
    // Special-case: if payload is huge diagnostic snapshots, keep only a compact summary.
    const summary: Record<string, unknown> = {
      ...pickLikelyIds(value),
    };

    if (depth >= MAX_DEPTH) {
      const keys = Object.keys(value).slice(0, MAX_OBJECT_KEYS);
      for (const k of keys) {
        if (k in summary) continue;
        const v = value[k];
        if (typeof v === "string") summary[k] = clampText(v, 200);
        else if (typeof v === "number" || typeof v === "boolean") summary[k] = v;
        else if (Array.isArray(v)) summary[k] = { _array_len: v.length };
        else if (isPlainObject(v)) summary[k] = { _object_keys: Object.keys(v).length };
        else summary[k] = typeof v;
      }
      const extra = Math.max(0, Object.keys(value).length - keys.length);
      if (extra) summary._keys_truncated = extra;
      return summary;
    }

    const keys = Object.keys(value).slice(0, MAX_OBJECT_KEYS);
    for (const k of keys) {
      if (k in summary) continue;
      summary[k] = prune(value[k], depth + 1);
    }
    const extra = Math.max(0, Object.keys(value).length - keys.length);
    if (extra) summary._keys_truncated = extra;
    return summary;
  }

  return String(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable payload]";
  }
}

export function payloadToInputText(payload: unknown): string {
  if (typeof payload === "string") return clampText(payload, MAX_INPUT_CHARS);

  if (payload && typeof payload === "object") {
    const text = (payload as Record<string, unknown>).text;
    if (typeof text === "string") return clampText(text, MAX_INPUT_CHARS);
  }

  // Generic: prune aggressively then stringify.
  const pruned = prune(payload ?? null, 0);
  let out = safeStringify(pruned);

  if (out.length > MAX_INPUT_CHARS) {
    out = out.slice(0, MAX_INPUT_CHARS) + `...[TRUNCATED ${(out.length - MAX_INPUT_CHARS).toString()} chars]`;
  }

  return out;
}

export function payloadIsLarge(payload: unknown): boolean {
  const text = payloadToInputText(payload);
  return text.length >= Math.floor(MAX_INPUT_CHARS * 0.9);
}
