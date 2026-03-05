import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export type EventRecord = {
  event_id: string;
  ts: string; // ISO timestamp
  type: string; // e.g. "status" | "report" | "log" | ...
  payload: any; // arbitrary JSON
  source: string; // "windsurf" | "chatgpt" | etc.
  conversation_id: string | null;
  direction: "outbound" | "inbound";
  dedupe_key: string | null;
};

function isoNow() {
  return new Date().toISOString();
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

async function ensureFile(p: string) {
  try {
    await fs.stat(p);
  } catch {
    await fs.writeFile(p, "", "utf8");
  }
}

export function getEventsPath(syncDir: string) {
  return path.join(syncDir, "events.jsonl");
}

export function getSyncStateDir(syncDir: string) {
  return path.join(syncDir, "sync", "state");
}

export function getOutboundCursorPath(syncDir: string) {
  return path.join(getSyncStateDir(syncDir), "outbound.cursor.json");
}

export function getInboundCursorPath(syncDir: string) {
  return path.join(getSyncStateDir(syncDir), "inbound.cursor.json");
}

async function ensureCursorFile(filePath: string) {
  try {
    await fs.stat(filePath);
  } catch {
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          version: 1,
          cursor: null,
          updated_at: isoNow(),
        },
        null,
        2
      ),
      "utf8"
    );
  }
}

export async function ensureSyncState(syncDir: string): Promise<{
  outbound_cursor_path: string;
  inbound_cursor_path: string;
}> {
  const stateDir = getSyncStateDir(syncDir);
  await ensureDir(stateDir);

  const outbound = getOutboundCursorPath(syncDir);
  const inbound = getInboundCursorPath(syncDir);

  await ensureCursorFile(outbound);
  await ensureCursorFile(inbound);

  return {
    outbound_cursor_path: outbound,
    inbound_cursor_path: inbound,
  };
}

function normalizeEvent(raw: any): EventRecord {
  const ts = typeof raw?.ts === "string" ? raw.ts : isoNow();
  const payload = raw?.payload ?? raw?.data ?? null;

  return {
    event_id:
      typeof raw?.event_id === "string" && raw.event_id.trim()
        ? raw.event_id
        : randomUUID(),
    ts,
    type: typeof raw?.type === "string" ? raw.type : "unknown",
    payload,
    source: typeof raw?.source === "string" && raw.source.trim() ? raw.source : "windsurf",
    conversation_id:
      typeof raw?.conversation_id === "string" && raw.conversation_id.trim()
        ? raw.conversation_id
        : null,
    direction: raw?.direction === "inbound" ? "inbound" : "outbound",
    dedupe_key:
      typeof raw?.dedupe_key === "string" && raw.dedupe_key.trim() ? raw.dedupe_key : null,
  };
}

export async function eventPublish(opts: {
  syncDir: string;
  type: string;
  payload?: any;
  data?: any; // backward compatibility
  source?: string;
  event_id?: string;
  conversation_id?: string;
  direction?: "outbound" | "inbound";
  dedupe_key?: string;
}): Promise<{ ok: boolean }> {
  const eventsPath = getEventsPath(opts.syncDir);
  await ensureDir(path.dirname(eventsPath));
  await ensureFile(eventsPath);
  await ensureSyncState(opts.syncDir);

  const rec = normalizeEvent({
    event_id: opts.event_id ?? randomUUID(),
    ts: isoNow(),
    type: opts.type,
    payload: opts.payload ?? opts.data ?? null,
    source: opts.source ?? "windsurf",
    conversation_id: opts.conversation_id ?? null,
    direction: opts.direction ?? "outbound",
    dedupe_key: opts.dedupe_key ?? null,
  });

  await fs.appendFile(eventsPath, JSON.stringify(rec) + "\n", "utf8");
  return { ok: true };
}

export async function eventList(opts: {
  syncDir: string;
  limit?: number;
  type?: string;
  since_ts?: string;
  source?: string;
  event_id?: string;
  conversation_id?: string;
  direction?: "outbound" | "inbound";
  dedupe_key?: string;
}): Promise<{ items: EventRecord[] }> {
  const eventsPath = getEventsPath(opts.syncDir);
  await ensureDir(path.dirname(eventsPath));
  await ensureFile(eventsPath);
  await ensureSyncState(opts.syncDir);

  const raw = await fs.readFile(eventsPath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const since = opts.since_ts ? Date.parse(opts.since_ts) : null;

  const items: EventRecord[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const rec = normalizeEvent(JSON.parse(lines[i]));
      if (opts.type && rec.type !== opts.type) continue;
      if (opts.source && rec.source !== opts.source) continue;
      if (opts.event_id && rec.event_id !== opts.event_id) continue;
      if (opts.conversation_id && rec.conversation_id !== opts.conversation_id) continue;
      if (opts.direction && rec.direction !== opts.direction) continue;
      if (opts.dedupe_key && rec.dedupe_key !== opts.dedupe_key) continue;
      if (since !== null && Date.parse(rec.ts) < since) continue;
      items.push(rec);
      if (items.length >= (opts.limit ?? 50)) break;
    } catch {
      // skip bad line
    }
  }

  // Return in chronological order (old -> new)
  items.reverse();
  return { items };
}
