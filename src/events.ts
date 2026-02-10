import * as fs from "node:fs/promises";
import * as path from "node:path";

export type EventRecord = {
  ts: string;              // ISO timestamp
  type: string;            // e.g. "status" | "report" | "log" | ...
  data: any;               // arbitrary JSON
  source?: string;         // "windsurf" | "chatgpt" | etc.
};

function isoNow() {
  return new Date().toISOString();
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

async function ensureFile(p: string) {
  try { await fs.stat(p); } catch { await fs.writeFile(p, "", "utf8"); }
}

export function getEventsPath(syncDir: string) {
  return path.join(syncDir, "events.jsonl");
}

export async function eventPublish(opts: {
  syncDir: string;
  type: string;
  data: any;
  source?: string;
}): Promise<{ ok: boolean }> {
  const eventsPath = getEventsPath(opts.syncDir);
  await ensureDir(path.dirname(eventsPath));
  await ensureFile(eventsPath);

  const rec: EventRecord = {
    ts: isoNow(),
    type: opts.type,
    data: opts.data ?? null,
    source: opts.source ?? "windsurf",
  };

  await fs.appendFile(eventsPath, JSON.stringify(rec) + "\n", "utf8");
  return { ok: true };
}

export async function eventList(opts: {
  syncDir: string;
  limit?: number;
  type?: string;
  since_ts?: string;
}): Promise<{ items: EventRecord[] }> {
  const eventsPath = getEventsPath(opts.syncDir);
  await ensureDir(path.dirname(eventsPath));
  await ensureFile(eventsPath);

  const raw = await fs.readFile(eventsPath, "utf8");
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const since = opts.since_ts ? Date.parse(opts.since_ts) : null;

  const items: EventRecord[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(lines[i]) as EventRecord;
      if (opts.type && rec.type !== opts.type) continue;
      if (since !== null && Date.parse(rec.ts) < since) continue;
      items.push(rec);
      if (items.length >= (opts.limit ?? 50)) break;
    } catch {
      // skip bad line
    }
  }

  // вернуть в хронологическом порядке (старые -> новые)
  items.reverse();
  return { items };
}
