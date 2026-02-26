import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireLock, releaseLock } from "./locks.js";
import {
  AdaptiveStrategyProfile,
  DomainSizeCategory,
  normalizeAdaptiveProfile
} from "./agent/registry.js";
import { computeDomainSignature, researchMemoryFindSimilar } from "./agent/research_memory.js";

export type ExperimentStatus = "draft" | "running" | "completed" | "archived";
export type RunStatus = "pending" | "running" | "completed" | "failed";
export type SearchStrategy = "grid" | "random" | "adaptive";
export type ObjectiveMode = "maximize" | "minimize";
export type ExperimentObjective = {
  metric: string;
  mode: ObjectiveMode;
};
export type ExperimentMetricSchema = Record<string, Record<string, any>>;

export type ExperimentRecord = {
  experiment_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  status: ExperimentStatus;
  best_run_id: string | null;
  objective: ExperimentObjective;
  metric_schema?: ExperimentMetricSchema;
  search_strategy: SearchStrategy;
  search_space: Record<string, any[]>;
  metadata?: Record<string, any>;
};

export type ExperimentRunRecord = {
  run_id: string;
  experiment_id: string;
  created_at: string;
  updated_at: string;
  params: Record<string, any>;
  metrics: Record<string, number>;
  status: RunStatus;
  duration_ms: number | null;
  score: number | null;
  task_id?: string | null;
  notes?: string;
};

export type MetricExtractionResult = {
  metrics: Record<string, number>;
  warnings: string[];
};

export type ExperimentResearchMetrics = {
  experiment_id: string;
  search_strategy: SearchStrategy;
  domain_profile: DomainProfile;
  domain_complexity_factor: number;
  transfer_context: {
    transfer_initialized: boolean;
    domain_signature?: string;
    strategy_id?: string;
    strategy_version_id?: string;
    transfer_confidence?: number;
  };
  converged: boolean;
  total_runs: number;
  completed_runs: number;
  improvement_delta: number;
  convergence_steps: number;
  exploration_efficiency: number;
  variance_stability: number;
  best_score_trend: number;
  stagnation_rate: number;
  best_score_initial: number | null;
  best_score_final: number | null;
};

export type DomainProfile = {
  size_category: DomainSizeCategory;
  metric_noise: "low" | "medium" | "high";
  search_complexity: "low" | "high";
  param_count: number;
};

type ExperimentsStore = {
  version: 1;
  updated_at: string;
  experiments: Record<string, ExperimentRecord>;
};

type AdaptiveConfig = {
  bootstrap_min: number;
  neighborhood_size: number;
  narrowing_factor: number;
  convergence_min_completed: number;
  convergence_patience: number;
  improvement_threshold: number;
  variance_threshold: number;
  exploration_bias: number;
  variance_sensitivity: number;
};

const VALID_SEARCH_STRATEGIES = new Set<SearchStrategy>(["grid", "random", "adaptive"]);
const DEFAULT_ADAPTIVE_CONFIG: AdaptiveConfig = {
  bootstrap_min: 5,
  neighborhood_size: 5,
  narrowing_factor: 1,
  convergence_min_completed: 8,
  convergence_patience: 4,
  improvement_threshold: 0.0005,
  variance_threshold: 0.0005,
  exploration_bias: 0.5,
  variance_sensitivity: 0.5,
};

function isoNow() {
  return new Date().toISOString();
}

function experimentsDir(syncDir: string) {
  return path.join(syncDir, "experiments");
}

function runsDir(syncDir: string) {
  return path.join(experimentsDir(syncDir), "runs");
}

function experimentsFile(syncDir: string) {
  return path.join(experimentsDir(syncDir), "experiments.json");
}

function metricsFile(syncDir: string) {
  return path.join(experimentsDir(syncDir), "metrics.jsonl");
}

function runFile(syncDir: string, experimentId: string) {
  return path.join(runsDir(syncDir), `${experimentId}.json`);
}

function lockDir(syncDir: string) {
  return path.join(syncDir, "queue", "locks");
}

async function ensureTextFile(p: string, init = "") {
  try {
    await fs.stat(p);
  } catch {
    await fs.writeFile(p, init, "utf8");
  }
}

async function ensureLayout(syncDir: string) {
  await fs.mkdir(experimentsDir(syncDir), { recursive: true });
  await fs.mkdir(runsDir(syncDir), { recursive: true });
  await ensureTextFile(
    experimentsFile(syncDir),
    JSON.stringify({ version: 1, updated_at: isoNow(), experiments: {} }, null, 2)
  );
  await ensureTextFile(metricsFile(syncDir), "");
}

async function withLock<T>(syncDir: string, fn: () => Promise<T>): Promise<T> {
  await ensureLayout(syncDir);
  const lock = await acquireLock({
    locksDir: lockDir(syncDir),
    name: "experiments",
    ttl_ms: 10_000,
  });
  if (!lock.ok || !lock.token) throw new Error("experiments lock busy");
  try {
    return await fn();
  } finally {
    await releaseLock({
      locksDir: lockDir(syncDir),
      name: "experiments",
      token: lock.token,
    });
  }
}

async function loadStore(syncDir: string): Promise<ExperimentsStore> {
  await ensureLayout(syncDir);
  const raw = await fs.readFile(experimentsFile(syncDir), "utf8");
  const parsed = JSON.parse(raw) as Partial<ExperimentsStore>;
  return {
    version: 1,
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : isoNow(),
    experiments: parsed.experiments ?? {},
  };
}

async function saveStore(syncDir: string, store: ExperimentsStore) {
  store.updated_at = isoNow();
  const p = experimentsFile(syncDir);
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, p);
}

async function loadRuns(syncDir: string, experimentId: string): Promise<ExperimentRunRecord[]> {
  await ensureLayout(syncDir);
  const p = runFile(syncDir, experimentId);
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as ExperimentRunRecord[] : [];
  } catch {
    return [];
  }
}

async function saveRuns(syncDir: string, experimentId: string, runs: ExperimentRunRecord[]) {
  const p = runFile(syncDir, experimentId);
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(runs, null, 2), "utf8");
  await fs.rename(tmp, p);
}

async function appendMetricLine(syncDir: string, run: ExperimentRunRecord) {
  const line = JSON.stringify({
    ts: isoNow(),
    experiment_id: run.experiment_id,
    run_id: run.run_id,
    status: run.status,
    params: run.params,
    metrics: run.metrics,
    score: run.score,
    duration_ms: run.duration_ms,
  });
  await fs.appendFile(metricsFile(syncDir), `${line}\n`, "utf8");
}

function parseLegacyObjectiveString(objective: string): ExperimentObjective | null {
  const raw = objective.trim();
  if (!raw) return { mode: "maximize", metric: "score" };
  const lowered = raw.toLowerCase();
  if (lowered === "score" || lowered === "max score" || lowered === "maximize score") {
    return { mode: "maximize", metric: "score" };
  }
  if (lowered === "min score" || lowered === "minimize score") {
    return { mode: "minimize", metric: "score" };
  }
  const match = raw.match(/^(maximize|minimize)\s+([a-zA-Z0-9_.-]+)$/i);
  if (!match) return null;
  return {
    mode: match[1].toLowerCase() as ObjectiveMode,
    metric: match[2],
  };
}

function normalizeObjective(objective: string | ExperimentObjective): ExperimentObjective {
  if (typeof objective === "string") {
    const parsed = parseLegacyObjectiveString(objective);
    if (!parsed) {
      throw new Error('invalid objective string; use "maximize <metric>" or "minimize <metric>" (example: "maximize score")');
    }
    return parsed;
  }

  if (!objective || typeof objective !== "object" || Array.isArray(objective)) {
    throw new Error('objective must be a string or object: { metric, mode }');
  }

  const metric = typeof objective.metric === "string" ? objective.metric.trim() : "score";
  if (!metric) throw new Error("objective.metric is required");
  if (!/^[a-zA-Z0-9_.-]+$/.test(metric)) {
    throw new Error("objective.metric contains invalid characters");
  }

  const modeRaw = typeof objective.mode === "string" ? objective.mode.trim().toLowerCase() : "";
  if (modeRaw !== "maximize" && modeRaw !== "minimize") {
    throw new Error('objective.mode must be "maximize" or "minimize"');
  }

  return { metric, mode: modeRaw };
}

function resolveObjective(objective: ExperimentObjective | string | undefined): ExperimentObjective | null {
  if (objective == null) return null;
  try {
    return normalizeObjective(objective);
  } catch {
    return null;
  }
}

function validateObjectiveInMetricSchema(objective: ExperimentObjective, metricSchema?: ExperimentMetricSchema) {
  if (!metricSchema) return;
  const metricKeys = Object.keys(metricSchema);
  if (metricKeys.length === 0) return;
  if (!Object.prototype.hasOwnProperty.call(metricSchema, objective.metric)) {
    throw new Error(`objective.metric "${objective.metric}" is not present in metric_schema`);
  }
}

function computeScore(objectiveInput: ExperimentObjective | string, metrics: Record<string, number>): number | null {
  const objective = resolveObjective(objectiveInput);
  if (!objective) return null;
  const value = metrics[objective.metric];
  if (!Number.isFinite(value)) return null;
  return objective.mode === "maximize" ? value : -value;
}

function sortRunsByScoreDesc(runs: ExperimentRunRecord[]) {
  return runs
    .filter((r) => r.status === "completed" && Number.isFinite(r.score))
    .sort((a, b) => Number((b.score ?? -Infinity) - (a.score ?? -Infinity)));
}

function variance(values: number[]) {
  if (values.length === 0) return 0;
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  const sumSq = values.reduce((acc, v) => acc + ((v - mean) ** 2), 0);
  return sumSq / values.length;
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function canonicalizeParams(params: Record<string, any>): string {
  const keys = Object.keys(params).sort();
  const normalized: Record<string, any> = {};
  for (const k of keys) normalized[k] = params[k];
  return JSON.stringify(normalized);
}

function sampleRandom<T>(arr: T[]) {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

function normalizeSearchStrategy(input: unknown, fallback: SearchStrategy = "grid"): SearchStrategy {
  if (typeof input !== "string") return fallback;
  const normalized = input.trim().toLowerCase();
  return VALID_SEARCH_STRATEGIES.has(normalized as SearchStrategy) ? normalized as SearchStrategy : fallback;
}

function parsePositiveInt(input: unknown, fallback: number, min: number, max: number): number {
  const n = typeof input === "number" ? Math.trunc(input) : Number.parseInt(String(input), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parsePositiveFloat(input: unknown, fallback: number, min: number, max: number): number {
  const n = typeof input === "number" ? input : Number.parseFloat(String(input));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function getAdaptiveConfig(metadata?: Record<string, any>, adaptiveProfile?: AdaptiveStrategyProfile): AdaptiveConfig {
  const raw = (metadata && typeof metadata.adaptive === "object" && metadata.adaptive)
    ? metadata.adaptive as Record<string, any>
    : {};
  const profile = adaptiveProfile ? normalizeAdaptiveProfile(adaptiveProfile) : undefined;
  const narrowingFactor = parsePositiveFloat(
    profile?.narrowing_factor ?? raw.narrowing_factor,
    DEFAULT_ADAPTIVE_CONFIG.narrowing_factor,
    0.5,
    1.5
  );
  const varianceSensitivity = parsePositiveFloat(
    profile?.variance_sensitivity ?? raw.variance_sensitivity,
    DEFAULT_ADAPTIVE_CONFIG.variance_sensitivity,
    0.01,
    0.5
  );
  const baseVarianceThreshold = parsePositiveFloat(
    raw.variance_threshold,
    DEFAULT_ADAPTIVE_CONFIG.variance_threshold,
    0,
    1000
  );
  return {
    bootstrap_min: parsePositiveInt(
      profile?.bootstrap_min ?? raw.bootstrap_min,
      DEFAULT_ADAPTIVE_CONFIG.bootstrap_min,
      1,
      10
    ),
    neighborhood_size: parsePositiveInt(raw.neighborhood_size, DEFAULT_ADAPTIVE_CONFIG.neighborhood_size, 2, 25),
    narrowing_factor: narrowingFactor,
    convergence_min_completed: parsePositiveInt(
      raw.convergence_min_completed,
      DEFAULT_ADAPTIVE_CONFIG.convergence_min_completed,
      3,
      500
    ),
    convergence_patience: parsePositiveInt(
      profile?.patience ?? raw.convergence_patience,
      DEFAULT_ADAPTIVE_CONFIG.convergence_patience,
      1,
      10
    ),
    improvement_threshold: parsePositiveFloat(
      profile?.improvement_threshold ?? raw.improvement_threshold,
      DEFAULT_ADAPTIVE_CONFIG.improvement_threshold,
      0,
      1000
    ),
    variance_threshold: parsePositiveFloat(
      baseVarianceThreshold / varianceSensitivity,
      DEFAULT_ADAPTIVE_CONFIG.variance_threshold,
      0,
      1000
    ),
    exploration_bias: parsePositiveFloat(
      profile?.exploration_bias ?? raw.exploration_bias,
      DEFAULT_ADAPTIVE_CONFIG.exploration_bias,
      0,
      1
    ),
    variance_sensitivity: varianceSensitivity,
  };
}

function estimateCombinationCount(searchSpace: Record<string, any[]>): number {
  const keys = Object.keys(searchSpace);
  if (keys.length === 0) return 0;
  let total = 1;
  for (const key of keys) {
    const values = Array.isArray(searchSpace[key]) ? searchSpace[key] : [];
    total *= values.length;
    if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  }
  return total;
}

function inferDomainProfile(input: {
  search_space: Record<string, any[]>;
  completed_scores?: number[];
  convergence_steps?: number;
  variance_stability?: number;
}): { profile: DomainProfile; complexity_factor: number } {
  const keys = Object.keys(input.search_space ?? {});
  const paramCount = keys.length;
  const comboCount = estimateCombinationCount(input.search_space ?? {});
  let sizeCategory: DomainSizeCategory = "medium";
  if ((comboCount > 0 && comboCount <= 64 && paramCount <= 2) || (comboCount > 0 && comboCount <= 100)) {
    sizeCategory = "small";
  } else if (comboCount > 2000 || paramCount >= 8) {
    sizeCategory = "large";
  }

  let metricNoise: DomainProfile["metric_noise"] = "medium";
  const scores = Array.isArray(input.completed_scores) ? input.completed_scores.filter((v) => Number.isFinite(v)) : [];
  if (scores.length >= 3) {
    const meanAbs = Math.max(1e-9, scores.reduce((acc, v) => acc + Math.abs(v), 0) / scores.length);
    const scoreStd = stdDev(scores);
    const cv = scoreStd / meanAbs;
    if (cv <= 0.05) metricNoise = "low";
    else if (cv > 0.2) metricNoise = "high";
  }
  if (typeof input.variance_stability === "number" && Number.isFinite(input.variance_stability)) {
    if (input.variance_stability >= 0.85) metricNoise = "low";
    else if (input.variance_stability < 0.6) metricNoise = "high";
  }

  let searchComplexity: DomainProfile["search_complexity"] = "low";
  if (paramCount >= 5 || comboCount > 500) searchComplexity = "high";
  const convergenceSteps = Number(input.convergence_steps ?? 0);
  if (Number.isFinite(convergenceSteps) && convergenceSteps > Math.max(8, paramCount * 3)) {
    searchComplexity = "high";
  }

  const sizeFactor = sizeCategory === "small" ? 0.9 : (sizeCategory === "large" ? 1.15 : 1);
  const noiseFactor = metricNoise === "low" ? 0.95 : (metricNoise === "high" ? 1.15 : 1);
  const searchFactor = searchComplexity === "high" ? 1.1 : 0.95;
  const dimensionalityFactor = 1 + Math.min(0.2, paramCount * 0.02);
  const complexityFactor = Number(Math.max(0.75, Math.min(1.75, sizeFactor * noiseFactor * searchFactor * dimensionalityFactor)).toFixed(6));

  return {
    profile: {
      size_category: sizeCategory,
      metric_noise: metricNoise,
      search_complexity: searchComplexity,
      param_count: paramCount,
    },
    complexity_factor: complexityFactor,
  };
}

function isDomainProfile(value: unknown): value is DomainProfile {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, any>;
  const sizeOk = p.size_category === "small" || p.size_category === "medium" || p.size_category === "large";
  const noiseOk = p.metric_noise === "low" || p.metric_noise === "medium" || p.metric_noise === "high";
  const complexityOk = p.search_complexity === "low" || p.search_complexity === "high";
  const paramOk = Number.isFinite(Number(p.param_count)) && Number(p.param_count) > 0;
  return sizeOk && noiseOk && complexityOk && paramOk;
}

function computeDomainComplexityFactor(profileInput: DomainProfile): number {
  const profile = {
    ...profileInput,
    param_count: Math.max(1, Math.trunc(Number(profileInput.param_count) || 1)),
  };
  const sizeFactor = profile.size_category === "small" ? 0.9 : (profile.size_category === "large" ? 1.15 : 1);
  const noiseFactor = profile.metric_noise === "low" ? 0.95 : (profile.metric_noise === "high" ? 1.15 : 1);
  const searchFactor = profile.search_complexity === "high" ? 1.1 : 0.95;
  const dimensionalityFactor = 1 + Math.min(0.2, profile.param_count * 0.02);
  return Number(Math.max(0.75, Math.min(1.75, sizeFactor * noiseFactor * searchFactor * dimensionalityFactor)).toFixed(6));
}

function resolveEffectiveDomainContext(input: {
  metadata?: Record<string, any>;
  inferred: { profile: DomainProfile; complexity_factor: number };
}) {
  const normalized = normalizeDomainMetadata((input.metadata && typeof input.metadata === "object") ? input.metadata : {});
  const useNormalized = isDomainProfile(normalized.domain_profile);
  const profile = useNormalized
    ? normalized.domain_profile as DomainProfile
    : input.inferred.profile;
  const complexity_factor = useNormalized
    ? computeDomainComplexityFactor(profile)
    : input.inferred.complexity_factor;
  return {
    profile,
    complexity_factor,
    metadata: normalized,
  };
}

function injectDomainMetadata(
  metadata: Record<string, any> | undefined,
  profile: DomainProfile,
  complexityFactor: number
): Record<string, any> {
  return normalizeDomainMetadata({
    ...(metadata ?? {}),
    domain_profile: profile,
    domain_complexity_factor: complexityFactor,
  });
}

function domainProfileFromSignature(sig: string): DomainProfile | null {
  const normalized = String(sig ?? "").trim();
  if (!normalized) return null;
  const parts = normalized.split("|").map((x) => x.trim());
  if (parts.length !== 4) return null;
  const [sizeRaw, complexityRaw, noiseRaw, bucketRaw] = parts;

  const size_category = (sizeRaw === "small" || sizeRaw === "medium" || sizeRaw === "large")
    ? sizeRaw as DomainSizeCategory
    : null;
  const search_complexity = (complexityRaw === "low" || complexityRaw === "high")
    ? complexityRaw as DomainProfile["search_complexity"]
    : null;
  const metric_noise = (noiseRaw === "low" || noiseRaw === "medium" || noiseRaw === "high")
    ? noiseRaw as DomainProfile["metric_noise"]
    : null;
  if (!size_category || !search_complexity || !metric_noise) return null;

  let param_count: number;
  if (bucketRaw === "p2") param_count = 2;
  else if (bucketRaw === "p5") param_count = 5;
  else if (bucketRaw === "p8") param_count = 8;
  else if (bucketRaw === "p9p") param_count = 9;
  else return null;

  return {
    size_category,
    metric_noise,
    search_complexity,
    param_count,
  };
}

function normalizeDomainMetadata(metadata: Record<string, any>): Record<string, any> {
  const meta = { ...(metadata ?? {}) };
  const sig = typeof meta.domain_signature === "string" ? meta.domain_signature.trim() : "";
  const profileRaw = (meta.domain_profile && typeof meta.domain_profile === "object")
    ? meta.domain_profile
    : null;

  // If signature is present, it is the source of truth for constrained campaigns.
  if (sig) {
    const fromSig = domainProfileFromSignature(sig);
    if (fromSig) {
      meta.domain_profile = fromSig;
      meta.domain_signature = computeDomainSignature(fromSig);
      return meta;
    }
  }

  // Fallback: derive signature from existing profile.
  if (profileRaw) {
    meta.domain_signature = computeDomainSignature(profileRaw as DomainProfile);
  }

  return meta;
}

function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + ((v - mean) * (v - mean)), 0) / values.length;
  return Math.sqrt(variance);
}

function dedupeValues(values: any[]): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function valueEquals(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function narrowValuesAroundBest(valuesRaw: any[], bestValue: any, neighborhoodSize: number): any[] {
  const values = dedupeValues(valuesRaw);
  if (values.length <= neighborhoodSize) return values;
  const hasBest = values.some((v) => valueEquals(v, bestValue));
  if (!hasBest) return values.slice(0, neighborhoodSize);

  const numeric = values.every((v) => typeof v === "number" && Number.isFinite(v)) && typeof bestValue === "number";
  if (!numeric) {
    const narrowed = [bestValue];
    for (const v of values) {
      if (narrowed.length >= neighborhoodSize) break;
      if (valueEquals(v, bestValue)) continue;
      narrowed.push(v);
    }
    return narrowed;
  }

  const sorted = [...values].sort((a, b) => Number(a) - Number(b));
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const dist = Math.abs(Number(sorted[i]) - Number(bestValue));
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  const narrowed = [sorted[bestIdx]];
  let left = bestIdx - 1;
  let right = bestIdx + 1;
  while (narrowed.length < neighborhoodSize && (left >= 0 || right < sorted.length)) {
    if (left >= 0) narrowed.push(sorted[left--]);
    if (narrowed.length >= neighborhoodSize) break;
    if (right < sorted.length) narrowed.push(sorted[right++]);
  }
  return narrowed;
}

function shrinkSearchSpaceAroundBest(
  searchSpace: Record<string, any[]>,
  bestParams: Record<string, any>,
  neighborhoodSize: number
): Record<string, any[]> {
  const narrowed: Record<string, any[]> = {};
  for (const key of Object.keys(searchSpace)) {
    const values = Array.isArray(searchSpace[key]) ? searchSpace[key] : [];
    if (values.length === 0) continue;
    narrowed[key] = narrowValuesAroundBest(values, bestParams[key], neighborhoodSize);
  }
  return narrowed;
}

function detectConvergence(
  runs: ExperimentRunRecord[],
  cfg: AdaptiveConfig
): { converged: boolean; reason: string | null } {
  const completed = runs
    .filter((r) => r.status === "completed" && Number.isFinite(r.score))
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
  if (completed.length < cfg.convergence_min_completed) return { converged: false, reason: null };

  const scores = completed.map((r) => Number(r.score ?? -Infinity));
  const bestProgress: number[] = [];
  let currentBest = -Infinity;
  for (const score of scores) {
    if (score > currentBest) currentBest = score;
    bestProgress.push(currentBest);
  }

  if (bestProgress.length <= cfg.convergence_patience) return { converged: false, reason: null };
  const end = bestProgress.length - 1;
  const start = end - cfg.convergence_patience;
  const improvement = bestProgress[end] - bestProgress[start];
  if (improvement > cfg.improvement_threshold) return { converged: false, reason: null };

  const recentScores = scores.slice(-cfg.convergence_patience);
  const recentVariance = stdDev(recentScores);
  if (recentVariance > cfg.variance_threshold) return { converged: false, reason: null };
  return { converged: true, reason: "adaptive_convergence" };
}

export async function experimentComputeResearchMetrics(opts: {
  syncDir: string;
  experiment_id: string;
  variance_window?: number;
}) {
  await ensureLayout(opts.syncDir);
  const store = await loadStore(opts.syncDir);
  const experiment = store.experiments[opts.experiment_id];
  if (!experiment) throw new Error(`experiment not found: ${opts.experiment_id}`);

  const runs = await loadRuns(opts.syncDir, opts.experiment_id);
  const completedChronological = runs
    .filter((r) => r.status === "completed" && Number.isFinite(r.score))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const totalRuns = runs.length;
  const completedRuns = completedChronological.length;
  const strategy = normalizeSearchStrategy(experiment.search_strategy, "grid");
  const adaptiveCfg = getAdaptiveConfig(experiment.metadata);
  const convergence = strategy === "adaptive"
    ? detectConvergence(runs, adaptiveCfg)
    : { converged: experiment.status === "completed", reason: null as string | null };
  const transferSource = (experiment.metadata?.transfer_source && typeof experiment.metadata.transfer_source === "object")
    ? experiment.metadata.transfer_source as Record<string, any>
    : {};

  if (completedRuns === 0) {
    const inferredDomain = inferDomainProfile({
      search_space: experiment.search_space,
      completed_scores: [],
      convergence_steps: 0,
      variance_stability: 1,
    });
    const domain = resolveEffectiveDomainContext({
      metadata: experiment.metadata,
      inferred: inferredDomain,
    });
    const empty: ExperimentResearchMetrics = {
      experiment_id: opts.experiment_id,
      search_strategy: strategy,
      domain_profile: domain.profile,
      domain_complexity_factor: domain.complexity_factor,
      transfer_context: {
        transfer_initialized: Boolean(experiment.metadata?.transfer_initialized),
        domain_signature: typeof transferSource.domain_signature === "string"
          ? transferSource.domain_signature
          : undefined,
        strategy_id: typeof transferSource.strategy_id === "string"
          ? transferSource.strategy_id
          : undefined,
        strategy_version_id: typeof transferSource.strategy_version_id === "string"
          ? transferSource.strategy_version_id
          : undefined,
        transfer_confidence: Number.isFinite(Number(transferSource.transfer_confidence))
          ? Number(transferSource.transfer_confidence)
          : undefined,
      },
      converged: convergence.converged,
      total_runs: totalRuns,
      completed_runs: 0,
      improvement_delta: 0,
      convergence_steps: 0,
      exploration_efficiency: 0,
      variance_stability: 1,
      best_score_trend: 0,
      stagnation_rate: 1,
      best_score_initial: null,
      best_score_final: null,
    };
    return { metrics: empty };
  }

  const scores = completedChronological.map((r) => Number(r.score ?? 0));
  const bestProgress: number[] = [];
  let bestSoFar = Number.NEGATIVE_INFINITY;
  for (const score of scores) {
    if (score > bestSoFar) bestSoFar = score;
    bestProgress.push(bestSoFar);
  }

  const bestScoreInitial = bestProgress[0];
  const bestScoreFinal = bestProgress[bestProgress.length - 1];
  const improvementDelta = Number((bestScoreFinal - bestScoreInitial).toFixed(6));
  const convergenceSteps = completedRuns;
  const explorationEfficiency = Number((improvementDelta / Math.max(1, completedRuns)).toFixed(6));

  const windowSize = Math.max(2, Math.min(opts.variance_window ?? 5, bestProgress.length));
  const recentBest = bestProgress.slice(-windowSize);
  const scoreVariance = variance(recentBest);
  const varianceStability = Number((1 / (1 + scoreVariance)).toFixed(6));

  const denominator = Math.max(1, bestProgress.length - 1);
  let stagnantTransitions = 0;
  for (let i = 1; i < bestProgress.length; i += 1) {
    if (bestProgress[i] - bestProgress[i - 1] <= adaptiveCfg.improvement_threshold) {
      stagnantTransitions += 1;
    }
  }
  const stagnationRate = Number(clamp01(stagnantTransitions / denominator).toFixed(6));
  const bestScoreTrend = Number(((bestScoreFinal - bestScoreInitial) / denominator).toFixed(6));
  const inferredDomain = inferDomainProfile({
    search_space: experiment.search_space,
    completed_scores: scores,
    convergence_steps: convergenceSteps,
    variance_stability: varianceStability,
  });
  const domain = resolveEffectiveDomainContext({
    metadata: experiment.metadata,
    inferred: inferredDomain,
  });

  const metrics: ExperimentResearchMetrics = {
    experiment_id: opts.experiment_id,
    search_strategy: strategy,
    domain_profile: domain.profile,
    domain_complexity_factor: domain.complexity_factor,
    transfer_context: {
      transfer_initialized: Boolean(experiment.metadata?.transfer_initialized),
      domain_signature: typeof transferSource.domain_signature === "string"
        ? transferSource.domain_signature
        : undefined,
      strategy_id: typeof transferSource.strategy_id === "string"
        ? transferSource.strategy_id
        : undefined,
      strategy_version_id: typeof transferSource.strategy_version_id === "string"
        ? transferSource.strategy_version_id
        : undefined,
      transfer_confidence: Number.isFinite(Number(transferSource.transfer_confidence))
        ? Number(transferSource.transfer_confidence)
        : undefined,
    },
    converged: convergence.converged,
    total_runs: totalRuns,
    completed_runs: completedRuns,
    improvement_delta: improvementDelta,
    convergence_steps: convergenceSteps,
    exploration_efficiency: explorationEfficiency,
    variance_stability: varianceStability,
    best_score_trend: bestScoreTrend,
    stagnation_rate: stagnationRate,
    best_score_initial: Number.isFinite(bestScoreInitial) ? bestScoreInitial : null,
    best_score_final: Number.isFinite(bestScoreFinal) ? bestScoreFinal : null,
  };
  return { metrics };
}

function coerceMetricValue(raw: string, typeRaw: unknown): number | null {
  const type = typeof typeRaw === "string" ? typeRaw.trim().toLowerCase() : "float";
  if (type === "float" || type === "number" || type === "double") {
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  }
  if (type === "int" || type === "integer") {
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
  }
  if (type === "bool" || type === "boolean") {
    const norm = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(norm)) return 1;
    if (["0", "false", "no", "off"].includes(norm)) return 0;
    return null;
  }

  const fallback = Number(raw);
  return Number.isFinite(fallback) ? fallback : null;
}

function parseMetricsJsonLine(input: string): Record<string, number> {
  const result: Record<string, number> = {};
  const re = /METRICS\s+(\{[^\r\n]*\})/m;
  const match = input.match(re);
  if (!match || typeof match[1] !== "string") return result;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== "object") return result;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      result[k] = n;
    }
  } catch {
    // Ignore malformed METRICS payload.
  }
  return result;
}

function parseKeyValueMetrics(input: string): Record<string, number> {
  const result: Record<string, number> = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_.-]*)=([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let match: RegExpExecArray | null = null;
  while ((match = re.exec(input))) {
    const key = String(match[1] ?? "").trim();
    const raw = String(match[2] ?? "").trim();
    if (!key || !raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    result[key] = n;
  }
  return result;
}

function extractMetricsWithFallback(
  objective: ExperimentObjective | undefined,
  metricSchema: ExperimentMetricSchema | undefined,
  stdout: string,
  stderr: string
): MetricExtractionResult {
  const primary = extractMetricsFromSchema(metricSchema, stdout, stderr);
  if (Object.keys(primary.metrics).length > 0) return primary;

  const combined = `${stdout}\n${stderr}`;
  const warnings = [...primary.warnings];
  const fallbackMetrics: Record<string, number> = {};

  const fromJson = parseMetricsJsonLine(combined);
  if (Object.keys(fromJson).length > 0) {
    Object.assign(fallbackMetrics, fromJson);
    warnings.push("metric_extraction_fallback: METRICS JSON");
  }

  const fromKv = parseKeyValueMetrics(combined);
  if (Object.keys(fromKv).length > 0) {
    Object.assign(fallbackMetrics, fromKv);
    warnings.push("metric_extraction_fallback: key=value");
  }

  const objectiveMetric = typeof objective?.metric === "string" ? objective.metric.trim() : "";
  if (objectiveMetric && !Object.prototype.hasOwnProperty.call(fallbackMetrics, objectiveMetric)) {
    const objRe = new RegExp(`${objectiveMetric.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)`, "m");
    const m = combined.match(objRe);
    if (m && typeof m[1] === "string") {
      const n = Number(m[1]);
      if (Number.isFinite(n)) {
        fallbackMetrics[objectiveMetric] = n;
        warnings.push("metric_extraction_fallback: objective.metric");
      }
    }
  }
  if (!Object.prototype.hasOwnProperty.call(fallbackMetrics, "score")) {
    const scoreMatch = combined.match(/score=([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/m);
    if (scoreMatch && typeof scoreMatch[1] === "string") {
      const n = Number(scoreMatch[1]);
      if (Number.isFinite(n)) {
        fallbackMetrics.score = n;
        warnings.push("metric_extraction_fallback: score");
      }
    }
  }

  return {
    metrics: fallbackMetrics,
    warnings,
  };
}

function extractMetricsFromSchema(
  metricSchema: ExperimentMetricSchema | undefined,
  stdout: string,
  stderr: string
): MetricExtractionResult {
  const metrics: Record<string, number> = {};
  const warnings: string[] = [];
  if (!metricSchema || typeof metricSchema !== "object") return { metrics, warnings };

  for (const [metricName, spec] of Object.entries(metricSchema)) {
    if (!spec || typeof spec !== "object") {
      warnings.push(`metric_schema.${metricName} is not an object`);
      continue;
    }

    const pattern = typeof spec.pattern === "string" ? spec.pattern : "";
    if (!pattern) {
      warnings.push(`metric_schema.${metricName}.pattern is required`);
      continue;
    }

    let re: RegExp;
    try {
      re = new RegExp(pattern, "m");
    } catch (e: any) {
      warnings.push(`metric_schema.${metricName}.pattern invalid regex: ${String(e?.message ?? e)}`);
      continue;
    }

    const source = typeof spec.source === "string" ? spec.source.trim().toLowerCase() : "stdout";
    const input = source === "stderr" ? stderr : (source === "combined" ? `${stdout}\n${stderr}` : stdout);
    const match = input.match(re);
    if (!match) continue;

    const rawValue = typeof match[1] === "string" ? match[1] : (typeof match[0] === "string" ? match[0] : "");
    if (!rawValue) {
      warnings.push(`metric_schema.${metricName} matched empty value`);
      continue;
    }

    const parsed = coerceMetricValue(rawValue, spec.type);
    if (parsed == null) {
      warnings.push(`metric_schema.${metricName} could not coerce "${rawValue}" as ${String(spec.type ?? "float")}`);
      continue;
    }

    metrics[metricName] = parsed;
  }

  return { metrics, warnings };
}

async function findRunByTaskId(syncDir: string, taskId: string): Promise<{
  experiment: ExperimentRecord;
  run: ExperimentRunRecord;
} | null> {
  const store = await loadStore(syncDir);
  let selected: { experiment: ExperimentRecord; run: ExperimentRunRecord } | null = null;
  let selectedTs = -Infinity;

  for (const experiment of Object.values(store.experiments)) {
    const runs = await loadRuns(syncDir, experiment.experiment_id);
    for (const run of runs) {
      if (run.task_id !== taskId) continue;
      const ts = Date.parse(run.updated_at || run.created_at || "");
      if (selected == null || ts > selectedTs) {
        selected = { experiment, run };
        selectedTs = Number.isFinite(ts) ? ts : -Infinity;
      }
    }
  }

  return selected;
}

function generateGridCandidates(searchSpace: Record<string, any[]>, limit: number): Record<string, any>[] {
  const keys = Object.keys(searchSpace);
  if (keys.length === 0) return [];
  const result: Record<string, any>[] = [];
  const walk = (idx: number, current: Record<string, any>) => {
    if (result.length >= limit) return;
    if (idx >= keys.length) {
      result.push({ ...current });
      return;
    }
    const key = keys[idx];
    const values = Array.isArray(searchSpace[key]) ? searchSpace[key] : [];
    for (const v of values) {
      current[key] = v;
      walk(idx + 1, current);
      if (result.length >= limit) return;
    }
    delete current[key];
  };
  walk(0, {});
  return result;
}

function generateRandomCandidates(searchSpace: Record<string, any[]>, limit: number): Record<string, any>[] {
  const keys = Object.keys(searchSpace);
  const out: Record<string, any>[] = [];
  for (let i = 0; i < limit; i++) {
    const candidate: Record<string, any> = {};
    for (const key of keys) {
      const values = Array.isArray(searchSpace[key]) ? searchSpace[key] : [];
      candidate[key] = sampleRandom(values);
    }
    out.push(candidate);
  }
  return out;
}

export async function experimentCreate(opts: {
  syncDir: string;
  experiment_id?: string;
  name: string;
  objective: string | ExperimentObjective;
  metric_schema?: ExperimentMetricSchema;
  search_space?: Record<string, any[]>;
  search_strategy?: SearchStrategy;
  strategy?: SearchStrategy;
  metadata?: Record<string, any>;
}) {
  return withLock(opts.syncDir, async () => {
    const store = await loadStore(opts.syncDir);
    const now = isoNow();
    const experimentId = (opts.experiment_id && opts.experiment_id.trim()) ? opts.experiment_id.trim() : `exp_${randomUUID()}`;
    const existing = store.experiments[experimentId];
    const objective = normalizeObjective(opts.objective);
    const metricSchema = opts.metric_schema ?? existing?.metric_schema;
    validateObjectiveInMetricSchema(objective, metricSchema);
    const strategyInput = opts.search_strategy ?? opts.strategy ?? existing?.search_strategy ?? "grid";
    const inferredDomain = inferDomainProfile({
      search_space: opts.search_space ?? existing?.search_space ?? {},
    });
    const transferThresholdRaw = Number(
      (opts.metadata as Record<string, any> | undefined)?.transfer_threshold ??
      process.env.RESEARCH_TRANSFER_INIT_THRESHOLD ??
      0.1
    );
    const transferThreshold = Math.max(0, Math.min(1, Number.isFinite(transferThresholdRaw) ? transferThresholdRaw : 0.1));
    const normalizedInputMetadata = normalizeDomainMetadata((opts.metadata ?? existing?.metadata ?? {}) as Record<string, any>);
    const domain = resolveEffectiveDomainContext({
      metadata: normalizedInputMetadata,
      inferred: inferredDomain,
    });
    let metadata = injectDomainMetadata(normalizedInputMetadata, domain.profile, domain.complexity_factor);
    let transfer_init: Record<string, any> | null = null;
    try {
      const transferCandidate = await researchMemoryFindSimilar({
        syncDir: opts.syncDir,
        domain_profile: domain.profile,
        threshold: transferThreshold,
        mark_used: true,
      });
      const match = transferCandidate.match ?? null;
      if (match) {
        const baseTransferSource = {
          domain_signature: match.domain_signature,
          strategy_id: match.strategy_id,
          strategy_version_id: match.strategy_version_id,
          similarity_score: match.similarity_score,
          transfer_score: match.transfer_score,
          transfer_confidence: match.transfer_confidence,
          confidence_factors: match.confidence_factors,
          source_experiment_count: match.experiment_count,
        };
        metadata = {
          ...metadata,
          transfer_initialized: true,
          transfer_source: baseTransferSource,
          transfer_reused: Boolean(transferCandidate.reused),
          transfer_reuse_threshold: transferThreshold,
        };
        if (transferCandidate.reused) {
          const reusedAdaptive = normalizeAdaptiveProfile(match.best_adaptive_profile);
          const prevAdaptive = (metadata.adaptive && typeof metadata.adaptive === "object")
            ? metadata.adaptive as Record<string, any>
            : {};
          metadata = {
            ...metadata,
            adaptive: {
              ...prevAdaptive,
              ...reusedAdaptive,
            },
          };
        }
        transfer_init = {
          reused: Boolean(transferCandidate.reused),
          ...baseTransferSource,
          threshold: transferCandidate.threshold,
          candidate_count: transferCandidate.candidate_count,
        };
      } else {
        metadata = {
          ...metadata,
          transfer_initialized: false,
        };
        transfer_init = {
          reused: false,
          threshold: transferCandidate.threshold,
          candidate_count: transferCandidate.candidate_count,
        };
      }
    } catch (e: any) {
      metadata = {
        ...metadata,
        transfer_initialized: false,
        transfer_error: String(e?.message ?? e),
      };
      transfer_init = {
        reused: false,
        error: String(e?.message ?? e),
      };
    }
    const record: ExperimentRecord = {
      experiment_id: experimentId,
      name: opts.name,
      objective,
      metric_schema: metricSchema,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      status: existing?.status ?? "running",
      best_run_id: existing?.best_run_id ?? null,
      search_strategy: normalizeSearchStrategy(strategyInput, "grid"),
      search_space: opts.search_space ?? existing?.search_space ?? {},
      metadata,
    };
    store.experiments[experimentId] = record;
    await saveStore(opts.syncDir, store);
    return { experiment: record, transfer_init };
  });
}

export async function experimentRun(opts: {
  syncDir: string;
  experiment_id: string;
  run_id?: string;
  params: Record<string, any>;
  metrics?: Record<string, number>;
  status?: RunStatus;
  duration_ms?: number | null;
  task_id?: string | null;
  notes?: string;
}) {
  return withLock(opts.syncDir, async () => {
    const store = await loadStore(opts.syncDir);
    const experiment = store.experiments[opts.experiment_id];
    if (!experiment) throw new Error(`experiment not found: ${opts.experiment_id}`);
    const now = isoNow();
    const runs = await loadRuns(opts.syncDir, opts.experiment_id);
    const runId = (opts.run_id && opts.run_id.trim()) ? opts.run_id.trim() : `run_${randomUUID()}`;
    const idx = runs.findIndex((r) => r.run_id === runId);

    const mergedMetrics: Record<string, number> = {};
    if (idx >= 0) {
      Object.assign(mergedMetrics, runs[idx].metrics ?? {});
    }
    Object.assign(mergedMetrics, opts.metrics ?? {});
    const status = opts.status ?? (idx >= 0 ? runs[idx].status : "pending");
    const score = status === "completed" ? computeScore(experiment.objective, mergedMetrics) : null;

    const record: ExperimentRunRecord = {
      run_id: runId,
      experiment_id: opts.experiment_id,
      created_at: idx >= 0 ? runs[idx].created_at : now,
      updated_at: now,
      params: idx >= 0 ? { ...runs[idx].params, ...opts.params } : opts.params,
      metrics: mergedMetrics,
      status,
      duration_ms: opts.duration_ms ?? (idx >= 0 ? runs[idx].duration_ms : null) ?? null,
      score,
      task_id: opts.task_id ?? (idx >= 0 ? runs[idx].task_id : null),
      notes: opts.notes ?? (idx >= 0 ? runs[idx].notes : undefined),
    };

    if (idx >= 0) runs[idx] = record;
    else runs.push(record);
    await saveRuns(opts.syncDir, opts.experiment_id, runs);
    if (status === "completed" || status === "failed") {
      await appendMetricLine(opts.syncDir, record);
    }

    const ordered = sortRunsByScoreDesc(runs);
    const best = ordered[0];
    experiment.best_run_id = best?.run_id ?? null;
    experiment.updated_at = now;
    if (runs.every((r) => r.status === "completed" || r.status === "failed")) {
      experiment.status = "completed";
    }
    store.experiments[opts.experiment_id] = experiment;
    await saveStore(opts.syncDir, store);

    return { run: record, best_run_id: experiment.best_run_id };
  });
}

export async function experimentList(opts: {
  syncDir: string;
  status?: ExperimentStatus;
  limit?: number;
}) {
  const store = await loadStore(opts.syncDir);
  let items = Object.values(store.experiments).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  if (opts.status) items = items.filter((x) => x.status === opts.status);
  return { items: items.slice(0, opts.limit ?? 100) };
}

export async function experimentLeaderboard(opts: {
  syncDir: string;
  experiment_id: string;
  limit?: number;
}) {
  const runs = await loadRuns(opts.syncDir, opts.experiment_id);
  const ordered = sortRunsByScoreDesc(runs);
  return { experiment_id: opts.experiment_id, items: ordered.slice(0, opts.limit ?? 20) };
}

export async function experimentBest(opts: {
  syncDir: string;
  experiment_id: string;
}) {
  const board = await experimentLeaderboard({
    syncDir: opts.syncDir,
    experiment_id: opts.experiment_id,
    limit: 1,
  });
  return {
    experiment_id: opts.experiment_id,
    best: board.items[0] ?? null,
  };
}

export async function experimentCompare(opts: {
  syncDir: string;
  experiment_id: string;
}) {
  const board = await experimentLeaderboard({
    syncDir: opts.syncDir,
    experiment_id: opts.experiment_id,
    limit: 1000,
  });
  const best = board.items[0] ?? null;
  const second = board.items[1] ?? null;
  const delta_to_second = (best && second && Number.isFinite(best.score) && Number.isFinite(second.score))
    ? Number(((best.score ?? 0) - (second.score ?? 0)).toFixed(6))
    : null;
  return {
    experiment_id: opts.experiment_id,
    runs_count: board.items.length,
    best,
    second,
    delta_to_second,
  };
}

export async function experimentSearchTick(opts: {
  syncDir: string;
  experiment_id: string;
  batch_size?: number;
  adaptive_profile?: AdaptiveStrategyProfile;
  adaptive_profiles_by_domain?: Partial<Record<DomainSizeCategory, AdaptiveStrategyProfile>>;
}) {
  return withLock(opts.syncDir, async () => {
    const store = await loadStore(opts.syncDir);
    const experiment = store.experiments[opts.experiment_id];
    if (!experiment) throw new Error(`experiment not found: ${opts.experiment_id}`);
    const batch = Math.max(1, Math.min(opts.batch_size ?? 10, 200));
    const runs = await loadRuns(opts.syncDir, opts.experiment_id);
    const existing = new Set(runs.map((r) => canonicalizeParams(r.params)));
    const strategy = normalizeSearchStrategy(experiment.search_strategy, "grid");
    const completedScores = runs
      .filter((r) => r.status === "completed" && Number.isFinite(r.score))
      .map((r) => Number(r.score ?? 0));
    const varianceStability = completedScores.length > 1
      ? Number((1 / (1 + variance(completedScores))).toFixed(6))
      : 1;
    const inferredDomain = inferDomainProfile({
      search_space: experiment.search_space,
      completed_scores: completedScores,
      convergence_steps: completedScores.length,
      variance_stability: varianceStability,
    });
    const domain = resolveEffectiveDomainContext({
      metadata: experiment.metadata,
      inferred: inferredDomain,
    });
    const domainProfile = opts.adaptive_profiles_by_domain?.[domain.profile.size_category];
    const adaptiveCfg = getAdaptiveConfig(experiment.metadata, domainProfile ?? opts.adaptive_profile);

    const convergence = strategy === "adaptive" ? detectConvergence(runs, adaptiveCfg) : { converged: false, reason: null };
    if (convergence.converged) {
      experiment.status = "completed";
      experiment.updated_at = isoNow();
      experiment.metadata = injectDomainMetadata(experiment.metadata, domain.profile, domain.complexity_factor);
      store.experiments[opts.experiment_id] = experiment;
      await saveStore(opts.syncDir, store);
      return {
        experiment_id: opts.experiment_id,
        created_count: 0,
        created: [] as ExperimentRunRecord[],
        phase: "converged",
        stop_reason: convergence.reason,
        domain_profile: domain.profile,
        domain_complexity_factor: domain.complexity_factor,
        adaptive_config: {
          bootstrap_min: adaptiveCfg.bootstrap_min,
          narrowing_factor: adaptiveCfg.narrowing_factor,
          patience: adaptiveCfg.convergence_patience,
          improvement_threshold: adaptiveCfg.improvement_threshold,
          exploration_bias: adaptiveCfg.exploration_bias,
          variance_sensitivity: adaptiveCfg.variance_sensitivity,
        },
      };
    }

    let phase: "grid" | "random" | "adaptive_bootstrap" | "adaptive_narrow";
    let candidates: Record<string, any>[];
    if (strategy === "grid") {
      phase = "grid";
      candidates = generateGridCandidates(experiment.search_space, batch * 20);
    } else if (strategy === "random") {
      phase = "random";
      candidates = generateRandomCandidates(experiment.search_space, batch * 40);
    } else {
      const completed = sortRunsByScoreDesc(runs);
      if (completed.length < adaptiveCfg.bootstrap_min || !completed[0]) {
        phase = "adaptive_bootstrap";
        const explorePool = 20 + Math.round(40 * adaptiveCfg.exploration_bias);
        candidates = generateRandomCandidates(experiment.search_space, batch * explorePool);
      } else {
        phase = "adaptive_narrow";
        const effectiveNeighborhoodSize = Math.max(
          2,
          Math.min(25, Math.round(adaptiveCfg.neighborhood_size * adaptiveCfg.narrowing_factor))
        );
        const narrowed = shrinkSearchSpaceAroundBest(
          experiment.search_space,
          completed[0].params,
          effectiveNeighborhoodSize
        );
        const randomMultiplier = 10 + Math.round(50 * adaptiveCfg.exploration_bias);
        const gridMultiplier = 10 + Math.round(50 * (1 - adaptiveCfg.exploration_bias));
        const poolFromNarrowGrid = generateGridCandidates(narrowed, batch * gridMultiplier);
        const poolFromNarrowRandom = generateRandomCandidates(narrowed, batch * randomMultiplier);
        candidates = [...poolFromNarrowGrid, ...poolFromNarrowRandom];
      }
    }

    const created: ExperimentRunRecord[] = [];
    for (const c of candidates) {
      if (created.length >= batch) break;
      const key = canonicalizeParams(c);
      if (existing.has(key)) continue;
      const now = isoNow();
      const run: ExperimentRunRecord = {
        run_id: `run_${randomUUID()}`,
        experiment_id: opts.experiment_id,
        created_at: now,
        updated_at: now,
        params: c,
        metrics: {},
        status: "pending",
        duration_ms: null,
        score: null,
        task_id: null,
      };
      runs.push(run);
      created.push(run);
      existing.add(key);
    }

    await saveRuns(opts.syncDir, opts.experiment_id, runs);
    experiment.updated_at = isoNow();
    experiment.metadata = injectDomainMetadata(experiment.metadata, domain.profile, domain.complexity_factor);
    if (created.length > 0) experiment.status = "running";
    const totalCombos = estimateCombinationCount(experiment.search_space);
    const spaceExhausted = totalCombos > 0 && existing.size >= totalCombos;
    if (created.length === 0 && spaceExhausted) {
      experiment.status = "completed";
    }
    store.experiments[opts.experiment_id] = experiment;
    await saveStore(opts.syncDir, store);
    return {
      experiment_id: opts.experiment_id,
      created_count: created.length,
      created,
      phase,
      domain_profile: domain.profile,
      domain_complexity_factor: domain.complexity_factor,
      adaptive_config: {
        bootstrap_min: adaptiveCfg.bootstrap_min,
        narrowing_factor: adaptiveCfg.narrowing_factor,
        patience: adaptiveCfg.convergence_patience,
        improvement_threshold: adaptiveCfg.improvement_threshold,
        exploration_bias: adaptiveCfg.exploration_bias,
        variance_sensitivity: adaptiveCfg.variance_sensitivity,
      },
      exhausted: created.length === 0 && spaceExhausted,
    };
  });
}

export async function experimentIngestExecResultByTask(opts: {
  syncDir: string;
  task_id: string;
  stdout?: string;
  stderr?: string;
  exit_code: number;
  duration_ms?: number | null;
  status?: RunStatus;
}) {
  const match = await findRunByTaskId(opts.syncDir, opts.task_id);
  if (!match) {
    return {
      matched: false as const,
      task_id: opts.task_id,
    };
  }

  const stdout = typeof opts.stdout === "string" ? opts.stdout : "";
  const stderr = typeof opts.stderr === "string" ? opts.stderr : "";
  const extracted = extractMetricsWithFallback(
    match.experiment.objective,
    match.experiment.metric_schema,
    stdout,
    stderr
  );
  const status = opts.status ?? (opts.exit_code === 0 ? "completed" : "failed");
  const notesParts: string[] = [];
  if (extracted.warnings.length > 0) {
    notesParts.push(`metric_extraction_warnings: ${extracted.warnings.join("; ")}`);
  }
  if (status !== "completed" && stderr.trim()) {
    notesParts.push(stderr.trim().slice(0, 1200));
  }

  const updated = await experimentRun({
    syncDir: opts.syncDir,
    experiment_id: match.experiment.experiment_id,
    run_id: match.run.run_id,
    params: {},
    metrics: extracted.metrics,
    status,
    duration_ms: opts.duration_ms ?? null,
    task_id: opts.task_id,
    notes: notesParts.length > 0 ? notesParts.join("\n") : undefined,
  });

  return {
    matched: true as const,
    task_id: opts.task_id,
    experiment_id: match.experiment.experiment_id,
    run_id: match.run.run_id,
    extracted_metrics: extracted.metrics,
    metric_extraction_warnings: extracted.warnings,
    run: updated.run,
    best_run_id: updated.best_run_id,
  };
}
