import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireLock, releaseLock } from "./locks.js";
import { safeAtomicWrite } from "./fs_atomic.js";

export type TaskStatus = "todo" | "doing" | "done" | "blocked";

export type Task = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  labels: string[];
  created_at: string; // ISO
  updated_at: string; // ISO
};

type TasksStore = {
  version: 1;
  updated_at: string;
  tasks: Record<string, Task>;
};

function isoNow() {
  return new Date().toISOString();
}

function tasksFile(syncDir: string) {
  return path.join(syncDir, "tasks.json");
}

function locksDir(syncDir: string) {
  return path.join(syncDir, "queue", "locks");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireTasksLockWithRetry(syncDir: string, attempts = 5): Promise<{ token: string }> {
  const dir = locksDir(syncDir);
  for (let i = 0; i < attempts; i += 1) {
    const lock = await acquireLock({ locksDir: dir, name: "tasks", ttl_ms: 10_000 });
    if (lock.ok && lock.token) return { token: lock.token };
    if (i < attempts - 1) {
      const delay = 50 + Math.floor(Math.random() * 101);
      await sleep(delay);
    }
  }
  throw new Error("tasks lock busy");
}

async function ensureStore(syncDir: string) {
  await fs.mkdir(syncDir, { recursive: true });
  const file = tasksFile(syncDir);
  try {
    await fs.stat(file);
  } catch {
    const init: TasksStore = { version: 1, updated_at: isoNow(), tasks: {} };
    await fs.writeFile(file, JSON.stringify(init, null, 2), "utf8");
  }
}

async function loadStore(syncDir: string): Promise<TasksStore> {
  await ensureStore(syncDir);
  const raw = await fs.readFile(tasksFile(syncDir), "utf8");
  const parsed = JSON.parse(raw) as TasksStore;
  if (!parsed.tasks) parsed.tasks = {};
  return parsed;
}

async function saveStore(syncDir: string, store: TasksStore) {
  const file = tasksFile(syncDir);
  store.updated_at = isoNow();
  await safeAtomicWrite({
    targetPath: file,
    content: JSON.stringify(store, null, 2),
    retries: 6,
    baseDelayMs: 30,
  });
}

export async function tasksUpsert(opts: {
  syncDir: string;
  id?: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  labels?: string[];
}): Promise<{ task: Task }> {
  const lock = await acquireTasksLockWithRetry(opts.syncDir);

  try {
    const store = await loadStore(opts.syncDir);
    const id = (opts.id && opts.id.trim()) ? opts.id.trim() : randomUUID();
    const now = isoNow();

    const existing = store.tasks[id];
    const task: Task = {
      id,
      title: opts.title,
      description: opts.description ?? existing?.description ?? "",
      status: opts.status ?? existing?.status ?? "todo",
      labels: opts.labels ?? existing?.labels ?? [],
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };

    store.tasks[id] = task;
    await saveStore(opts.syncDir, store);
    return { task };
  } finally {
    await releaseLock({ locksDir: locksDir(opts.syncDir), name: "tasks", token: lock.token });
  }
}

export async function tasksGet(opts: {
  syncDir: string;
  id: string;
}): Promise<{ task: Task | null }> {
  const store = await loadStore(opts.syncDir);
  return { task: store.tasks[opts.id] ?? null };
}

export async function tasksDelete(opts: {
  syncDir: string;
  id: string;
}): Promise<{ ok: boolean; deleted: boolean }> {
  const lock = await acquireTasksLockWithRetry(opts.syncDir);

  try {
    const store = await loadStore(opts.syncDir);
    const existed = Boolean(store.tasks[opts.id]);
    if (existed) delete store.tasks[opts.id];
    await saveStore(opts.syncDir, store);
    return { ok: true, deleted: existed };
  } finally {
    await releaseLock({ locksDir: locksDir(opts.syncDir), name: "tasks", token: lock.token });
  }
}

export async function tasksList(opts: {
  syncDir: string;
  limit?: number;
  query?: string;
  status?: TaskStatus;
}): Promise<{ items: Task[] }> {
  const store = await loadStore(opts.syncDir);
  const q = (opts.query ?? "").trim().toLowerCase();

  let items = Object.values(store.tasks);
  if (opts.status) items = items.filter(t => t.status === opts.status);
  if (q) {
    items = items.filter(t =>
      t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
    );
  }

  items.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  return { items: items.slice(0, opts.limit ?? 50) };
}
