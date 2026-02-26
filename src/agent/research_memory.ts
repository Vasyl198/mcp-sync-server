import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireLock, releaseLock } from "../locks.js";
import { safeAtomicWrite } from "../fs_atomic.js";
import { AdaptiveStrategyProfile, DomainSizeCategory, normalizeAdaptiveProfile } from "./registry.js";

export type TransferDomainProfile = {
  size_category: DomainSizeCategory;
  metric_noise: "low" | "medium" | "high";
  search_complexity: "low" | "high";
  param_count: number;
};

export type DomainSimilarityWeights = {
  param_count_similarity: number;
  size_category_match: number;
  search_complexity_match: number;
  metric_noise_similarity: number;
};

export type ArenaStrategyStatus = "active" | "shadow" | "inactive";

export type ResearchArenaStrategy = {
  strategy_id: string;
  version_id: string;
  lineage_id: string;
  adaptive_profile: AdaptiveStrategyProfile;
  fitness: number;
  experiments_count: number;
  avg_convergence_steps: number;
  avg_variance_stability: number;
  transfer_effectiveness: number;
  status: ArenaStrategyStatus;
  created_at: string;
  updated_at: string;
  last_used_at: string;
  selection_count_window: number;
  allocation_weight: number;
  allocation_weight_updated_at?: string;
  reuse_blocked_until?: string;
};

export type ResearchArenaGovernance = {
  max_strategies_per_domain: number;
  arena_evaluation_window: number;
  promotion_margin: number;
  arena_cooldown_ms: number;
};

export type ResearchArenaState = {
  governance: ResearchArenaGovernance;
  last_evaluated_at?: string;
  last_selected_cursor: number;
  experiments_since_last_eval: number;
  lineage_last_replication_at: Record<string, string>;
};

export type TransferEvidenceStats = {
  obs: number;
  succ: number;
  fail: number;
  ema_match_conf?: number;
  ema_success?: number;
  updated_at: string;
};

export type ResearchMemoryDomainState = {
  last_micro_impact_tick_index?: number;
};

export type ResearchMemoryEntry = {
  domain_signature: string;
  domain_profile: TransferDomainProfile;
  best_adaptive_profile: AdaptiveStrategyProfile;
  fitness_snapshot: number;
  experiment_count: number;
  strategy_age: number;
  success_streak: number;
  failure_streak: number;
  last_used_at: string;
  last_updated_at: string;
  created_at: string;
  strategy_pool: ResearchArenaStrategy[];
  active_strategy_id?: string;
  arena_state: ResearchArenaState;
  last_success_at?: string;
  reuse_blocked_until?: string;
  last_transfer_confidence?: number;
  last_evidence_confidence?: number;
  transfer_evidence?: TransferEvidenceStats;
  last_experiment_id?: string;
  stabilization_mode?: {
    ticks_remaining: number;
    active_only: boolean;
    shadow_cap: number;
    variance_lambda_multiplier: number;
    freeze_novelty: boolean;
    reason?: string;
    activated_at: string;
    updated_at: string;
  };
  micro_impact_cooldown_ticks_remaining?: number;
  last_micro_impact_tick_index?: number;
  micro_impact_cap_multiplier?: number;
  transfer_variance_short_window?: number[];
  transfer_variance_ultra_window?: number[];
  micro_impact_budget_window?: number[];
  entropy_boost_ticks_remaining?: number;
};

export type ExperimentAnomalyFlags = {
  extreme_variance: boolean;
  unexpected_fitness_spike: boolean;
  too_fast_convergence: boolean;
};

type ResearchMemoryStore = {
  version: 1;
  updated_at: string;
  items: ResearchMemoryEntry[];
  domain_state?: Record<string, ResearchMemoryDomainState>;
};

const DEFAULT_SIMILARITY_WEIGHTS: DomainSimilarityWeights = {
  param_count_similarity: 0.35,
  size_category_match: 0.2,
  search_complexity_match: 0.2,
  metric_noise_similarity: 0.25,
};
const DEFAULT_TRANSFER_CONFIDENCE_THRESHOLD = 0.16;
const DEFAULT_MAX_MEMORY_ENTRIES = 80;
const DEFAULT_MIN_TRANSFER_SCORE = 0.04;
const DEFAULT_FITNESS_TO_STORE = 0.12;
const DEFAULT_LINEAGE_CONCENTRATION_CAP = 0.6;
const DEFAULT_LINEAGE_REPLICATION_COOLDOWN_MS = 20 * 60 * 1000;
const ENTROPY_DIVERSITY_TRIGGER = 0.35;
const ENTROPY_TARGET_HIGH = 0.88;
const ENTROPY_TARGET_LOW_DOMAIN = 0.74;
const ENTROPY_BOOST_RELEASE_DOMAIN = 0.82;
const ANNEAL_SHADOW_REDUCTION = 0.4;
const SHADOW_WEIGHT_FLOOR = 0.1;
const SHADOW_TOTAL_CAP_WHEN_ANNEALED = 0.35;
const SHADOW_TARGET_WHEN_HIGH_ENTROPY = 0.2;
const SHADOW_TARGET_WHEN_HIGH_ENTROPY_MAX3 = 0.15;
const SHADOW_TARGET_WHEN_LOW_ENTROPY = 0.4;
const SHADOW_TOTAL_MIN_FLOOR = 0.1;
const ACTIVE_SKEW_EXPONENT_HIGH_ENTROPY = 2.6;
const TOP_ACTIVE_SHARE_MIN_HIGH_ENTROPY = 0.5;
const VARIANCE_PENALTY_LAMBDA = 0.45;
const VARIANCE_TARGET = 0.13;
const TRANSFER_CONFIDENCE_TARGET = 0.2;
const CONFIDENCE_UTILITY_TARGET = 0.18;
const CONFIDENCE_UTILITY_LAMBDA = 0.2;
const TRANSFER_MATCH_CONF_MIN_FULL = 0.11;
const TRANSFER_MATCH_CONF_MIN_MICRO = 0.09;
const TRANSFER_EVIDENCE_STRENGTH_MIN = 0.55;
const TRANSFER_EVIDENCE_STRENGTH_MIN_MICRO_BASE = 0.22;
const TRANSFER_EVIDENCE_STRENGTH_MIN_MICRO_MAX = 0.35;
const TRANSFER_EVIDENCE_MIN_OBS = 5;
const TRANSFER_MICRO_IMPACT_CAP = 0.05;
const TRANSFER_MICRO_IMPACT_VARIANCE_SOFT = 0.12;
const TRANSFER_MICRO_IMPACT_VARIANCE_HARD = 0.18;
const TRANSFER_MICRO_IMPACT_COOLDOWN_SOFT_TICKS = 1;
const TRANSFER_MICRO_IMPACT_COOLDOWN_HARD_TICKS = 3;
const TRANSFER_MICRO_IMPACT_VARIANCE_K = 3;
const TRANSFER_VARIANCE_SHORT_WINDOW = 12;
const TRANSFER_VARIANCE_ULTRA_WINDOW = 4;
const TRANSFER_MICRO_BUDGET_WINDOW = 24;
const TRANSFER_MICRO_BUDGET_RATIO = 0.08;
const TRANSFER_SUCCESS_MARGIN = 0.015;
const DOMAIN_VARIANCE_K = 1.25;
const DOMAIN_CONFIDENCE_K = 0.75;
const DOMAIN_VARIANCE_BOOST_SIGNATURE = "medium|high|low|p5";
const DOMAIN_VARIANCE_BOOST_MULTIPLIER = 1.5;
const CIRCUIT_BREAKER_DEFAULT_TICKS = 3;
const CIRCUIT_BREAKER_SHADOW_CAP = 0.2;
const CIRCUIT_BREAKER_VARIANCE_MULTIPLIER = 1.75;
const DEFAULT_ARENA_GOVERNANCE: ResearchArenaGovernance = {
  max_strategies_per_domain: 3,
  arena_evaluation_window: 6,
  promotion_margin: 0.08,
  arena_cooldown_ms: 15 * 60 * 1000,
};
const DEFAULT_ACTIVE_PORTFOLIO_TARGET = 2;
const DEFAULT_SHADOW_PORTFOLIO_TARGET = 2;

function isoNow() {
  return new Date().toISOString();
}

function agentsDir(syncDir: string) {
  return path.join(syncDir, "agents");
}

function memoryFile(syncDir: string) {
  return path.join(agentsDir(syncDir), "research_memory.json");
}

function locksDir(syncDir: string) {
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
  await fs.mkdir(agentsDir(syncDir), { recursive: true });
  await ensureTextFile(memoryFile(syncDir), JSON.stringify({
    version: 1,
    updated_at: isoNow(),
    items: [],
    domain_state: {},
  }, null, 2));
}

async function withLock<T>(syncDir: string, fn: () => Promise<T>): Promise<T> {
  await ensureLayout(syncDir);
  const lock = await acquireLock({
    locksDir: locksDir(syncDir),
    name: "research_memory",
    ttl_ms: 10_000,
  });
  if (!lock.ok || !lock.token) throw new Error("research_memory lock busy");
  try {
    return await fn();
  } finally {
    await releaseLock({
      locksDir: locksDir(syncDir),
      name: "research_memory",
      token: lock.token,
    });
  }
}

function clamp01(v: number) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function weightedAverage(currentAvg: number, count: number, nextValue: number) {
  if (count <= 0) return nextValue;
  return ((currentAvg * count) + nextValue) / (count + 1);
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((acc, n) => acc + n, 0) / values.length;
}

function variance(values: number[]) {
  if (values.length < 2) return 0;
  const mu = average(values);
  const acc = values.reduce((sum, n) => sum + ((n - mu) ** 2), 0);
  return acc / values.length;
}

function median(values: number[]) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function mad(values: number[]) {
  const xs = values.filter((v) => Number.isFinite(v));
  if (!xs.length) return 0;
  const med = median(xs);
  const deviations = xs.map((v) => Math.abs(v - med));
  return median(deviations);
}

function normalizeNumberWindow(input: unknown, maxLen: number): number[] {
  const arr = Array.isArray(input) ? input : [];
  const normalized = arr
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .map((v) => Number(v));
  if (normalized.length <= maxLen) return normalized;
  return normalized.slice(-maxLen);
}

function pushNumberWindow(input: number[], value: number, maxLen: number): number[] {
  const base = normalizeNumberWindow(input, maxLen);
  base.push(value);
  if (base.length <= maxLen) return base;
  return base.slice(-maxLen);
}

function planMicroBudgetTopK(input: number[], signal: number, capacity: number, maxLen: number) {
  const normalized = normalizeNumberWindow(input, maxLen).filter((v) => Number.isFinite(v) && v > 0);
  const safeCapacity = Math.max(0, Math.trunc(capacity));
  const safeSignal = Number.isFinite(signal) ? Math.max(0, signal) : NaN;
  const next = [...normalized];
  let accepted = false;
  let threshold: number | null = null;

  if (safeCapacity > 0 && Number.isFinite(safeSignal)) {
    if (next.length < safeCapacity) {
      accepted = true;
      next.push(safeSignal);
    } else if (next.length > 0) {
      const minValue = Math.min(...next);
      threshold = minValue;
      if (safeSignal >= minValue) {
        accepted = true;
        const idx = next.indexOf(minValue);
        if (idx >= 0) next.splice(idx, 1);
        next.push(safeSignal);
      }
    }
  }

  const trimmed = next.length <= maxLen ? next : next.slice(-maxLen);
  return {
    accepted,
    next: trimmed,
    used: trimmed.length,
    threshold,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function strategyLineageIdFromProfile(profile: AdaptiveStrategyProfile): string {
  const normalized = normalizeAdaptiveProfile(profile);
  const raw = stableStringify(normalized);
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return `lin_${Math.abs(hash).toString(16)}`;
}

function normalizedEntropy(weightsInput: number[]): number {
  const weights = weightsInput
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0);
  if (weights.length <= 1) return 0;
  const total = weights.reduce((acc, n) => acc + n, 0);
  if (total <= 0) return 0;
  let entropy = 0;
  for (const w of weights) {
    const p = w / total;
    if (p > 0) entropy += -(p * Math.log(p));
  }
  const maxEntropy = Math.log(weights.length);
  return maxEntropy > 0 ? clamp01(entropy / maxEntropy) : 0;
}

function normalizeDomainProfile(input: TransferDomainProfile): TransferDomainProfile {
  const sizeRaw = typeof input?.size_category === "string" ? input.size_category.toLowerCase() : "medium";
  const noiseRaw = typeof input?.metric_noise === "string" ? input.metric_noise.toLowerCase() : "medium";
  const complexityRaw = typeof input?.search_complexity === "string" ? input.search_complexity.toLowerCase() : "low";
  return {
    size_category: (sizeRaw === "small" || sizeRaw === "medium" || sizeRaw === "large")
      ? sizeRaw
      : "medium",
    metric_noise: (noiseRaw === "low" || noiseRaw === "medium" || noiseRaw === "high")
      ? noiseRaw
      : "medium",
    search_complexity: complexityRaw === "high" ? "high" : "low",
    param_count: Math.max(0, Math.trunc(Number(input?.param_count ?? 0))),
  };
}

function normalizeWeights(weights?: Partial<DomainSimilarityWeights>): DomainSimilarityWeights {
  const raw = { ...DEFAULT_SIMILARITY_WEIGHTS, ...(weights ?? {}) };
  const sum = Math.max(0.0001, raw.param_count_similarity + raw.size_category_match + raw.search_complexity_match + raw.metric_noise_similarity);
  return {
    param_count_similarity: raw.param_count_similarity / sum,
    size_category_match: raw.size_category_match / sum,
    search_complexity_match: raw.search_complexity_match / sum,
    metric_noise_similarity: raw.metric_noise_similarity / sum,
  };
}

function normalizeArenaGovernance(input?: Partial<ResearchArenaGovernance>): ResearchArenaGovernance {
  const raw = { ...DEFAULT_ARENA_GOVERNANCE, ...(input ?? {}) };
  return {
    max_strategies_per_domain: Math.max(1, Math.min(10, Math.trunc(Number(raw.max_strategies_per_domain ?? 3)))),
    arena_evaluation_window: Math.max(2, Math.min(50, Math.trunc(Number(raw.arena_evaluation_window ?? 6)))),
    promotion_margin: Math.max(0.01, Math.min(0.5, Number(raw.promotion_margin ?? 0.08))),
    arena_cooldown_ms: Math.max(10_000, Math.min(24 * 60 * 60 * 1000, Math.trunc(Number(raw.arena_cooldown_ms ?? (15 * 60 * 1000))))),
  };
}

function normalizeStabilizationMode(input: any) {
  if (!input || typeof input !== "object") return undefined;
  const ticksRemaining = Math.max(0, Math.trunc(Number(input?.ticks_remaining ?? 0)));
  if (ticksRemaining <= 0) return undefined;
  const now = isoNow();
  return {
    ticks_remaining: ticksRemaining,
    active_only: input?.active_only !== false,
    shadow_cap: clamp01(Number(input?.shadow_cap ?? CIRCUIT_BREAKER_SHADOW_CAP)),
    variance_lambda_multiplier: Math.max(1, Math.min(4, Number(input?.variance_lambda_multiplier ?? CIRCUIT_BREAKER_VARIANCE_MULTIPLIER))),
    freeze_novelty: input?.freeze_novelty !== false,
    reason: typeof input?.reason === "string" ? input.reason : undefined,
    activated_at: typeof input?.activated_at === "string" ? input.activated_at : now,
    updated_at: typeof input?.updated_at === "string" ? input.updated_at : now,
  };
}

function normalizeArenaState(input?: Partial<ResearchArenaState>): ResearchArenaState {
  const rawReplications = input?.lineage_last_replication_at;
  const lineageReplication = (rawReplications && typeof rawReplications === "object")
    ? Object.fromEntries(
      Object.entries(rawReplications)
        .filter(([k, v]) => typeof k === "string" && typeof v === "string")
        .map(([k, v]) => [k.trim(), String(v)])
        .filter(([k]) => k.length > 0)
    )
    : {};
  return {
    governance: normalizeArenaGovernance(input?.governance),
    last_evaluated_at: typeof input?.last_evaluated_at === "string" ? input.last_evaluated_at : undefined,
    last_selected_cursor: Math.max(0, Math.trunc(Number(input?.last_selected_cursor ?? 0))),
    experiments_since_last_eval: Math.max(0, Math.trunc(Number(input?.experiments_since_last_eval ?? 0))),
    lineage_last_replication_at: lineageReplication,
  };
}

function normalizeTransferEvidence(input: any): TransferEvidenceStats | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obs = Math.max(0, Math.trunc(Number(input?.obs ?? 0)));
  const succ = Math.max(0, Math.trunc(Number(input?.succ ?? 0)));
  const fail = Math.max(0, Math.trunc(Number(input?.fail ?? 0)));
  const now = isoNow();
  return {
    obs,
    succ: Math.min(succ, obs),
    fail: Math.min(fail, obs),
    ema_match_conf: Number.isFinite(Number(input?.ema_match_conf))
      ? clamp01(Number(input.ema_match_conf))
      : undefined,
    ema_success: Number.isFinite(Number(input?.ema_success))
      ? clamp01(Number(input.ema_success))
      : undefined,
    updated_at: typeof input?.updated_at === "string" ? input.updated_at : now,
  };
}

function normalizeDomainStateRecord(input: any): Record<string, ResearchMemoryDomainState> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, ResearchMemoryDomainState> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = String(rawKey ?? "").trim();
    if (!key) continue;
    const value = rawValue && typeof rawValue === "object" ? rawValue as Record<string, unknown> : {};
    const tickRaw = Number((value as any)?.last_micro_impact_tick_index ?? NaN);
    out[key] = {
      last_micro_impact_tick_index: Number.isFinite(tickRaw) ? Math.trunc(tickRaw) : undefined,
    };
  }
  return out;
}

function getDomainState(store: ResearchMemoryStore, domainSignature: string): ResearchMemoryDomainState {
  if (!store.domain_state || typeof store.domain_state !== "object") store.domain_state = {};
  const key = String(domainSignature ?? "").trim();
  if (!key) return {};
  if (!store.domain_state[key]) store.domain_state[key] = {};
  return store.domain_state[key];
}

function computeNextTransferEvidence(params: {
  previous?: TransferEvidenceStats;
  match_confidence: number;
  success: boolean;
  now: string;
}) {
  const prev = params.previous;
  const prevObs = Math.max(0, Math.trunc(Number(prev?.obs ?? 0)));
  const prevSucc = Math.max(0, Math.trunc(Number(prev?.succ ?? 0)));
  const prevFail = Math.max(0, Math.trunc(Number(prev?.fail ?? 0)));
  const matchConfidence = clamp01(Number(params.match_confidence));
  const obs = prevObs + 1;
  const succ = prevSucc + (params.success ? 1 : 0);
  const fail = prevFail + (params.success ? 0 : 1);
  const emaAlpha = 0.22;
  const prevEmaMatch = clamp01(Number(prev?.ema_match_conf ?? matchConfidence));
  const prevEmaSuccess = clamp01(Number(prev?.ema_success ?? ((prevSucc + 1) / (Math.max(1, prevObs) + 2))));
  const emaMatch = clamp01((prevEmaMatch * (1 - emaAlpha)) + (matchConfidence * emaAlpha));
  const successNow = params.success ? 1 : 0;
  const emaSuccess = clamp01((prevEmaSuccess * (1 - emaAlpha)) + (successNow * emaAlpha));
  const sr = (succ + 1) / (obs + 2);
  const nFactor = clamp01(obs / Math.max(1, TRANSFER_EVIDENCE_MIN_OBS));
  const blendedSuccess = clamp01((sr + emaSuccess) / 2);
  // Evidence strength is independent from match quality: it reflects data support only.
  const evidenceStrength = clamp01(nFactor * blendedSuccess);
  return {
    next: {
      obs,
      succ,
      fail,
      ema_match_conf: Number(emaMatch.toFixed(6)),
      ema_success: Number(emaSuccess.toFixed(6)),
      updated_at: params.now,
    } as TransferEvidenceStats,
    evidence_confidence: Number(evidenceStrength.toFixed(6)),
    success_rate: Number(sr.toFixed(6)),
  };
}

function microEvidenceMin(obs: number, nMin: number) {
  const safeNMin = Math.max(1, Math.trunc(Number(nMin)));
  const safeObs = Math.max(0, Math.trunc(Number(obs)));
  const t = clamp01((safeObs - safeNMin) / safeNMin);
  return TRANSFER_EVIDENCE_STRENGTH_MIN_MICRO_BASE
    + (t * (TRANSFER_EVIDENCE_STRENGTH_MIN_MICRO_MAX - TRANSFER_EVIDENCE_STRENGTH_MIN_MICRO_BASE));
}

function normalizeArenaStrategy(input: any): ResearchArenaStrategy {
  const now = isoNow();
  const adaptive = normalizeAdaptiveProfile(input?.adaptive_profile);
  const status: ArenaStrategyStatus = input?.status === "inactive"
    ? "inactive"
    : (input?.status === "shadow" ? "shadow" : "active");
  const allocationWeightRaw = Number(input?.allocation_weight);
  const allocationWeight = Number.isFinite(allocationWeightRaw)
    ? clamp01(allocationWeightRaw)
    : (status === "active" ? 1 : (status === "shadow" ? SHADOW_WEIGHT_FLOOR : 0));
  return {
    strategy_id: typeof input?.strategy_id === "string" ? input.strategy_id : `stg_${randomUUID()}`,
    version_id: typeof input?.version_id === "string" ? input.version_id : `v_${Date.now()}`,
    lineage_id: typeof input?.lineage_id === "string" && input.lineage_id.trim().length > 0
      ? input.lineage_id.trim()
      : strategyLineageIdFromProfile(adaptive),
    adaptive_profile: adaptive,
    fitness: Number(input?.fitness ?? 0),
    experiments_count: Math.max(0, Math.trunc(Number(input?.experiments_count ?? 0))),
    avg_convergence_steps: Math.max(0, Number(input?.avg_convergence_steps ?? 0)),
    avg_variance_stability: clamp01(Number(input?.avg_variance_stability ?? 1)),
    transfer_effectiveness: clamp01(Number(input?.transfer_effectiveness ?? 0.5)),
    status,
    created_at: typeof input?.created_at === "string" ? input.created_at : now,
    updated_at: typeof input?.updated_at === "string" ? input.updated_at : now,
    last_used_at: typeof input?.last_used_at === "string" ? input.last_used_at : now,
    selection_count_window: Math.max(0, Math.trunc(Number(input?.selection_count_window ?? 0))),
    allocation_weight: allocationWeight,
    allocation_weight_updated_at: typeof input?.allocation_weight_updated_at === "string"
      ? input.allocation_weight_updated_at
      : undefined,
    reuse_blocked_until: typeof input?.reuse_blocked_until === "string" ? input.reuse_blocked_until : undefined,
  };
}

function noiseToScale(noise: TransferDomainProfile["metric_noise"]): number {
  if (noise === "low") return 0;
  if (noise === "medium") return 0.5;
  return 1;
}

function daysSince(ts: string) {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, (Date.now() - parsed) / (1000 * 60 * 60 * 24));
}

function applyFitnessDecay(fitness: number, lastUpdatedAt: string, decayPerDay = 0.015) {
  const decayed = Number(fitness) * Math.exp(-decayPerDay * daysSince(lastUpdatedAt));
  return Number(decayed.toFixed(6));
}

function domainStability(profile: TransferDomainProfile) {
  const noisePenalty = profile.metric_noise === "high" ? 0.22 : (profile.metric_noise === "medium" ? 0.1 : 0);
  const complexityPenalty = profile.search_complexity === "high" ? 0.1 : 0;
  return Number(clamp01(1 - noisePenalty - complexityPenalty).toFixed(6));
}

function recencyFactor(ts: string) {
  const d = daysSince(ts);
  return Number(Math.exp(-0.02 * d).toFixed(6));
}

function strategyAgingFactor(entry: ResearchMemoryEntry) {
  const agePenalty = Math.min(0.35, 0.01 * Math.max(0, entry.strategy_age));
  const failurePenalty = Math.min(0.25, 0.05 * Math.max(0, entry.failure_streak));
  const streakBonus = Math.min(0.2, 0.03 * Math.max(0, entry.success_streak));
  return Number(clamp01(1 - agePenalty - failurePenalty + streakBonus).toFixed(6));
}

function computeArenaStrategyScore(strategy: ResearchArenaStrategy) {
  const domainWeightedFitness = clamp01(strategy.fitness);
  const convergenceSpeed = clamp01(1 / Math.max(1, strategy.avg_convergence_steps || 1));
  const stability = clamp01(strategy.avg_variance_stability);
  const transferEffectiveness = clamp01(strategy.transfer_effectiveness);
  const ageDays = daysSince(strategy.last_used_at || strategy.updated_at || strategy.created_at);
  const recencyFactor = Number(Math.exp(-0.06 * ageDays).toFixed(6));
  const score =
    ((0.45 * domainWeightedFitness) + (0.2 * convergenceSpeed) + (0.2 * stability) + (0.15 * transferEffectiveness))
    * recencyFactor;
  return Number(score.toFixed(6));
}

function memoryTransferScore(entry: ResearchMemoryEntry) {
  const decayedFitness = Math.max(0, applyFitnessDecay(entry.fitness_snapshot, entry.last_updated_at));
  const fitnessFactor = clamp01(decayedFitness);
  const usedRecent = recencyFactor(entry.last_used_at || entry.last_updated_at);
  const stable = domainStability(entry.domain_profile);
  const aging = strategyAgingFactor(entry);
  const score = fitnessFactor * usedRecent * stable * aging;
  return Number(score.toFixed(6));
}

function createStrategyCandidate(input: {
  adaptive_profile: AdaptiveStrategyProfile;
  fitness: number;
  status?: ArenaStrategyStatus;
}): ResearchArenaStrategy {
  const now = isoNow();
  const adaptive = normalizeAdaptiveProfile(input.adaptive_profile);
  return {
    strategy_id: `stg_${randomUUID()}`,
    version_id: `v_${Date.now()}`,
    lineage_id: strategyLineageIdFromProfile(adaptive),
    adaptive_profile: adaptive,
    fitness: Number(input.fitness.toFixed(6)),
    experiments_count: 1,
    avg_convergence_steps: 0,
    avg_variance_stability: 1,
    transfer_effectiveness: 0.5,
    status: input.status ?? "active",
    created_at: now,
    updated_at: now,
    last_used_at: now,
    selection_count_window: 0,
    allocation_weight: input.status === "inactive" ? 0 : (input.status === "shadow" ? SHADOW_WEIGHT_FLOOR : 1),
    allocation_weight_updated_at: now,
  };
}

function computePortfolioTargets(entry: ResearchMemoryEntry): { activeTarget: number; shadowTarget: number } {
  const govMax = Math.max(1, Math.trunc(Number(entry.arena_state?.governance?.max_strategies_per_domain ?? DEFAULT_ARENA_GOVERNANCE.max_strategies_per_domain)));
  const live = entry.strategy_pool.filter((s) => s.status !== "inactive");
  const liveWeights = live.map((s) => {
    const alloc = Number(s.allocation_weight ?? NaN);
    if (Number.isFinite(alloc) && alloc > 0) return alloc;
    return Math.max(0, Number(s.fitness ?? 0));
  });
  const entropy = normalizedEntropy(liveWeights);
  const highEntropyMode = entropy > ENTROPY_TARGET_HIGH;
  // Keep 2+1 as a hard invariant for max=3 domains.
  // 1+2 repeatedly caused shadow dominance and entropy stalls.
  if (govMax === 3) {
    return { activeTarget: 2, shadowTarget: 1 };
  }
  if (govMax >= 4 && highEntropyMode) {
    return { activeTarget: 3, shadowTarget: 1 };
  }
  const desiredLive = Math.max(1, Math.min(govMax, DEFAULT_ACTIVE_PORTFOLIO_TARGET + DEFAULT_SHADOW_PORTFOLIO_TARGET));
  const shadowTarget = Math.max(0, Math.min(DEFAULT_SHADOW_PORTFOLIO_TARGET, desiredLive - 1));
  const activeTarget = Math.max(1, desiredLive - shadowTarget);
  return { activeTarget, shadowTarget };
}

function computeShadowFloorPerStrategy(targetShadowShare: number, shadowCount: number): number {
  const n = Math.max(0, Math.trunc(Number(shadowCount)));
  if (n <= 0) return 0;
  const total = clamp01(Number(targetShadowShare));
  const raw = Math.min(0.1, (0.5 * total) / n);
  const maxAllowed = total / n;
  return Math.max(0, Math.min(raw, maxAllowed));
}

function applyShadowFloorToTotal(current: number[], targetTotal: number, floorPerStrategy: number): number[] {
  const n = current.length;
  if (n === 0) return [];
  const target = Math.max(0, Number(targetTotal));
  if (target <= 0) return Array.from({ length: n }, () => 0);
  const safeFloor = Math.max(0, Number(floorPerStrategy));
  if ((safeFloor * n) >= target - 1e-9) {
    const equal = target / n;
    return Array.from({ length: n }, () => equal);
  }
  let out = current.map((v) => Math.max(0, Number(v)));
  const sum = out.reduce((acc, v) => acc + v, 0);
  if (sum <= 1e-12) {
    const equal = target / n;
    return Array.from({ length: n }, () => equal);
  }
  out = out.map((v) => (v / sum) * target);
  for (let iter = 0; iter < n; iter += 1) {
    const below: number[] = [];
    const above: number[] = [];
    for (let i = 0; i < n; i += 1) {
      if (out[i] < safeFloor) below.push(i);
      else above.push(i);
    }
    if (below.length === 0) break;
    const budgetForBelow = safeFloor * below.length;
    for (const i of below) out[i] = safeFloor;
    const remain = Math.max(0, target - budgetForBelow);
    if (above.length === 0) break;
    const aboveSum = above.reduce((acc, i) => acc + out[i], 0);
    if (aboveSum <= 1e-12) {
      const equalAbove = remain / above.length;
      for (const i of above) out[i] = equalAbove;
    } else {
      for (const i of above) out[i] = (out[i] / aboveSum) * remain;
    }
  }
  const finalSum = out.reduce((acc, v) => acc + v, 0);
  if (finalSum > 1e-12) {
    const k = target / finalSum;
    out = out.map((v) => v * k);
  }
  return out;
}

function rebalancePortfolioStatuses(entry: ResearchMemoryEntry, opts?: { active_target?: number; shadow_target?: number }) {
  const nowIso = isoNow();
  const inferredTargets = computePortfolioTargets(entry);
  const activeTarget = Math.max(1, Math.trunc(Number(opts?.active_target ?? inferredTargets.activeTarget)));
  const shadowTarget = Math.max(0, Math.trunc(Number(opts?.shadow_target ?? inferredTargets.shadowTarget)));
  const ranked = [...entry.strategy_pool]
    .sort((a, b) => computeArenaStrategyScore(b) - computeArenaStrategyScore(a));
  const desired = new Map<string, ArenaStrategyStatus>();
  for (let i = 0; i < ranked.length; i += 1) {
    const s = ranked[i];
    if (i < activeTarget) desired.set(s.strategy_id, "active");
    else if (i < activeTarget + shadowTarget) desired.set(s.strategy_id, "shadow");
    else desired.set(s.strategy_id, "inactive");
  }
  for (const s of entry.strategy_pool) {
    const prevStatus = s.status;
    const status = desired.get(s.strategy_id) ?? "inactive";
    s.status = status;
    const currentAlloc = Number(s.allocation_weight ?? NaN);
    const hasAlloc = Number.isFinite(currentAlloc) && currentAlloc > 0;
    if (status === "inactive") {
      if (s.allocation_weight !== 0) s.allocation_weight_updated_at = nowIso;
      s.allocation_weight = 0;
      continue;
    }
    if (!hasAlloc || prevStatus === "inactive") {
      s.allocation_weight = status === "active" ? 1 : SHADOW_WEIGHT_FLOOR;
      s.allocation_weight_updated_at = nowIso;
      continue;
    }
    s.allocation_weight = clamp01(currentAlloc);
  }
  const topActive = ranked.find((s) => (desired.get(s.strategy_id) ?? "inactive") === "active");
  if (topActive) entry.active_strategy_id = topActive.strategy_id;
}

function ensurePortfolioFloor(entry: ResearchMemoryEntry) {
  const govMax = Math.max(1, Math.trunc(Number(entry.arena_state?.governance?.max_strategies_per_domain ?? DEFAULT_ARENA_GOVERNANCE.max_strategies_per_domain)));
  const liveForEntropy = entry.strategy_pool.filter((s) => s.status !== "inactive");
  const liveWeights = liveForEntropy.map((s) => {
    const alloc = Number(s.allocation_weight ?? NaN);
    if (Number.isFinite(alloc) && alloc > 0) return alloc;
    return Math.max(0, Number(s.fitness ?? 0));
  });
  const currentEntropy = normalizedEntropy(liveWeights);
  const boostedMax = (currentEntropy < ENTROPY_TARGET_LOW_DOMAIN && govMax < 4) ? 4 : govMax;
  const desiredPoolSize = Math.max(1, Math.min(boostedMax, DEFAULT_ACTIVE_PORTFOLIO_TARGET + DEFAULT_SHADOW_PORTFOLIO_TARGET));
  if (entry.strategy_pool.length >= desiredPoolSize) return;

  const existingLineages = new Set(entry.strategy_pool.map((s) => String(s.lineage_id || "").trim()).filter(Boolean));
  const base = normalizeAdaptiveProfile(entry.best_adaptive_profile);
  let seedIdx = 0;
  while (entry.strategy_pool.length < desiredPoolSize && seedIdx < 16) {
    const d = (seedIdx % 3) - 1; // -1,0,+1
    const candidate = normalizeAdaptiveProfile({
      ...base,
      narrowing_factor: clamp01(Number(base.narrowing_factor ?? 0.9) + (0.03 * d)),
      exploration_bias: clamp01(Number(base.exploration_bias ?? 0.45) + (0.06 * (-d))),
      patience: Math.max(1, Math.trunc(Number(base.patience ?? 3) + d)),
      variance_sensitivity: clamp01(Number(base.variance_sensitivity ?? 0.5) + (0.05 * d)),
    });
    seedIdx += 1;
    const lineageId = strategyLineageIdFromProfile(candidate);
    if (existingLineages.has(lineageId)) continue;
    const activeCount = entry.strategy_pool.filter((s) => s.status === "active").length;
    const status: ArenaStrategyStatus = activeCount < DEFAULT_ACTIVE_PORTFOLIO_TARGET ? "active" : "shadow";
    const seededFitness = Math.max(0, Number(entry.fitness_snapshot ?? 0) * 0.97);
    entry.strategy_pool.push(createStrategyCandidate({
      adaptive_profile: candidate,
      fitness: seededFitness,
      status,
    }));
    existingLineages.add(lineageId);
  }
}

function syncEntrySummary(entry: ResearchMemoryEntry) {
  const strategies = entry.strategy_pool
    .filter((s) => s.status !== "inactive")
    .sort((a, b) => computeArenaStrategyScore(b) - computeArenaStrategyScore(a));
  const best = strategies[0] ?? entry.strategy_pool.sort((a, b) => b.fitness - a.fitness)[0];
  if (best) {
    entry.best_adaptive_profile = normalizeAdaptiveProfile(best.adaptive_profile);
    entry.fitness_snapshot = Number(best.fitness.toFixed(6));
    entry.active_strategy_id = best.strategy_id;
  }
}

function ensureArenaPool(entry: ResearchMemoryEntry) {
  if (!Array.isArray(entry.strategy_pool) || entry.strategy_pool.length === 0) {
    entry.strategy_pool = [createStrategyCandidate({ adaptive_profile: entry.best_adaptive_profile, fitness: entry.fitness_snapshot, status: "active" })];
  }
  entry.strategy_pool = entry.strategy_pool.map(normalizeArenaStrategy);
  ensurePortfolioFloor(entry);
  if (!entry.active_strategy_id || !entry.strategy_pool.some((s) => s.strategy_id === entry.active_strategy_id)) {
    entry.active_strategy_id = entry.strategy_pool.find((s) => s.status === "active")?.strategy_id ?? entry.strategy_pool[0].strategy_id;
  }
  rebalancePortfolioStatuses(entry);
  applySafetyEntropyRebalance(entry);
}

function applySafetyEntropyRebalance(entry: ResearchMemoryEntry) {
  const live = entry.strategy_pool.filter((s) => s.status !== "inactive");
  if (live.length <= 1) return;

  const shadowItems = live.filter((s) => s.status === "shadow");
  const activeItems = live.filter((s) => s.status === "active");
  if (shadowItems.length === 0 || activeItems.length === 0) return;

  const weights = live.map((s) => {
    const alloc = Number(s.allocation_weight ?? NaN);
    if (Number.isFinite(alloc) && alloc > 0) return alloc;
    const selected = Number(s.selection_count_window ?? NaN);
    if (Number.isFinite(selected) && selected > 0) return selected;
    return Math.max(0, Number(s.fitness ?? 0));
  });
  const strategyEntropy = normalizedEntropy(weights);
  if (strategyEntropy > ENTROPY_TARGET_HIGH) return;
  const totalAlloc = live.reduce((acc, s) => acc + Math.max(0, Number(s.allocation_weight ?? 0)), 0);
  const shadowTotal = shadowItems.reduce((acc, s) => acc + Math.max(0, Number(s.allocation_weight ?? 0)), 0);
  const shadowShare = totalAlloc > 0 ? shadowTotal / totalAlloc : 0;
  const needsSafetyRebalance = shadowShare < 0.2 || strategyEntropy < ENTROPY_TARGET_LOW_DOMAIN;
  if (!needsSafetyRebalance) return;

  const targetShadowShare = strategyEntropy < ENTROPY_TARGET_LOW_DOMAIN
    ? Math.max(0.2, SHADOW_TARGET_WHEN_LOW_ENTROPY)
    : 0.2;
  const boundedTargetShadowShare = Math.max(0.2, Math.min(0.5, targetShadowShare));
  const nowIso = isoNow();
  const currentShadowTotal = shadowItems.reduce((acc, s) => acc + Math.max(0, Number(s.allocation_weight ?? 0)), 0);
  const currentActiveTotal = activeItems.reduce((acc, s) => acc + Math.max(0, Number(s.allocation_weight ?? 0)), 0);

  if (shadowItems.length === 1) {
    const loneShadow = shadowItems[0];
    const currentShadow = Math.max(0, Number(loneShadow.allocation_weight ?? 0));
    if (currentShadow + 1e-9 < boundedTargetShadowShare) {
      loneShadow.allocation_weight = Number(boundedTargetShadowShare.toFixed(6));
      loneShadow.allocation_weight_updated_at = nowIso;
    }
  } else if (currentShadowTotal > 0) {
    const scaleShadow = boundedTargetShadowShare / currentShadowTotal;
    for (const s of shadowItems) {
      s.allocation_weight = Number((Math.max(0, Number(s.allocation_weight ?? 0)) * scaleShadow).toFixed(6));
      s.allocation_weight_updated_at = nowIso;
    }
  } else {
    const equalShadow = Number((boundedTargetShadowShare / shadowItems.length).toFixed(6));
    for (const s of shadowItems) {
      s.allocation_weight = equalShadow;
      s.allocation_weight_updated_at = nowIso;
    }
  }

  const remaining = Math.max(0, 1 - boundedTargetShadowShare);
  if (currentActiveTotal > 0) {
    for (const s of activeItems) {
      s.allocation_weight = Number(((Math.max(0, Number(s.allocation_weight ?? 0)) / currentActiveTotal) * remaining).toFixed(6));
      s.allocation_weight_updated_at = nowIso;
    }
  } else {
    const equalActive = Number((remaining / activeItems.length).toFixed(6));
    for (const s of activeItems) {
      s.allocation_weight = equalActive;
      s.allocation_weight_updated_at = nowIso;
    }
  }
}

function selectArenaStrategy(entry: ResearchMemoryEntry, advanceCursor: boolean) {
  ensureArenaPool(entry);
  const stabilization = normalizeStabilizationMode(entry.stabilization_mode);
  if (stabilization) {
    entry.stabilization_mode = stabilization;
  } else {
    entry.stabilization_mode = undefined;
  }
  const now = Date.now();
  const active = entry.strategy_pool.filter((s) => {
    if (s.status !== "active") return false;
    const blockedUntil = Date.parse(String(s.reuse_blocked_until ?? ""));
    if (Number.isFinite(blockedUntil) && blockedUntil > now) return false;
    return true;
  });
  const shadow = entry.strategy_pool.filter((s) => {
    if (s.status !== "shadow") return false;
    const blockedUntil = Date.parse(String(s.reuse_blocked_until ?? ""));
    if (Number.isFinite(blockedUntil) && blockedUntil > now) return false;
    return true;
  });
  const activeShadow = [...active, ...shadow];
  const candidates = stabilization?.active_only
    ? (active.length > 0 ? active : (activeShadow.length > 0 ? activeShadow : entry.strategy_pool.filter((s) => s.status !== "inactive")))
    : (activeShadow.length > 0 ? activeShadow : entry.strategy_pool.filter((s) => s.status !== "inactive"));
  const candidateEntropy = normalizedEntropy(candidates.map((s) => Number(s.allocation_weight ?? s.fitness ?? 0)));
  let entropyBoostTicksRemaining = Math.max(0, Math.trunc(Number(entry.entropy_boost_ticks_remaining ?? 0)));
  if (candidateEntropy < ENTROPY_TARGET_LOW_DOMAIN) {
    entropyBoostTicksRemaining = Math.max(entropyBoostTicksRemaining, 2);
  } else if (candidateEntropy > ENTROPY_BOOST_RELEASE_DOMAIN) {
    entropyBoostTicksRemaining = 0;
  } else if (entropyBoostTicksRemaining > 0) {
    entropyBoostTicksRemaining -= 1;
  }
  entry.entropy_boost_ticks_remaining = entropyBoostTicksRemaining;
  const transferEffs = candidates.map((s) => clamp01(Number(s.transfer_effectiveness ?? 0.5)));
  const transferEffMean = average(transferEffs);
  const domainTransferVariance = variance(transferEffs);
  const annealMode = candidateEntropy > ENTROPY_TARGET_HIGH;
  const annealOvershoot = Math.max(0, candidateEntropy - ENTROPY_TARGET_HIGH);
  const annealStrength = clamp01(annealOvershoot / Math.max(1e-6, (1 - ENTROPY_TARGET_HIGH)));
  const domainConfidence = clamp01(Number.isFinite(Number(entry.last_transfer_confidence))
    ? Number(entry.last_transfer_confidence)
    : transferEffMean);
  const varianceRatio = VARIANCE_TARGET > 0
    ? Math.max(0, (domainTransferVariance - VARIANCE_TARGET) / VARIANCE_TARGET)
    : 0;
  const confidenceGap = TRANSFER_CONFIDENCE_TARGET > 0
    ? Math.max(0, (TRANSFER_CONFIDENCE_TARGET - domainConfidence) / TRANSFER_CONFIDENCE_TARGET)
    : 0;
  let domainVarianceLambda = VARIANCE_PENALTY_LAMBDA
    * (1 + (DOMAIN_VARIANCE_K * Math.min(2, varianceRatio)))
    * (1 + (DOMAIN_CONFIDENCE_K * Math.min(2, confidenceGap)));
  if (entry.domain_signature === DOMAIN_VARIANCE_BOOST_SIGNATURE) {
    domainVarianceLambda *= DOMAIN_VARIANCE_BOOST_MULTIPLIER;
  }
  if (stabilization) {
    domainVarianceLambda *= stabilization.variance_lambda_multiplier;
  }
  domainVarianceLambda = Math.max(
    VARIANCE_PENALTY_LAMBDA * 0.5,
    Math.min(VARIANCE_PENALTY_LAMBDA * 4, domainVarianceLambda),
  );
  const lineageCounts = new Map<string, number>();
  for (const s of candidates) {
    const lineageId = String(s.lineage_id || strategyLineageIdFromProfile(s.adaptive_profile));
    lineageCounts.set(lineageId, (lineageCounts.get(lineageId) ?? 0) + 1);
  }
  const totalCandidates = Math.max(1, candidates.length);

  const weighted = candidates.map((s) => {
    const lineageId = String(s.lineage_id || strategyLineageIdFromProfile(s.adaptive_profile));
    const lineageShare = (lineageCounts.get(lineageId) ?? 1) / totalCandidates;
    const transferEff = clamp01(Number(s.transfer_effectiveness ?? 0.5));
    const winRate = transferEff;
    const convergenceSpeed = clamp01(1 / Math.max(1, Number(s.avg_convergence_steps ?? 1)));
    const stabilityScore = clamp01(Number(s.avg_variance_stability ?? 1));
    const strategyConfidence = clamp01((domainConfidence + transferEff) / 2);
    const confidencePenalty = CONFIDENCE_UTILITY_LAMBDA * Math.max(0, CONFIDENCE_UTILITY_TARGET - strategyConfidence);
    const strategyVariancePenalty = Math.abs(transferEff - transferEffMean);
    const stabilityPenalty = clamp01(1 - Number(s.avg_variance_stability ?? 1));
    const qualityScore = Math.max(1e-6, clamp01(Number(s.fitness ?? 0)))
      * (0.2 + (0.8 * winRate))
      * (0.5 + (0.3 * stabilityScore) + (0.2 * convergenceSpeed));
    const risk = clamp01((domainVarianceLambda * strategyVariancePenalty) + (0.35 * domainTransferVariance) + (0.2 * stabilityPenalty));
    const adjustedFitness = clamp01((qualityScore * (1 - risk)) - confidencePenalty);
    const cappedShadowBase = stabilization
      ? Math.max(0, Math.min(stabilization.shadow_cap, SHADOW_WEIGHT_FLOOR))
      : SHADOW_WEIGHT_FLOOR;
    let baseWeight = s.status === "active" ? 1 : (s.status === "shadow" ? cappedShadowBase : 0.1);
    if (annealMode && s.status === "shadow") {
      baseWeight = Math.max(
        SHADOW_WEIGHT_FLOOR,
        baseWeight * (1 - (ANNEAL_SHADOW_REDUCTION * annealStrength)),
      );
    }
    if (annealMode && s.status === "active") {
      baseWeight = Math.min(1.2, baseWeight + (0.2 * annealStrength));
    }
    let legacyTickets = Math.max(1, Math.round(1 + (10 * adjustedFitness) + (3 * transferEff) + (4 * baseWeight)));
    if (lineageShare > DEFAULT_LINEAGE_CONCENTRATION_CAP) {
      legacyTickets = Math.max(1, Math.round(legacyTickets * (1 - Math.min(0.6, (lineageShare - DEFAULT_LINEAGE_CONCENTRATION_CAP) * 1.5))));
    }
    if (candidateEntropy < ENTROPY_DIVERSITY_TRIGGER) {
      if (s.status === "shadow") legacyTickets += 2;
      if (lineageShare <= (DEFAULT_LINEAGE_CONCENTRATION_CAP / 2)) legacyTickets += 1;
    }
    return {
      strategy: s,
      tickets: legacyTickets,
      legacyTickets,
      adjustedFitness,
      risk,
      baseWeight,
      qualityScore,
    };
  });
  const temp = 4 + (3 * annealStrength);
  const activeAnnealBias = annealMode ? (0.5 * annealStrength) : 0;
  const logits = weighted.map((w) => {
    const statusBias = w.strategy.status === "active"
      ? activeAnnealBias
      : (w.strategy.status === "shadow" ? -activeAnnealBias : -1);
    const logitInput = Math.max(0, (w.adjustedFitness * (1 - w.risk)) + (0.2 * w.baseWeight) + statusBias);
    return Math.exp(logitInput * temp);
  });
  const logitsTotal = Math.max(1e-6, logits.reduce((acc, n) => acc + n, 0));
  const allocUpdatedAt = isoNow();
  for (let i = 0; i < weighted.length; i += 1) {
    const share = logits[i] / logitsTotal;
    weighted[i].strategy.allocation_weight = Number(clamp01(share).toFixed(6));
    weighted[i].strategy.allocation_weight_updated_at = allocUpdatedAt;
  }
  const shadowItems = weighted.filter((w) => w.strategy.status === "shadow");
  const activeItems = weighted.filter((w) => w.strategy.status === "active");
  if (shadowItems.length > 0) {
    const liveCount = Math.max(1, activeItems.length + shadowItems.length);
    const shadowTotal = shadowItems.reduce((acc, w) => acc + Number(w.strategy.allocation_weight ?? 0), 0);
    const highEntropyShadowCap = liveCount <= 3
      ? SHADOW_TARGET_WHEN_HIGH_ENTROPY_MAX3
      : SHADOW_TARGET_WHEN_HIGH_ENTROPY;
    let minShadowTotal = candidateEntropy > ENTROPY_TARGET_HIGH
      ? Math.max(0, Math.min(highEntropyShadowCap, SHADOW_WEIGHT_FLOOR))
      : Math.min(0.49, Math.max(SHADOW_TOTAL_MIN_FLOOR, SHADOW_WEIGHT_FLOOR));
    if (stabilization) {
      minShadowTotal = Math.min(minShadowTotal, Math.max(0, stabilization.shadow_cap));
    }
    let targetShadowShare = shadowTotal;
    if (candidateEntropy > ENTROPY_TARGET_HIGH) {
      targetShadowShare = Math.min(
        targetShadowShare,
        highEntropyShadowCap,
        Math.max(
          SHADOW_WEIGHT_FLOOR,
          SHADOW_TOTAL_CAP_WHEN_ANNEALED - (0.1 * annealStrength),
        ),
      );
      if (stabilization) {
        targetShadowShare = Math.min(targetShadowShare, stabilization.shadow_cap);
      }
    } else if (entropyBoostTicksRemaining > 0) {
      // Anti-collapse hysteresis: keep boost briefly, then release above threshold.
      targetShadowShare = Math.max(targetShadowShare, SHADOW_TARGET_WHEN_LOW_ENTROPY);
    }
    targetShadowShare = Math.max(minShadowTotal, Math.min(0.9, targetShadowShare));
    const shadowFloorPerStrategy = computeShadowFloorPerStrategy(targetShadowShare, shadowItems.length);
    const currentShadowWeights = shadowItems.map((w) => Number(w.strategy.allocation_weight ?? 0));
    let adjustedShadowWeights = applyShadowFloorToTotal(currentShadowWeights, targetShadowShare, shadowFloorPerStrategy);
    if (candidateEntropy > ENTROPY_TARGET_HIGH) {
      const total = adjustedShadowWeights.reduce((acc, n) => acc + Math.max(0, n), 0);
      const hardCap = highEntropyShadowCap;
      if (total > hardCap + 1e-9) {
        const scaled = applyShadowFloorToTotal(adjustedShadowWeights, hardCap, computeShadowFloorPerStrategy(hardCap, shadowItems.length));
        adjustedShadowWeights = scaled;
      }
    }
    for (let i = 0; i < shadowItems.length; i += 1) {
      shadowItems[i].strategy.allocation_weight = Number(adjustedShadowWeights[i].toFixed(6));
      shadowItems[i].strategy.allocation_weight_updated_at = allocUpdatedAt;
    }

    const adjustedShadowTotal = shadowItems.reduce((acc, w) => acc + Number(w.strategy.allocation_weight ?? 0), 0);
    const activeTotal = activeItems.reduce((acc, w) => acc + Number(w.strategy.allocation_weight ?? 0), 0);
    const remaining = Math.max(0, 1 - adjustedShadowTotal);
    if (activeItems.length > 0 && activeTotal > 0) {
      if (annealMode) {
        const skewExp = ACTIVE_SKEW_EXPONENT_HIGH_ENTROPY;
        const skewed = activeItems.map((w) => Math.pow(Math.max(1e-9, Number(w.qualityScore ?? 0)), skewExp));
        const skewedTotal = Math.max(1e-9, skewed.reduce((acc, n) => acc + n, 0));
        const activeWeights = skewed.map((v) => remaining * (v / skewedTotal));
        if (activeItems.length >= 3 && remaining > 0) {
          const topIdx = activeWeights.reduce((bestIdx, w, idx, arr) => (w > arr[bestIdx] ? idx : bestIdx), 0);
          const topShare = activeWeights[topIdx] / remaining;
          if (topShare < TOP_ACTIVE_SHARE_MIN_HIGH_ENTROPY) {
            const desiredTop = remaining * TOP_ACTIVE_SHARE_MIN_HIGH_ENTROPY;
            const othersTotal = Math.max(1e-9, remaining - activeWeights[topIdx]);
            const remainAfterTop = Math.max(0, remaining - desiredTop);
            for (let i = 0; i < activeWeights.length; i += 1) {
              if (i === topIdx) continue;
              activeWeights[i] = remainAfterTop * (activeWeights[i] / othersTotal);
            }
            activeWeights[topIdx] = desiredTop;
          }
        }
        for (let i = 0; i < activeItems.length; i += 1) {
          activeItems[i].strategy.allocation_weight = Number(activeWeights[i].toFixed(6));
          activeItems[i].strategy.allocation_weight_updated_at = allocUpdatedAt;
        }
      } else {
        for (const w of activeItems) {
          w.strategy.allocation_weight = Number((remaining * (Number(w.strategy.allocation_weight ?? 0) / activeTotal)).toFixed(6));
          w.strategy.allocation_weight_updated_at = allocUpdatedAt;
        }
      }
    } else if (activeItems.length > 0) {
      const equalActive = Number((remaining / activeItems.length).toFixed(6));
      for (const w of activeItems) {
        w.strategy.allocation_weight = equalActive;
        w.strategy.allocation_weight_updated_at = allocUpdatedAt;
      }
    }
  }
  for (const s of entry.strategy_pool) {
    if (weighted.some((w) => w.strategy.strategy_id === s.strategy_id)) continue;
    if (s.status === "inactive") {
      if (s.allocation_weight !== 0) s.allocation_weight_updated_at = allocUpdatedAt;
      s.allocation_weight = 0;
      continue;
    }
    const currentAlloc = Number(s.allocation_weight ?? NaN);
    if (!Number.isFinite(currentAlloc) || currentAlloc <= 0) {
      s.allocation_weight = Number((s.status === "shadow" ? SHADOW_WEIGHT_FLOOR : 0.45).toFixed(6));
      s.allocation_weight_updated_at = allocUpdatedAt;
    }
  }
  // Couple selection directly to final allocation distribution so anneal/shadow-cap
  // changes are reflected in strategy choice, not only in telemetry.
  const ticketAlpha = annealMode ? (1 + (1.5 * annealStrength)) : 1;
  for (const w of weighted) {
    const allocation = clamp01(Number(w.strategy.allocation_weight ?? 0));
    const allocationInfluence = Math.pow(allocation, ticketAlpha);
    w.tickets = Math.max(1, Math.round(Math.max(1, Number(w.legacyTickets ?? 1)) * allocationInfluence));
  }
  const totalTickets = Math.max(1, weighted.reduce((acc, it) => acc + it.tickets, 0));
  const cursor = entry.arena_state.last_selected_cursor % totalTickets;
  let rolling = 0;
  let selected = weighted[0]?.strategy ?? entry.strategy_pool[0];
  for (const item of weighted) {
    rolling += item.tickets;
    if (cursor < rolling) {
      selected = item.strategy;
      break;
    }
  }
  if (advanceCursor) {
    entry.arena_state.last_selected_cursor = (entry.arena_state.last_selected_cursor + 1) % totalTickets;
    selected.selection_count_window = Math.max(0, Math.trunc(Number(selected.selection_count_window ?? 0))) + 1;
    for (const s of entry.strategy_pool) {
      if (s.strategy_id === selected.strategy_id) continue;
      s.selection_count_window = Math.max(0, Math.trunc(Math.floor((Number(s.selection_count_window ?? 0)) * 0.9)));
    }
  }
  return selected;
}

function normalizeEntry(input: any): ResearchMemoryEntry {
  const now = isoNow();
  const createdAt = typeof input?.created_at === "string" ? input.created_at : now;
  const strategyAge = Math.max(0, Math.trunc(Number(input?.strategy_age ?? daysSince(createdAt))));
  const strategyPoolRaw = Array.isArray(input?.strategy_pool) ? input.strategy_pool : [];
  const poolFromLegacy = strategyPoolRaw.length > 0
    ? strategyPoolRaw
    : [{
      strategy_id: `stg_${randomUUID()}`,
      version_id: "v_legacy",
      adaptive_profile: normalizeAdaptiveProfile(input?.best_adaptive_profile),
      fitness: Number(input?.fitness_snapshot ?? 0),
      experiments_count: Math.max(1, Math.trunc(Number(input?.experiment_count ?? 1))),
      avg_convergence_steps: 0,
      avg_variance_stability: 1,
      transfer_effectiveness: 0.5,
      status: "active",
      created_at: createdAt,
      updated_at: typeof input?.last_updated_at === "string" ? input.last_updated_at : now,
      last_used_at: typeof input?.last_used_at === "string" ? input.last_used_at : now,
      selection_count_window: 0,
      allocation_weight: 1,
    }];

  const entry: ResearchMemoryEntry = {
    domain_signature: typeof input?.domain_signature === "string"
      ? input.domain_signature
      : computeDomainSignature(input?.domain_profile),
    domain_profile: normalizeDomainProfile(input?.domain_profile),
    best_adaptive_profile: normalizeAdaptiveProfile(input?.best_adaptive_profile),
    fitness_snapshot: Number(input?.fitness_snapshot ?? 0),
    experiment_count: Math.max(0, Math.trunc(Number(input?.experiment_count ?? 0))),
    strategy_age: strategyAge,
    success_streak: Math.max(0, Math.trunc(Number(input?.success_streak ?? 0))),
    failure_streak: Math.max(0, Math.trunc(Number(input?.failure_streak ?? 0))),
    last_used_at: typeof input?.last_used_at === "string" ? input.last_used_at : now,
    last_updated_at: typeof input?.last_updated_at === "string" ? input.last_updated_at : now,
    created_at: createdAt,
    strategy_pool: poolFromLegacy.map(normalizeArenaStrategy),
    active_strategy_id: typeof input?.active_strategy_id === "string" ? input.active_strategy_id : undefined,
    arena_state: normalizeArenaState(input?.arena_state),
    last_success_at: typeof input?.last_success_at === "string" ? input.last_success_at : undefined,
    reuse_blocked_until: typeof input?.reuse_blocked_until === "string" ? input.reuse_blocked_until : undefined,
    last_transfer_confidence: Number.isFinite(Number(input?.last_transfer_confidence))
      ? Number(input.last_transfer_confidence)
      : undefined,
    last_evidence_confidence: Number.isFinite(Number(input?.last_evidence_confidence))
      ? Number(input.last_evidence_confidence)
      : undefined,
    transfer_evidence: normalizeTransferEvidence(input?.transfer_evidence),
    last_experiment_id: typeof input?.last_experiment_id === "string" ? input.last_experiment_id : undefined,
    stabilization_mode: normalizeStabilizationMode(input?.stabilization_mode),
    micro_impact_cooldown_ticks_remaining: Math.max(
      0,
      Math.trunc(Number(input?.micro_impact_cooldown_ticks_remaining ?? 0)),
    ),
    last_micro_impact_tick_index: Number.isFinite(Number(input?.last_micro_impact_tick_index))
      ? Math.trunc(Number(input.last_micro_impact_tick_index))
      : undefined,
    micro_impact_cap_multiplier: Number.isFinite(Number(input?.micro_impact_cap_multiplier))
      ? clamp01(Number(input.micro_impact_cap_multiplier))
      : undefined,
    transfer_variance_short_window: normalizeNumberWindow(input?.transfer_variance_short_window, TRANSFER_VARIANCE_SHORT_WINDOW),
    transfer_variance_ultra_window: normalizeNumberWindow(input?.transfer_variance_ultra_window, TRANSFER_VARIANCE_ULTRA_WINDOW),
    micro_impact_budget_window: normalizeNumberWindow(input?.micro_impact_budget_window, TRANSFER_MICRO_BUDGET_WINDOW),
    entropy_boost_ticks_remaining: Math.max(0, Math.trunc(Number(input?.entropy_boost_ticks_remaining ?? 0))),
  };
  ensureArenaPool(entry);
  syncEntrySummary(entry);
  return entry;
}

async function loadStore(syncDir: string): Promise<ResearchMemoryStore> {
  await ensureLayout(syncDir);
  try {
    const raw = await fs.readFile(memoryFile(syncDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<ResearchMemoryStore>;
    const itemsRaw = Array.isArray(parsed.items) ? parsed.items : [];
    const items = itemsRaw.filter((item: any) => item && typeof item === "object").map(normalizeEntry);
    return {
      version: 1,
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : isoNow(),
      items,
      domain_state: normalizeDomainStateRecord((parsed as any).domain_state),
    };
  } catch {
    return {
      version: 1,
      updated_at: isoNow(),
      items: [],
      domain_state: {},
    };
  }
}

type PruneStats = {
  before: number;
  after: number;
  removed_low_score: number;
  removed_lru_low_fitness: number;
  max_entries: number;
};

function pruneMemoryEntries(store: ResearchMemoryStore, maxEntries = DEFAULT_MAX_MEMORY_ENTRIES, minTransferScore = DEFAULT_MIN_TRANSFER_SCORE): PruneStats {
  const before = store.items.length;
  const now = Date.now();
  const lowScoreCandidates = store.items.filter((item) => {
    const score = memoryTransferScore(item);
    const oldEnough = daysSince(item.last_updated_at) >= 3;
    return score < minTransferScore && oldEnough;
  });
  const lowScoreSet = new Set(lowScoreCandidates.map((x) => x.domain_signature));
  let items = store.items.filter((x) => !lowScoreSet.has(x.domain_signature));
  const removedLowScore = before - items.length;

  if (items.length > maxEntries) {
    const ranked = [...items].sort((a, b) => {
      const fa = applyFitnessDecay(a.fitness_snapshot, a.last_updated_at);
      const fb = applyFitnessDecay(b.fitness_snapshot, b.last_updated_at);
      if (fa !== fb) return fa - fb;
      const ua = Date.parse(a.last_used_at || a.last_updated_at);
      const ub = Date.parse(b.last_used_at || b.last_updated_at);
      return (Number.isFinite(ua) ? ua : now) - (Number.isFinite(ub) ? ub : now);
    });
    const removeCount = Math.max(0, ranked.length - maxEntries);
    const evict = new Set(ranked.slice(0, removeCount).map((x) => x.domain_signature));
    items = ranked.filter((x) => !evict.has(x.domain_signature));
  }
  const removedLru = before - removedLowScore - items.length;
  store.items = items;
  return {
    before,
    after: items.length,
    removed_low_score: removedLowScore,
    removed_lru_low_fitness: removedLru,
    max_entries: maxEntries,
  };
}

async function saveStore(syncDir: string, store: ResearchMemoryStore, maxEntries = DEFAULT_MAX_MEMORY_ENTRIES) {
  const pruneStats = pruneMemoryEntries(store, maxEntries);
  store.updated_at = isoNow();
  await safeAtomicWrite({
    targetPath: memoryFile(syncDir),
    content: JSON.stringify(store, null, 2),
    retries: 12,
    baseDelayMs: 20,
    useLockFile: true,
  });
  return pruneStats;
}

function paramCountSimilarity(a: number, b: number) {
  const maxVal = Math.max(1, a, b);
  const diff = Math.abs(a - b);
  return clamp01(1 - (diff / maxVal));
}

export function computeDomainSignature(profileInput: TransferDomainProfile): string {
  const p = normalizeDomainProfile(profileInput);
  const paramBucket =
    p.param_count <= 2 ? "p2" :
      p.param_count <= 5 ? "p5" :
        p.param_count <= 8 ? "p8" : "p9p";
  return `${p.size_category}|${p.search_complexity}|${p.metric_noise}|${paramBucket}`;
}

// Encode domain signature for safe filenames
export function encodeDomainSignature(domainSignature: string): string {
  return domainSignature.replace(/\|/g, '_');
}

// Generate safe filename for operations
export function generateSafeFilename(operation: string, domainSignature: string, timestamp: string): string {
  const safeDomain = encodeDomainSignature(domainSignature);
  return `${operation}-${safeDomain}-${timestamp}`;
}

export function computeDomainSimilarity(
  aInput: TransferDomainProfile,
  bInput: TransferDomainProfile,
  weights?: Partial<DomainSimilarityWeights>
) {
  const a = normalizeDomainProfile(aInput);
  const b = normalizeDomainProfile(bInput);
  const w = normalizeWeights(weights);
  const components = {
    param_count_similarity: paramCountSimilarity(a.param_count, b.param_count),
    size_category_match: a.size_category === b.size_category ? 1 : 0,
    search_complexity_match: a.search_complexity === b.search_complexity ? 1 : 0,
    metric_noise_similarity: clamp01(1 - Math.abs(noiseToScale(a.metric_noise) - noiseToScale(b.metric_noise))),
  };
  const score =
    (w.param_count_similarity * components.param_count_similarity) +
    (w.size_category_match * components.size_category_match) +
    (w.search_complexity_match * components.search_complexity_match) +
    (w.metric_noise_similarity * components.metric_noise_similarity);
  return {
    score: Number(score.toFixed(6)),
    components,
    weights: w,
  };
}

function computeTransferConfidence(similarityScore: number, entry: ResearchMemoryEntry, strategy: ResearchArenaStrategy) {
  const fitnessFactor = clamp01(Math.max(0, applyFitnessDecay(strategy.fitness, strategy.updated_at)));
  const recent = recencyFactor(strategy.last_used_at || entry.last_used_at || entry.last_updated_at);
  const stable = domainStability(entry.domain_profile);
  const aging = strategyAgingFactor(entry);
  return {
    transfer_confidence: clamp01(similarityScore * fitnessFactor * recent * stable * aging),
    factors: {
      similarity_score: Number(similarityScore.toFixed(6)),
      fitness_factor: Number(fitnessFactor.toFixed(6)),
      recency_factor: Number(recent.toFixed(6)),
      domain_stability: Number(stable.toFixed(6)),
      aging_factor: Number(aging.toFixed(6)),
    },
  };
}

function evaluateArenaEntry(entry: ResearchMemoryEntry) {
  const now = Date.now();
  const governance = entry.arena_state.governance;
  const lastEvaluated = Date.parse(String(entry.arena_state.last_evaluated_at ?? ""));
  const cooldownActive = Number.isFinite(lastEvaluated) && ((now - lastEvaluated) < governance.arena_cooldown_ms);
  if (cooldownActive || entry.arena_state.experiments_since_last_eval < governance.arena_evaluation_window) {
    return { evaluated: false as const, reason: cooldownActive ? "cooldown" : "window_not_reached" };
  }

  ensureArenaPool(entry);
  const candidates = entry.strategy_pool.filter((s) => s.status !== "inactive");
  const ranked = [...candidates]
    .map((s) => ({
      strategy: s,
      arena_score: computeArenaStrategyScore(s),
    }))
    .sort((a, b) => b.arena_score - a.arena_score);
  if (ranked.length === 0) {
    return { evaluated: false as const, reason: "no_candidates" };
  }
  const decisions: Array<Record<string, any>> = [];

  const nonInactive = entry.strategy_pool.filter((s) => s.status !== "inactive");
  if (nonInactive.length > 1) {
    const maxPerLineage = Math.max(1, Math.floor(nonInactive.length * DEFAULT_LINEAGE_CONCENTRATION_CAP));
    const byLineage = new Map<string, ResearchArenaStrategy[]>();
    for (const s of nonInactive) {
      const lineageId = String(s.lineage_id || strategyLineageIdFromProfile(s.adaptive_profile));
      const list = byLineage.get(lineageId) ?? [];
      list.push(s);
      byLineage.set(lineageId, list);
    }
    for (const [lineageId, list] of byLineage.entries()) {
      if (list.length <= maxPerLineage) continue;
      const sorted = [...list].sort((a, b) => computeArenaStrategyScore(a) - computeArenaStrategyScore(b));
      const demoteCount = list.length - maxPerLineage;
      for (let i = 0; i < demoteCount; i += 1) {
        const victim = sorted[i];
        victim.status = "inactive";
        decisions.push({
          strategy_id: victim.strategy_id,
          decision: "lineage_cap_deactivate",
          lineage_id: lineageId,
        });
      }
    }
  }

  const winner = ranked[0];
  const beforeStatus = new Map(entry.strategy_pool.map((s) => [s.strategy_id, s.status]));
  rebalancePortfolioStatuses(entry);
  for (const item of ranked) {
    const prev = beforeStatus.get(item.strategy.strategy_id);
    if (prev !== item.strategy.status) {
      decisions.push({
        strategy_id: item.strategy.strategy_id,
        decision: "portfolio_rebalance",
        from_status: prev ?? null,
        to_status: item.strategy.status,
        arena_score: item.arena_score,
      });
    }
  }

  const maxPool = governance.max_strategies_per_domain;
  if (entry.strategy_pool.length > maxPool) {
    const removable = [...entry.strategy_pool].sort((a, b) => {
      const sa = a.status === "inactive" ? 0 : (a.status === "shadow" ? 1 : 2);
      const sb = b.status === "inactive" ? 0 : (b.status === "shadow" ? 1 : 2);
      if (sa !== sb) return sa - sb;
      return computeArenaStrategyScore(a) - computeArenaStrategyScore(b);
    });
    const removeCount = Math.max(0, entry.strategy_pool.length - maxPool);
    const removeSet = new Set(removable.slice(0, removeCount).map((x) => x.strategy_id));
    entry.strategy_pool = entry.strategy_pool.filter((x) => !removeSet.has(x.strategy_id));
    decisions.push({ decision: "pool_prune", removed_count: removeCount });
    rebalancePortfolioStatuses(entry);
  }

  entry.arena_state.last_evaluated_at = isoNow();
  entry.arena_state.experiments_since_last_eval = 0;
  syncEntrySummary(entry);

  return {
    evaluated: true as const,
    domain_signature: entry.domain_signature,
    winner_strategy_id: winner.strategy.strategy_id,
    decisions,
  };
}

export async function researchMemoryFindSimilar(opts: {
  syncDir: string;
  domain_profile: TransferDomainProfile;
  threshold?: number;
  weights?: Partial<DomainSimilarityWeights>;
  mark_used?: boolean;
}) {
  return withLock(opts.syncDir, async () => {
    const threshold = Math.max(0, Math.min(1, Number(opts.threshold ?? DEFAULT_TRANSFER_CONFIDENCE_THRESHOLD)));
    const incoming = normalizeDomainProfile(opts.domain_profile);
    const store = await loadStore(opts.syncDir);
    let best: {
      entry: ResearchMemoryEntry;
      selected_strategy: ResearchArenaStrategy;
      similarity_score: number;
      transfer_score: number;
      transfer_confidence: number;
      confidence_factors: ReturnType<typeof computeTransferConfidence>["factors"];
      breakdown: ReturnType<typeof computeDomainSimilarity>;
    } | null = null;

    for (const entry of store.items) {
      const blockedUntil = Date.parse(String(entry.reuse_blocked_until ?? ""));
      if (Number.isFinite(blockedUntil) && blockedUntil > Date.now()) continue;

      const selectedStrategy = selectArenaStrategy(entry, false);
      const strategyBlocked = Date.parse(String(selectedStrategy.reuse_blocked_until ?? ""));
      if (Number.isFinite(strategyBlocked) && strategyBlocked > Date.now()) continue;

      const breakdown = computeDomainSimilarity(incoming, entry.domain_profile, opts.weights);
      const similarity = breakdown.score;
      const transferScore = memoryTransferScore(entry);
      const confidence = computeTransferConfidence(similarity, entry, selectedStrategy);
      if (!best || confidence.transfer_confidence > best.transfer_confidence) {
        best = {
          entry,
          selected_strategy: selectedStrategy,
          similarity_score: similarity,
          transfer_score: transferScore,
          transfer_confidence: confidence.transfer_confidence,
          confidence_factors: confidence.factors,
          breakdown,
        };
      }
    }

    if (!best || best.transfer_confidence < threshold) {
      return {
        reused: false as const,
        threshold,
        candidate_count: store.items.length,
        match: null,
      };
    }

    if (opts.mark_used ?? true) {
      const selected = selectArenaStrategy(best.entry, true);
      selected.last_used_at = isoNow();
      best.entry.last_used_at = selected.last_used_at;
      best.entry.last_transfer_confidence = best.transfer_confidence;
      best.entry.strategy_age = Math.max(0, Math.trunc(daysSince(best.entry.created_at)));
      syncEntrySummary(best.entry);
      await saveStore(opts.syncDir, store);
    }

    return {
      reused: true as const,
      threshold,
      candidate_count: store.items.length,
      match: {
        domain_signature: best.entry.domain_signature,
        domain_profile: best.entry.domain_profile,
        best_adaptive_profile: best.selected_strategy.adaptive_profile,
        fitness_snapshot: best.entry.fitness_snapshot,
        experiment_count: best.entry.experiment_count,
        strategy_age: best.entry.strategy_age,
        success_streak: best.entry.success_streak,
        strategy_id: best.selected_strategy.strategy_id,
        strategy_version_id: best.selected_strategy.version_id,
        similarity_score: best.similarity_score,
        transfer_score: best.transfer_score,
        transfer_confidence: best.transfer_confidence,
        confidence_factors: best.confidence_factors,
        similarity_breakdown: best.breakdown.components,
      },
    };
  });
}

function detectExperimentAnomaly(input?: {
  variance_stability?: number;
  improvement_delta?: number;
  convergence_steps?: number;
  best_score_trend?: number;
  completed_runs?: number;
}): { suspect: boolean; flags: ExperimentAnomalyFlags } {
  const varianceStability = Number(input?.variance_stability ?? 1);
  const improvement = Number(input?.improvement_delta ?? 0);
  const conv = Math.max(0, Number(input?.convergence_steps ?? 0));
  const trend = Math.abs(Number(input?.best_score_trend ?? 0));
  const completed = Math.max(0, Number(input?.completed_runs ?? 0));
  const expectedScale = Math.max(0.0001, trend * Math.max(1, conv));
  const flags: ExperimentAnomalyFlags = {
    extreme_variance: varianceStability < 0.32,
    unexpected_fitness_spike: improvement > Math.max(1.5, expectedScale * 6),
    too_fast_convergence: conv > 0 && conv <= 2 && completed >= 2 && improvement > 0.05,
  };
  return {
    suspect: flags.extreme_variance || flags.unexpected_fitness_spike || flags.too_fast_convergence,
    flags,
  };
}

export async function researchMemoryUpsertFromOutcome(opts: {
  syncDir: string;
  experiment_id: string;
  domain_profile: TransferDomainProfile;
  adaptive_profile: AdaptiveStrategyProfile;
  research_fitness: number;
  min_fitness_to_store?: number;
  strategy_context?: {
    domain_signature?: string;
    strategy_id?: string;
    strategy_version_id?: string;
    transfer_confidence?: number;
    transfer_initialized?: boolean;
    tick_index?: number;
    tick_id?: string;
    campaign_id?: string;
  };
  experiment_metrics?: {
    variance_stability?: number;
    improvement_delta?: number;
    convergence_steps?: number;
    best_score_trend?: number;
    completed_runs?: number;
  };
}) {
  return withLock(opts.syncDir, async () => {
    const minFitnessToStore = Number(opts.min_fitness_to_store ?? DEFAULT_FITNESS_TO_STORE);
    const fitness = Number(opts.research_fitness);
    const incomingProfile = normalizeDomainProfile(opts.domain_profile);
    const incomingAdaptive = normalizeAdaptiveProfile(opts.adaptive_profile);
    const signature = computeDomainSignature(incomingProfile);
    const store = await loadStore(opts.syncDir);
    const now = isoNow();
    const anomaly = detectExperimentAnomaly(opts.experiment_metrics);
    const existing = store.items.find((item) => item.domain_signature === signature);
    const transferInitialized = Boolean(opts.strategy_context?.transfer_initialized);
    const incomingTransferConfidenceRaw = Number(opts.strategy_context?.transfer_confidence ?? NaN);

    if (anomaly.suspect) {
      return {
        updated: false as const,
        reason: "suspect_experiment_anomaly",
        anomaly_flags: anomaly.flags,
        require_recheck: true,
        fallback_profile: existing?.best_adaptive_profile ?? null,
      };
    }

    if (!Number.isFinite(fitness) || fitness < minFitnessToStore) {
      if (existing) {
        existing.failure_streak += 1;
        existing.success_streak = 0;
        existing.strategy_age = Math.max(0, Math.trunc(daysSince(existing.created_at)));
        existing.last_updated_at = now;
        const prune = await saveStore(opts.syncDir, store);
        return {
          updated: false as const,
          reason: "fitness_below_threshold",
          threshold: minFitnessToStore,
          pruning: prune,
        };
      }
      return {
        updated: false as const,
        reason: "fitness_below_threshold",
        threshold: minFitnessToStore,
      };
    }

    if (!existing) {
      const initialEvidence = transferInitialized
        ? computeNextTransferEvidence({
          previous: undefined,
          match_confidence: clamp01(
            Number.isFinite(incomingTransferConfidenceRaw)
              ? incomingTransferConfidenceRaw
              : 0
          ),
          success: true,
          now,
        })
        : null;
      const created: ResearchMemoryEntry = normalizeEntry({
        domain_signature: signature,
        domain_profile: incomingProfile,
        best_adaptive_profile: incomingAdaptive,
        fitness_snapshot: Number(fitness.toFixed(6)),
        experiment_count: 1,
        strategy_age: 0,
        success_streak: 1,
        failure_streak: 0,
        last_used_at: now,
        last_updated_at: now,
        created_at: now,
        last_success_at: now,
        last_transfer_confidence: initialEvidence?.next?.ema_match_conf,
        last_evidence_confidence: initialEvidence?.evidence_confidence,
        transfer_evidence: initialEvidence?.next,
        last_experiment_id: opts.experiment_id,
        strategy_pool: [createStrategyCandidate({ adaptive_profile: incomingAdaptive, fitness, status: "active" })],
        arena_state: normalizeArenaState(),
      });
      const arenaEval = evaluateArenaEntry(created);
      store.items.push(created);
      const prune = await saveStore(opts.syncDir, store);
      return {
        updated: true as const,
        action: "created",
        entry: created,
        arena: arenaEval,
        pruning: prune,
      };
    }

    ensureArenaPool(existing);
    const domainObservationCount = Math.max(0, Math.trunc(Number(existing.experiment_count ?? 0)));
    const domainMatchConfidence = clamp01(
      Number.isFinite(incomingTransferConfidenceRaw)
        ? incomingTransferConfidenceRaw
        : Number(existing.last_transfer_confidence ?? 0)
    );
    const domainTransferVariance = variance(
      existing.strategy_pool
        .filter((s) => s.status !== "inactive")
        .map((s) => Number(s.transfer_effectiveness ?? 0.5))
    );
    const existingShortWindow = normalizeNumberWindow(
      existing.transfer_variance_short_window,
      TRANSFER_VARIANCE_SHORT_WINDOW,
    );
    const existingUltraWindow = normalizeNumberWindow(
      existing.transfer_variance_ultra_window,
      TRANSFER_VARIANCE_ULTRA_WINDOW,
    );
    const transferSignal = clamp01(
      Number.isFinite(incomingTransferConfidenceRaw)
        ? incomingTransferConfidenceRaw
        : Number(existing.last_transfer_confidence ?? 0),
    );
    const varianceShortWindow = pushNumberWindow(existingShortWindow, transferSignal, TRANSFER_VARIANCE_SHORT_WINDOW);
    const varianceUltraWindow = pushNumberWindow(existingUltraWindow, transferSignal, TRANSFER_VARIANCE_ULTRA_WINDOW);
    const rollingVarianceShort = variance(varianceShortWindow);
    const rollingVarianceUltra = variance(varianceUltraWindow);
    const rollingVarianceTrend = Number((rollingVarianceUltra - rollingVarianceShort).toFixed(6));
    existing.transfer_variance_short_window = varianceShortWindow;
    existing.transfer_variance_ultra_window = varianceUltraWindow;
    const experimentVarianceStability = clamp01(Number(opts.experiment_metrics?.variance_stability ?? 1));
    const varianceHard = domainTransferVariance >= TRANSFER_MICRO_IMPACT_VARIANCE_HARD
      || rollingVarianceShort >= TRANSFER_MICRO_IMPACT_VARIANCE_HARD
      || rollingVarianceUltra >= (TRANSFER_MICRO_IMPACT_VARIANCE_HARD + 0.02)
      || experimentVarianceStability < 0.32;
    const varianceSoft = domainTransferVariance >= TRANSFER_MICRO_IMPACT_VARIANCE_SOFT
      || rollingVarianceShort >= TRANSFER_MICRO_IMPACT_VARIANCE_SOFT
      || rollingVarianceUltra >= (TRANSFER_MICRO_IMPACT_VARIANCE_SOFT + 0.01)
      || experimentVarianceStability < 0.5;
    let microImpactCooldownTicksRemaining = Math.max(
      0,
      Math.trunc(Number(existing.micro_impact_cooldown_ticks_remaining ?? 0)),
    );
    if (microImpactCooldownTicksRemaining > 0) microImpactCooldownTicksRemaining -= 1;
    if (varianceHard) {
      microImpactCooldownTicksRemaining = Math.max(
        microImpactCooldownTicksRemaining,
        TRANSFER_MICRO_IMPACT_COOLDOWN_HARD_TICKS,
      );
    } else if (varianceSoft) {
      microImpactCooldownTicksRemaining = Math.max(
        microImpactCooldownTicksRemaining,
        TRANSFER_MICRO_IMPACT_COOLDOWN_SOFT_TICKS,
      );
    }
    const microImpactCooldownActive = microImpactCooldownTicksRemaining > 0;
    const currentTickIndex = Number(opts.strategy_context?.tick_index ?? NaN);
    const domainState = getDomainState(store, signature);
    const lastMicroImpactTickIndex = Number(domainState.last_micro_impact_tick_index ?? NaN);
    const microDomainCooldownTicks = 1;
    const microDomainTickCooldown = Number.isFinite(currentTickIndex)
      && Number.isFinite(lastMicroImpactTickIndex)
      && (Math.trunc(currentTickIndex) - Math.trunc(lastMicroImpactTickIndex)) >= 0
      && (Math.trunc(currentTickIndex) - Math.trunc(lastMicroImpactTickIndex)) <= microDomainCooldownTicks;
    const domainCapMultiplier = clamp01(
      Math.max(
        0.2,
        Math.min(
          1,
          Math.exp(-TRANSFER_MICRO_IMPACT_VARIANCE_K * Math.max(0, domainTransferVariance - TRANSFER_MICRO_IMPACT_VARIANCE_SOFT)),
        ),
      ),
    );
    const globalCapMultiplier = (
      existing.stabilization_mode
      || rollingVarianceTrend > 0.02
      || rollingVarianceUltra > rollingVarianceShort
    ) ? 0.5 : 1;
    const microImpactCapMultiplier = clamp01(
      Math.max(0.2, Math.min(1, domainCapMultiplier * globalCapMultiplier)),
    );
    const microImpactCapUsed = Number((TRANSFER_MICRO_IMPACT_CAP * microImpactCapMultiplier).toFixed(6));
    existing.micro_impact_cap_multiplier = microImpactCapMultiplier;
    existing.micro_impact_cooldown_ticks_remaining = microImpactCooldownTicksRemaining;
    const existingEvidenceObs = Math.max(0, Math.trunc(Number(existing.transfer_evidence?.obs ?? 0)));
    const existingEvidenceStrength = clamp01(Number(existing.last_evidence_confidence ?? 0));
    const hardEvidenceGatePre = transferInitialized
      && (
        domainMatchConfidence < TRANSFER_MATCH_CONF_MIN_FULL
        || existingEvidenceStrength < TRANSFER_EVIDENCE_STRENGTH_MIN
        || existingEvidenceObs < TRANSFER_EVIDENCE_MIN_OBS
      );

    const targetStrategy = (() => {
      const ctxId = opts.strategy_context?.strategy_id;
      if (typeof ctxId === "string") {
        const found = existing.strategy_pool.find((s) => s.strategy_id === ctxId);
        if (found) return found;
      }
      const key = JSON.stringify(incomingAdaptive);
      const same = existing.strategy_pool.find((s) => JSON.stringify(s.adaptive_profile) === key);
      if (same) return same;
      return null;
    })();

    let strategy = targetStrategy;
    let replicationGuardReason: string | null = null;
    const stabilization = normalizeStabilizationMode(existing.stabilization_mode);
    if (stabilization) {
      existing.stabilization_mode = stabilization;
    } else {
      existing.stabilization_mode = undefined;
    }
    if (!strategy) {
      const gov = existing.arena_state.governance;
      const nonInactive = existing.strategy_pool.filter((s) => s.status !== "inactive");
      const incomingLineageId = strategyLineageIdFromProfile(incomingAdaptive);
      const sameLineage = nonInactive.filter((s) => s.lineage_id === incomingLineageId);
      const lineageShare = nonInactive.length > 0 ? sameLineage.length / nonInactive.length : 0;
      const lastReplicationAt = existing.arena_state.lineage_last_replication_at[incomingLineageId];
      const lastReplicationTs = Date.parse(String(lastReplicationAt ?? ""));
      const replicationCooldownActive = Number.isFinite(lastReplicationTs)
        && (Date.now() - lastReplicationTs) < DEFAULT_LINEAGE_REPLICATION_COOLDOWN_MS;

      if (hardEvidenceGatePre) {
        strategy = [...nonInactive]
          .filter((s) => s.status === "active")
          .sort((a, b) => computeArenaStrategyScore(b) - computeArenaStrategyScore(a))[0]
          ?? [...nonInactive].sort((a, b) => computeArenaStrategyScore(b) - computeArenaStrategyScore(a))[0]
          ?? null;
        replicationGuardReason = "transfer_evidence_gate_no_replication";
      } else if (stabilization?.freeze_novelty) {
        strategy = [...nonInactive]
          .filter((s) => s.status === "active")
          .sort((a, b) => computeArenaStrategyScore(b) - computeArenaStrategyScore(a))[0]
          ?? [...nonInactive].sort((a, b) => computeArenaStrategyScore(b) - computeArenaStrategyScore(a))[0]
          ?? null;
        replicationGuardReason = "freeze_novelty_circuit_breaker";
      } else if (lineageShare >= DEFAULT_LINEAGE_CONCENTRATION_CAP || replicationCooldownActive) {
        strategy = [...sameLineage].sort((a, b) => computeArenaStrategyScore(b) - computeArenaStrategyScore(a))[0]
          ?? [...nonInactive].sort((a, b) => computeArenaStrategyScore(b) - computeArenaStrategyScore(a))[0]
          ?? null;
        replicationGuardReason = lineageShare >= DEFAULT_LINEAGE_CONCENTRATION_CAP
          ? "lineage_concentration_cap"
          : "lineage_replication_cooldown";
      } else if (existing.strategy_pool.length < gov.max_strategies_per_domain) {
        strategy = createStrategyCandidate({ adaptive_profile: incomingAdaptive, fitness, status: "active" });
        existing.strategy_pool.push(strategy);
        existing.arena_state.lineage_last_replication_at[strategy.lineage_id] = now;
      } else {
        strategy = createStrategyCandidate({ adaptive_profile: incomingAdaptive, fitness, status: "shadow" });
        existing.strategy_pool.push(strategy);
        existing.arena_state.lineage_last_replication_at[strategy.lineage_id] = now;
      }
    }
    if (!strategy) {
      strategy = existing.strategy_pool[0] ?? createStrategyCandidate({ adaptive_profile: incomingAdaptive, fitness, status: "active" });
      if (!existing.strategy_pool.some((s) => s.strategy_id === strategy?.strategy_id)) {
        existing.strategy_pool.push(strategy);
      }
      replicationGuardReason = replicationGuardReason ?? "fallback_existing_strategy";
    }

    const previousDecayedFitness = applyFitnessDecay(strategy.fitness, strategy.updated_at);
    const baselinePool = existing.strategy_pool
      .filter((s) => s.status !== "inactive")
      .map((s) => applyFitnessDecay(s.fitness, s.updated_at));
    baselinePool.push(applyFitnessDecay(existing.fitness_snapshot, existing.last_updated_at));
    const domainBaseline = median(baselinePool);
    const baselineMad = mad(baselinePool);
    const successMarginUsed = Math.max(
      TRANSFER_SUCCESS_MARGIN,
      1.25 * baselineMad,
      0.04 * Math.max(0.1, domainBaseline),
    );
    // Micro success signal is intentionally more permissive than the full gate.
    // Goal: let evidence_strength grow with observations even before we can clear full thresholds.
    const microSuccessMarginUsed = Math.max(
      TRANSFER_SUCCESS_MARGIN,
      0.9 * baselineMad,
      0.02 * Math.max(0.1, domainBaseline),
      0.02 * Math.max(0.1, previousDecayedFitness),
    );

    const microImpactMarginUsed = Math.max(
      TRANSFER_SUCCESS_MARGIN,
      1.0 * baselineMad,
      0.03 * Math.max(0.1, domainBaseline),
      0.06 * Math.max(0.1, previousDecayedFitness),
    );
    const microImpactFloor = previousDecayedFitness - microImpactMarginUsed;
    const impactAllowedMicro = Number.isFinite(fitness)
      && fitness >= microImpactFloor;
    const transferSuccessSignalFull = Number.isFinite(fitness)
      && fitness >= (domainBaseline - successMarginUsed);
    const transferSuccessSignalMicro = Number.isFinite(fitness)
      && fitness >= (previousDecayedFitness - microSuccessMarginUsed);
    const transferSuccessSignal = transferInitialized
      ? (transferSuccessSignalFull || transferSuccessSignalMicro)
      : true;
    const nextEvidence = transferInitialized
      ? computeNextTransferEvidence({
        previous: existing.transfer_evidence,
        match_confidence: domainMatchConfidence,
        success: transferSuccessSignal,
        now,
      })
      : null;
    const domainEvidenceObs = transferInitialized
      ? Math.max(0, Math.trunc(Number(nextEvidence?.next.obs ?? existing.transfer_evidence?.obs ?? 0)))
      : domainObservationCount;
    const domainEvidenceStrength = transferInitialized
      ? clamp01(Number(nextEvidence?.evidence_confidence ?? existing.last_evidence_confidence ?? 0))
      : 1;
    const matchGateOkMicro = !transferInitialized || domainMatchConfidence >= TRANSFER_MATCH_CONF_MIN_MICRO;
    const matchGateOkFull = !transferInitialized || domainMatchConfidence >= TRANSFER_MATCH_CONF_MIN_FULL;
    const evidenceStrengthGateOk = !transferInitialized || domainEvidenceStrength >= TRANSFER_EVIDENCE_STRENGTH_MIN;
    const microMin = microEvidenceMin(domainEvidenceObs, TRANSFER_EVIDENCE_MIN_OBS);
    const microEvidenceGateOk = !transferInitialized || domainEvidenceStrength >= microMin;
    const microGateSignalName = "evidence_confidence";
    const microGateSignalValue = Number(domainEvidenceStrength.toFixed(6));
    const microGateThreshold = Number(microMin.toFixed(6));
    const observationsGateOk = !transferInitialized || domainEvidenceObs >= TRANSFER_EVIDENCE_MIN_OBS;
    const matchGateFailedMicro = !matchGateOkMicro;
    const matchGateFailedFull = !matchGateOkFull;
    const evidenceStrengthGateFailedFull = !evidenceStrengthGateOk;
    const evidenceStrengthGateFailedMicro = !microEvidenceGateOk;
    const observationsGateFailed = !observationsGateOk;
    const hardMicroImpactGate = transferInitialized
      && (matchGateFailedMicro || evidenceStrengthGateFailedMicro || observationsGateFailed);
    const hardFullImpactGate = transferInitialized
      && (matchGateFailedFull || evidenceStrengthGateFailedFull || observationsGateFailed);
    const microGatePassed = transferInitialized ? !hardMicroImpactGate : true;
    let transferImpactScale = transferInitialized ? 0 : 1;
    let impactLevel: "none" | "micro" | "full" = transferInitialized ? "none" : "full";
    let microThrottledByCooldown = false;
    let microThrottledByVariance = false;
    let microThrottledByBudget = false;
    let microAttempted = false;
    let microCandidate = false;
    let microNotConsideredDueToBudget = false;
    const microBudgetWindowRaw = normalizeNumberWindow(existing.micro_impact_budget_window, TRANSFER_MICRO_BUDGET_WINDOW);
    const isLegacyBinaryBudgetWindow = microBudgetWindowRaw.length > 0
      && microBudgetWindowRaw.every((n) => n === 0 || n === 1);
    const microBudgetWindow = (isLegacyBinaryBudgetWindow ? [] : microBudgetWindowRaw.filter((n) => n > 0))
      .slice(-TRANSFER_MICRO_BUDGET_WINDOW);
    const microBudgetCapacityBase = Math.max(2, Math.ceil(TRANSFER_MICRO_BUDGET_WINDOW * TRANSFER_MICRO_BUDGET_RATIO));
    const microBudgetStableBoost = (!varianceSoft && !varianceHard && rollingVarianceTrend <= 0) ? 1 : 0;
    const microBudgetCapacity = Math.max(2, microBudgetCapacityBase + microBudgetStableBoost);
    const microBudgetUsed = microBudgetWindow.length;
    let microBudgetNext = [...microBudgetWindow];
    let microBudgetUsedNext = microBudgetUsed;
    let microBudgetSignalThreshold: number | null = null;
    if (!transferInitialized) {
      transferImpactScale = 1;
      impactLevel = "full";
    } else {
      const rawImpact = clamp01(domainMatchConfidence * domainEvidenceStrength);
      if (!hardFullImpactGate && transferSuccessSignalFull) {
        transferImpactScale = rawImpact;
        impactLevel = transferImpactScale > 0 ? "full" : "none";
      } else if (
        !hardMicroImpactGate
        && (domainEvidenceStrength < TRANSFER_EVIDENCE_STRENGTH_MIN || matchGateFailedFull)
        && transferSuccessSignalMicro
        && impactAllowedMicro
      ) {
        microCandidate = true;
        microThrottledByCooldown = microImpactCooldownActive;
        microThrottledByVariance = varianceHard;
        const budgetPlan = planMicroBudgetTopK(
          microBudgetWindow,
          microGateSignalValue,
          microBudgetCapacity,
          TRANSFER_MICRO_BUDGET_WINDOW,
        );
        microNotConsideredDueToBudget = !budgetPlan.accepted;
        microAttempted = budgetPlan.accepted;
        microThrottledByBudget = !budgetPlan.accepted;
        microBudgetSignalThreshold = budgetPlan.threshold;
        if (!microThrottledByCooldown && !microThrottledByVariance && !microThrottledByBudget && !microDomainTickCooldown) {
          transferImpactScale = Math.min(rawImpact, microImpactCapUsed);
          impactLevel = transferImpactScale > 0 ? "micro" : "none";
          if (impactLevel === "micro" && transferImpactScale > 0) {
            microBudgetNext = budgetPlan.next;
            microBudgetUsedNext = budgetPlan.used;
          }
          if (impactLevel === "micro" && Number.isFinite(currentTickIndex)) {
            domainState.last_micro_impact_tick_index = Math.trunc(currentTickIndex);
            // Backward-compatible per-entry mirror (legacy telemetry/readers)
            existing.last_micro_impact_tick_index = Math.trunc(currentTickIndex);
          }
          // Always enforce at least one tick cooldown after any micro impact.
          existing.micro_impact_cooldown_ticks_remaining = Math.max(
            1,
            microImpactCooldownTicksRemaining,
            varianceSoft ? TRANSFER_MICRO_IMPACT_COOLDOWN_SOFT_TICKS : 0,
          );
        } else {
          transferImpactScale = 0;
          impactLevel = "none";
        }
      } else {
        transferImpactScale = 0;
        impactLevel = "none";
      }
    }
    const impactApplied = transferInitialized ? (transferImpactScale > 0) : false;
    const impactLevelReported: "none" | "micro" | "full" = impactApplied ? impactLevel : "none";
    existing.micro_impact_budget_window = microBudgetNext;
    if (transferInitialized && nextEvidence) {
      existing.transfer_evidence = nextEvidence.next;
      existing.last_transfer_confidence = nextEvidence.next.ema_match_conf;
      existing.last_evidence_confidence = domainEvidenceStrength;
    }

    if (transferInitialized && transferImpactScale <= 0) {
      strategy.experiments_count += 1;
      strategy.updated_at = now;
      strategy.last_used_at = now;
      existing.experiment_count += 1;
      existing.last_updated_at = now;
      existing.last_experiment_id = opts.experiment_id;
      existing.arena_state.experiments_since_last_eval += 1;
      syncEntrySummary(existing);
      const arenaEval = evaluateArenaEntry(existing);
      const prune = await saveStore(opts.syncDir, store);
      return {
        updated: false as const,
        memory_updated: true as const,
        impact_applied: false as const,
        reason: "transfer_evidence_gated",
        evidence_gate: {
          min_match_confidence: TRANSFER_MATCH_CONF_MIN_MICRO,
          min_match_confidence_full: TRANSFER_MATCH_CONF_MIN_FULL,
          min_evidence_strength_micro: TRANSFER_EVIDENCE_STRENGTH_MIN_MICRO_MAX,
          min_evidence_strength_micro_effective: Number(microMin.toFixed(6)),
          min_evidence_strength: TRANSFER_EVIDENCE_STRENGTH_MIN,
          min_observations: TRANSFER_EVIDENCE_MIN_OBS,
          observations: domainEvidenceObs,
          transfer_confidence: domainMatchConfidence,
          evidence_confidence: domainEvidenceStrength,
          domain_baseline: Number(domainBaseline.toFixed(6)),
          baseline_mad: Number(baselineMad.toFixed(6)),
          baseline_pool_n: baselinePool.length,
          success_margin: Number(successMarginUsed.toFixed(6)),
          transfer_success_signal: transferSuccessSignal,
          transfer_success_signal_full: transferSuccessSignalFull,
          transfer_success_signal_micro: transferSuccessSignalMicro,
          micro_success_margin: Number(microSuccessMarginUsed.toFixed(6)),
          micro_gate_signal_name: microGateSignalName,
          micro_gate_signal_value: microGateSignalValue,
          micro_gate_threshold: microGateThreshold,
          micro_gate_passed: microGatePassed,
          micro_candidate: microCandidate,
          micro_attempted: microAttempted,
          micro_not_considered_due_to_budget: microNotConsideredDueToBudget,
          previous_decayed_fitness: Number(previousDecayedFitness.toFixed(6)),
          success_rate: Number(nextEvidence?.success_rate ?? 0),
          match_gate_failed: matchGateFailedMicro,
          match_gate_failed_full: matchGateFailedFull,
          confidence_gate_failed: evidenceStrengthGateFailedFull,
          micro_confidence_gate_failed: evidenceStrengthGateFailedMicro,
          observations_gate_failed: observationsGateFailed,
          impact_level: impactLevelReported,
          impact_allowed_micro: impactAllowedMicro,
          micro_throttled_by_cooldown: microThrottledByCooldown,
          micro_throttled_by_variance: microThrottledByVariance,
          micro_throttled_by_budget: microThrottledByBudget,
          micro_throttled_by_domain_tick_cooldown: microDomainTickCooldown,
          micro_domain_tick_cooldown: microDomainTickCooldown,
          domain_signature: signature,
          tick_index: Number.isFinite(currentTickIndex) ? Math.trunc(currentTickIndex) : undefined,
          last_micro_impact_tick_index: Number.isFinite(lastMicroImpactTickIndex)
            ? Math.trunc(lastMicroImpactTickIndex)
            : undefined,
          micro_cooldown_ticks_remaining: Math.max(
            0,
            Math.trunc(Number(existing.micro_impact_cooldown_ticks_remaining ?? 0)),
          ),
          rolling_variance_short: Number(rollingVarianceShort.toFixed(6)),
          rolling_variance_ultra: Number(rollingVarianceUltra.toFixed(6)),
          rolling_variance_trend: rollingVarianceTrend,
          micro_budget_capacity: microBudgetCapacity,
          micro_budget_used: microBudgetUsedNext,
          micro_budget_signal_threshold: microBudgetSignalThreshold == null ? null : Number(microBudgetSignalThreshold.toFixed(6)),
          micro_cap_multiplier: Number(microImpactCapMultiplier.toFixed(6)),
          micro_cap_used: Number(microImpactCapUsed.toFixed(6)),
          domain_transfer_variance: Number(domainTransferVariance.toFixed(6)),
          experiment_variance_stability: Number(experimentVarianceStability.toFixed(6)),
          micro_impact_margin: Number(microImpactMarginUsed.toFixed(6)),
          micro_impact_floor: Number(microImpactFloor.toFixed(6)),
          impact_scale: 0,
        },
        strategy: {
          strategy_id: strategy.strategy_id,
          version_id: strategy.version_id,
          status: strategy.status,
        },
        arena: arenaEval,
        replication_guard: replicationGuardReason,
        pruning: prune,
      };
    }

    const effectiveFitness = transferInitialized
      ? Number((previousDecayedFitness + ((fitness - previousDecayedFitness) * transferImpactScale)).toFixed(6))
      : fitness;
    const degradedSeverely = effectiveFitness < (previousDecayedFitness * 0.55) && strategy.experiments_count >= 3;
    if (degradedSeverely) {
      const blockUntil = new Date(Date.now() + (6 * 60 * 60 * 1000)).toISOString();
      strategy.status = "shadow";
      strategy.reuse_blocked_until = blockUntil;
      strategy.updated_at = now;
      strategy.last_used_at = now;
      existing.failure_streak += 1;
      existing.success_streak = 0;
      existing.strategy_age = Math.max(0, Math.trunc(daysSince(existing.created_at)));
      existing.last_updated_at = now;
      existing.arena_state.experiments_since_last_eval += 1;
      syncEntrySummary(existing);
      const arenaEval = evaluateArenaEntry(existing);
      const prune = await saveStore(opts.syncDir, store);
      return {
        updated: false as const,
        memory_updated: true as const,
        impact_applied: false as const,
        reason: "catastrophic_forgetting_guard",
        fallback_profile: existing.best_adaptive_profile,
        blocked_until: blockUntil,
        anomaly_event: "transfer_degradation_detected",
        arena: arenaEval,
        pruning: prune,
      };
    }

    strategy.fitness = Number(weightedAverage(strategy.fitness, strategy.experiments_count, effectiveFitness).toFixed(6));
    strategy.avg_convergence_steps = Number(weightedAverage(
      strategy.avg_convergence_steps,
      strategy.experiments_count,
      Number(opts.experiment_metrics?.convergence_steps ?? 0)
    ).toFixed(6));
    strategy.avg_variance_stability = Number(clamp01(weightedAverage(
      strategy.avg_variance_stability,
      strategy.experiments_count,
      Number(opts.experiment_metrics?.variance_stability ?? 1)
    )).toFixed(6));
    strategy.transfer_effectiveness = Number(clamp01(weightedAverage(
      strategy.transfer_effectiveness,
      strategy.experiments_count,
      transferInitialized
        ? Number(domainEvidenceStrength.toFixed(6))
        : 0.5
    )).toFixed(6));
    strategy.experiments_count += 1;
    strategy.updated_at = now;
    strategy.last_used_at = now;
    strategy.reuse_blocked_until = undefined;

    existing.experiment_count += 1;
    existing.success_streak += 1;
    existing.failure_streak = 0;
    existing.last_success_at = now;
    existing.strategy_age = Math.max(0, Math.trunc(daysSince(existing.created_at)));
    existing.last_updated_at = now;
    existing.last_experiment_id = opts.experiment_id;
    if (!transferInitialized) {
      existing.last_transfer_confidence = Number(opts.strategy_context?.transfer_confidence ?? existing.last_transfer_confidence ?? 0);
    }
    existing.arena_state.experiments_since_last_eval += 1;

    syncEntrySummary(existing);
    const arenaEval = evaluateArenaEntry(existing);
    const prune = await saveStore(opts.syncDir, store);

    return {
      updated: true as const,
      memory_updated: true as const,
      impact_applied: impactApplied,
      action: strategy.strategy_id === targetStrategy?.strategy_id
        ? "refined_existing_strategy"
        : "added_or_competed_strategy",
      entry: existing,
      strategy: {
        strategy_id: strategy.strategy_id,
        version_id: strategy.version_id,
        status: strategy.status,
        fitness: strategy.fitness,
      },
      arena: arenaEval,
      comparison: {
        previous_decayed_fitness: previousDecayedFitness,
        incoming_fitness: Number(fitness.toFixed(6)),
        effective_fitness: Number(effectiveFitness.toFixed(6)),
      },
      evidence_gate: transferInitialized ? {
        min_match_confidence: TRANSFER_MATCH_CONF_MIN_MICRO,
        min_match_confidence_full: TRANSFER_MATCH_CONF_MIN_FULL,
        min_evidence_strength_micro: TRANSFER_EVIDENCE_STRENGTH_MIN_MICRO_MAX,
        min_evidence_strength_micro_effective: Number(microMin.toFixed(6)),
        min_evidence_strength: TRANSFER_EVIDENCE_STRENGTH_MIN,
        min_observations: TRANSFER_EVIDENCE_MIN_OBS,
        observations: domainEvidenceObs,
        transfer_confidence: domainMatchConfidence,
        evidence_confidence: domainEvidenceStrength,
        domain_baseline: Number(domainBaseline.toFixed(6)),
        baseline_mad: Number(baselineMad.toFixed(6)),
        baseline_pool_n: baselinePool.length,
        success_margin: Number(successMarginUsed.toFixed(6)),
        transfer_success_signal: transferSuccessSignal,
        transfer_success_signal_full: transferSuccessSignalFull,
        transfer_success_signal_micro: transferSuccessSignalMicro,
        micro_success_margin: Number(microSuccessMarginUsed.toFixed(6)),
        micro_gate_signal_name: microGateSignalName,
        micro_gate_signal_value: microGateSignalValue,
        micro_gate_threshold: microGateThreshold,
        micro_gate_passed: microGatePassed,
        micro_candidate: microCandidate,
        micro_attempted: microAttempted,
        micro_not_considered_due_to_budget: microNotConsideredDueToBudget,
        previous_decayed_fitness: Number(previousDecayedFitness.toFixed(6)),
        success_rate: Number(nextEvidence?.success_rate ?? 0),
        match_gate_failed: matchGateFailedMicro,
        match_gate_failed_full: matchGateFailedFull,
        confidence_gate_failed: evidenceStrengthGateFailedFull,
        micro_confidence_gate_failed: evidenceStrengthGateFailedMicro,
        observations_gate_failed: observationsGateFailed,
        impact_level: impactLevelReported,
        impact_allowed_micro: impactAllowedMicro,
          micro_throttled_by_cooldown: microThrottledByCooldown,
          micro_throttled_by_variance: microThrottledByVariance,
          micro_throttled_by_budget: microThrottledByBudget,
          micro_throttled_by_domain_tick_cooldown: microDomainTickCooldown,
          micro_domain_tick_cooldown: microDomainTickCooldown,
          domain_signature: signature,
          tick_index: Number.isFinite(currentTickIndex) ? Math.trunc(currentTickIndex) : undefined,
          last_micro_impact_tick_index: Number.isFinite(lastMicroImpactTickIndex)
            ? Math.trunc(lastMicroImpactTickIndex)
            : undefined,
          micro_cooldown_ticks_remaining: Math.max(
            0,
            Math.trunc(Number(existing.micro_impact_cooldown_ticks_remaining ?? 0)),
        ),
        rolling_variance_short: Number(rollingVarianceShort.toFixed(6)),
        rolling_variance_ultra: Number(rollingVarianceUltra.toFixed(6)),
        rolling_variance_trend: rollingVarianceTrend,
        micro_budget_capacity: microBudgetCapacity,
        micro_budget_used: microBudgetUsedNext,
        micro_budget_signal_threshold: microBudgetSignalThreshold == null ? null : Number(microBudgetSignalThreshold.toFixed(6)),
        micro_cap_multiplier: Number(microImpactCapMultiplier.toFixed(6)),
        micro_cap_used: Number(microImpactCapUsed.toFixed(6)),
        domain_transfer_variance: Number(domainTransferVariance.toFixed(6)),
        experiment_variance_stability: Number(experimentVarianceStability.toFixed(6)),
        micro_impact_margin: Number(microImpactMarginUsed.toFixed(6)),
        micro_impact_floor: Number(microImpactFloor.toFixed(6)),
        impact_scale: Number(transferImpactScale.toFixed(6)),
      } : undefined,
      replication_guard: replicationGuardReason,
      pruning: prune,
    };
  });
}

export async function researchMemoryArenaEvaluationTick(opts: {
  syncDir: string;
  limit?: number;
}) {
  return withLock(opts.syncDir, async () => {
    const store = await loadStore(opts.syncDir);
    const limit = Math.max(1, Math.min(500, Math.trunc(Number(opts.limit ?? 100))));
    const decisions: any[] = [];
    for (const entry of store.items.slice(0, limit)) {
      const result = evaluateArenaEntry(entry);
      if (result.evaluated) decisions.push(result);
    }
    const prune = await saveStore(opts.syncDir, store);
    return {
      scanned: Math.min(store.items.length, limit),
      evaluated: decisions.length,
      decisions,
      pruning: prune,
    };
  });
}

export async function researchMemoryArenaGovernanceGet(opts: {
  syncDir: string;
}) {
  return withLock(opts.syncDir, async () => {
    const store = await loadStore(opts.syncDir);
    const by_domain = store.items.map((entry) => ({
      domain_signature: entry.domain_signature,
      governance: normalizeArenaGovernance(entry.arena_state?.governance),
    }));
    return {
      domains_count: by_domain.length,
      by_domain,
    };
  });
}

export async function researchMemoryArenaGovernanceSet(opts: {
  syncDir: string;
  patch: Partial<ResearchArenaGovernance>;
  domain_signature?: string;
}) {
  return withLock(opts.syncDir, async () => {
    const store = await loadStore(opts.syncDir);
    const targetDomain = typeof opts.domain_signature === "string" ? opts.domain_signature.trim() : "";
    const updated: Array<{ domain_signature: string; governance: ResearchArenaGovernance }> = [];

    for (const entry of store.items) {
      if (targetDomain && entry.domain_signature !== targetDomain) continue;
      const next = normalizeArenaGovernance({
        ...entry.arena_state.governance,
        ...opts.patch,
      });
      entry.arena_state.governance = next;
      entry.last_updated_at = isoNow();
      updated.push({
        domain_signature: entry.domain_signature,
        governance: next,
      });
    }

    const pruning = await saveStore(opts.syncDir, store);
    return {
      updated_count: updated.length,
      domain_signature: targetDomain || null,
      patch_applied: opts.patch,
      updated,
      pruning,
    };
  });
}

export async function researchMemoryApplyCircuitBreaker(opts: {
  syncDir: string;
  domain_signatures: string[];
  ticks?: number;
  shadow_cap?: number;
  variance_lambda_multiplier?: number;
  active_only?: boolean;
  freeze_novelty?: boolean;
  reason?: string;
}) {
  return withLock(opts.syncDir, async () => {
    const store = await loadStore(opts.syncDir);
    const domainSet = new Set((opts.domain_signatures ?? []).map((s) => String(s).trim()).filter(Boolean));
    const ticks = Math.max(1, Math.min(8, Math.trunc(Number(opts.ticks ?? CIRCUIT_BREAKER_DEFAULT_TICKS))));
    const shadowCap = clamp01(Number(opts.shadow_cap ?? CIRCUIT_BREAKER_SHADOW_CAP));
    const varianceLambdaMultiplier = Math.max(
      1,
      Math.min(4, Number(opts.variance_lambda_multiplier ?? CIRCUIT_BREAKER_VARIANCE_MULTIPLIER)),
    );
    const now = isoNow();
    const updated: Array<{ domain_signature: string; stabilization_mode: NonNullable<ResearchMemoryEntry["stabilization_mode"]> }> = [];

    for (const entry of store.items) {
      if (domainSet.size > 0 && !domainSet.has(entry.domain_signature)) continue;
      entry.stabilization_mode = {
        ticks_remaining: ticks,
        active_only: opts.active_only !== false,
        shadow_cap: shadowCap,
        variance_lambda_multiplier: varianceLambdaMultiplier,
        freeze_novelty: opts.freeze_novelty !== false,
        reason: typeof opts.reason === "string" ? opts.reason : "degenerating_circuit_breaker",
        activated_at: now,
        updated_at: now,
      };
      entry.last_updated_at = now;
      updated.push({
        domain_signature: entry.domain_signature,
        stabilization_mode: entry.stabilization_mode,
      });
    }

    const pruning = await saveStore(opts.syncDir, store);
    return {
      updated_count: updated.length,
      ticks,
      domains: updated,
      pruning,
    };
  });
}

export async function researchMemoryAdvanceCircuitBreakerTick(opts: {
  syncDir: string;
  domain_signatures?: string[];
}) {
  return withLock(opts.syncDir, async () => {
    const store = await loadStore(opts.syncDir);
    const domainSet = new Set((opts.domain_signatures ?? []).map((s) => String(s).trim()).filter(Boolean));
    const now = isoNow();
    const updated: Array<{ domain_signature: string; ticks_remaining: number; active: boolean }> = [];
    let changed = 0;

    for (const entry of store.items) {
      if (!entry.stabilization_mode) continue;
      if (domainSet.size > 0 && !domainSet.has(entry.domain_signature)) continue;
      const current = normalizeStabilizationMode(entry.stabilization_mode);
      if (!current) {
        entry.stabilization_mode = undefined;
        continue;
      }
      const nextTicks = Math.max(0, current.ticks_remaining - 1);
      if (nextTicks <= 0) {
        entry.stabilization_mode = undefined;
        changed += 1;
        updated.push({
          domain_signature: entry.domain_signature,
          ticks_remaining: 0,
          active: false,
        });
      } else {
        entry.stabilization_mode = {
          ...current,
          ticks_remaining: nextTicks,
          updated_at: now,
        };
        changed += 1;
        updated.push({
          domain_signature: entry.domain_signature,
          ticks_remaining: nextTicks,
          active: true,
        });
      }
      entry.last_updated_at = now;
    }

    const pruning = changed > 0 ? await saveStore(opts.syncDir, store) : null;
    return {
      changed,
      updated,
      pruning,
    };
  });
}

export async function researchMemoryForceStrategyRotation(opts: {
  syncDir: string;
  domain_signature?: string;
  reason?: string;
}) {
  return withLock(opts.syncDir, async () => {
    const store = await loadStore(opts.syncDir);
    const now = isoNow();
    const targetDomain = typeof opts.domain_signature === "string" ? opts.domain_signature.trim() : "";
    const rotations: Array<{
      domain_signature: string;
      from_strategy_id: string;
      to_strategy_id: string;
      from_score: number;
      to_score: number;
      reason: string;
    }> = [];
    const skipped: Array<{ domain_signature: string; reason: string }> = [];

    for (const entry of store.items) {
      if (targetDomain && entry.domain_signature !== targetDomain) continue;
      ensureArenaPool(entry);
      const active = entry.strategy_pool.find((s) => s.status === "active")
        ?? (entry.active_strategy_id
          ? entry.strategy_pool.find((s) => s.strategy_id === entry.active_strategy_id)
          : undefined);
      if (!active) {
        skipped.push({ domain_signature: entry.domain_signature, reason: "no_active_strategy" });
        continue;
      }
      const bestShadow = [...entry.strategy_pool]
        .filter((s) => s.status === "shadow")
        .sort((a, b) => computeArenaStrategyScore(b) - computeArenaStrategyScore(a))[0];
      if (!bestShadow) {
        skipped.push({ domain_signature: entry.domain_signature, reason: "no_shadow_candidate" });
        continue;
      }
      if (bestShadow.strategy_id === active.strategy_id) {
        skipped.push({ domain_signature: entry.domain_signature, reason: "active_equals_shadow" });
        continue;
      }

      active.status = "inactive";
      active.updated_at = now;
      bestShadow.status = "active";
      bestShadow.updated_at = now;
      bestShadow.last_used_at = now;
      entry.active_strategy_id = bestShadow.strategy_id;
      entry.arena_state.last_evaluated_at = now;
      entry.arena_state.experiments_since_last_eval = 0;
      entry.last_updated_at = now;
      syncEntrySummary(entry);

      rotations.push({
        domain_signature: entry.domain_signature,
        from_strategy_id: active.strategy_id,
        to_strategy_id: bestShadow.strategy_id,
        from_score: computeArenaStrategyScore(active),
        to_score: computeArenaStrategyScore(bestShadow),
        reason: opts.reason || "forced_rotation",
      });
    }

    const pruning = await saveStore(opts.syncDir, store);
    return {
      domain_signature: targetDomain || null,
      rotated_count: rotations.length,
      rotations,
      skipped_count: skipped.length,
      skipped,
      pruning,
    };
  });
}

