import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireLock, releaseLock } from "./locks.js";

export type MemoryItem = {
  memory_id: string;
  project_id: string;
  type: string;
  tags: string[];
  content: string;
  ts: number;
  updated_ts?: number;
};

function memoryPath(syncDir: string) {
  return path.join(syncDir, "memory", "memory.jsonl");
}

function locksDir(syncDir: string) {
  return path.join(syncDir, "queue", "locks");
}

async function ensureMemory(syncDir: string) {
  const file = memoryPath(syncDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.stat(file);
  } catch {
    await fs.writeFile(file, "", "utf8");
  }
}

async function readMemory(syncDir: string): Promise<MemoryItem[]> {
  await ensureMemory(syncDir);
  const raw = await fs.readFile(memoryPath(syncDir), "utf8");
  const out: MemoryItem[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as MemoryItem);
    } catch {
      // skip broken line
    }
  }
  return out;
}

async function writeMemory(syncDir: string, items: MemoryItem[]) {
  await ensureMemory(syncDir);
  const file = memoryPath(syncDir);
  const tmp = `${file}.tmp`;
  const body = items.map((x) => JSON.stringify(x)).join("\n");
  await fs.writeFile(tmp, body ? `${body}\n` : "", "utf8");
  await fs.rename(tmp, file);
}

async function withMemoryLock<T>(syncDir: string, handler: (items: MemoryItem[]) => Promise<T>): Promise<T> {
  const lock = await acquireLock({
    locksDir: locksDir(syncDir),
    name: "memory_store",
    ttl_ms: 10_000,
  });
  if (!lock.ok || !lock.token) throw new Error("memory lock busy");

  try {
    const items = await readMemory(syncDir);
    const result = await handler(items);
    await writeMemory(syncDir, items);
    return result;
  } finally {
    await releaseLock({
      locksDir: locksDir(syncDir),
      name: "memory_store",
      token: lock.token,
    });
  }
}

export async function memoryStore(opts: {
  syncDir: string;
  project_id: string;
  type: string;
  tags?: string[];
  content: string;
}): Promise<{ item: MemoryItem }> {
  return withMemoryLock(opts.syncDir, async (items) => {
    const item: MemoryItem = {
      memory_id: randomUUID(),
      project_id: opts.project_id.trim() || "default",
      type: opts.type.trim() || "note",
      tags: opts.tags ?? [],
      content: opts.content,
      ts: Date.now(),
    };
    items.push(item);
    return { item };
  });
}

export async function memoryQuery(opts: {
  syncDir: string;
  project_id?: string;
  type?: string;
  tags?: string[];
  query?: string;
  limit?: number;
}): Promise<{ items: MemoryItem[]; total: number }> {
  const items = await readMemory(opts.syncDir);
  const q = (opts.query ?? "").trim().toLowerCase();
  const tags = opts.tags ?? [];

  let out = items.slice();
  if (opts.project_id) out = out.filter((x) => x.project_id === opts.project_id);
  if (opts.type) out = out.filter((x) => x.type === opts.type);
  if (tags.length) out = out.filter((x) => tags.every((t) => x.tags.includes(t)));
  if (q) {
    out = out.filter(
      (x) =>
        x.content.toLowerCase().includes(q) ||
        x.type.toLowerCase().includes(q) ||
        x.tags.some((t) => t.toLowerCase().includes(q))
    );
  }

  out.sort((a, b) => (b.updated_ts ?? b.ts) - (a.updated_ts ?? a.ts));
  return { items: out.slice(0, opts.limit ?? 50), total: out.length };
}

export async function memoryUpdate(opts: {
  syncDir: string;
  memory_id: string;
  content?: string;
  tags?: string[];
  type?: string;
}): Promise<{ updated: boolean; item: MemoryItem | null }> {
  return withMemoryLock(opts.syncDir, async (items) => {
    const idx = items.findIndex((x) => x.memory_id === opts.memory_id);
    if (idx < 0) return { updated: false, item: null };

    const current = items[idx];
    const next: MemoryItem = {
      ...current,
      content: opts.content ?? current.content,
      tags: opts.tags ?? current.tags,
      type: opts.type ?? current.type,
      updated_ts: Date.now(),
    };
    items[idx] = next;
    return { updated: true, item: next };
  });
}

export async function memoryPrune(opts: {
  syncDir: string;
  older_than_ts?: number;
  project_id?: string;
  limit?: number;
}): Promise<{ deleted: number; remaining: number }> {
  return withMemoryLock(opts.syncDir, async (items) => {
    const olderThan = opts.older_than_ts ?? 0;
    const maxDelete = Math.max(1, opts.limit ?? Number.MAX_SAFE_INTEGER);

    const keep: MemoryItem[] = [];
    let deleted = 0;
    for (const item of items) {
      const byProject = opts.project_id ? item.project_id === opts.project_id : true;
      const byAge = olderThan > 0 ? item.ts < olderThan : true;
      const shouldDelete = byProject && byAge && deleted < maxDelete;
      if (shouldDelete) {
        deleted += 1;
      } else {
        keep.push(item);
      }
    }

    items.length = 0;
    items.push(...keep);
    return { deleted, remaining: items.length };
  });
}
