import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireLock, releaseLock } from "./locks.js";

export type Note = {
  id: string;
  title: string;
  content: string;
  tags: string[];
  created_at: string; // ISO
  updated_at: string; // ISO
};

type NotesStore = {
  version: 1;
  updated_at: string;
  notes: Record<string, Note>;
};

function isoNow() {
  return new Date().toISOString();
}

function notesFile(syncDir: string) {
  return path.join(syncDir, "notes.json");
}

function locksDir(syncDir: string) {
  return path.join(syncDir, "queue", "locks");
}

async function ensureStore(syncDir: string) {
  await fs.mkdir(syncDir, { recursive: true });
  const file = notesFile(syncDir);
  try {
    await fs.stat(file);
  } catch {
    const init: NotesStore = { version: 1, updated_at: isoNow(), notes: {} };
    await fs.writeFile(file, JSON.stringify(init, null, 2), "utf8");
  }
}

async function loadStore(syncDir: string): Promise<NotesStore> {
  await ensureStore(syncDir);
  const raw = await fs.readFile(notesFile(syncDir), "utf8");
  const parsed = JSON.parse(raw) as NotesStore;
  if (!parsed.notes) parsed.notes = {};
  return parsed;
}

// атомарная запись (temp -> rename)
async function saveStore(syncDir: string, store: NotesStore) {
  const file = notesFile(syncDir);
  const tmp = file + ".tmp";
  store.updated_at = isoNow();
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function notesUpsert(opts: {
  syncDir: string;
  id?: string;
  title: string;
  content?: string;
  tags?: string[];
}): Promise<{ note: Note }> {
  const lock = await acquireLock({ locksDir: locksDir(opts.syncDir), name: "notes", ttl_ms: 10_000 });
  if (!lock.ok || !lock.token) throw new Error("notes lock busy");

  try {
    const store = await loadStore(opts.syncDir);
    const id = (opts.id && opts.id.trim()) ? opts.id.trim() : randomUUID();
    const now = isoNow();

    const existing = store.notes[id];
    const note: Note = {
      id,
      title: opts.title,
      content: opts.content ?? existing?.content ?? "",
      tags: opts.tags ?? existing?.tags ?? [],
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };

    store.notes[id] = note;
    await saveStore(opts.syncDir, store);
    return { note };
  } finally {
    await releaseLock({ locksDir: locksDir(opts.syncDir), name: "notes", token: lock.token });
  }
}

export async function notesGet(opts: {
  syncDir: string;
  id: string;
}): Promise<{ note: Note | null }> {
  const store = await loadStore(opts.syncDir);
  return { note: store.notes[opts.id] ?? null };
}

export async function notesDelete(opts: {
  syncDir: string;
  id: string;
}): Promise<{ ok: boolean; deleted: boolean }> {
  const lock = await acquireLock({ locksDir: locksDir(opts.syncDir), name: "notes", ttl_ms: 10_000 });
  if (!lock.ok || !lock.token) throw new Error("notes lock busy");

  try {
    const store = await loadStore(opts.syncDir);
    const existed = Boolean(store.notes[opts.id]);
    if (existed) delete store.notes[opts.id];
    await saveStore(opts.syncDir, store);
    return { ok: true, deleted: existed };
  } finally {
    await releaseLock({ locksDir: locksDir(opts.syncDir), name: "notes", token: lock.token });
  }
}

export async function notesList(opts: {
  syncDir: string;
  limit?: number;
  query?: string;
}): Promise<{ items: Note[] }> {
  const store = await loadStore(opts.syncDir);
  const q = (opts.query ?? "").trim().toLowerCase();

  let items = Object.values(store.notes);
  if (q) {
    items = items.filter(n =>
      n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)
    );
  }

  items.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  return { items: items.slice(0, opts.limit ?? 50) };
}
