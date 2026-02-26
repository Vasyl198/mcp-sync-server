type WorkerResult = {
  status?: string;
  [k: string]: any;
};

type WorkerFn = () => Promise<WorkerResult>;
type QueueDepthFn = () => Promise<number>;

type WorkerOptions = {
  name: string;
  fn: WorkerFn;
  interval_ms: number;
  concurrency: number;
  idle_backoff_ms?: number;
  max_idle_backoff_ms?: number;
  queue_depth_fn?: QueueDepthFn;
  stuck_job_threshold_ms?: number;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type WorkerSample = {
  ts: number;
  latency_ms: number;
  idle: boolean;
  error: boolean;
};

export class Worker {
  private readonly name: string;
  private readonly fn: WorkerFn;
  private readonly intervalMs: number;
  private readonly idleBackoffMs: number;
  private readonly maxIdleBackoffMs: number;
  private readonly queueDepthFn?: QueueDepthFn;
  private readonly stuckJobThresholdMs: number;

  private running = false;
  private desiredConcurrency = 1;
  private throttleMs = 0;
  private loops = new Map<number, Promise<void>>();

  private totalRuns = 0;
  private totalErrors = 0;
  private totalJobsProcessed = 0;
  private lastQueueDepth = 0;
  private lastProgressAt = Date.now();
  private samples: WorkerSample[] = [];
  private jobTimestamps: number[] = [];

  constructor(opts: WorkerOptions) {
    this.name = opts.name;
    this.fn = opts.fn;
    this.intervalMs = Math.max(10, Math.trunc(opts.interval_ms));
    this.desiredConcurrency = Math.max(1, Math.trunc(opts.concurrency));
    this.idleBackoffMs = Math.max(10, Math.trunc(opts.idle_backoff_ms ?? this.intervalMs));
    this.maxIdleBackoffMs = Math.max(this.idleBackoffMs, Math.trunc(opts.max_idle_backoff_ms ?? 5_000));
    this.queueDepthFn = opts.queue_depth_fn;
    this.stuckJobThresholdMs = Math.max(15_000, Math.trunc(opts.stuck_job_threshold_ms ?? 120_000));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.ensureLoopCount();
  }

  async stop() {
    this.running = false;
    await Promise.all(Array.from(this.loops.values()));
    this.loops.clear();
  }

  setConcurrency(next: number) {
    this.desiredConcurrency = Math.max(1, Math.trunc(next));
    if (this.running) this.ensureLoopCount();
  }

  getConcurrency() {
    return this.desiredConcurrency;
  }

  setThrottleMs(next: number) {
    this.throttleMs = Math.max(0, Math.trunc(next));
  }

  getThrottleMs() {
    return this.throttleMs;
  }

  private ensureLoopCount() {
    for (let i = 0; i < this.desiredConcurrency; i += 1) {
      if (this.loops.has(i)) continue;
      const p = this.runSlot(i).finally(() => {
        this.loops.delete(i);
      });
      this.loops.set(i, p);
    }
  }

  private pruneNow(now: number) {
    const minTs = now - 60_000;
    this.samples = this.samples.filter((s) => s.ts >= minTs);
    this.jobTimestamps = this.jobTimestamps.filter((ts) => ts >= minTs);
  }

  private async runSlot(slotIndex: number) {
    let idleBackoff = this.idleBackoffMs;

    while (this.running && slotIndex < this.desiredConcurrency) {
      const startedAt = Date.now();
      let idle = false;
      let errored = false;
      let processed = false;

      try {
        if (this.queueDepthFn) {
          this.lastQueueDepth = await this.queueDepthFn();
        }

        const result = await this.fn();
        const status = String(result?.status ?? "").toLowerCase();
        idle = status === "idle";
        processed = status === "done";
      } catch {
        errored = true;
      }

      const latency = Date.now() - startedAt;
      this.totalRuns += 1;
      if (errored) this.totalErrors += 1;
      if (processed) {
        this.totalJobsProcessed += 1;
        const now = Date.now();
        this.jobTimestamps.push(now);
        this.lastProgressAt = now;
      }
      this.samples.push({
        ts: Date.now(),
        latency_ms: latency,
        idle,
        error: errored,
      });
      this.pruneNow(Date.now());

      if (idle) {
        idleBackoff = Math.min(this.maxIdleBackoffMs, Math.max(this.idleBackoffMs, idleBackoff * 2));
      } else {
        idleBackoff = this.idleBackoffMs;
      }

      const delay = idle ? (idleBackoff + this.throttleMs) : (this.intervalMs + this.throttleMs);
      await sleep(delay);
    }
  }

  metrics() {
    const now = Date.now();
    this.pruneNow(now);
    const samples = this.samples;
    const windowCount = samples.length;
    const idleCount = samples.filter((s) => s.idle).length;
    const errorCount = samples.filter((s) => s.error).length;
    const latencyAvg = windowCount
      ? samples.reduce((acc, s) => acc + s.latency_ms, 0) / windowCount
      : 0;
    const errorRate = windowCount ? (errorCount / windowCount) : 0;
    const stuck = this.running && this.lastQueueDepth > 0 && (now - this.lastProgressAt) > this.stuckJobThresholdMs;
    return {
      name: this.name,
      running: this.running,
      target_concurrency: this.desiredConcurrency,
      throttle_ms: this.throttleMs,
      active_loops: this.loops.size,
      jobs_processed_per_min: this.jobTimestamps.length,
      avg_latency_ms: Number(latencyAvg.toFixed(3)),
      avg_exec_latency_ms: Number(latencyAvg.toFixed(3)),
      idle_ratio: windowCount ? Number((idleCount / windowCount).toFixed(4)) : 1,
      worker_error_rate: Number(errorRate.toFixed(4)),
      queue_depth: this.lastQueueDepth,
      stuck_job_detection: {
        is_stuck: stuck,
        no_progress_ms: Math.max(0, now - this.lastProgressAt),
        threshold_ms: this.stuckJobThresholdMs,
      },
      totals: {
        runs: this.totalRuns,
        errors: this.totalErrors,
        jobs_processed: this.totalJobsProcessed,
      },
    };
  }
}

export class WorkerManager {
  private workers = new Map<string, Worker>();
  private started = false;

  addWorker(worker: Worker) {
    this.workers.set((worker.metrics().name), worker);
  }

  getWorker(name: string) {
    return this.workers.get(name);
  }

  startAll() {
    if (this.started) return;
    this.started = true;
    for (const worker of this.workers.values()) {
      worker.start();
    }
  }

  async stopAll() {
    this.started = false;
    await Promise.all(Array.from(this.workers.values()).map((w) => w.stop()));
  }

  metrics() {
    const items = Array.from(this.workers.values()).map((w) => w.metrics());
    return {
      started: this.started,
      workers: items,
    };
  }
}
