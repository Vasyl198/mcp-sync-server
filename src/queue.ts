import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireLock, releaseLock } from "./locks.js";

export type JobType = "exec" | "project_task" | "custom";

export type QueueJob = {
  job_id: string;
  type: JobType;
  payload: any;
  created_at: string; // ISO
  source: string;
  priority: number;
};

type Claim = {
  job_id: string;
  claimed_by: string;
  lease_token: string;
  lease_until: string; // ISO
  claimed_at: string; // ISO
};

type Ack = {
  job_id: string;
  lease_token: string;
  status: "done" | "error" | "canceled";
  acked_at: string; // ISO
  result_ref: string;
};

export type QueuePaths = {
  baseDir: string;
  jobsPath: string;
  claimsPath: string;
  acksPath: string;
  locksDir: string;
  runsDir: string;
};

function isoNow() {
  return new Date().toISOString();
}

async function ensureFile(p: string) {
  try {
    await fs.stat(p);
  } catch {
    await fs.writeFile(p, "", "utf8");
  }
}

export async function ensureQueueLayout(syncDir: string): Promise<QueuePaths> {
  const baseDir = path.join(syncDir, "queue");
  const locksDir = path.join(baseDir, "locks");
  const runsDir = path.join(baseDir, "runs");

  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(locksDir, { recursive: true });
  await fs.mkdir(runsDir, { recursive: true });

  const jobsPath = path.join(baseDir, "jobs.jsonl");
  const claimsPath = path.join(baseDir, "claims.jsonl");
  const acksPath = path.join(baseDir, "acks.jsonl");

  await ensureFile(jobsPath);
  await ensureFile(claimsPath);
  await ensureFile(acksPath);

  return { baseDir, jobsPath, claimsPath, acksPath, locksDir, runsDir };
}

async function appendJsonl(filePath: string, obj: any) {
  const line = JSON.stringify(obj) + "\n";
  await fs.appendFile(filePath, line, "utf8");
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const out: T[] = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line) as T); } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

function pickNextJob(jobs: QueueJob[], activeClaims: Map<string, Claim>, acked: Set<string>) {
  const candidates = jobs.filter(j => !acked.has(j.job_id) && !activeClaims.has(j.job_id));
  candidates.sort((a, b) => {
    // higher priority first, then older first
    if (b.priority !== a.priority) return b.priority - a.priority;
    return Date.parse(a.created_at) - Date.parse(b.created_at);
  });
  return candidates[0] ?? null;
}

function buildActiveClaims(claims: Claim[]): Map<string, Claim> {
  const latest = new Map<string, Claim>();
  for (const c of claims) {
    const prev = latest.get(c.job_id);
    if (!prev || Date.parse(c.claimed_at) > Date.parse(prev.claimed_at)) {
      latest.set(c.job_id, c);
    }
  }
  const active = new Map<string, Claim>();
  for (const [jobId, c] of latest.entries()) {
    if (Date.parse(c.lease_until) > Date.now()) {
      active.set(jobId, c);
    }
  }
  return active;
}

function buildAckedSet(acks: Ack[]): Set<string> {
  const s = new Set<string>();
  for (const a of acks) s.add(a.job_id);
  return s;
}

export async function queuePush(opts: {
  syncDir: string;
  type: JobType;
  payload: any;
  priority?: number;
  job_id?: string;
  source?: string;
}): Promise<{ job_id: string }> {
  const paths = await ensureQueueLayout(opts.syncDir);

  const job: QueueJob = {
    job_id: opts.job_id ?? randomUUID(),
    type: opts.type,
    payload: opts.payload,
    created_at: isoNow(),
    source: opts.source ?? "chatgpt",
    priority: opts.priority ?? 0,
  };

  await appendJsonl(paths.jobsPath, job);
  return { job_id: job.job_id };
}

export async function queuePop(opts: {
  syncDir: string;
  worker?: string;
  max_lease_ms?: number;
}): Promise<{ job?: QueueJob; lease_token?: string; lease_until?: string }> {
  const paths = await ensureQueueLayout(opts.syncDir);
  const worker = opts.worker ?? "windsurf-router";
  const leaseMs = Math.max(1000, opts.max_lease_ms ?? 60_000);

  const lock = await acquireLock({ locksDir: paths.locksDir, name: "queue", ttl_ms: 15_000 });
  if (!lock.ok || !lock.token) return {};

  try {
    const jobs = await readJsonl<QueueJob>(paths.jobsPath);
    const claims = await readJsonl<Claim>(paths.claimsPath);
    const acks = await readJsonl<Ack>(paths.acksPath);

    const activeClaims = buildActiveClaims(claims);
    const acked = buildAckedSet(acks);

    const next = pickNextJob(jobs, activeClaims, acked);
    if (!next) return {};

    const leaseToken = randomUUID();
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();

    const claim: Claim = {
      job_id: next.job_id,
      claimed_by: worker,
      lease_token: leaseToken,
      lease_until: leaseUntil,
      claimed_at: isoNow(),
    };

    await appendJsonl(paths.claimsPath, claim);

    return { job: next, lease_token: leaseToken, lease_until: leaseUntil };
  } finally {
    await releaseLock({ locksDir: paths.locksDir, name: "queue", token: lock.token });
  }
}

export async function queueAck(opts: {
  syncDir: string;
  job_id: string;
  lease_token: string;
  status: "done" | "error" | "canceled";
  result?: any;
  report_md?: string;
  logs?: string;
}): Promise<{ ok: boolean; already_acked?: boolean; result_ref?: string }> {
  const paths = await ensureQueueLayout(opts.syncDir);

  const lock = await acquireLock({ locksDir: paths.locksDir, name: "queue", ttl_ms: 15_000 });
  if (!lock.ok || !lock.token) return { ok: false };

  try {
    const acks = await readJsonl<Ack>(paths.acksPath);
    if (acks.some(a => a.job_id === opts.job_id)) {
      return { ok: true, already_acked: true };
    }

    // Write run artifacts
    const runDir = path.join(paths.runsDir, opts.job_id);
    await fs.mkdir(runDir, { recursive: true });

    const reportPath = path.join(runDir, "report.md");
    const logsPath = path.join(runDir, "logs.txt");
    const resultPath = path.join(runDir, "result.json");

    if (opts.report_md != null) await fs.writeFile(reportPath, opts.report_md, "utf8");
    if (opts.logs != null) await fs.writeFile(logsPath, opts.logs, "utf8");
    await fs.writeFile(resultPath, JSON.stringify(opts.result ?? {}, null, 2), "utf8");

    const resultRef = path.relative(opts.syncDir, resultPath).replace(/\\/g, "/");

    const ack: Ack = {
      job_id: opts.job_id,
      lease_token: opts.lease_token,
      status: opts.status,
      acked_at: isoNow(),
      result_ref: resultRef,
    };

    await appendJsonl(paths.acksPath, ack);

    return { ok: true, result_ref: resultRef };
  } finally {
    await releaseLock({ locksDir: paths.locksDir, name: "queue", token: lock.token });
  }
}

export async function jobHistoryList(opts: {
  syncDir: string;
  limit?: number;
  status?: "pending" | "running" | "done" | "error" | "canceled";
}): Promise<{ items: any[] }> {
  const paths = await ensureQueueLayout(opts.syncDir);

  const jobs = await readJsonl<QueueJob>(paths.jobsPath);
  const claims = await readJsonl<Claim>(paths.claimsPath);
  const acks = await readJsonl<Ack>(paths.acksPath);

  const activeClaims = buildActiveClaims(claims);
  const ackById = new Map<string, Ack>();
  for (const a of acks) ackById.set(a.job_id, a);

  const items = jobs
    .slice()
    .reverse()
    .map(j => {
      const ack = ackById.get(j.job_id);
      const claim = activeClaims.get(j.job_id);

      let st: string = "pending";
      if (ack) st = ack.status;
      else if (claim) st = "running";

      return {
        job_id: j.job_id,
        type: j.type,
        created_at: j.created_at,
        priority: j.priority,
        source: j.source,
        status: st,
        lease_until: claim?.lease_until ?? null,
        result_ref: ack?.result_ref ?? null,
      };
    });

  const filtered = opts.status ? items.filter(i => i.status === opts.status) : items;
  return { items: filtered.slice(0, opts.limit ?? 50) };
}
