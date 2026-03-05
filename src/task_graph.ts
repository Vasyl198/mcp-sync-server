import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireLock, releaseLock } from "./locks.js";
import { safeAtomicWrite } from "./fs_atomic.js";

export type TaskGraphStatus = "open" | "in_progress" | "blocked" | "done" | "canceled";
export type TaskRole = "planner" | "dev" | "research" | "critic";

export type TaskExecutionState = {
  mode: "exec" | "agent";
  command: string;
  job_id?: string;
  attempts?: number;
  queued_at?: string;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
  last_error?: string;
  next_retry_at?: string;
};

export type TaskExecutionPolicy = {
  max_attempts?: number;
  retry_delay_ms?: number;
  backoff_multiplier?: number;
};

export type TaskGraphItem = {
  task_id: string;
  project_id: string;
  role?: TaskRole;
  title: string;
  description: string;
  status: TaskGraphStatus;
  depends_on: string[];
  children: string[];
  execution?: TaskExecutionState;
  execution_policy?: TaskExecutionPolicy;
  created_at: string;
  updated_at: string;
};

type TaskGraphStore = {
  version: 1;
  updated_at: string;
  tasks: Record<string, TaskGraphItem>;
};

function isoNow() {
  return new Date().toISOString();
}

function tasksDir(syncDir: string) {
  return path.join(syncDir, "tasks");
}

function tasksFile(syncDir: string) {
  return path.join(tasksDir(syncDir), "tasks.json");
}

function locksDir(syncDir: string) {
  return path.join(syncDir, "queue", "locks");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireTaskGraphLockWithRetry(syncDir: string, attempts = 5): Promise<{ token: string }> {
  const dir = locksDir(syncDir);
  for (let i = 0; i < attempts; i += 1) {
    const lock = await acquireLock({
      locksDir: dir,
      name: "task_graph",
      ttl_ms: 10_000,
    });
    if (lock.ok && lock.token) return { token: lock.token };
    if (i < attempts - 1) {
      const delay = 50 + Math.floor(Math.random() * 101);
      await sleep(delay);
    }
  }
  throw new Error("task_graph lock busy");
}

async function ensureStore(syncDir: string) {
  await fs.mkdir(tasksDir(syncDir), { recursive: true });
  const file = tasksFile(syncDir);
  try {
    await fs.stat(file);
  } catch {
    const init: TaskGraphStore = {
      version: 1,
      updated_at: isoNow(),
      tasks: {},
    };
    await fs.writeFile(file, JSON.stringify(init, null, 2), "utf8");
  }
}

async function loadStore(syncDir: string): Promise<TaskGraphStore> {
  await ensureStore(syncDir);
  const raw = await fs.readFile(tasksFile(syncDir), "utf8");
  const parsed = JSON.parse(raw) as Partial<TaskGraphStore>;
  return {
    version: 1,
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : isoNow(),
    tasks: parsed.tasks ?? {},
  };
}

async function saveStore(syncDir: string, store: TaskGraphStore) {
  const file = tasksFile(syncDir);
  store.updated_at = isoNow();
  await safeAtomicWrite({
    targetPath: file,
    content: JSON.stringify(store, null, 2),
    retries: 6,
    baseDelayMs: 30,
  });
}

async function withLock<T>(syncDir: string, handler: (store: TaskGraphStore) => Promise<T>): Promise<T> {
  const lock = await acquireTaskGraphLockWithRetry(syncDir);

  try {
    const store = await loadStore(syncDir);
    const result = await handler(store);
    await saveStore(syncDir, store);
    return result;
  } finally {
    await releaseLock({
      locksDir: locksDir(syncDir),
      name: "task_graph",
      token: lock.token,
    });
  }
}

function dedupe(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function sortByUpdatedDesc(items: TaskGraphItem[]) {
  return items.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

export async function taskCreate(opts: {
  syncDir: string;
  project_id?: string;
  role?: TaskRole;
  task_id?: string;
  title: string;
  description?: string;
  status?: TaskGraphStatus;
  depends_on?: string[];
  children?: string[];
  execution_policy?: TaskExecutionPolicy;
}): Promise<{ task: TaskGraphItem }> {
  return withLock(opts.syncDir, async (store) => {
    const now = isoNow();
    const taskId = (opts.task_id && opts.task_id.trim()) ? opts.task_id.trim() : randomUUID();
    const existing = store.tasks[taskId];

    const task: TaskGraphItem = {
      task_id: taskId,
      project_id: opts.project_id?.trim() || existing?.project_id || "default",
      role: opts.role ?? existing?.role,
      title: opts.title,
      description: opts.description ?? existing?.description ?? "",
      status: opts.status ?? existing?.status ?? "open",
      depends_on: dedupe(opts.depends_on ?? existing?.depends_on ?? []),
      children: dedupe(opts.children ?? existing?.children ?? []),
      execution: existing?.execution,
      execution_policy: opts.execution_policy ?? existing?.execution_policy,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };

    store.tasks[taskId] = task;
    return { task };
  });
}

export async function taskLink(opts: {
  syncDir: string;
  task_id: string;
  depends_on?: string[];
  children?: string[];
}): Promise<{ task: TaskGraphItem }> {
  return withLock(opts.syncDir, async (store) => {
    const task = store.tasks[opts.task_id];
    if (!task) throw new Error(`task not found: ${opts.task_id}`);

    const newDepends = dedupe([...(task.depends_on ?? []), ...(opts.depends_on ?? [])]);
    const newChildren = dedupe([...(task.children ?? []), ...(opts.children ?? [])]);

    for (const id of [...(opts.depends_on ?? []), ...(opts.children ?? [])]) {
      if (!store.tasks[id]) {
        throw new Error(`linked task not found: ${id}`);
      }
    }

    const updated: TaskGraphItem = {
      ...task,
      depends_on: newDepends,
      children: newChildren,
      updated_at: isoNow(),
    };
    store.tasks[opts.task_id] = updated;
    return { task: updated };
  });
}

export async function taskGraph(opts: {
  syncDir: string;
  project_id?: string;
}): Promise<{ project_id: string | null; items: TaskGraphItem[]; counts: Record<string, number> }> {
  const store = await loadStore(opts.syncDir);
  let items = Object.values(store.tasks);
  if (opts.project_id) items = items.filter((t) => t.project_id === opts.project_id);
  items = sortByUpdatedDesc(items);

  const counts = {
    open: items.filter((x) => x.status === "open").length,
    in_progress: items.filter((x) => x.status === "in_progress").length,
    blocked: items.filter((x) => x.status === "blocked").length,
    done: items.filter((x) => x.status === "done").length,
    canceled: items.filter((x) => x.status === "canceled").length,
  };

  return {
    project_id: opts.project_id ?? null,
    items,
    counts,
  };
}

export async function taskPlanGenerate(opts: {
  syncDir: string;
  goal: string;
  project_id?: string;
  max_tasks?: number;
}): Promise<{ project_id: string; created: TaskGraphItem[] }> {
  const projectId = opts.project_id?.trim() || "default";
  const maxTasks = Math.max(1, Math.min(opts.max_tasks ?? 5, 20));

  const goal = opts.goal.trim();
  const seed = goal
    .split(/[.!\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const plannedTitles = seed.length
    ? seed.slice(0, maxTasks).map((s, i) => `${i + 1}. ${s}`)
    : [
        `1. Analyze goal: ${goal}`,
        "2. Design implementation approach",
        "3. Implement core changes",
        "4. Validate and test",
        "5. Finalize and document",
      ].slice(0, maxTasks);

  return withLock(opts.syncDir, async (store) => {
    const created: TaskGraphItem[] = [];
    const now = isoNow();
    let prevId: string | null = null;

    for (const title of plannedTitles) {
      const taskId = randomUUID();
      const task: TaskGraphItem = {
        task_id: taskId,
        project_id: projectId,
        title,
        description: `Auto-generated from goal: ${goal}`,
        status: "open",
        depends_on: prevId ? [prevId] : [],
        children: [],
        created_at: now,
        updated_at: now,
      };
      store.tasks[taskId] = task;
      created.push(task);

      if (prevId) {
        const prev = store.tasks[prevId];
        prev.children = dedupe([...(prev.children ?? []), taskId]);
        prev.updated_at = isoNow();
        store.tasks[prevId] = prev;
      }
      prevId = taskId;
    }

    return { project_id: projectId, created };
  });
}

export async function taskStatusUpdate(opts: {
  syncDir: string;
  task_id: string;
  status: TaskGraphStatus;
}): Promise<{ task: TaskGraphItem }> {
  return withLock(opts.syncDir, async (store) => {
    const task = store.tasks[opts.task_id];
    if (!task) throw new Error(`task not found: ${opts.task_id}`);
    const updated: TaskGraphItem = {
      ...task,
      status: opts.status,
      updated_at: isoNow(),
    };
    store.tasks[opts.task_id] = updated;
    return { task: updated };
  });
}

function normalizeExecutionPolicy(policy?: TaskExecutionPolicy): Required<TaskExecutionPolicy> {
  const maxAttempts = Math.max(1, Math.min(policy?.max_attempts ?? 3, 100));
  const retryDelayMs = Math.max(0, Math.min(policy?.retry_delay_ms ?? 2000, 24 * 60 * 60 * 1000));
  const backoffMultiplier = Math.max(1, Math.min(policy?.backoff_multiplier ?? 1, 10));
  return {
    max_attempts: maxAttempts,
    retry_delay_ms: retryDelayMs,
    backoff_multiplier: backoffMultiplier,
  };
}

function withMs(baseIso: string, deltaMs: number) {
  return new Date(Date.parse(baseIso) + deltaMs).toISOString();
}

export async function orchestratorTick(opts: {
  syncDir: string;
  project_id?: string;
  limit?: number;
}): Promise<{
  project_id: string | null;
  activated: TaskGraphItem[];
  scanned_open: number;
  remaining_open: number;
}> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  return withLock(opts.syncDir, async (store) => {
    const allTasks = Object.values(store.tasks);
    const scoped = opts.project_id
      ? allTasks.filter((t) => t.project_id === opts.project_id)
      : allTasks;

    const openTasks = scoped.filter((t) => t.status === "open");
    const activated: TaskGraphItem[] = [];

    for (const task of openTasks) {
      if (activated.length >= limit) break;
      const nextRetryAt = task.execution?.next_retry_at;
      if (nextRetryAt && Date.parse(nextRetryAt) > Date.now()) continue;
      const deps = task.depends_on ?? [];
      const depsDone = deps.every((depId) => store.tasks[depId]?.status === "done");
      if (!depsDone) continue;

      const updated: TaskGraphItem = {
        ...task,
        status: "in_progress",
        updated_at: isoNow(),
      };
      store.tasks[task.task_id] = updated;
      activated.push(updated);
    }

    const remainingOpen = (opts.project_id
      ? Object.values(store.tasks).filter((t) => t.project_id === opts.project_id)
      : Object.values(store.tasks)
    ).filter((t) => t.status === "open").length;

    return {
      project_id: opts.project_id ?? null,
      activated,
      scanned_open: openTasks.length,
      remaining_open: remainingOpen,
    };
  });
}

export async function taskExecutionMarkQueued(opts: {
  syncDir: string;
  task_id: string;
  command: string;
  job_id: string;
}): Promise<{ task: TaskGraphItem }> {
  return withLock(opts.syncDir, async (store) => {
    const task = store.tasks[opts.task_id];
    if (!task) throw new Error(`task not found: ${opts.task_id}`);
    const updated: TaskGraphItem = {
      ...task,
      execution: {
        mode: "exec",
        command: opts.command,
        job_id: opts.job_id,
        attempts: task.execution?.attempts ?? 0,
        queued_at: isoNow(),
        started_at: task.execution?.started_at,
        finished_at: task.execution?.finished_at,
        exit_code: task.execution?.exit_code,
        last_error: task.execution?.last_error,
        next_retry_at: undefined,
      },
      updated_at: isoNow(),
    };
    store.tasks[opts.task_id] = updated;
    return { task: updated };
  });
}

export async function taskAgentMarkDispatched(opts: {
  syncDir: string;
  task_id: string;
  role: TaskRole;
  profile_id: string;
  job_id: string;
}): Promise<{ task: TaskGraphItem }> {
  return withLock(opts.syncDir, async (store) => {
    const task = store.tasks[opts.task_id];
    if (!task) throw new Error(`task not found: ${opts.task_id}`);
    const now = isoNow();
    const updated: TaskGraphItem = {
      ...task,
      execution: {
        mode: "agent",
        command: `agent:${opts.role}:${opts.profile_id}`,
        job_id: opts.job_id,
        attempts: task.execution?.attempts ?? 0,
        queued_at: now,
        started_at: task.execution?.started_at,
        finished_at: task.execution?.finished_at,
        exit_code: task.execution?.exit_code,
        last_error: task.execution?.last_error,
        next_retry_at: undefined,
      },
      updated_at: now,
    };
    store.tasks[opts.task_id] = updated;
    return { task: updated };
  });
}

export async function taskExecutionMarkFinished(opts: {
  syncDir: string;
  task_id: string;
  exit_code: number;
  error?: string;
}): Promise<{ task: TaskGraphItem }> {
  return withLock(opts.syncDir, async (store) => {
    const task = store.tasks[opts.task_id];
    if (!task) throw new Error(`task not found: ${opts.task_id}`);
    const updated: TaskGraphItem = {
      ...task,
      execution: {
        mode: "exec",
        command: task.execution?.command ?? "",
        job_id: task.execution?.job_id,
        attempts: task.execution?.attempts ?? 0,
        queued_at: task.execution?.queued_at,
        started_at: task.execution?.started_at ?? task.execution?.queued_at,
        finished_at: isoNow(),
        exit_code: opts.exit_code,
        last_error: opts.error,
        next_retry_at: task.execution?.next_retry_at,
      },
      updated_at: isoNow(),
    };
    store.tasks[opts.task_id] = updated;
    return { task: updated };
  });
}

export async function taskExecutionHandleResult(opts: {
  syncDir: string;
  task_id: string;
  exit_code: number;
  error?: string;
}): Promise<{
  task: TaskGraphItem;
  outcome: "done" | "retry" | "blocked";
  attempts: number;
  max_attempts: number;
  next_retry_at?: string;
}> {
  return withLock(opts.syncDir, async (store) => {
    const task = store.tasks[opts.task_id];
    if (!task) throw new Error(`task not found: ${opts.task_id}`);

    const now = isoNow();
    const policy = normalizeExecutionPolicy(task.execution_policy);
    const prevAttempts = task.execution?.attempts ?? 0;
    const attempts = prevAttempts + 1;
    const command = task.execution?.command ?? "";
    const jobId = task.execution?.job_id;
    const queuedAt = task.execution?.queued_at;
    const startedAt = task.execution?.started_at ?? queuedAt ?? now;

    if (opts.exit_code === 0) {
      const updated: TaskGraphItem = {
        ...task,
        status: "done",
        execution: {
          mode: "exec",
          command,
          job_id: jobId,
          attempts,
          queued_at: queuedAt,
          started_at: startedAt,
          finished_at: now,
          exit_code: 0,
          last_error: undefined,
          next_retry_at: undefined,
        },
        updated_at: now,
      };
      store.tasks[opts.task_id] = updated;
      return { task: updated, outcome: "done", attempts, max_attempts: policy.max_attempts };
    }

    const err = opts.error ?? `Process exited with code ${opts.exit_code}`;
    if (attempts < policy.max_attempts) {
      const exponent = Math.max(0, attempts - 1);
      const retryDelay = Math.trunc(policy.retry_delay_ms * Math.pow(policy.backoff_multiplier, exponent));
      const nextRetryAt = withMs(now, retryDelay);
      const updated: TaskGraphItem = {
        ...task,
        status: "open",
        execution: {
          mode: "exec",
          command,
          job_id: undefined,
          attempts,
          queued_at: queuedAt,
          started_at: startedAt,
          finished_at: now,
          exit_code: opts.exit_code,
          last_error: err,
          next_retry_at: nextRetryAt,
        },
        updated_at: now,
      };
      store.tasks[opts.task_id] = updated;
      return {
        task: updated,
        outcome: "retry",
        attempts,
        max_attempts: policy.max_attempts,
        next_retry_at: nextRetryAt,
      };
    }

    const updated: TaskGraphItem = {
      ...task,
      status: "blocked",
      execution: {
        mode: "exec",
        command,
        job_id: jobId,
        attempts,
        queued_at: queuedAt,
        started_at: startedAt,
        finished_at: now,
        exit_code: opts.exit_code,
        last_error: err,
        next_retry_at: undefined,
      },
      updated_at: now,
    };
    store.tasks[opts.task_id] = updated;
    return {
      task: updated,
      outcome: "blocked",
      attempts,
      max_attempts: policy.max_attempts,
    };
  });
}
