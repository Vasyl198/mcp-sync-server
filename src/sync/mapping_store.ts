import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acquireLock, releaseLock } from "../locks.js";
import {
  ConversationMapping,
  ConversationMappingSchema,
  DedupeEntry,
  MappingStore,
  MappingStoreSchema,
  SyncDirection,
  normalizeConversationId,
} from "./types.js";

function isoNow() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function parseTsMs(ts: string): number {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : 0;
}

function mappingStorePath(syncDir: string) {
  return path.join(syncDir, "sync", "state", "mappings.json");
}

function locksDir(syncDir: string) {
  return path.join(syncDir, "queue", "locks");
}

// How long we consider an outbound reservation "alive".
// After this, a new worker may take over the key.
const OUTBOUND_RESERVATION_TTL_MS = 60_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureStore(syncDir: string) {
  const file = mappingStorePath(syncDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.stat(file);
  } catch {
    const init: MappingStore = {
      version: 1,
      updated_at: isoNow(),
      conversations: {},
      dedupe: { outbound: {}, inbound: {} },
    };
    await fs.writeFile(file, JSON.stringify(init, null, 2), "utf8");
  }
}

async function loadStore(syncDir: string): Promise<MappingStore> {
  await ensureStore(syncDir);
  const raw = await fs.readFile(mappingStorePath(syncDir), "utf8");
  const parsed = JSON.parse(raw);
  return MappingStoreSchema.parse(parsed);
}

async function saveStore(syncDir: string, store: MappingStore): Promise<void> {
  const file = mappingStorePath(syncDir);
  const tmp = `${file}.tmp`;
  store.updated_at = isoNow();
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, file);
}

async function withLockedStore<T>(syncDir: string, handler: (store: MappingStore) => Promise<T>): Promise<T> {
  // More retries because Windows file locking can transiently fail.
  const attempts = 15;
  for (let i = 0; i < attempts; i++) {
    const lock = await acquireLock({
      locksDir: locksDir(syncDir),
      name: "sync_mapping_store",
      ttl_ms: 15_000,
    });
    if (!lock.ok || !lock.token) {
      const backoff = Math.min(800, 40 * 2 ** i) + Math.floor(Math.random() * 80);
      await sleep(backoff);
      continue;
    }
    try {
      const store = await loadStore(syncDir);
      const result = await handler(store);
      await saveStore(syncDir, store);
      return result;
    } finally {
      await releaseLock({
        locksDir: locksDir(syncDir),
        name: "sync_mapping_store",
        token: lock.token,
      });
    }
  }
  throw new Error("sync mapping store lock busy (exhausted retries)");
}

function ensureConversation(store: MappingStore, conversationId: string): ConversationMapping {
  const normalized = normalizeConversationId(conversationId);
  const existing = store.conversations[normalized];
  if (existing) return ConversationMappingSchema.parse(existing);

  const now = isoNow();
  const created: ConversationMapping = {
    conversation_id: normalized,
    remote_conversation_id: null,
    last_outbound_event_id: null,
    last_inbound_event_id: null,
    last_response_id: null,
    pending_inbound_response_ids: [],
    created_at: now,
    updated_at: now,
  };
  store.conversations[normalized] = created;
  return created;
}

// --- High-level helpers to reduce lock contention ---

export type ReserveResult =
  | { ok: true; status: "reserved" }
  | { ok: true; status: "done" }
  | { ok: true; status: "busy" };

function isStaleReservation(entry: DedupeEntry): boolean {
  if ((entry.state ?? "done") !== "reserved") return false;
  const age = nowMs() - parseTsMs(entry.ts);
  return age > OUTBOUND_RESERVATION_TTL_MS;
}

/**
 * Atomically check+reserve an outbound dedupe key.
 * Tri-state result:
 * - reserved: caller may process
 * - done: already processed (safe to skip and advance cursor)
 * - busy: reserved by another worker and not stale yet (do NOT advance cursor)
 */
export async function reserveOutboundDedupe(
  syncDir: string,
  dedupeKey: string,
  eventId: string
): Promise<ReserveResult> {
  return withLockedStore(syncDir, async (store) => {
    const map = store.dedupe.outbound;
    const existing = map[dedupeKey];

    if (!existing) {
      map[dedupeKey] = {
        key: dedupeKey,
        direction: "outbound",
        event_id: eventId,
        ts: isoNow(),
        state: "reserved",
      };
      return { ok: true, status: "reserved" };
    }

    const state = existing.state ?? "done";
    if (state === "done") return { ok: true, status: "done" };

    // state === reserved
    if (existing.event_id === eventId) {
      // Re-entrant retry for the same local event.
      return { ok: true, status: "reserved" };
    }

    if (isStaleReservation(existing)) {
      // Take over stale reservation.
      map[dedupeKey] = {
        key: dedupeKey,
        direction: "outbound",
        event_id: eventId,
        ts: isoNow(),
        state: "reserved",
      };
      return { ok: true, status: "reserved" };
    }

    return { ok: true, status: "busy" };
  });
}

/**
 * Atomically record the outbound processing result + dedupe entries.
 * This replaces multiple separate lock acquisitions in outbound_worker.
 */
export async function recordOutboundProcessed(syncDir: string, args: {
  conversationId: string;
  eventId: string;
  outboundDedupeKey: string | null;
  responseId: string;
  remoteConversationId: string | null;
}): Promise<void> {
  await withLockedStore(syncDir, async (store) => {
    const mapping = ensureConversation(store, args.conversationId);
    store.conversations[mapping.conversation_id] = {
      ...mapping,
      remote_conversation_id: args.remoteConversationId ?? mapping.remote_conversation_id,
      last_outbound_event_id: args.eventId,
      last_response_id: args.responseId,
      updated_at: isoNow(),
    };

    if (args.outboundDedupeKey) {
      store.dedupe.outbound[args.outboundDedupeKey] = {
        key: args.outboundDedupeKey,
        direction: "outbound",
        event_id: args.eventId,
        ts: isoNow(),
        state: "done",
      };
    }

    // Mark inbound dedupe for the generated response id so inbound worker won't re-process.
    store.dedupe.inbound[args.responseId] = {
      key: args.responseId,
      direction: "inbound",
      event_id: null,
      ts: isoNow(),
      state: "done",
    };
  });
}

// --- Existing APIs (kept for compatibility) ---

export async function getConversationMapping(syncDir: string, conversationId: string): Promise<ConversationMapping> {
  return withLockedStore(syncDir, async (store) => {
    const mapping = ensureConversation(store, conversationId);
    return mapping;
  });
}

export async function upsertConversationMapping(
  syncDir: string,
  conversationId: string,
  patch: Partial<ConversationMapping>
): Promise<ConversationMapping> {
  return withLockedStore(syncDir, async (store) => {
    const mapping = ensureConversation(store, conversationId);
    const updated: ConversationMapping = ConversationMappingSchema.parse({
      ...mapping,
      ...patch,
      conversation_id: mapping.conversation_id,
      pending_inbound_response_ids: patch.pending_inbound_response_ids ?? mapping.pending_inbound_response_ids,
      updated_at: isoNow(),
    });
    store.conversations[mapping.conversation_id] = updated;
    return updated;
  });
}

export async function enqueueInboundResponseId(
  syncDir: string,
  conversationId: string,
  responseId: string
): Promise<ConversationMapping> {
  return withLockedStore(syncDir, async (store) => {
    const mapping = ensureConversation(store, conversationId);
    const pending = new Set(mapping.pending_inbound_response_ids);
    pending.add(responseId);
    const updated: ConversationMapping = {
      ...mapping,
      pending_inbound_response_ids: Array.from(pending),
      updated_at: isoNow(),
    };
    store.conversations[mapping.conversation_id] = updated;
    return updated;
  });
}

export async function shiftPendingInboundResponseId(
  syncDir: string,
  conversationId: string,
  responseId: string
): Promise<ConversationMapping> {
  return withLockedStore(syncDir, async (store) => {
    const mapping = ensureConversation(store, conversationId);
    const filtered = mapping.pending_inbound_response_ids.filter((id) => id !== responseId);
    const updated: ConversationMapping = {
      ...mapping,
      pending_inbound_response_ids: filtered,
      updated_at: isoNow(),
    };
    store.conversations[mapping.conversation_id] = updated;
    return updated;
  });
}

export async function listConversationMappings(syncDir: string): Promise<ConversationMapping[]> {
  return withLockedStore(syncDir, async (store) =>
    Object.values(store.conversations).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  );
}

export async function hasDedupeKey(syncDir: string, direction: SyncDirection, dedupeKey: string): Promise<boolean> {
  return withLockedStore(syncDir, async (store) => {
    const map = direction === "outbound" ? store.dedupe.outbound : store.dedupe.inbound;
    return Boolean(map[dedupeKey]);
  });
}

export async function markDedupeKey(
  syncDir: string,
  direction: SyncDirection,
  dedupeKey: string,
  eventId?: string | null
): Promise<void> {
  await withLockedStore(syncDir, async (store) => {
    const map = direction === "outbound" ? store.dedupe.outbound : store.dedupe.inbound;
    map[dedupeKey] = {
      key: dedupeKey,
      direction,
      event_id: eventId ?? null,
      ts: isoNow(),
      state: "done",
    };
  });
}

export async function getMappingStoreStats(syncDir: string): Promise<{
  mappings_count: number;
  pending_inbound_ids: number;
  dedupe_outbound_count: number;
  dedupe_inbound_count: number;
  last_updated_at: string;
}> {
  return withLockedStore(syncDir, async (store) => {
    const mappings = Object.values(store.conversations);
    const pending = mappings.reduce((acc, item) => acc + item.pending_inbound_response_ids.length, 0);
    return {
      mappings_count: mappings.length,
      pending_inbound_ids: pending,
      dedupe_outbound_count: Object.keys(store.dedupe.outbound).length,
      dedupe_inbound_count: Object.keys(store.dedupe.inbound).length,
      last_updated_at: store.updated_at,
    };
  });
}

export async function reconcileMappingStore(syncDir: string): Promise<{
  mappings_count: number;
  normalized_pending_lists: number;
}> {
  return withLockedStore(syncDir, async (store) => {
    let normalized = 0;

    for (const key of Object.keys(store.conversations)) {
      const mapping = ConversationMappingSchema.parse(store.conversations[key]);
      const uniquePending = Array.from(new Set(mapping.pending_inbound_response_ids));
      if (uniquePending.length !== mapping.pending_inbound_response_ids.length) {
        normalized += 1;
      }

      store.conversations[key] = {
        ...mapping,
        pending_inbound_response_ids: uniquePending,
        updated_at: isoNow(),
      };
    }

    return {
      mappings_count: Object.keys(store.conversations).length,
      normalized_pending_lists: normalized,
    };
  });
}
