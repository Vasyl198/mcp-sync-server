import express from "express";
import path from "node:path";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { acquireLock, releaseLock } from "./locks.js";
import {
  ensureQueueLayout,
  queuePush,
  queuePop,
  queueAck,
  queueCleanupExpiredRunning,
  jobHistoryList,
  queueDepth,
  queueHasLiveCampaignJob,
  queueHasLiveShadowEvaluationRetry,
  queueRunDirCandidates,
} from "./queue.js";
import { executeOneFromQueue } from "./router_queue.js";
import { Worker, WorkerManager } from "./workers.js";
import { ensureSyncState, eventPublish, eventList, getInboundCursorPath, getOutboundCursorPath } from "./events.js";
import { notesList, notesGet, notesUpsert, notesDelete } from "./notes.js";
import { tasksList, tasksGet, tasksUpsert, tasksDelete } from "./tasks.js";
import {
  experimentBest,
  experimentCompare,
  experimentComputeResearchMetrics,
  experimentCreate,
  experimentIngestExecResultByTask,
  experimentLeaderboard,
  experimentList,
  experimentRun,
  experimentSearchTick,
} from "./experiments.js";
import { projectCreate, projectList, projectSwitch, projectContextSet, projectContextGet } from "./projects.js";
import { memoryStore, memoryQuery, memoryUpdate, memoryPrune } from "./memory.js";
import { AgentRole, normalizeAdaptiveProfile, normalizeAdaptiveProfilesByDomain } from "./agent/registry.js";
import {
  computeDomainSignature,
  researchMemoryAdvanceCircuitBreakerTick,
  researchMemoryApplyCircuitBreaker,
  researchMemoryArenaEvaluationTick,
  researchMemoryArenaGovernanceGet,
  researchMemoryArenaGovernanceSet,
  researchMemoryForceStrategyRotation,
  researchMemoryUpsertFromOutcome
} from "./agent/research_memory.js";
import {
  arenaTelemetrySnapshot,
  intelligenceMetaSnapshot,
  intelligenceHealthSnapshot,
  lineageSnapshot,
  mutationEffectivenessSnapshot,
  transferDiagnosticsSnapshot
} from "./agent/telemetry.js";
import {
  campaignAppendHistory,
  campaignCommitPreparedTick,
  campaignCreate,
  campaignGet,
  campaignList,
  campaignMarkRunning,
  campaignReconcileAll,
  campaignReportGenerate,
  campaignSave,
  campaignTickRecordWrite,
} from "./campaigns.js";
import {
  agentVersionActivate,
  agentShadowDiscard,
  agentGetActiveByRole,
  agentEvolutionTick,
  governanceGet,
  governanceSet,
  agentMetricsOverwrite,
  agentMetricsRecordResearchImpact,
  agentMetricsRecordRun,
  agentMetricsSnapshot,
  agentRegistryList,
  researchProfileGovernanceTune,
  agentVersionCreate,
} from "./agent/store.js";
import {
  taskCreate,
  taskLink,
  taskGraph,
  taskPlanGenerate,
  taskStatusUpdate,
  orchestratorTick,
  taskExecutionMarkQueued,
  taskExecutionMarkFinished,
  taskExecutionHandleResult,
  taskAgentMarkDispatched,
} from "./task_graph.js";
import { protocolInit, protocolWriteCommand, protocolReadCommand, protocolUpdateStatus, protocolWriteReport, protocolWriteLogs } from "./protocol.js";
import { EXPOSE_LEGACY_TOOLS, OPENAI_MODEL, PORT, SYNC_BATCH_SIZE, SYNC_DIR, SYNC_ENABLED, SYNC_MOCK_MODE, SYNC_POLL_MS } from "./config.js";
import { InboundSyncWorker } from "./sync/inbound_worker.js";
import { OutboundSyncWorker } from "./sync/outbound_worker.js";
import { applyAssistantResponse } from "./sync/llm_actions.js";
import {
  enqueueInboundResponseId,
  getMappingStoreStats,
  hasDedupeKey,
  reconcileMappingStore,
} from "./sync/mapping_store.js";
import { registerLlmAgentChatTool } from "./agent/llm_agent_chat.js";

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MCP_SYNC_TOKEN_RAW = process.env.MCP_SYNC_TOKEN;
const MCP_SYNC_TOKEN = (MCP_SYNC_TOKEN_RAW ?? "").trim();  
const AUTH_ENABLED_RAW = (process.env.AUTH_ENABLED ?? "").trim().toLowerCase();
const ORIGIN_ALLOWLIST = (process.env.MCP_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DEFAULT_SYNC_BUDGET_MS = Math.max(500, Math.min(
  Number(process.env.LATENCY_SYNC_BUDGET_MS ?? "4000") || 4000,
  60000
));

function parseBooleanEnv(value: string): boolean | undefined {
  if (!value) return undefined;
  if (["1", "true", "yes", "on", "enabled"].includes(value)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(value)) return false;
  return undefined;
}

const AUTH_ENABLED_FROM_ENV = parseBooleanEnv(AUTH_ENABLED_RAW);
const AUTH_ENABLED = AUTH_ENABLED_FROM_ENV ?? MCP_SYNC_TOKEN.length > 0;
const CORS_ALLOW_HEADERS =
  "Content-Type, Accept, mcp-session-id, mcp-protocol-version, Last-Event-ID, Authorization";

const LEGACY_TOOL_NAMES = new Set<string>([
  "notes_upsert", "notes_get", "notes_list", "notes_delete",
  "tasks_upsert", "tasks_get", "tasks_list", "tasks_delete",
  "task_create", "task_link", "task_graph", "task_plan_generate", "task_status_update",
  "orchestrator_tick", "execution_bind_tick", "recovery_tick",
  "fs_list", "fs_read", "fs_write", "fs_mkdir", "fs_exists", "fs_read_content", "fs_write_content",
  "protocol_init", "protocol_write_command", "protocol_read_command", "protocol_update_status", "protocol_write_report", "protocol_write_logs",
  "sync_outbound_once", "sync_inbound_once", "enqueue_inbound_response_id", "sync_status", "sync_reconcile",
  "experiment_create", "experiment_run", "experiment_list", "experiment_compare", "experiment_leaderboard", "experiment_best", "experiment_search_tick",
  "campaign_create", "campaign_tick", "campaign_watchdog_tick", "campaign_report_generate", "campaign_list",
]);

function isLegacyToolName(name: unknown): boolean {
  return typeof name === "string" && LEGACY_TOOL_NAMES.has(name);
}

let backgroundWorkerManager: WorkerManager | null = null;
let backgroundWorkerAdaptiveTimer: NodeJS.Timeout | null = null;
let backgroundWorkerStartedAt: string | null = null;
let lastCampaignWatchdogRunAt = 0;
let metaGuardSafeModeEnabled = false;
let metaGuardOverloadStreak = 0;
let metaGuardHealthyStreak = 0;
let metaGuardLastSwitchAt = 0;
let metaGuardBaselineGovernance: Record<string, any> | null = null;

function normalizeRoutePath(routePath: string): string {
  if (!routePath) return "/";
  if (routePath === "/") return routePath;
  return routePath.replace(/\/+$/, "");
}

function isAuthProtectedPath(routePath: string): boolean {
  const normalized = normalizeRoutePath(routePath);
  return (
    normalized === "/mcp" ||
    normalized.startsWith("/mcp/") ||
    normalized === "/messages" ||
    normalized.startsWith("/messages/") ||
    normalized === "/sse" ||
    normalized.startsWith("/sse/") ||
    normalized === "/sse-simple" ||
    normalized.startsWith("/sse-simple/")
  );
}

function isValidBearerToken(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

// Explicit paths to avoid confusion
const ROOTS = ["C:\\Users\\anani\\Projects", "C:\\", "D:\\"];

const ALLOWED_ROOTS = (process.env.MCP_ALLOWED_ROOTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => {
    if (path.isAbsolute(p)) return p;
    // Handle relative paths relative to each root
    if (p.startsWith("C:") || p.startsWith("D:")) return path.resolve(p);
    return path.resolve("C:\\Users\\anani\\Projects", p);
  });

const ROOTS_FINAL = ALLOWED_ROOTS.length ? ALLOWED_ROOTS : ROOTS;

// Utility functions to convert Express <-> Fetch Request/Response
function toFetchHeaders(h: any) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) headers.set(k, v.join(", "));
    else headers.set(k, String(v));
  }
  return headers;
}

function toFetchRequest(req: any) {
  const host = req.headers.host || "localhost";
  const url = `http://${host}${req.originalUrl}`;

  const headers = toFetchHeaders(req.headers);

  const method = req.method.toUpperCase();
  const body = (method === "GET" || method === "HEAD") ? undefined : JSON.stringify(req.body ?? {});

  return new Request(url, {
    method,
    headers,
    body,
  });
}

function ensureArrayItems(schema: any) {
  if (!schema || typeof schema !== "object") return;

  if (schema.type === "array" && schema.items === undefined) {
    schema.items = {};
  }

  for (const k of Object.keys(schema)) {
    const v = (schema as any)[k];
    if (Array.isArray(v)) v.forEach(ensureArrayItems);
    else if (v && typeof v === "object") ensureArrayItems(v);
  }
}

function sanitizeToolsListInputSchemas(payload: any) {
  const tools = payload?.result?.tools;
  if (!Array.isArray(tools)) return payload;
  const filtered = EXPOSE_LEGACY_TOOLS
    ? tools
    : tools.filter((tool: any) => !isLegacyToolName(tool?.name));
  payload.result.tools = filtered;
  for (const tool of filtered) {
    if (tool && typeof tool === "object" && tool.inputSchema && typeof tool.inputSchema === "object") {
      ensureArrayItems(tool.inputSchema);
    }
  }
  return payload;
}

function sanitizeSseToolsListPayload(raw: string) {
  const chunks = raw.split("\n\n");
  const out: string[] = [];

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const lines = chunk.split(/\r?\n/);
    const mapped = lines.map((line) => {
      if (!line.startsWith("data:")) return line;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return line;
      try {
        const parsed = JSON.parse(data);
        const sanitized = sanitizeToolsListInputSchemas(parsed);
        return `data: ${JSON.stringify(sanitized)}`;
      } catch {
        return line;
      }
    });
    out.push(mapped.join("\n"));
  }

  return out.length > 0 ? `${out.join("\n\n")}\n\n` : raw;
}

async function sendFetchResponseToExpress(webRes: Response, res: any, rpcMethod?: string) {
  const contentType = String(webRes.headers.get("content-type") ?? "").toLowerCase();
  const isJson = contentType.includes("application/json");
  const isSse = contentType.includes("text/event-stream");
  const shouldSanitizeToolsList = rpcMethod === "tools/list";

  if (shouldSanitizeToolsList && (isJson || isSse)) {
    const text = await webRes.text();
    let output = text;
    if (isSse) {
      output = sanitizeSseToolsListPayload(text);
    } else {
      try {
        const parsed = JSON.parse(text);
        const sanitized = sanitizeToolsListInputSchemas(parsed);
        output = JSON.stringify(sanitized);
      } catch {
        // Keep original payload if it's not valid JSON.
      }
    }

    res.status(webRes.status);
    webRes.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-length") return;
      res.setHeader(key, value);
    });
    res.send(output);
    return;
  }

  res.status(webRes.status);
  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  (res as any).flushHeaders?.();

  let closed = false;
  res.on("close", () => { closed = true; });
  res.on("finish", () => { closed = true; });

  if (!webRes.body) {
    res.end();
    return;
  }

  const reader = webRes.body.getReader();
  try {
    while (!closed) {
      const { value, done } = await reader.read();
      if (done || closed) break;
      if (value) {
        const ok = res.write(Buffer.from(value));
        if (!ok) {
          await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      }
    }
  } finally {
    if (!closed) {
      res.end();
    }
    try { reader.releaseLock(); } catch {}
  }
}

function isInsideRoot(root: string, target: string) {
  const r = path.resolve(root);
  const t = path.resolve(target);

  // Windows: case-insensitive comparison for drive letters
  const rel = path.relative(r, t);

  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertInAllowedRoots(p: string) {
  const rp = path.resolve(p);
  for (const root of ROOTS_FINAL) {
    if (isInsideRoot(root, rp)) return rp;
  }
  throw new Error(`Path is outside allowed roots: ${rp}`);
}

function sha1(s: string) {
  return createHash("sha1").update(s).digest("hex");
}

function tryNormalizeNodeEExecCommand(template: string): { cmd: string; args: string[] } | null {
  const s = String(template ?? "").trim();
  const m = s.match(/^node\s+-e\s+([\s\S]+)$/i);
  if (!m) return null;

  let payload = m[1].trim();
  const unwrap = (q: string) => {
    if (payload.startsWith(q) && payload.endsWith(q) && payload.length >= 2) {
      payload = payload.slice(1, -1);
      return true;
    }
    return false;
  };

  if (payload.startsWith('\\"') && payload.endsWith('\\"') && payload.length >= 4) {
    payload = payload.slice(2, -2);
  } else {
    unwrap('"') || unwrap("'") || unwrap("`");
  }

  payload = payload
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");

  return { cmd: "node", args: ["-e", payload] };
}

function normalizeNodeEArgs(cmd: string, args: string[]): string[] {
  if (String(cmd).toLowerCase() !== "node") return args;
  if (!Array.isArray(args) || args.length < 2) return args;
  if (String(args[0]) !== "-e") return args;
  const joined = args.slice(1).join(" ").trim();
  if (!joined) return args;
  const normalized = tryNormalizeNodeEExecCommand(`node -e ${joined}`);
  if (!normalized) return args;
  return normalized.args;
}

function parseExecCommand(rawTitle: string): { cmd: string; args: string[]; command: string } | null {
  if (!rawTitle.toLowerCase().startsWith("exec:")) return null;
  const command = rawTitle.slice(5).trim();
  if (!command) return null;

  const normalizedNodeE = tryNormalizeNodeEExecCommand(command);
  if (normalizedNodeE) {
    return {
      cmd: normalizedNodeE.cmd,
      args: normalizedNodeE.args,
      command,
    };
  }

  const tokens: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`|([^\s]+)/g;
  let match: RegExpExecArray | null = null;
  while ((match = re.exec(command))) {
    const token = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (typeof token === "string" && token.length > 0) {
      tokens.push(token.replace(/\\(["'`\\])/g, "$1"));
    }
  }
  if (tokens.length === 0) return null;

  return {
    cmd: tokens[0],
    args: tokens.slice(1),
    command,
  };
}

function clamp01(v: number) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function roleTargetTemperature(role: AgentRole): number {
  if (role === "research") return 0.45;
  if (role === "dev") return 0.1;
  if (role === "planner") return 0.15;
  return 0.2;
}

function compositeScore(successRate: number, criticScore: number, avgMs: number, parentAvgMs: number): number {
  const s = clamp01(successRate);
  const c = clamp01(criticScore);
  const speedRatio = parentAvgMs > 0 && avgMs > 0 ? Math.max(0, Math.min(2, parentAvgMs / avgMs)) : 1;
  const speed = clamp01(speedRatio / 2);
  return Number((s * 0.5 + c * 0.3 + speed * 0.2).toFixed(4));
}

function variance(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((acc, x) => acc + Math.pow(x - mean, 2), 0) / values.length;
  return Number(v.toFixed(8));
}

function okText(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] as any[] };
}

function errText(message: string) {
  return { isError: true, content: [{ type: "text", text: message }] as any[] };
}

function classifyLatencyMode(expectedMs: number, syncBudgetMs: number): "sync" | "async" {
  if (!Number.isFinite(expectedMs) || expectedMs < 0) return "async";
  if (!Number.isFinite(syncBudgetMs) || syncBudgetMs <= 0) return "async";
  return expectedMs > syncBudgetMs ? "async" : "sync";
}

function asyncAcceptedResponse(opts: {
  job_id: string;
  status_tool: string;
  estimated_wait_ms?: number;
  sync_budget_ms?: number;
  mode_reason?: string;
}) {
  return {
    mode: "async",
    accepted: true,
    job_id: opts.job_id,
    status: "running",
    status_tool: opts.status_tool,
    estimated_wait_ms: opts.estimated_wait_ms ?? null,
    sync_budget_ms: opts.sync_budget_ms ?? null,
    mode_reason: opts.mode_reason ?? "expected_runtime_exceeds_budget",
  };
}

type SweGuardClaim =
  | { type: "file_exists"; path: string }
  | { type: "file_contains"; path: string; substring?: string; regex?: string; flags?: string }
  | { type: "command_succeeds"; cmd: string; cwd?: string; timeout_ms?: number }
  | { type: "job_done"; job_id?: string; logical_queue?: string; source?: string }
  | { type: "metrics_at_least"; role: AgentRole; version?: number; runs_count?: number; success_rate?: number; critic_score?: number }
  | { type: "task_status"; task_id: string; status: string };

type SweGuardClaimResult = {
  ok: boolean;
  type: string;
  claim: any;
  evidence?: any;
  error?: string;
};

function parseSweGuardClaim(raw: any): SweGuardClaim | null {
  if (!raw || typeof raw !== "object") return null;
  const type = String(raw.type ?? "").trim();
  if (type === "file_exists" && typeof raw.path === "string" && raw.path.trim()) {
    return { type, path: raw.path.trim() };
  }
  if (type === "file_contains" && typeof raw.path === "string" && raw.path.trim()) {
    return {
      type,
      path: raw.path.trim(),
      substring: typeof raw.substring === "string" ? raw.substring : undefined,
      regex: typeof raw.regex === "string" ? raw.regex : undefined,
      flags: typeof raw.flags === "string" ? raw.flags : undefined,
    };
  }
  if (type === "command_succeeds" && typeof raw.cmd === "string" && raw.cmd.trim()) {
    return {
      type,
      cmd: raw.cmd.trim(),
      cwd: typeof raw.cwd === "string" && raw.cwd.trim() ? raw.cwd.trim() : undefined,
      timeout_ms: Number.isFinite(Number(raw.timeout_ms)) ? Math.trunc(Number(raw.timeout_ms)) : undefined,
    };
  }
  if (type === "job_done") {
    return {
      type,
      job_id: typeof raw.job_id === "string" && raw.job_id.trim() ? raw.job_id.trim() : undefined,
      logical_queue: typeof raw.logical_queue === "string" && raw.logical_queue.trim() ? raw.logical_queue.trim() : undefined,
      source: typeof raw.source === "string" && raw.source.trim() ? raw.source.trim() : undefined,
    };
  }
  if (type === "metrics_at_least" && typeof raw.role === "string" && raw.role.trim()) {
    return {
      type,
      role: raw.role as AgentRole,
      version: Number.isFinite(Number(raw.version)) ? Math.trunc(Number(raw.version)) : undefined,
      runs_count: Number.isFinite(Number(raw.runs_count)) ? Number(raw.runs_count) : undefined,
      success_rate: Number.isFinite(Number(raw.success_rate)) ? Number(raw.success_rate) : undefined,
      critic_score: Number.isFinite(Number(raw.critic_score)) ? Number(raw.critic_score) : undefined,
    };
  }
  if (type === "task_status" && typeof raw.task_id === "string" && raw.task_id.trim() && typeof raw.status === "string" && raw.status.trim()) {
    return { type, task_id: raw.task_id.trim(), status: raw.status.trim() };
  }
  return null;
}

export { okText, errText };

// Use Projects directory for SYNC_DIR
const INBOX_FILE = path.join(SYNC_DIR, 'inbox_command.json');
const STATUS_FILE = path.join(SYNC_DIR, 'status.json');
const REPORT_FILE = path.join(SYNC_DIR, 'last_report.md');
const LOGS_FILE = path.join(SYNC_DIR, 'last_logs.txt');
const EVENTS_FILE = path.join(SYNC_DIR, 'events.jsonl');

async function ensureSyncDir() {
  await fs.mkdir(SYNC_DIR, { recursive: true });
  // Initialize queue layout
  await ensureQueueLayout(SYNC_DIR);
  // Initialize sync state cursors
  await ensureSyncState(SYNC_DIR);
}

async function readCursorState(cursorPath: string): Promise<{ cursor: string | null; updated_at: string | null }> {
  try {
    const raw = await fs.readFile(cursorPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      cursor: typeof parsed?.cursor === "string" ? parsed.cursor : null,
      updated_at: typeof parsed?.updated_at === "string" ? parsed.updated_at : null,
    };
  } catch {
    return { cursor: null, updated_at: null };
  }
}

function buildWorkerSnapshot() {
  const metrics = backgroundWorkerManager?.metrics() ?? { started: false, workers: [] as any[] };
  return {
    started: metrics.started,
    started_at: backgroundWorkerStartedAt,
    workers: metrics.workers,
  };
}

// Create MCP server
function createMcpServer() {
  const server = new McpServer(
    {
      name: "mcp-sync-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: { listChanged: true },
      },
    }
  );

  // Basic tools
  server.tool(
    "whoami",
    "Get server info and available roots",
    {},
    async () => {
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify({
            server: "mcp-sync-server",
            version: "1.0.0",
            auth: AUTH_ENABLED ? "enabled" : "disabled",
            roots: ROOTS_FINAL,
            sync_dir: SYNC_DIR,
            sync: {
              enabled: SYNC_ENABLED,
              mock_mode: SYNC_MOCK_MODE,
              poll_ms: SYNC_POLL_MS,
              batch_size: SYNC_BATCH_SIZE,
              openai_model: OPENAI_MODEL,
            },
            tools: [
              "whoami",
              "router_execute_command", 
              "notes",
              "tasks",
              "fs",
              "protocol",
              "sync",
              "experiment",
              "campaign",
              "fs_lock_acquire",
              "fs_lock_release", 
              "queue_push",
              "queue_pop",
              "queue_ack",
              "job_history_list",
              "router_execute_from_queue",
              "router_execute_exec_queue",
              "router_execute_research_queue",
              "router_execute_campaign_queue",
              "router_execute_meta_queue",
              "worker_metrics_snapshot",
              "fs_list",
              "fs_read", 
              "fs_write",
              "fs_mkdir",
              "fs_exists",
              "search_in_files",
              "fs_read_content",
              "fs_write_content",
              "exec",
              "event_publish",
              "event_list",
              "experiment_create",
              "experiment_run",
              "experiment_list",
              "experiment_compare",
              "experiment_leaderboard",
              "experiment_best",
              "experiment_search_tick",
              "notes_upsert",
              "notes_get",
              "notes_delete",
              "notes_list",
              "tasks_upsert",
              "tasks_get",
              "tasks_delete",
              "tasks_list",
              "task_create",
              "task_link",
              "task_graph",
              "task_plan_generate",
              "task_status_update",
              "orchestrator_tick",
              "execution_bind_tick",
              "recovery_tick",
              "governance_get",
              "governance_set",
              "arena_governance_get",
              "arena_governance_set",
              "agent_registry",
              "agent_metrics_snapshot",
              "agent_version_create",
              "agent_version_activate",
              "evolution_tick",
              "shadow_evaluation_tick",
              "agent_dispatch_tick",
              "arena_telemetry_snapshot",
              "mutation_effectiveness_snapshot",
              "transfer_diagnostics",
              "intelligence_health_snapshot",
              "intelligence_meta_snapshot",
              "meta_governance_tick",
              "governance_tuner_tick",
              "governance_threshold_tuner_tick",
              "research_agenda_tick",
              "patch_proposal_tick",
              "patch_test_tick",
              "patch_governance_tick",
              "lineage_snapshot",
              "campaign_create",
              "campaign_tick",
              "campaign_report_generate",
              "campaign_list",
              "project_create",
              "project_list",
              "project_switch",
              "project_context_set",
              "project_context_get",
              "memory_store",
              "memory_query",
              "memory_update",
              "memory_prune",
              "protocol_init",
              "protocol_write_command",
              "protocol_read_command",
              "protocol_update_status",
              "protocol_write_report",
              "protocol_write_logs",
              "sync_outbound_once",
              "sync_inbound_once",
              "sync_status",
              "sync_reconcile",
              "enqueue_inbound_response_id"
            ].filter((name) => EXPOSE_LEGACY_TOOLS || !isLegacyToolName(name))
          })
        }]
      };
    }
  );

  async function runSyncOutboundOnce(batchSize?: number) {
    await ensureSyncDir();
    const worker = new OutboundSyncWorker({
      syncDir: SYNC_DIR,
      batchSize: batchSize ?? SYNC_BATCH_SIZE,
    });
    return worker.runOnce();
  }

  async function runSyncInboundOnce(batchSize?: number) {
    await ensureSyncDir();
    const worker = new InboundSyncWorker({
      syncDir: SYNC_DIR,
      batchSize: batchSize ?? SYNC_BATCH_SIZE,
    });
    return worker.runOnce();
  }

  async function runSyncStatus() {
    await ensureSyncDir();

    const [outboundCursor, inboundCursor, stats, lastAny, lastOutbound, lastInbound] = await Promise.all([
      readCursorState(getOutboundCursorPath(SYNC_DIR)),
      readCursorState(getInboundCursorPath(SYNC_DIR)),
      getMappingStoreStats(SYNC_DIR),
      eventList({ syncDir: SYNC_DIR, limit: 1 }),
      eventList({ syncDir: SYNC_DIR, limit: 1, direction: "outbound" }),
      eventList({ syncDir: SYNC_DIR, limit: 1, direction: "inbound" }),
    ]);

    return {
      enabled: SYNC_ENABLED,
      poll_ms: SYNC_POLL_MS,
      batch_size: SYNC_BATCH_SIZE,
      model: OPENAI_MODEL,
      cursors: {
        outbound: outboundCursor,
        inbound: inboundCursor,
      },
      mappings: {
        count: stats.mappings_count,
        pending_inbound_ids: stats.pending_inbound_ids,
        last_updated_at: stats.last_updated_at,
      },
      dedupe: {
        outbound: stats.dedupe_outbound_count,
        inbound: stats.dedupe_inbound_count,
      },
      last_activity: {
        any: lastAny.items[0]?.ts ?? null,
        outbound: lastOutbound.items[0]?.ts ?? null,
        inbound: lastInbound.items[0]?.ts ?? null,
      },
    };
  }

  async function runSyncReconcile() {
    await ensureSyncDir();
    const reconciliation = await reconcileMappingStore(SYNC_DIR);
    const [outboundCursor, inboundCursor] = await Promise.all([
      readCursorState(getOutboundCursorPath(SYNC_DIR)),
      readCursorState(getInboundCursorPath(SYNC_DIR)),
    ]);

    return {
      reconciled: true,
      mappings: reconciliation,
      cursors: {
        outbound: outboundCursor,
        inbound: inboundCursor,
      },
    };
  }

  async function runResearchAgendaTick(args?: {
    project_id?: string;
    campaign_id?: string;
    top_domains?: number;
    transfer_window?: number;
    mutation_window?: number;
    gihi_window?: number;
    publish_only?: boolean;
    dry_run?: boolean;
    batch_size?: number;
  }) {
    await ensureSyncDir();
    const topDomains = Math.max(1, Math.min(10, Math.trunc(Number(args?.top_domains ?? 3))));
    const campaignId = typeof args?.campaign_id === "string" && args.campaign_id.trim()
      ? args.campaign_id.trim()
      : undefined;
    const projectId = typeof args?.project_id === "string" && args.project_id.trim()
      ? args.project_id.trim()
      : null;

    const [meta, transfer, arena] = await Promise.all([
      intelligenceMetaSnapshot({
        syncDir: SYNC_DIR,
        transfer_window: typeof args?.transfer_window === "number" ? Math.trunc(args.transfer_window) : undefined,
        mutation_window: typeof args?.mutation_window === "number" ? Math.trunc(args.mutation_window) : undefined,
        gihi_window: typeof args?.gihi_window === "number" ? Math.trunc(args.gihi_window) : undefined,
        campaign_id: campaignId,
      }),
      transferDiagnosticsSnapshot({ syncDir: SYNC_DIR }),
      arenaTelemetrySnapshot({
        syncDir: SYNC_DIR,
        limit_domains: Math.max(6, topDomains * 2),
      }),
    ]);

    const transferDomains = Array.isArray((transfer as any)?.snapshot?.per_domain_transfer)
      ? (transfer as any).snapshot.per_domain_transfer
      : [];
    const topVarianceDomains = [...transferDomains]
      .sort((a: any, b: any) => Number(b?.transfer_variance ?? 0) - Number(a?.transfer_variance ?? 0))
      .slice(0, topDomains)
      .map((d: any) => ({
        domain_signature: d?.domain_signature ?? null,
        transfer_variance: d?.transfer_variance ?? null,
        evidence_observations_latest: d?.evidence_observations_latest ?? null,
        evidence_observations_recent_ewma: d?.evidence_observations_recent_ewma ?? null,
        micro_applied_share: d?.impact_applied_share_micro ?? null,
      }));

    const arenaDomains = Array.isArray((arena as any)?.snapshot?.domains)
      ? (arena as any).snapshot.domains
      : [];
    const topEntropyDomains = [...arenaDomains]
      .sort((a: any, b: any) => Number(b?.strategy_entropy ?? 0) - Number(a?.strategy_entropy ?? 0))
      .slice(0, topDomains)
      .map((d: any) => ({
        domain_signature: d?.domain_signature ?? null,
        strategy_entropy: d?.strategy_entropy ?? null,
        top_active_share: d?.top_active_share ?? null,
        shadow_share: d?.shadow_share ?? null,
      }));

    const brief = {
      mode: "research_agenda_tick_v1",
      campaign_id: campaignId ?? null,
      project_id: projectId,
      objective: "Generate 2-5 safe research tasks to improve stability and performance.",
      constraints: {
        tasks_only: true,
        governance_autoapply_disabled: true,
        task_count_min: 2,
        task_count_max: 5,
      },
      snapshots: {
        meta: {
          meta_state: (meta as any)?.snapshot?.meta_state ?? null,
          arena_entropy: (meta as any)?.snapshot?.arena_entropy ?? null,
          gihi_delta_ultra: (meta as any)?.snapshot?.gihi_delta_ultra ?? null,
          transfer_variance_trend: (meta as any)?.snapshot?.transfer_variance_trend ?? null,
          mutation_roi_trend: (meta as any)?.snapshot?.mutation_roi_trend ?? null,
        },
        top_transfer_variance_domains: topVarianceDomains,
        top_entropy_domains: topEntropyDomains,
      },
      output_contract: {
        hypotheses_max: 5,
        tasks_max: 5,
        required_fields: ["hypotheses", "tasks", "metrics", "risks"],
        task_fields: ["title", "description", "labels", "priority"],
      },
      ask: [
        "Return only JSON using the requested agenda schema.",
        "Prioritize concrete experiments/tasks with measurable success criteria in task descriptions.",
        "No governance actions. Tasks and notes only.",
      ],
    };

    const dedupeCampaign = campaignId ?? "global";
    const snapshotTs = String((meta as any)?.snapshot?.computed_at ?? new Date().toISOString());
    const dedupe = `research_agenda:${dedupeCampaign}:${snapshotTs}`;
    const conversationId = projectId ? `research_agenda:${projectId}` : "research_agenda";
    const published = await eventPublish({
      syncDir: SYNC_DIR,
      type: "research_agenda.request",
      source: "research-agenda",
      direction: "outbound",
      conversation_id: conversationId,
      dedupe_key: dedupe,
      payload: brief,
    });

    const publishOnly = Boolean(args?.publish_only || args?.dry_run);
    const sync = publishOnly
      ? null
      : await runSyncOutboundOnce(
          typeof args?.batch_size === "number" && Number.isFinite(args.batch_size)
            ? Math.max(1, Math.trunc(args.batch_size))
            : 1
        );

    return {
      ok: true,
      published,
      dry_run: publishOnly,
      sync_outbound: sync,
      summary: {
        meta_state: (meta as any)?.snapshot?.meta_state ?? null,
        arena_entropy: (meta as any)?.snapshot?.arena_entropy ?? null,
        top_transfer_variance_domains: topVarianceDomains,
        top_entropy_domains: topEntropyDomains,
      },
    };
  }

  type PatchProposalItem = {
    kind: "prompt_patch" | "repo_patch";
    scope: string;
    diff: unknown;
    rationale: string;
    risk: "low" | "med" | "high";
    tests: string[];
    success_metrics: string[];
    rollback_plan?: string;
  };

  function parsePatchProposalNote(note: any): { proposal_id: string; patches: PatchProposalItem[]; summary?: string } | null {
    const content = typeof note?.content === "string" ? note.content : "";
    if (!content) return null;
    try {
      const parsed = JSON.parse(content);
      const patchesRaw = Array.isArray(parsed?.patches) ? parsed.patches : [];
      const patches: PatchProposalItem[] = patchesRaw
        .map((p: any): PatchProposalItem | null => {
          const kind: "prompt_patch" | "repo_patch" = p?.kind === "repo_patch" ? "repo_patch" : "prompt_patch";
          const scope = String(p?.scope ?? "").trim();
          const rationale = String(p?.rationale ?? "").trim();
          const risk: "low" | "med" | "high" = p?.risk === "high" ? "high" : (p?.risk === "med" ? "med" : "low");
          const tests = Array.isArray(p?.tests) ? p.tests.map((x: any) => String(x)).map((x: string) => x.trim()).filter(Boolean) : [];
          const success_metrics = Array.isArray(p?.success_metrics) ? p.success_metrics.map((x: any) => String(x)).map((x: string) => x.trim()).filter(Boolean) : [];
          const rollback_plan = typeof p?.rollback_plan === "string" ? p.rollback_plan : undefined;
          const diff = p?.diff;

          if (!scope || !rationale) return null;
          if (tests.length === 0 || success_metrics.length === 0) return null;

          if (kind === "prompt_patch") {
            if (!/^agent:(planner|dev|research|critic)$/i.test(scope)) return null;
            if (!diff || typeof diff !== "object" || Array.isArray(diff)) return null;
            const d = diff as Record<string, unknown>;
            const hasSystemPrompt = typeof d.system_prompt === "string" && d.system_prompt.trim().length > 0;
            const hasModel = typeof d.model === "string" && d.model.trim().length > 0;
            const hasTemperature = Number.isFinite(Number(d.temperature));
            if (!hasSystemPrompt && !hasModel && !hasTemperature) return null;
            return { kind, scope, diff: d, rationale, risk, tests, success_metrics, rollback_plan };
          }

          if (typeof diff !== "string" || diff.trim().length === 0) return null;
          return { kind, scope, diff, rationale, risk, tests, success_metrics, rollback_plan };
        })
        .filter((p: PatchProposalItem | null): p is PatchProposalItem => Boolean(p));
      if (patches.length === 0) return null;
      return {
        proposal_id: String(note?.id ?? ""),
        patches: patches.slice(0, 2),
        summary: typeof parsed?.summary === "string" ? parsed.summary : undefined,
      };
    } catch {
      return null;
    }
  }

  function parsePatchDiffJson(diffInput: unknown): { system_prompt?: string; temperature?: number; model?: string } | null {
    const candidates: unknown[] = [];
    if (diffInput && typeof diffInput === "object" && !Array.isArray(diffInput)) {
      candidates.push(diffInput);
    }
    const text = typeof diffInput === "string" ? diffInput.trim() : "";
    if (text) {
      candidates.push(text);
      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence?.[1]) candidates.push(fence[1].trim());
    }
    for (const c of candidates) {
      try {
        const parsed = typeof c === "string" ? JSON.parse(c) : c;
        if (!parsed || typeof parsed !== "object") continue;
        const out: { system_prompt?: string; temperature?: number; model?: string } = {};
        if (typeof (parsed as any).system_prompt === "string" && (parsed as any).system_prompt.trim()) {
          out.system_prompt = (parsed as any).system_prompt;
        }
        if (typeof (parsed as any).model === "string" && (parsed as any).model.trim()) {
          out.model = (parsed as any).model;
        }
        const tempNum = Number((parsed as any).temperature);
        if (Number.isFinite(tempNum)) {
          out.temperature = Math.max(0, Math.min(2, Number(tempNum.toFixed(4))));
        }
        if (out.system_prompt || out.model || typeof out.temperature === "number") return out;
      } catch {
        // continue
      }
    }
    return null;
  }

  async function runPatchProposalTick(args?: {
    project_id?: string;
    top_domains?: number;
    transfer_window?: number;
    mutation_window?: number;
    gihi_window?: number;
    publish_only?: boolean;
    dry_run?: boolean;
    batch_size?: number;
  }) {
    await ensureSyncDir();
    const startedAtIso = new Date().toISOString();
    const topDomains = Math.max(1, Math.min(6, Math.trunc(Number(args?.top_domains ?? 2))));
    const projectId = typeof args?.project_id === "string" && args.project_id.trim()
      ? args.project_id.trim()
      : null;
    const [meta, transfer, arena, failedJobs] = await Promise.all([
      intelligenceMetaSnapshot({
        syncDir: SYNC_DIR,
        transfer_window: typeof args?.transfer_window === "number" ? Math.trunc(args.transfer_window) : undefined,
        mutation_window: typeof args?.mutation_window === "number" ? Math.trunc(args.mutation_window) : undefined,
        gihi_window: typeof args?.gihi_window === "number" ? Math.trunc(args.gihi_window) : undefined,
      }),
      transferDiagnosticsSnapshot({ syncDir: SYNC_DIR }),
      arenaTelemetrySnapshot({ syncDir: SYNC_DIR, limit_domains: 20 }),
      jobHistoryList({ syncDir: SYNC_DIR, status: "error", limit: 10 }),
    ]);
    const transferDomains = Array.isArray((transfer as any)?.snapshot?.per_domain_transfer)
      ? (transfer as any).snapshot.per_domain_transfer
      : [];
    const arenaDomains = Array.isArray((arena as any)?.snapshot?.domains)
      ? (arena as any).snapshot.domains
      : [];
    const topVarianceDomains = [...transferDomains]
      .sort((a: any, b: any) => Number(b?.transfer_variance ?? 0) - Number(a?.transfer_variance ?? 0))
      .slice(0, topDomains)
      .map((d: any) => ({
        domain_signature: d?.domain_signature ?? null,
        transfer_variance: d?.transfer_variance ?? null,
        evidence_drop_reason_recent_last: d?.evidence_drop_reason_recent_last ?? null,
        evidence_observations_recent_ewma: d?.evidence_observations_recent_ewma ?? null,
      }));
    const topEntropyDomains = [...arenaDomains]
      .sort((a: any, b: any) => Number(b?.strategy_entropy ?? 0) - Number(a?.strategy_entropy ?? 0))
      .slice(0, topDomains)
      .map((d: any) => ({
        domain_signature: d?.domain_signature ?? null,
        strategy_entropy: d?.strategy_entropy ?? null,
        top_active_share: d?.top_active_share ?? null,
      }));
    const failed = Array.isArray((failedJobs as any)?.items)
      ? (failedJobs as any).items.slice(0, 5).map((j: any) => ({
          job_id: j?.job_id ?? null,
          logical_queue: j?.logical_queue ?? null,
          type: j?.type ?? null,
          error: j?.error ?? null,
        }))
      : [];
    const brief = {
      mode: "patch_proposal_tick_v1",
      project_id: projectId,
      objective: "Propose 1-2 safe patches using PatchEnvelope JSON only.",
      constraints: {
        proposal_only: true,
        no_auto_apply: true,
        allow_kinds: ["prompt_patch", "repo_patch"],
        prefer_kind: "prompt_patch",
      },
      snapshots: {
        meta: {
          meta_state: (meta as any)?.snapshot?.meta_state ?? null,
          arena_entropy: (meta as any)?.snapshot?.arena_entropy ?? null,
          gihi_delta_ultra: (meta as any)?.snapshot?.gihi_delta_ultra ?? null,
          transfer_variance_trend: (meta as any)?.snapshot?.transfer_variance_trend ?? null,
          mutation_roi_trend: (meta as any)?.snapshot?.mutation_roi_trend ?? null,
        },
        top_transfer_variance_domains: topVarianceDomains,
        top_entropy_domains: topEntropyDomains,
        failed_jobs_recent: failed,
      },
      output_contract: {
        max_patches: 2,
        required: ["kind", "scope", "diff", "rationale", "risk", "tests", "success_metrics", "rollback_plan"],
      },
      ask: [
        "Return only JSON with field patches[].",
        "For prompt_patch use scope agent:<role> and diff as JSON object with optional system_prompt/model/temperature.",
        "Keep risk low where possible.",
      ],
    };
    const snapshotTs = String((meta as any)?.snapshot?.computed_at ?? new Date().toISOString());
    const dedupe = `patch_proposal:${projectId ?? "global"}:${snapshotTs}`;
    const conversationId = projectId ? `patch_proposal:${projectId}` : "patch_proposal";
    const published = await eventPublish({
      syncDir: SYNC_DIR,
      type: "patch_proposal.request",
      source: "patch-proposal",
      direction: "outbound",
      conversation_id: conversationId,
      dedupe_key: dedupe,
      payload: brief,
    });
    const publishOnly = Boolean(args?.publish_only || args?.dry_run);
    const sync = publishOnly
      ? null
      : await runSyncOutboundOnce(
          typeof args?.batch_size === "number" && Number.isFinite(args.batch_size)
            ? Math.max(1, Math.trunc(args.batch_size))
            : 10
        );
    // Backstop for environments where inbound mapping path is idle:
    // replay recent inbound openai.response events for this conversation
    // so patch proposals are materialized into notes deterministically.
    let replayed = 0;
    if (!publishOnly) {
      const inbound = await eventList({
        syncDir: SYNC_DIR,
        direction: "inbound",
        limit: 200,
      });
      const recentPatchResponses = inbound.items
        .filter((evt: any) => evt?.type === "openai.response")
        .filter((evt: any) => String(evt?.conversation_id ?? "") === conversationId)
        .filter((evt: any) => Date.parse(String(evt?.ts ?? 0)) >= Date.parse(startedAtIso))
        .slice(-3);
      for (const evt of recentPatchResponses) {
        const responseId = String((evt as any)?.payload?.response_id ?? "").trim();
        const text = typeof (evt as any)?.payload?.text === "string" ? (evt as any).payload.text : "";
        if (!responseId || !text) continue;
        await applyAssistantResponse({
          syncDir: SYNC_DIR,
          responseId,
          conversationId,
          text,
        });
        replayed += 1;
      }
    }
    const recentProposals = await notesList({ syncDir: SYNC_DIR, query: "patch_proposal:", limit: 3 });
    return {
      ok: true,
      dry_run: publishOnly,
      published,
      sync_outbound: sync,
      replayed_responses: replayed,
      proposals_recent: recentProposals.items.map((n) => ({ id: n.id, title: n.title, updated_at: n.updated_at })),
      summary: {
        meta_state: (meta as any)?.snapshot?.meta_state ?? null,
        arena_entropy: (meta as any)?.snapshot?.arena_entropy ?? null,
        top_transfer_variance_domains: topVarianceDomains,
      },
    };
  }

  function extractUnifiedDiffPaths(diffText: string): string[] {
    const out = new Set<string>();
    const lines = String(diffText ?? "").split(/\r?\n/);
    for (const raw of lines) {
      const line = String(raw);
      if (!line.startsWith("+++ ")) continue;
      let p = line.slice(4).trim();
      if (!p || p === "/dev/null") continue;
      if (p.startsWith("b/")) p = p.slice(2);
      p = p.replace(/\\/g, "/");
      if (!p || p.includes("..") || p.startsWith("/") || /^[a-zA-Z]:\//.test(p)) continue;
      out.add(p);
    }
    return Array.from(out);
  }

  function isPatchPathAllowed(relPath: string): boolean {
    const normalized = String(relPath ?? "").replace(/\\/g, "/").trim();
    if (!normalized) return false;
    const raw = String(process.env.PATCH_REPO_ALLOW_PATHS ?? "src/,tests/,ops/,README.md,package.json,tsconfig.json").trim();
    const patterns = raw
      .split(",")
      .map((x) => x.trim().replace(/\\/g, "/"))
      .filter(Boolean);
    if (patterns.length === 0) return false;
    return patterns.some((pat) => normalized === pat || normalized.startsWith(pat.endsWith("/") ? pat : `${pat}/`));
  }

  async function runPatchValidationCommands(commandsInput: string[], timeoutMs: number, maxCommands: number) {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const commandSet = new Set<string>();
    for (const cmd of commandsInput ?? []) {
      const normalized = String(cmd ?? "").trim();
      if (normalized) commandSet.add(normalized);
    }
    if (commandSet.size === 0) commandSet.add("npm run -s build");
    const commands = Array.from(commandSet).slice(0, maxCommands);
    const results: any[] = [];
    for (const command of commands) {
      const lower = command.toLowerCase();
      let execResult: any;
      if (lower === "npm run -s build") {
        execResult = await runExecInternal({ cmd: npmCmd, args: ["run", "-s", "build"], cwd: process.cwd(), timeout_ms: timeoutMs });
      } else if (lower === "npm run build") {
        execResult = await runExecInternal({ cmd: npmCmd, args: ["run", "build"], cwd: process.cwd(), timeout_ms: timeoutMs });
      } else if (lower === "npm test" || lower === "npm run test" || lower === "npm run -s test") {
        execResult = await runExecInternal({ cmd: npmCmd, args: ["test"], cwd: process.cwd(), timeout_ms: timeoutMs });
      } else if (lower === "npm run lint" || lower === "npm run -s lint") {
        execResult = await runExecInternal({ cmd: npmCmd, args: ["run", "lint"], cwd: process.cwd(), timeout_ms: timeoutMs });
      } else {
        execResult = {
          success: false,
          exit_code: -2,
          duration_ms: 0,
          stdout: "",
          stderr: `unsupported_test_command:${command}`,
        };
      }
      results.push({
        command,
        success: Boolean(execResult?.success),
        exit_code: Number(execResult?.exit_code ?? -1),
        duration_ms: Number(execResult?.duration_ms ?? 0),
        stderr_tail: String(execResult?.stderr ?? "").slice(-1200),
        stdout_tail: String(execResult?.stdout ?? "").slice(-1200),
      });
    }
    return {
      commands: results,
      overall_pass: results.length > 0 && results.every((r) => r.success === true),
    };
  }

  async function runPatchTestTick(args?: { limit?: number; timeout_ms?: number; max_commands?: number }) {
    await ensureSyncDir();
    const syncInbound = await runSyncInboundOnce(1);
    const limit = Math.max(1, Math.min(10, Math.trunc(Number(args?.limit ?? 3))));
    const timeoutMs = Math.max(10_000, Math.min(10 * 60_000, Math.trunc(Number(args?.timeout_ms ?? 120_000))));
    const maxCommands = Math.max(1, Math.min(4, Math.trunc(Number(args?.max_commands ?? 2))));
    const proposals = await notesList({ syncDir: SYNC_DIR, query: "patch_proposal", limit: 100 });
    const proposalNotes = proposals.items.filter((note: any) => {
      const title = String(note?.title ?? "");
      const id = String(note?.id ?? "");
      const tags = Array.isArray(note?.tags) ? note.tags.map((x: any) => String(x).toLowerCase()) : [];
      return title.startsWith("patch_proposal:") || id.startsWith("patch-proposal:") || (tags.includes("patch") && tags.includes("proposal"));
    });
    const processed: any[] = [];
    for (const note of proposalNotes) {
      if (processed.length >= limit) break;
      const parsed = parsePatchProposalNote(note);
      if (!parsed) continue;
      const reportId = `patch-test-report:${parsed.proposal_id}`;
      const existingReport = await notesGet({ syncDir: SYNC_DIR, id: reportId });
      if (existingReport.note) continue;

      const commandsInput: string[] = [];
      for (const patch of parsed.patches) {
        for (const cmd of patch.tests) commandsInput.push(String(cmd ?? ""));
      }
      const validation = await runPatchValidationCommands(commandsInput, timeoutMs, maxCommands);
      const ok = validation.overall_pass;
      const report = {
        proposal_id: parsed.proposal_id,
        tested_at: new Date().toISOString(),
        overall_pass: ok,
        commands: validation.commands,
        patch_kinds: parsed.patches.map((p) => p.kind),
        patch_scopes: parsed.patches.map((p) => p.scope),
      };
      await notesUpsert({
        syncDir: SYNC_DIR,
        id: reportId,
        title: "patch_test_report",
        content: JSON.stringify(report, null, 2),
        tags: ["patch", "test_report", ok ? "pass" : "fail"],
      });
      processed.push(report);
    }
    return {
      ok: true,
      sync_inbound: syncInbound,
      scanned: proposalNotes.length,
      processed_count: processed.length,
      reports: processed,
    };
  }

  async function runPatchGovernanceTick(args?: {
    dry_run?: boolean;
    limit?: number;
    auto_activate?: boolean;
    auto_apply_repo?: boolean;
    auto_commit_repo?: boolean;
    timeout_ms?: number;
    max_commands?: number;
  }) {
    await ensureSyncDir();
    const dryRun = args?.dry_run !== false;
    const autoActivate = Boolean(args?.auto_activate);
    const autoApplyRepo = Boolean(args?.auto_apply_repo);
    const autoCommitRepo = Boolean(args?.auto_commit_repo);
    const limit = Math.max(1, Math.min(3, Math.trunc(Number(args?.limit ?? 1))));
    const timeoutMs = Math.max(10_000, Math.min(10 * 60_000, Math.trunc(Number(args?.timeout_ms ?? 120_000))));
    const maxCommands = Math.max(1, Math.min(4, Math.trunc(Number(args?.max_commands ?? 2))));
    const gitCmd = process.platform === "win32" ? "git.exe" : "git";
    const lock = await acquireLock({
      locksDir: path.join(SYNC_DIR, "queue", "locks"),
      name: "patch_governance_tick",
      ttl_ms: 120_000,
    });
    if (!lock.ok || !lock.token) {
      return { ok: false, reason: "patch_governance_lock_busy" };
    }
    try {
      const proposals = await notesList({ syncDir: SYNC_DIR, query: "patch_proposal", limit: 150 });
      const proposalNotes = proposals.items.filter((note: any) => {
        const title = String(note?.title ?? "");
        const id = String(note?.id ?? "");
        const tags = Array.isArray(note?.tags) ? note.tags.map((x: any) => String(x).toLowerCase()) : [];
        return title.startsWith("patch_proposal:") || id.startsWith("patch-proposal:") || (tags.includes("patch") && tags.includes("proposal"));
      });
      const decisions: any[] = [];
      for (const note of proposalNotes) {
        if (decisions.length >= limit) break;
        const parsed = parsePatchProposalNote(note);
        if (!parsed) continue;
        const report = await notesGet({ syncDir: SYNC_DIR, id: `patch-test-report:${parsed.proposal_id}` });
        if (!report.note) continue;
        let reportPayload: any = null;
        try {
          reportPayload = JSON.parse(String(report.note.content ?? "{}"));
        } catch {
          continue;
        }
        if (!Boolean(reportPayload?.overall_pass)) continue;
        const decisionId = dryRun
          ? `patch-governance-preview:${parsed.proposal_id}`
          : `patch-governance-apply:${parsed.proposal_id}`;
        const existingDecision = await notesGet({ syncDir: SYNC_DIR, id: decisionId });
        if (existingDecision.note) continue;

        const applied: any[] = [];
        const manualTasks: any[] = [];
        const scheduledShadowEvals: any[] = [];
        for (const patch of parsed.patches) {
          if (patch.kind === "repo_patch") {
            const taskId = `patch-review-${createHash("sha1").update(`${parsed.proposal_id}|${patch.scope}|${patch.diff}`).digest("hex").slice(0, 16)}`;
            const diffText = String(patch.diff ?? "");
            const touched = extractUnifiedDiffPaths(diffText);
            const disallowed = touched.filter((p) => !isPatchPathAllowed(p));
            if (disallowed.length > 0) {
              applied.push({
                kind: patch.kind,
                scope: patch.scope,
                status: "skipped_disallowed_paths",
                touched_paths: touched,
                disallowed_paths: disallowed,
              });
              continue;
            }
            if (dryRun) {
              applied.push({
                kind: patch.kind,
                scope: patch.scope,
                status: "dry_run_repo_patch",
                touched_paths: touched,
              });
              continue;
            }
            if (!autoApplyRepo) {
              await tasksUpsert({
                syncDir: SYNC_DIR,
                id: taskId,
                title: `Review repo patch: ${patch.scope}`,
                description: `${patch.rationale}\n\nRisk: ${patch.risk}\n\nDiff:\n${patch.diff}\n\nRollback:\n${patch.rollback_plan ?? "n/a"}`,
                status: "todo",
                labels: ["patch", "repo", "manual_review"],
              });
              manualTasks.push({ task_id: taskId, scope: patch.scope });
              continue;
            }
            const patchDir = path.join(SYNC_DIR, "patches");
            await fs.mkdir(patchDir, { recursive: true });
            const patchName = `${createHash("sha1").update(`${parsed.proposal_id}|${patch.scope}|${diffText}`).digest("hex").slice(0, 16)}.diff`;
            const patchPath = path.join(patchDir, patchName);
            const diffForApply = diffText.endsWith("\n") ? diffText : `${diffText}\n`;
            await fs.writeFile(patchPath, diffForApply, "utf8");
            const check: any = await runExecInternal({
              cmd: gitCmd,
              args: ["apply", "--check", "--whitespace=nowarn", patchPath],
              cwd: process.cwd(),
              timeout_ms: timeoutMs,
            });
            if (!Boolean(check?.success)) {
              applied.push({
                kind: patch.kind,
                scope: patch.scope,
                status: "repo_apply_check_failed",
                touched_paths: touched,
                stderr_tail: String(check?.stderr ?? "").slice(-1200),
              });
              continue;
            }
            const apply: any = await runExecInternal({
              cmd: gitCmd,
              args: ["apply", "--whitespace=nowarn", patchPath],
              cwd: process.cwd(),
              timeout_ms: timeoutMs,
            });
            if (!Boolean(apply?.success)) {
              applied.push({
                kind: patch.kind,
                scope: patch.scope,
                status: "repo_apply_failed",
                touched_paths: touched,
                stderr_tail: String(apply?.stderr ?? "").slice(-1200),
              });
              continue;
            }
            const validation = await runPatchValidationCommands(patch.tests, timeoutMs, maxCommands);
            if (!validation.overall_pass) {
              const rollback: any = await runExecInternal({
                cmd: gitCmd,
                args: ["apply", "-R", "--whitespace=nowarn", patchPath],
                cwd: process.cwd(),
                timeout_ms: timeoutMs,
              });
              applied.push({
                kind: patch.kind,
                scope: patch.scope,
                status: "repo_applied_rolled_back_validation_failed",
                touched_paths: touched,
                validation: validation.commands,
                rollback_success: Boolean(rollback?.success),
                rollback_stderr_tail: String(rollback?.stderr ?? "").slice(-1200),
              });
              continue;
            }
            let commit = null as any;
            if (autoCommitRepo) {
              const add: any = await runExecInternal({
                cmd: gitCmd,
                args: ["add", "--", ...touched],
                cwd: process.cwd(),
                timeout_ms: timeoutMs,
              });
              if (Boolean(add?.success)) {
                const msg = `auto(repo_patch): ${patch.scope} [proposal ${parsed.proposal_id}]`;
                const doCommit: any = await runExecInternal({
                  cmd: gitCmd,
                  args: ["commit", "-m", msg],
                  cwd: process.cwd(),
                  timeout_ms: timeoutMs,
                });
                commit = {
                  success: Boolean(doCommit?.success),
                  stderr_tail: String(doCommit?.stderr ?? "").slice(-1200),
                  stdout_tail: String(doCommit?.stdout ?? "").slice(-1200),
                };
              } else {
                commit = {
                  success: false,
                  stderr_tail: String(add?.stderr ?? "").slice(-1200),
                };
              }
            }
            applied.push({
              kind: patch.kind,
              scope: patch.scope,
              status: "repo_patch_applied",
              touched_paths: touched,
              validation: validation.commands,
              commit,
            });
            await eventPublish({
              syncDir: SYNC_DIR,
              type: "patch.repo.applied",
              source: "patch-governance",
              direction: "outbound",
              dedupe_key: `patch-repo-applied:${parsed.proposal_id}:${patch.scope}:${createHash("sha1").update(diffText).digest("hex").slice(0, 12)}`,
              payload: {
                proposal_id: parsed.proposal_id,
                scope: patch.scope,
                touched_paths: touched,
                auto_commit: autoCommitRepo,
              },
            });
            if (!dryRun) {
              await tasksUpsert({
                syncDir: SYNC_DIR,
                id: taskId,
                title: `Patch applied: ${patch.scope}`,
                description: `${patch.rationale}\n\nApplied paths:\n${touched.join("\n")}\n\nRollback:\n${patch.rollback_plan ?? "git apply -R <saved.diff>"}`,
                status: "done",
                labels: ["patch", "repo", "auto_applied"],
              });
            }
            continue;
          }
          const scope = String(patch.scope ?? "").trim().toLowerCase();
          const m = scope.match(/^agent:(planner|dev|research|critic)$/);
          if (!m) {
            applied.push({ kind: patch.kind, scope: patch.scope, status: "skipped_invalid_scope" });
            continue;
          }
          const role = m[1] as AgentRole;
          const parsedDiff = parsePatchDiffJson(patch.diff);
          if (!parsedDiff) {
            applied.push({ kind: patch.kind, scope: patch.scope, status: "skipped_unparseable_diff" });
            continue;
          }
          if (dryRun) {
            applied.push({ kind: patch.kind, scope: patch.scope, status: "dry_run", patch: parsedDiff });
            continue;
          }
          const roleRegistry = await agentRegistryList(SYNC_DIR, role);
          const existingShadows = roleRegistry.items.filter((a) => !a.active && !!a.parent_version);
          if (existingShadows.length > 0) {
            applied.push({
              kind: patch.kind,
              scope: patch.scope,
              status: "hold_existing_shadow",
              role,
              existing_shadow_versions: existingShadows.map((s) => s.version).slice(0, 5),
            });
            continue;
          }
          const created = await agentVersionCreate({
            syncDir: SYNC_DIR,
            role,
            model: parsedDiff.model,
            temperature: parsedDiff.temperature,
            system_prompt: parsedDiff.system_prompt,
            activate: false,
          });
          const createdVersion = Number((created as any)?.agent?.version ?? NaN);
          let activated = false;
          if (autoActivate && Number.isFinite(createdVersion)) {
            await agentVersionActivate({
              syncDir: SYNC_DIR,
              role,
              version: createdVersion,
              reason: `patch_governance_tick:${parsed.proposal_id}`,
            });
            activated = true;
          }
          applied.push({
            kind: patch.kind,
            scope: patch.scope,
            status: "created_shadow",
            role,
            version: Number.isFinite(createdVersion) ? createdVersion : null,
            activated,
          });
          if (!dryRun && Number.isFinite(createdVersion)) {
            const notBefore = new Date(Date.now() + 2 * 60_000).toISOString();
            const evalPayload = {
              command: "shadow_evaluation_tick",
              role,
              max_evaluations: 5,
              sample_size: 40,
              promote_threshold: 0.02,
              discard_on_fail: true,
              not_before_ts: notBefore,
            };
            await queuePush({
              syncDir: SYNC_DIR,
              type: "project_task",
              logical_queue: "meta",
              source: "patch-governance",
              job_id: `shadow-eval:${role}:v${createdVersion}`,
              payload: evalPayload,
            });
            scheduledShadowEvals.push({
              role,
              version: createdVersion,
              not_before_ts: notBefore,
            });
          }
        }
      const decision = {
        proposal_id: parsed.proposal_id,
        decided_at: new Date().toISOString(),
        dry_run: dryRun,
        auto_apply_repo: autoApplyRepo,
        auto_commit_repo: autoCommitRepo,
        test_report_id: `patch-test-report:${parsed.proposal_id}`,
        applied,
        manual_tasks: manualTasks,
          scheduled_shadow_evaluations: scheduledShadowEvals,
        };
        await notesUpsert({
          syncDir: SYNC_DIR,
          id: decisionId,
          title: "patch_governance_decision",
          content: JSON.stringify(decision, null, 2),
          tags: ["patch", "governance", dryRun ? "preview" : "applied"],
        });
        decisions.push(decision);
      }
      await eventPublish({
        syncDir: SYNC_DIR,
        type: "patch.governance.tick",
        source: "patch-governance",
        data: {
          dry_run: dryRun,
          decisions_count: decisions.length,
        },
      });
      return {
        ok: true,
        dry_run: dryRun,
        auto_apply_repo: autoApplyRepo,
        auto_commit_repo: autoCommitRepo,
        decisions_count: decisions.length,
        decisions,
      };
    } finally {
      await releaseLock({
        locksDir: path.join(SYNC_DIR, "queue", "locks"),
        name: "patch_governance_tick",
        token: lock.token,
      });
    }
  }

  async function runEnqueueInboundResponseId(conversationId: string, responseId: string, dedupeKey?: string) {
    await ensureSyncDir();
    const dedupe = (dedupeKey ?? responseId).trim();
    const isDuplicate = await hasDedupeKey(SYNC_DIR, "inbound", dedupe);
    if (isDuplicate) {
      return {
        queued: false,
        reason: "duplicate",
        conversation_id: conversationId,
        response_id: responseId,
        dedupe_key: dedupe,
      };
    }

    const mapping = await enqueueInboundResponseId(SYNC_DIR, conversationId, responseId);
    return {
      queued: true,
      conversation_id: mapping.conversation_id,
      response_id: responseId,
      pending_inbound_response_ids: mapping.pending_inbound_response_ids,
    };
  }

  async function applyResearchImpactOnExperimentConverged(search: {
    experiment_id: string;
    phase?: string;
    stop_reason?: string | null;
    force_check?: boolean;
    tick_index?: number;
    tick_id?: string;
    campaign_id?: string;
  }) {
    if (!search.force_check && search.phase !== "converged") return null;
    const computed = await experimentComputeResearchMetrics({
      syncDir: SYNC_DIR,
      experiment_id: search.experiment_id,
    });
    let allowImpact = computed.metrics.converged;
    if (!allowImpact && search.force_check) {
      const listed = await experimentList({ syncDir: SYNC_DIR, limit: 2000 });
      const exp = listed.items.find((x) => x.experiment_id === search.experiment_id);
      const completedRuns = Number(computed.metrics.completed_runs ?? 0);
      allowImpact = Boolean(exp && (exp.status === "completed" || completedRuns > 0));
    }
    if (!allowImpact) return null;

    const research = await agentGetActiveByRole(SYNC_DIR, "research");
    const impact = await agentMetricsRecordResearchImpact({
      syncDir: SYNC_DIR,
      role: "research",
      version: research.version,
      sample: {
        experiment_id: computed.metrics.experiment_id,
        improvement_delta: computed.metrics.improvement_delta,
        convergence_steps: computed.metrics.convergence_steps,
        exploration_efficiency: computed.metrics.exploration_efficiency,
        best_score_trend: computed.metrics.best_score_trend,
        stagnation_rate: computed.metrics.stagnation_rate,
        variance_stability: computed.metrics.variance_stability,
        domain_profile: computed.metrics.domain_profile,
        domain_complexity_factor: computed.metrics.domain_complexity_factor,
      },
    });
    let transfer_memory_update: any = null;
    try {
      const adaptiveByDomain = normalizeAdaptiveProfilesByDomain(
        research.profile?.adaptive_profiles_by_domain,
        research.profile?.adaptive_profile
      );
      const domainSize = computed.metrics.domain_profile.size_category;
      const adaptiveForDomain = adaptiveByDomain[domainSize] ?? normalizeAdaptiveProfile(research.profile?.adaptive_profile);
      transfer_memory_update = await researchMemoryUpsertFromOutcome({
        syncDir: SYNC_DIR,
        experiment_id: computed.metrics.experiment_id,
        domain_profile: computed.metrics.domain_profile,
        adaptive_profile: adaptiveForDomain,
        research_fitness: impact.research_fitness,
        // Exec-ingest path is used to drive arena selection under stress even when
        // short-term fitness is low; otherwise arena never sees harmful-transfer signals.
        min_fitness_to_store: search.phase === "exec_ingest" ? 0 : undefined,
        strategy_context: {
          domain_signature: computed.metrics.transfer_context.domain_signature,
          strategy_id: computed.metrics.transfer_context.strategy_id,
          strategy_version_id: computed.metrics.transfer_context.strategy_version_id,
          transfer_confidence: computed.metrics.transfer_context.transfer_confidence,
          transfer_initialized: computed.metrics.transfer_context.transfer_initialized,
          tick_index: typeof search.tick_index === "number" ? search.tick_index : undefined,
          tick_id: typeof search.tick_id === "string" ? search.tick_id : undefined,
          campaign_id: typeof search.campaign_id === "string" ? search.campaign_id : undefined,
        },
        experiment_metrics: {
          variance_stability: computed.metrics.variance_stability,
          improvement_delta: computed.metrics.improvement_delta,
          convergence_steps: computed.metrics.convergence_steps,
          best_score_trend: computed.metrics.best_score_trend,
          completed_runs: computed.metrics.completed_runs,
        },
      });
      if (transfer_memory_update?.arena?.evaluated) {
        await eventPublish({
          syncDir: SYNC_DIR,
          type: "strategy_arena_evaluated",
          source: "research-arena",
          direction: "outbound",
          dedupe_key: `arena-evaluated:${computed.metrics.experiment_id}`,
          payload: {
            experiment_id: computed.metrics.experiment_id,
            domain_signature: transfer_memory_update.arena.domain_signature ?? null,
            winner_strategy_id: transfer_memory_update.arena.winner_strategy_id ?? null,
            decisions: transfer_memory_update.arena.decisions ?? [],
          },
        });
      }
      if (transfer_memory_update && transfer_memory_update.reason === "suspect_experiment_anomaly") {
        await eventPublish({
          syncDir: SYNC_DIR,
          type: "experiment_anomaly",
          source: "research-stabilization",
          direction: "outbound",
          dedupe_key: `experiment-anomaly:${computed.metrics.experiment_id}`,
          payload: {
            experiment_id: computed.metrics.experiment_id,
            anomaly_flags: transfer_memory_update.anomaly_flags ?? null,
            action: "memory_update_skipped",
            require_recheck: true,
          },
        });
      }
      if (transfer_memory_update && transfer_memory_update.reason === "catastrophic_forgetting_guard") {
        await eventPublish({
          syncDir: SYNC_DIR,
          type: "transfer_guard_triggered",
          source: "research-stabilization",
          direction: "outbound",
          dedupe_key: `transfer-guard:${computed.metrics.experiment_id}`,
          payload: {
            experiment_id: computed.metrics.experiment_id,
            blocked_until: transfer_memory_update.blocked_until ?? null,
            anomaly_event: transfer_memory_update.anomaly_event ?? "transfer_degradation_detected",
            fallback_profile: transfer_memory_update.fallback_profile ?? null,
          },
        });
      }
    } catch (e: any) {
      transfer_memory_update = {
        updated: false,
        reason: "memory_update_error",
        error: String(e?.message ?? e),
      };
    }

    const normalizedEvidenceGate = normalizeEvidenceGate(transfer_memory_update?.evidence_gate ?? null);

    await eventPublish({
      syncDir: SYNC_DIR,
      type: "experiment_complete",
      source: "research-adaptive",
      direction: "outbound",
      dedupe_key: `experiment-complete:${search.experiment_id}`,
      payload: {
        experiment_id: search.experiment_id,
        phase: search.phase,
        stop_reason: search.stop_reason ?? null,
        metrics: computed.metrics,
        research_agent_version: research.version,
        research_fitness: impact.research_fitness,
        evidence_gate: normalizedEvidenceGate,
        transfer_memory_update,
      },
    });
    await eventPublish({
      syncDir: SYNC_DIR,
      type: "research.impact",
      source: "research-adaptive",
      direction: "outbound",
      dedupe_key: `research-impact:${search.experiment_id}`,
      payload: {
        experiment_id: search.experiment_id,
        metrics: computed.metrics,
        research_agent_version: research.version,
        research_fitness: impact.research_fitness,
      },
    });

    return {
      research_metrics: computed.metrics,
      research_fitness: impact.research_fitness,
      research_agent_version: research.version,
      transfer_memory_update,
    };
  }

  async function runExperimentSearchTickWithResearchProfile(args: {
    experiment_id: string;
    batch_size?: number;
  }) {
    let adaptiveProfile: any = undefined;
    let adaptiveProfilesByDomain: any = undefined;
    try {
      const activeResearch = await agentGetActiveByRole(SYNC_DIR, "research");
      adaptiveProfile = activeResearch.profile?.adaptive_profile;
      adaptiveProfilesByDomain = normalizeAdaptiveProfilesByDomain(
        activeResearch.profile?.adaptive_profiles_by_domain,
        activeResearch.profile?.adaptive_profile
      );
    } catch {
      adaptiveProfile = undefined;
      adaptiveProfilesByDomain = undefined;
    }
    return experimentSearchTick({
      syncDir: SYNC_DIR,
      experiment_id: args.experiment_id,
      batch_size: args.batch_size,
      adaptive_profile: adaptiveProfile,
      adaptive_profiles_by_domain: adaptiveProfilesByDomain,
    });
  }

  function extractObjectiveMetricName(objective: any): string | null {
    if (objective && typeof objective === "object" && typeof objective.metric === "string") {
      const metric = objective.metric.trim();
      return metric || null;
    }
    if (typeof objective === "string") {
      const m = objective.trim().match(/^(maximize|minimize)\s+([a-zA-Z0-9_.-]+)$/i);
      if (m && m[2]) return m[2];
    }
    return null;
  }

  function normalizeObjectiveForExperiment(objective: any): { metric: string; mode: "maximize" | "minimize" } {
    if (objective && typeof objective === "object") {
      const metricRaw = typeof objective.metric === "string" ? objective.metric.trim() : "";
      const modeRaw = typeof objective.mode === "string" ? objective.mode.trim().toLowerCase() : "";
      const mode = modeRaw === "minimize" ? "minimize" : "maximize";
      const metric = metricRaw || "score";
      return { metric, mode };
    }

    if (typeof objective === "string") {
      const m = objective.trim().match(/^(maximize|minimize)\s+([a-zA-Z0-9_.-]+)$/i);
      if (m && m[1] && m[2]) {
        const mode = m[1].toLowerCase() === "minimize" ? "minimize" : "maximize";
        const metric = m[2].trim() || "score";
        return { metric, mode };
      }
    }

    return { metric: "score", mode: "maximize" };
  }

  function buildDefaultMetricSchemaForObjective(objective: any): Record<string, any> | undefined {
    const metric = extractObjectiveMetricName(objective) ?? "score";
    const escaped = metric.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      [metric]: {
        type: "float",
        source: "combined",
        pattern: `${escaped}=([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)`,
      },
    };
  }

  function normalizeEvidenceGate(input: any) {
    const eg = (input && typeof input === "object") ? input : {};
    const b = (v: any) => v === true ? true : false;
    const n = (v: any) => Number.isFinite(Number(v)) ? Number(v) : null;
    const s = (v: any) => (typeof v === "string" && v.length > 0) ? v : null;
    const obs = (v: any): number | null => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") {
        const m = v.match(/-?\d+(\.\d+)?/);
        if (m) {
          const parsed = Number(m[0]);
          if (Number.isFinite(parsed)) return parsed;
        }
      }
      if (Array.isArray(v)) return v.length;
      if (v && typeof v === "object") {
        const o = v as Record<string, any>;
        const cands: any[] = [
          o.observations,
          o.count,
          o.n,
          o.total,
          o.value,
          Array.isArray(o.items) ? o.items.length : null,
        ];
        for (const c of cands) {
          const got = obs(c);
          if (got != null) return got;
        }
      }
      return null;
    };
    const schemaVersionRaw = Number(eg.schema_version);
    const schemaVersion = Number.isFinite(schemaVersionRaw) && schemaVersionRaw > 0
      ? Math.trunc(schemaVersionRaw)
      : 2;
    const observationsRawValue = eg.observations;
    const observationsRawValueType = observationsRawValue == null
      ? "nullish"
      : Array.isArray(observationsRawValue)
        ? "array"
        : typeof observationsRawValue;
    const observationsValue = obs(observationsRawValue);

    return {
      schema_version: schemaVersion,
      domain_signature: s(eg.domain_signature),
      tick_index: n(eg.tick_index),
      min_observations: n(eg.min_observations),
      observations: observationsValue == null ? 0 : observationsValue,
      observations_raw_value_type: observationsRawValueType,
      transfer_confidence: n(eg.transfer_confidence),
      evidence_confidence: n(eg.evidence_confidence),
      success_rate: n(eg.success_rate),
      impact_allowed_micro: b(eg.impact_allowed_micro),
      micro_candidate: b(eg.micro_candidate),
      micro_attempted: b(eg.micro_attempted),
      micro_not_considered_due_to_budget: b(eg.micro_not_considered_due_to_budget),
      micro_throttled_by_budget: b(eg.micro_throttled_by_budget),
      micro_throttled_by_domain_tick_cooldown: b(eg.micro_throttled_by_domain_tick_cooldown),
      micro_throttled_by_other_gates: b(eg.micro_throttled_by_other_gates),
      micro_gate_signal_name: s(eg.micro_gate_signal_name),
      micro_gate_signal_value: n(eg.micro_gate_signal_value),
      micro_gate_threshold: n(eg.micro_gate_threshold),
      last_micro_impact_tick_index: n(eg.last_micro_impact_tick_index),
      match_gate_failed: b(eg.match_gate_failed),
      observations_gate_failed: b(eg.observations_gate_failed),
      micro_confidence_gate_failed: b(eg.micro_confidence_gate_failed),
      confidence_gate_failed: b(eg.confidence_gate_failed),
      impact_level: s(eg.impact_level),
      impact_scale: n(eg.impact_scale),
    };
  }

  function extractTemplateKeys(template: string): string[] {
    const keys = new Set<string>();
    const re = /\{([a-zA-Z0-9_.-]+)\}/g;
    let match: RegExpExecArray | null = null;
    while ((match = re.exec(template))) {
      if (match[1]) keys.add(match[1]);
    }
    return [...keys];
  }

  function isTemplateCompatibleWithSearchSpace(template: string, searchSpace: Record<string, any[]>): boolean {
    const keys = extractTemplateKeys(template);
    if (keys.length === 0) return true;
    const available = new Set(Object.keys(searchSpace ?? {}));
    return keys.every((k) => available.has(k));
  }

  async function inferExecTemplateForCampaign(opts: {
    campaignId: string;
    objective: any;
    searchSpace: Record<string, any[]>;
  }): Promise<{ template: string; source_experiment_id: string | null } | null> {
    const objectiveMetric = extractObjectiveMetricName(opts.objective);
    const paramCount = Object.keys(opts.searchSpace ?? {}).length;
    const listed = await experimentList({ syncDir: SYNC_DIR, limit: 2000 });
    const candidates = listed.items
      .filter((e) => e?.metadata?.campaign_id !== opts.campaignId)
      .map((e) => {
        const templateRaw = typeof e?.metadata?.exec_command === "string"
          ? e.metadata.exec_command.trim()
          : "";
        if (!templateRaw) return null;
        if (!isTemplateCompatibleWithSearchSpace(templateRaw, opts.searchSpace)) return null;
        const metric = extractObjectiveMetricName(e.objective);
        const score =
          (objectiveMetric && metric === objectiveMetric ? 2 : 0) +
          (Object.keys(e.search_space ?? {}).length === paramCount ? 1 : 0);
        return {
          experiment_id: e.experiment_id,
          template: templateRaw,
          score,
          updated_at: e.updated_at,
        };
      })
      .filter((x): x is { experiment_id: string; template: string; score: number; updated_at: string } => Boolean(x));

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return Date.parse(b.updated_at) - Date.parse(a.updated_at);
    });
    const best = candidates[0];
    return {
      template: best.template,
      source_experiment_id: best.experiment_id,
    };
  }

  async function ensureCampaignPrimaryExperiment(campaign: any) {
    const terminalExperimentStatuses = new Set(["completed", "archived", "failed", "stopped"]);
    const expList = await experimentList({ syncDir: SYNC_DIR, limit: 500 });
    const campaignExperiments = expList.items.filter((e) => e?.metadata?.campaign_id === campaign.campaign_id);
    const allowlistMeta = getCampaignConfidenceDomainAllowlist(campaign);
    const allowlist = allowlistMeta.valid;
    const allowedDomains = new Set(allowlist);

    if (typeof campaign.primary_experiment_id === "string" && campaign.primary_experiment_id.trim()) {
      const primary = expList.items.find((e) => e.experiment_id === campaign.primary_experiment_id);
      const primaryDomain = primary ? getExperimentDomainSignature(primary) : "";
      const primaryAllowed = allowlist.length === 0 || allowedDomains.has(primaryDomain);
      if (primary && !terminalExperimentStatuses.has(String(primary.status ?? "")) && primaryAllowed) {
        return campaign.primary_experiment_id;
      }
    }

    const activeExisting = campaignExperiments.find(
      (e) => {
        if (terminalExperimentStatuses.has(String(e?.status ?? ""))) return false;
        if (allowlist.length === 0) return true;
        return allowedDomains.has(getExperimentDomainSignature(e));
      },
    );
    if (activeExisting?.experiment_id) {
      campaign.primary_experiment_id = activeExisting.experiment_id;
      if (!Array.isArray(campaign.experiment_ids)) campaign.experiment_ids = [];
      if (!campaign.experiment_ids.includes(activeExisting.experiment_id)) {
        campaign.experiment_ids.push(activeExisting.experiment_id);
      }
      await campaignSave({
        syncDir: SYNC_DIR,
        campaign,
      });
      return activeExisting.experiment_id;
    }

    const objective = normalizeObjectiveForExperiment(campaign.objective);
    const constraints = (campaign.constraints && typeof campaign.constraints === "object")
      ? campaign.constraints
      : {};
    const searchSpace = (constraints.search_space && typeof constraints.search_space === "object")
      ? constraints.search_space
      : { exploration_bias: [0.2, 0.4, 0.6, 0.8], narrowing_factor: [0.8, 1.0, 1.2] };
    const metricSchema = (constraints.metric_schema && typeof constraints.metric_schema === "object")
      ? constraints.metric_schema
      : buildDefaultMetricSchemaForObjective(objective);
    const explicitExecTemplate = typeof constraints.exec_command === "string"
      ? constraints.exec_command.trim()
      : "";
    const inferredExec = !explicitExecTemplate
      ? await inferExecTemplateForCampaign({
        campaignId: String(campaign.campaign_id),
        objective,
        searchSpace,
      })
      : null;
    const execTemplate = explicitExecTemplate || inferredExec?.template || "";
    const nextExperimentIndex = Math.max(
      1,
      (Array.isArray(campaign.experiment_ids) ? campaign.experiment_ids.length : campaignExperiments.length) + 1,
    );
    const name = typeof constraints.experiment_name === "string"
      ? constraints.experiment_name
      : `campaign_${campaign.campaign_id}_exp_${nextExperimentIndex}`;
    const metadata: Record<string, any> = {
      campaign_id: campaign.campaign_id,
      campaign_goal: campaign.goal,
      campaign_mode: "autonomous",
    };
    if (allowlist.length > 0) {
      metadata.domain_signature = allowlist[0];
      const profile = domainProfileFromSignature(allowlist[0]);
      if (profile) metadata.domain_profile = profile;
    }
    const transferThresholdRaw = Number(constraints.transfer_threshold);
    if (Number.isFinite(transferThresholdRaw)) {
      metadata.transfer_threshold = Math.max(0, Math.min(1, transferThresholdRaw));
    }
    if (execTemplate) {
      metadata.exec_command = execTemplate;
      metadata.exec_command_source = explicitExecTemplate ? "campaign_constraints" : "inferred_from_experiment";
      if (inferredExec?.source_experiment_id) {
        metadata.exec_command_source_experiment_id = inferredExec.source_experiment_id;
      }
      campaign.constraints = {
        ...(campaign.constraints && typeof campaign.constraints === "object" ? campaign.constraints : {}),
        exec_command: execTemplate,
      };
    }

    const created = await experimentCreate({
      syncDir: SYNC_DIR,
      name,
      objective,
      metric_schema: metricSchema,
      search_space: searchSpace,
      search_strategy: "adaptive",
      metadata,
    });
    const experimentId = created.experiment.experiment_id;
    campaign.primary_experiment_id = experimentId;
    if (!Array.isArray(campaign.experiment_ids)) campaign.experiment_ids = [];
    if (!campaign.experiment_ids.includes(experimentId)) campaign.experiment_ids.push(experimentId);
    await campaignSave({
      syncDir: SYNC_DIR,
      campaign,
    });
    await campaignAppendHistory({
      syncDir: SYNC_DIR,
      campaign_id: campaign.campaign_id,
      type: "campaign.primary_experiment.created",
      data: {
        experiment_id: experimentId,
        exec_command_attached: Boolean(execTemplate),
        exec_command_source: metadata.exec_command_source ?? null,
        exec_command_source_experiment_id: metadata.exec_command_source_experiment_id ?? null,
      },
    });
    return experimentId;
  }

  function renderExecCommandTemplate(template: string, params: Record<string, any>): string {
    return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_m, key) => {
      const val = params?.[key];
      return val == null ? "" : String(val);
    }).trim();
  }

  function resolveCampaignExecTemplate(campaign: any, experiment: any): string | null {
    const fromExperiment = typeof experiment?.metadata?.exec_command === "string"
      ? experiment.metadata.exec_command.trim()
      : "";
    if (fromExperiment) return fromExperiment;
    const fromCampaign = typeof campaign?.constraints?.exec_command === "string"
      ? campaign.constraints.exec_command.trim()
      : "";
    return fromCampaign || null;
  }

  async function bindCreatedRunsToExecTasks(args: {
    campaign: any;
    experiment: any;
    createdRuns: Array<{ run_id: string; params?: Record<string, any>; task_id?: string | null }>;
  }) {
    const template = resolveCampaignExecTemplate(args.campaign, args.experiment);
    const result = {
      scanned: args.createdRuns.length,
      task_created: 0,
      run_linked: 0,
      skipped_no_template: 0,
      skipped_has_task_id: 0,
      skipped_empty_command: 0,
      errors: [] as Array<{ run_id: string; error: string }>,
    };

    if (!template) {
      result.skipped_no_template = args.createdRuns.length;
      return result;
    }

    for (const run of args.createdRuns) {
      if (typeof run?.task_id === "string" && run.task_id.trim()) {
        result.skipped_has_task_id += 1;
        continue;
      }
      const rendered = renderExecCommandTemplate(template, run?.params ?? {});
      if (!rendered) {
        result.skipped_empty_command += 1;
        continue;
      }
      try {
        const createdTask = await taskCreate({
          syncDir: SYNC_DIR,
          role: "research",
          title: `exec: ${rendered}`,
          description: `Campaign ${args.campaign.campaign_id} run ${run.run_id} for ${args.experiment.experiment_id}`,
          status: "open",
        });
        result.task_created += 1;
        await experimentRun({
          syncDir: SYNC_DIR,
          experiment_id: args.experiment.experiment_id,
          run_id: run.run_id,
          params: {},
          task_id: createdTask.task.task_id,
        });
        result.run_linked += 1;
      } catch (e: any) {
        result.errors.push({
          run_id: String(run?.run_id ?? "unknown"),
          error: String(e?.message ?? e),
        });
      }
    }

    return result;
  }

  function buildQuotaEvalParams(input: {
    searchSpace?: Record<string, any[]>;
    seed?: number;
    domainSignature?: string;
  }) {
    const out: Record<string, any> = {};
    const searchSpace = (input.searchSpace && typeof input.searchSpace === "object") ? input.searchSpace : {};
    const keys = Object.keys(searchSpace).sort();
    let idx = 0;
    for (const key of keys) {
      const values = Array.isArray((searchSpace as any)[key]) ? (searchSpace as any)[key] : [];
      if (values.length === 0) continue;
      const pick = Math.abs(Math.trunc(Number(input.seed ?? 0)) + idx) % values.length;
      out[key] = values[pick];
      idx += 1;
    }
    out.__transfer_eval = 1;
    if (input.domainSignature) {
      out.__domain_signature = input.domainSignature;
    }
    return out;
  }

  function parseDomainAllowlist(v: unknown): string[] {
    if (Array.isArray(v)) {
      return v
        .map((item) => String(item ?? "").trim())
        .filter(Boolean);
    }
    if (typeof v !== "string") return [];
    return v
      .split(/[,\n\r\t ]+/g)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function validateDomainAllowlist(raw: unknown): {
    candidates: string[];
    valid: string[];
    invalid: string[];
  } {
    const candidates = parseDomainAllowlist(raw);
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const s of candidates) {
      if (domainProfileFromSignature(s)) valid.push(s);
      else invalid.push(s);
    }
    return {
      candidates,
      valid: Array.from(new Set(valid)),
      invalid: Array.from(new Set(invalid)),
    };
  }

  function getCampaignConfidenceDomainAllowlist(campaign: any): {
    source: "confidence_domains_targeted" | "domain_signature" | "none";
    candidates: string[];
    valid: string[];
    invalid: string[];
  } {
    const constraints = (campaign?.constraints && typeof campaign.constraints === "object")
      ? campaign.constraints
      : {};
    const confidenceTargets = validateDomainAllowlist((constraints as any)?.confidence_domains_targeted);
    if (confidenceTargets.candidates.length > 0) {
      return {
        source: "confidence_domains_targeted",
        candidates: confidenceTargets.candidates,
        valid: confidenceTargets.valid,
        invalid: confidenceTargets.invalid,
      };
    }
    const domainSignature = validateDomainAllowlist((constraints as any)?.domain_signature);
    if (domainSignature.candidates.length > 0) {
      return {
        source: "domain_signature",
        candidates: domainSignature.candidates,
        valid: domainSignature.valid,
        invalid: domainSignature.invalid,
      };
    }
    return {
      source: "none",
      candidates: [],
      valid: [],
      invalid: [],
    };
  }

  function domainProfileFromSignature(signature: string): Record<string, any> | null {
    const sig = String(signature ?? "").trim();
    if (!sig) return null;
    const parts = sig.split("|").map((p) => p.trim());
    if (parts.length !== 4) return null;
    const [size_category, search_complexity, metric_noise, paramRaw] = parts;
    const match = /^p(\d+)$/i.exec(paramRaw);
    if (!match) return null;
    const param_count = Number(match[1]);
    if (!Number.isFinite(param_count) || param_count <= 0) return null;
    return {
      size_category,
      search_complexity,
      metric_noise,
      param_count,
    };
  }

  function getExperimentDomainSignature(experiment: any): string {
    const fromMetadata = typeof experiment?.metadata?.domain_signature === "string"
      ? experiment.metadata.domain_signature.trim()
      : "";
    if (fromMetadata) return fromMetadata;
    const profile = (experiment?.metadata?.domain_profile && typeof experiment.metadata.domain_profile === "object")
      ? experiment.metadata.domain_profile
      : null;
    return profile ? computeDomainSignature(profile) : "";
  }

  async function buildCampaignSnapshot(campaign: any) {
    const expList = await experimentList({ syncDir: SYNC_DIR, limit: 500 });
    const campaignExperiments = expList.items.filter((e) => e?.metadata?.campaign_id === campaign.campaign_id);
    const bestParams: any[] = [];
    const convergenceSummary: any[] = [];
    for (const exp of campaignExperiments) {
      const best = await experimentBest({
        syncDir: SYNC_DIR,
        experiment_id: exp.experiment_id,
      });
      if (best.best) {
        bestParams.push({
          experiment_id: exp.experiment_id,
          run_id: best.best.run_id,
          params: best.best.params,
          score: best.best.score,
        });
      }
      const computed = await experimentComputeResearchMetrics({
        syncDir: SYNC_DIR,
        experiment_id: exp.experiment_id,
      });
      convergenceSummary.push({
        experiment_id: exp.experiment_id,
        converged: computed.metrics.converged,
        completed_runs: computed.metrics.completed_runs,
        stagnation_rate: computed.metrics.stagnation_rate,
      });
    }

    const [arena, mutation, transfer, health, lineage] = await Promise.all([
      arenaTelemetrySnapshot({ syncDir: SYNC_DIR, limit_domains: 200 }),
      mutationEffectivenessSnapshot({ syncDir: SYNC_DIR }),
      transferDiagnosticsSnapshot({ syncDir: SYNC_DIR }),
      intelligenceHealthSnapshot({ syncDir: SYNC_DIR }),
      lineageSnapshot({ syncDir: SYNC_DIR, role: "research", limit: 500 }),
    ]);

    const bestStrategyPerDomain = (arena.snapshot?.domains ?? []).map((d: any) => ({
      domain_signature: d.domain_signature,
      best_strategy: d.strategies?.[0] ?? null,
    }));

    return {
      best_strategy_per_domain: bestStrategyPerDomain,
      best_parameters: bestParams,
      convergence_summary: {
        experiments_total: campaignExperiments.length,
        converged_count: convergenceSummary.filter((x) => x.converged).length,
        details: convergenceSummary,
      },
      evolution_summary: {
        mutation_effectiveness: mutation.snapshot,
        lineage_nodes: lineage.snapshot?.nodes_count ?? 0,
      },
      transfer_summary: transfer.snapshot,
      intelligence_health_trajectory: health.snapshot?.fitness_trajectory ?? {},
      recommendations: [
        ...(Number(health.snapshot?.global_intelligence_health_index ?? 0) < 0.35
          ? ["Reduce mutation aggressiveness and increase arena cooldown."]
          : []),
        ...(Number(transfer.snapshot?.anomaly_rate ?? 0) > 0.2
          ? ["Increase anomaly scrutiny and tighten transfer confidence threshold."]
          : []),
        ...(Number(transfer.snapshot?.transfer_success_rate ?? 0) < 0.4
          ? ["Collect more domain evidence before enabling transfer for new domains."]
          : []),
      ],
    };
  }

  async function runCampaignTick(args: {
    campaign_id: string;
    max_steps?: number;
    retry_count?: number;
  }) {
    const tickLock = await acquireLock({
      locksDir: path.join(SYNC_DIR, "queue", "locks"),
      name: `campaign_tick_${args.campaign_id}`,
      ttl_ms: 60_000,
    });
    if (!tickLock.ok || !tickLock.token) {
      throw new Error(`campaign_tick lock busy: ${args.campaign_id}`);
    }
    try {
      let campaign = (await campaignGet({
        syncDir: SYNC_DIR,
        campaign_id: args.campaign_id,
      })).campaign;
      const steps = Math.max(1, Math.min(50, Math.trunc(Number(args.max_steps ?? 1))));
      const tickResults: any[] = [];

      if (campaign.status === "completed" || campaign.status === "stopped" || campaign.status === "failed") {
        return {
          campaign,
          steps_requested: steps,
          steps_executed: 0,
          reason: "campaign_not_running",
        };
      }

      if (campaign.status === "draft") {
        await campaignMarkRunning({
          syncDir: SYNC_DIR,
          campaign_id: campaign.campaign_id,
        });
        campaign = (await campaignGet({
          syncDir: SYNC_DIR,
          campaign_id: args.campaign_id,
        })).campaign;
      }

      const constraintAllowlist = getCampaignConfidenceDomainAllowlist(campaign);
      if (constraintAllowlist.candidates.length > 0 && constraintAllowlist.valid.length === 0) {
        const failedCampaign: any = {
          ...campaign,
          status: "failed",
          stop_reason: "invalid_campaign_constraints",
          updated_at: new Date().toISOString(),
        };
        await campaignSave({
          syncDir: SYNC_DIR,
          campaign: failedCampaign,
        });
        await campaignAppendHistory({
          syncDir: SYNC_DIR,
          campaign_id: failedCampaign.campaign_id,
          type: "campaign.failed.invalid_constraints",
          data: {
            source: constraintAllowlist.source,
            invalid_domains: constraintAllowlist.invalid,
            candidates: constraintAllowlist.candidates,
          },
        });
        return {
          campaign: failedCampaign,
          steps_requested: steps,
          steps_executed: 0,
          reason: "invalid_campaign_constraints",
          invalid_domains: constraintAllowlist.invalid,
        };
      }

      await ensureCampaignPrimaryExperiment(campaign);

      for (let i = 0; i < steps; i += 1) {
        campaign = (await campaignGet({
          syncDir: SYNC_DIR,
          campaign_id: args.campaign_id,
        })).campaign;
        if (campaign.status !== "running") break;
        const nextTickIndex = Math.max(0, Number(campaign.tick_count ?? 0)) + 1;
        const nextTickId = `${campaign.campaign_id}:${nextTickIndex}`;
        const duplicateTick = (campaign.history ?? []).some((h: any) =>
          h?.type === "campaign.tick" &&
          (
            String(h?.data?.tick_id ?? "") === nextTickId ||
            Number(h?.data?.tick_index ?? NaN) === nextTickIndex
          )
        );
        if (duplicateTick) {
          tickResults.push({
            step: i + 1,
            tick_index: nextTickIndex,
            tick_id: nextTickId,
            skipped_idempotent: true,
            status: campaign.status,
            stop_reason: campaign.stop_reason ?? null,
          });
          continue;
        }
        const expList = await experimentList({ syncDir: SYNC_DIR, limit: 500 });
        const campaignExperimentsAll = expList.items.filter((e) => e?.metadata?.campaign_id === campaign.campaign_id);
        const domainAllowlistMeta = getCampaignConfidenceDomainAllowlist(campaign);
        const domainAllowlist = domainAllowlistMeta.valid;
        const domainAllowlistInvalid = domainAllowlistMeta.invalid;
        const allowedDomains = new Set(domainAllowlist);
        const campaignExperiments = domainAllowlist.length > 0
          ? campaignExperimentsAll.filter((e) => allowedDomains.has(getExperimentDomainSignature(e)))
          : campaignExperimentsAll;
        const transferDiagBeforeTick = await transferDiagnosticsSnapshot({ syncDir: SYNC_DIR });
        const perDomainTransfer = Array.isArray(transferDiagBeforeTick.snapshot?.per_domain_transfer)
          ? transferDiagBeforeTick.snapshot?.per_domain_transfer
          : [];
        const bootstrapQuotaMode = Number(transferDiagBeforeTick.snapshot?.impact_applied_share ?? 0) <= 0;
        const recentTargetedDomains = new Set<string>();
        for (const h of [...(campaign.history ?? [])].reverse()) {
          if (h?.type !== "campaign.tick") continue;
          const arr = Array.isArray(h?.data?.confidence_domains_targeted)
            ? h.data.confidence_domains_targeted
            : [];
          for (const item of arr) {
            const sig = String(item ?? "").trim();
            if (sig) recentTargetedDomains.add(sig);
          }
          if (recentTargetedDomains.size >= 4) break;
        }
        const totalDomainTraffic = Math.max(
          1,
          perDomainTransfer.reduce((acc: number, d: any) => acc + Math.max(0, Number(d?.experiments_total ?? 0)), 0)
        );
        const totalTransferAttempts = Math.max(
          1,
          perDomainTransfer.reduce((acc: number, d: any) => acc + Math.max(0, Number(d?.transfer_initialized ?? 0)), 0)
        );
        const scoredLowConfidenceRaw = perDomainTransfer
          .map((d: any) => ({
            domain_signature: String(d?.domain_signature ?? "").trim(),
            confidence: Number(d?.average_transfer_evidence_confidence ?? d?.average_transfer_confidence ?? NaN),
            observations: Math.max(0, Math.trunc(Number(d?.evidence_observations ?? d?.confidence_observations ?? 0))),
            impact_applied_share: clamp01(Number(d?.impact_applied_share ?? 0)),
            transfer_initialized: Math.max(0, Number(d?.transfer_initialized ?? 0)),
            experiments_total: Math.max(0, Number(d?.experiments_total ?? 0)),
          }))
          .filter((d: any) => d.domain_signature.length > 0 && d.domain_signature !== "unknown")
          .map((d: any) => {
            const confidence = Number.isFinite(d.confidence) ? d.confidence : 0;
            const deficit = Math.max(0, 0.16 - confidence);
            const transferAttemptsShare = d.transfer_initialized / totalTransferAttempts;
            const domainTrafficShare = d.experiments_total / totalDomainTraffic;
            const importance = (0.45 * d.impact_applied_share) + (0.35 * transferAttemptsShare) + (0.2 * domainTrafficShare);
            const cooldownPenalty = recentTargetedDomains.has(d.domain_signature) ? 0.03 : 0;
            const score = Number((deficit * (0.05 + importance) - cooldownPenalty).toFixed(6));
            return {
              ...d,
              confidence,
              deficit,
              importance: Number(importance.toFixed(6)),
              cooldown_penalty: cooldownPenalty,
              score,
            };
          })
          .filter((d: any) => d.deficit > 0)
          .sort((a: any, b: any) => {
            if (b.score !== a.score) return b.score - a.score;
            if (a.confidence !== b.confidence) return a.confidence - b.confidence;
            return a.observations - b.observations;
          })
          .slice(0, 8);
        const scoredLowConfidence = domainAllowlist.length > 0
          ? scoredLowConfidenceRaw.filter((d: any) => allowedDomains.has(d.domain_signature))
          : scoredLowConfidenceRaw;
        const isP5Domain = (domainSignature: string) =>
          domainSignature.endsWith("|p5") || domainSignature.includes("|p5");
        const isP2Domain = (domainSignature: string) =>
          domainSignature.endsWith("|p2") || domainSignature.includes("|p2");
        const selectedLowConfidence: any[] = [];
        const p5Priority = scoredLowConfidence.find((d: any) => isP5Domain(String(d.domain_signature ?? "")));
        if (p5Priority) selectedLowConfidence.push(p5Priority);
        if (bootstrapQuotaMode) {
          const secondP5 = scoredLowConfidence.find((d: any) =>
            isP5Domain(String(d.domain_signature ?? ""))
            && !selectedLowConfidence.some((x) => x.domain_signature === d.domain_signature)
          );
          if (secondP5) selectedLowConfidence.push(secondP5);
        }
        const secondPass = bootstrapQuotaMode
          ? [
            ...scoredLowConfidence.filter((d: any) => isP5Domain(String(d.domain_signature ?? ""))),
            ...scoredLowConfidence.filter((d: any) => isP2Domain(String(d.domain_signature ?? ""))),
            ...scoredLowConfidence,
          ]
          : scoredLowConfidence;
        for (const candidate of secondPass) {
          if (selectedLowConfidence.some((x) => x.domain_signature === candidate.domain_signature)) continue;
          selectedLowConfidence.push(candidate);
          if (selectedLowConfidence.length >= 2) break;
        }
        let lowConfidenceDomains = selectedLowConfidence.slice(0, 2);
        const roundRobinDomain = domainAllowlist.length > 1
          ? domainAllowlist[(Math.max(1, nextTickIndex) - 1) % domainAllowlist.length]
          : null;
        if (domainAllowlist.length > 0) {
          const filtered = lowConfidenceDomains.filter((d: any) => {
            const sig = String(d?.domain_signature ?? "");
            if (!allowedDomains.has(sig)) return false;
            if (roundRobinDomain && sig !== roundRobinDomain) return false;
            return true;
          });
          if (filtered.length > 0) {
            lowConfidenceDomains = filtered.map((d: any) => ({
              ...d,
              reason: d.reason
                ? `${d.reason}|campaign_constraint${roundRobinDomain ? "|campaign_constraint_round_robin" : ""}`
                : (roundRobinDomain ? "campaign_constraint_round_robin" : "campaign_constraint"),
            }));
          } else {
            const forcedDomain = roundRobinDomain ?? domainAllowlist[0];
            lowConfidenceDomains = [{
              domain_signature: forcedDomain,
              confidence: 0,
              observations: 0,
              impact_applied_share: 0,
              transfer_initialized: 0,
              experiments_total: 0,
              deficit: 1,
              importance: 1,
              score: 1,
              reason: roundRobinDomain ? "campaign_constraint_round_robin_forced" : "campaign_constraint_forced",
            }];
          }
        }
        const outOfAllowlistDomains = domainAllowlist.length > 0
          ? lowConfidenceDomains
            .map((d: any) => String(d?.domain_signature ?? "").trim())
            .filter((sig: string) => sig.length > 0 && !allowedDomains.has(sig))
          : [];
        if (outOfAllowlistDomains.length > 0) {
          const forcedDomain = roundRobinDomain ?? domainAllowlist[0];
          lowConfidenceDomains = [{
            domain_signature: forcedDomain,
            confidence: 0,
            observations: 0,
            impact_applied_share: 0,
            transfer_initialized: 0,
            experiments_total: 0,
            deficit: 1,
            importance: 1,
            score: 1,
            reason: roundRobinDomain ? "campaign_constraint_round_robin_hard_override" : "campaign_constraint_hard_override",
          }];
        }
        const confidenceQuotaByDomain = new Map<string, {
          raw_runs: number;
          min_runs: number;
          confidence: number;
          observations: number;
          score: number;
          deficit: number;
          importance: number;
        }>();
        for (const d of lowConfidenceDomains) {
          const needObs = Math.max(0, 5 - d.observations);
          const isVeryLow = Number.isFinite(d.confidence) && d.confidence < 0.12;
          const rawRuns = bootstrapQuotaMode
            ? Math.min(4, Math.max(2, needObs > 0 ? needObs : 2))
            : (needObs > 0 ? Math.min(4, Math.max(1, needObs)) : 1);
          let minRuns = rawRuns;
          if (isVeryLow) minRuns = Math.min(4, minRuns + 1);
          if (recentTargetedDomains.has(d.domain_signature) && needObs === 0) {
            minRuns = bootstrapQuotaMode ? 2 : 1;
          }
          confidenceQuotaByDomain.set(d.domain_signature, {
            raw_runs: Number(rawRuns),
            min_runs: minRuns,
            confidence: Number.isFinite(d.confidence) ? d.confidence : 0,
            observations: d.observations,
            score: Number(d.score ?? 0),
            deficit: Number(d.deficit ?? 0),
            importance: Number(d.importance ?? 0),
          });
        }
        const confidenceQuotaDiagnostics: Array<{
          experiment_id: string;
          domain_signature: string;
          quota_raw_runs: number;
          quota_min_runs: number;
          quota_requested_batch: number;
          quota_created_after_search: number;
          quota_available_before_materialize: number;
          quota_materialized_runs: number;
          quota_created_final: number;
          quota_remaining: number;
        }> = [];
        let createdTotal = 0;
        let autobindScanned = 0;
        let autobindTaskCreated = 0;
        let autobindRunLinked = 0;
        let autobindSkippedNoTemplate = 0;
        let autobindSkippedHasTaskId = 0;
        let autobindSkippedEmptyCommand = 0;
        const autobindErrors: Array<{ experiment_id: string; run_id: string; error: string }> = [];
        const confidenceQuotaHits: Array<{ experiment_id: string; domain_signature: string; quota_min_runs: number; created_runs: number }> = [];
        const impacted: any[] = [];
        for (const exp of campaignExperiments) {
          if (exp.status === "completed" || exp.status === "archived") continue;
          const expDomainSignature = getExperimentDomainSignature(exp);
          const quota = confidenceQuotaByDomain.get(expDomainSignature);
          const requestedBatch = quota
            ? Math.max(1, Number(quota.min_runs ?? 1))
            : 10;
          let search = await runExperimentSearchTickWithResearchProfile({
            experiment_id: exp.experiment_id,
            batch_size: requestedBatch,
          });
          let createdForQuota = Number(search.created_count ?? 0);
          let createdRuns = Array.isArray((search as any).created) ? [...(search as any).created] : [];
          if (quota) {
            const createdAfterInitialSearch = createdForQuota;
            let topupGuard = 0;
            while (createdForQuota < quota.min_runs && topupGuard < 3 && (search as any).phase !== "converged") {
              const needed = Math.max(1, quota.min_runs - createdForQuota);
              const topup = await runExperimentSearchTickWithResearchProfile({
                experiment_id: exp.experiment_id,
                batch_size: needed,
              });
              createdForQuota += Number(topup.created_count ?? 0);
              if (Array.isArray((topup as any).created)) {
                createdRuns.push(...(topup as any).created);
              }
              topupGuard += 1;
              search = {
                ...(search as any),
                created_count: createdForQuota,
                created: createdRuns,
              } as any;
              if (Number(topup.created_count ?? 0) <= 0) break;
            }
            const createdAfterSearchAndTopup = createdForQuota;
            const availableBeforeMaterialize = Math.max(0, quota.min_runs - createdAfterSearchAndTopup);
            // Materialize quota with explicit transfer-eval runs when search tick cannot produce enough.
            let materialized = 0;
            while (createdForQuota < quota.min_runs) {
              const fallback = await experimentRun({
                syncDir: SYNC_DIR,
                experiment_id: exp.experiment_id,
                params: buildQuotaEvalParams({
                  searchSpace: exp.search_space,
                  seed: createdForQuota + materialized + 1,
                  domainSignature: expDomainSignature,
                }),
                status: "pending",
                notes: `transfer_eval_quota:${expDomainSignature}`,
              });
              createdForQuota += 1;
              materialized += 1;
              createdRuns.push({
                run_id: fallback.run.run_id,
                params: fallback.run.params,
                task_id: fallback.run.task_id ?? null,
              });
              if (materialized >= 8) break;
            }
            search = {
              ...(search as any),
              created_count: createdForQuota,
              created: createdRuns,
            } as any;
            confidenceQuotaDiagnostics.push({
              experiment_id: exp.experiment_id,
              domain_signature: expDomainSignature,
              quota_raw_runs: Number(quota.raw_runs ?? 0),
              quota_min_runs: Number(quota.min_runs ?? 0),
              quota_requested_batch: requestedBatch,
              quota_created_after_search: Number(createdAfterSearchAndTopup ?? createdAfterInitialSearch),
              quota_available_before_materialize: Number(availableBeforeMaterialize),
              quota_materialized_runs: Number(materialized),
              quota_created_final: Number(createdForQuota),
              quota_remaining: Number(Math.max(0, quota.min_runs - createdForQuota)),
            });
          }
          createdTotal += Number(search.created_count ?? 0);
          if (quota) {
            const realized = Number(search.created_count ?? 0);
            if (realized > 0) {
              confidenceQuotaHits.push({
                experiment_id: exp.experiment_id,
                domain_signature: expDomainSignature,
                quota_min_runs: quota.min_runs,
                created_runs: realized,
              });
            }
          }
          const autobind = await bindCreatedRunsToExecTasks({
            campaign,
            experiment: exp,
            createdRuns: createdRuns,
          });
          autobindScanned += autobind.scanned;
          autobindTaskCreated += autobind.task_created;
          autobindRunLinked += autobind.run_linked;
          autobindSkippedNoTemplate += autobind.skipped_no_template;
          autobindSkippedHasTaskId += autobind.skipped_has_task_id;
          autobindSkippedEmptyCommand += autobind.skipped_empty_command;
          for (const err of autobind.errors) {
            autobindErrors.push({
              experiment_id: exp.experiment_id,
              run_id: err.run_id,
              error: err.error,
            });
          }
          const impact = await applyResearchImpactOnExperimentConverged({
            experiment_id: exp.experiment_id,
            phase: (search as any).phase,
            stop_reason: (search as any).stop_reason ?? null,
            tick_index: nextTickIndex,
            tick_id: nextTickId,
            campaign_id: campaign.campaign_id,
          });
          if (impact) impacted.push(impact);
        }

        // Guarantee at least one transfer-eval run if quota domains were targeted but no runs were created.
        if (lowConfidenceDomains.length > 0 && createdTotal <= 0 && campaignExperiments.length > 0) {
          const fallbackExperiment = campaignExperiments.find((e) => e.status !== "completed" && e.status !== "archived")
            ?? campaignExperiments[0];
          const fallbackDomain = String(lowConfidenceDomains[0]?.domain_signature ?? "").trim();
          const fallbackRun = await experimentRun({
            syncDir: SYNC_DIR,
            experiment_id: fallbackExperiment.experiment_id,
            params: buildQuotaEvalParams({
              searchSpace: fallbackExperiment.search_space,
              seed: 1,
              domainSignature: fallbackDomain || undefined,
            }),
            status: "pending",
            notes: `transfer_eval_forced_tick:${fallbackDomain || "unknown"}`,
          });
          createdTotal += 1;
          confidenceQuotaHits.push({
            experiment_id: fallbackExperiment.experiment_id,
            domain_signature: fallbackDomain || "unknown",
            quota_min_runs: 1,
            created_runs: 1,
          });
          const fallbackBind = await bindCreatedRunsToExecTasks({
            campaign,
            experiment: fallbackExperiment,
            createdRuns: [{
              run_id: fallbackRun.run.run_id,
              params: fallbackRun.run.params,
              task_id: fallbackRun.run.task_id ?? null,
            }],
          });
          autobindScanned += fallbackBind.scanned;
          autobindTaskCreated += fallbackBind.task_created;
          autobindRunLinked += fallbackBind.run_linked;
          autobindSkippedNoTemplate += fallbackBind.skipped_no_template;
          autobindSkippedHasTaskId += fallbackBind.skipped_has_task_id;
          autobindSkippedEmptyCommand += fallbackBind.skipped_empty_command;
          for (const err of fallbackBind.errors) {
            autobindErrors.push({
              experiment_id: fallbackExperiment.experiment_id,
              run_id: err.run_id,
              error: err.error,
            });
          }
        }

        // Serialize task-graph mutating operations to avoid Windows rename contention.
        const execBind = await runExecutionBindTick(undefined, 100);
        const orchestrated = await orchestratorTick({ syncDir: SYNC_DIR, limit: 200 });
        const recovered = await runRecoveryTick(undefined, 200);
        const [arenaEval, evolved, transfer, mutation, health, metricsSnap] = await Promise.all([
          researchMemoryArenaEvaluationTick({ syncDir: SYNC_DIR, limit: 200 }),
          agentEvolutionTick({ syncDir: SYNC_DIR, role: "research", max_new_versions: 2, shadow_mode: true }),
          transferDiagnosticsSnapshot({ syncDir: SYNC_DIR }),
          mutationEffectivenessSnapshot({ syncDir: SYNC_DIR }),
          intelligenceHealthSnapshot({ syncDir: SYNC_DIR }),
          agentMetricsSnapshot(SYNC_DIR, "research"),
        ]);

        const projectedTickCount = Math.max(0, Number(campaign.tick_count ?? 0)) + 1;
        const projectedExperimentsRun = Math.max(0, Number(campaign.experiments_run ?? 0)) + createdTotal;
        const activeResearch = (metricsSnap.items ?? []).find((it: any) => it.active) ?? (metricsSnap.items ?? [])[0];
        const stagnationRate = Number(activeResearch?.metrics?.research_stats?.stagnation_rate ?? 0);
        const nextMetrics = {
          gihi: Number(health.snapshot?.global_intelligence_health_index ?? 0),
          transfer_success_rate: Number(transfer.snapshot?.transfer_success_rate ?? 0),
          mutation_effectiveness_ratio: Number(mutation.snapshot?.overall?.mutation_effectiveness_ratio ?? 0),
          arena_domains: Number(arenaEval.evaluated ?? 0),
          stagnation_rate: stagnationRate,
        };

        const converged = campaign.stop_conditions?.convergence_detected
          ? (await Promise.all(campaignExperiments.map((e) => experimentComputeResearchMetrics({
            syncDir: SYNC_DIR,
            experiment_id: e.experiment_id,
          })))).some((x) => x.metrics.converged)
          : false;
        const maxExperimentsReached = projectedExperimentsRun >= Number(campaign.stop_conditions?.max_experiments ?? campaign.max_experiments ?? 0);
        const gihiGraceTicks = Math.max(0, Math.trunc(Number(campaign.stop_conditions?.gihi_grace_ticks ?? 0)));
        const gihiGuardActive = projectedTickCount > gihiGraceTicks;
        const gihiLow = gihiGuardActive && (
          Number(nextMetrics.gihi ?? 0) < Number(campaign.stop_conditions?.min_gihi ?? 0)
        );
        const stagnated = Number(nextMetrics.stagnation_rate ?? 0) > Number(campaign.stop_conditions?.stagnation_rate_gt ?? 1);
        const maxTicksReached = projectedTickCount >= Number(campaign.stop_conditions?.max_ticks ?? Number.MAX_SAFE_INTEGER);

        let stopReason: string | null = null;
        if (converged) stopReason = "convergence_detected";
        else if (maxExperimentsReached) stopReason = "max_experiments_reached";
        else if (gihiLow) stopReason = "gihi_below_threshold";
        else if (stagnated) stopReason = "stagnation_too_high";
        else if (maxTicksReached) stopReason = "max_ticks_reached";

        const status = stopReason
          ? (stopReason === "convergence_detected" || stopReason === "max_experiments_reached" ? "completed" : "stopped")
          : "running";
        const tickTs = new Date().toISOString();
        const tickData = {
          step: i + 1,
          tick_index: nextTickIndex,
          tick_id: nextTickId,
          created_runs: createdTotal,
          impacted_count: impacted.length,
          pending_runs_scanned: autobindScanned,
          exec_tasks_created: autobindTaskCreated,
          runs_linked_with_task_id: autobindRunLinked,
          autobind_skipped_no_template: autobindSkippedNoTemplate,
          autobind_skipped_has_task_id: autobindSkippedHasTaskId,
          autobind_skipped_empty_command: autobindSkippedEmptyCommand,
          autobind_errors: autobindErrors.length,
          exec_bind_queued: execBind.queued,
          orchestrated_activated: orchestrated.activated.length,
          recovered_activated: recovered.activated.length,
          arena_evaluated: arenaEval.evaluated,
          evolved_created: evolved.created.length,
          gihi: nextMetrics.gihi,
          transfer_success_rate: nextMetrics.transfer_success_rate,
          mutation_effectiveness_ratio: nextMetrics.mutation_effectiveness_ratio,
          stagnation_rate: nextMetrics.stagnation_rate,
          confidence_domains_targeted: lowConfidenceDomains.map((d: any) => d.domain_signature),
          confidence_domains_targeted_reasons: lowConfidenceDomains.map((d: any) => ({
            domain_signature: d.domain_signature,
            reason: d.reason ?? null,
          })),
          confidence_domains_targeted_invalid: domainAllowlistInvalid,
          confidence_domains_targeted_constraint_violations: outOfAllowlistDomains,
          confidence_quota_hits: confidenceQuotaHits,
          confidence_quota_diagnostics: confidenceQuotaDiagnostics,
          status,
          stop_reason: stopReason,
        };
        const commitLock = await acquireLock({
          locksDir: path.join(SYNC_DIR, "queue", "locks"),
          name: `campaign_commit:${campaign.campaign_id}`,
          ttl_ms: 5_000,
        });
        const commitToken = commitLock.token;
        if (!commitLock.ok || !commitToken) {
          const retryCount = Math.max(0, Math.trunc(Number(args.retry_count ?? 0))) + 1;
          const notBeforeTs = computeRetryNotBeforeTs(retryCount);
          const requeued = await enqueueCampaignRetryWithCoalescing({
            campaign_id: campaign.campaign_id,
            max_steps: 1,
            source: "campaign-commit-lock-retry",
            idempotency_key: `commitlock-${nextTickIndex}-r${retryCount}-${randomUUID()}`,
            retry_count: retryCount,
            not_before_ts: notBeforeTs,
          });
          return {
            campaign,
            steps_requested: steps,
            steps_executed: tickResults.length,
            ticks: tickResults,
            retryable: true,
            retry_count: retryCount,
            requeued,
            reason: "campaign_commit lock busy",
          };
        }
        const committed = await (async () => {
          try {
            await campaignTickRecordWrite({
              syncDir: SYNC_DIR,
              campaign_id: campaign.campaign_id,
              tick_record: {
                tick_id: nextTickId,
                tick_index: nextTickIndex,
                ts: tickTs,
                data: tickData,
              },
            });
            return await campaignCommitPreparedTick({
              syncDir: SYNC_DIR,
              campaign_id: campaign.campaign_id,
              tick_id: nextTickId,
              tick_index: nextTickIndex,
            });
          } finally {
            await releaseLock({
              locksDir: path.join(SYNC_DIR, "queue", "locks"),
              name: `campaign_commit:${campaign.campaign_id}`,
              token: commitToken,
            });
          }
        })();
        await researchMemoryAdvanceCircuitBreakerTick({
          syncDir: SYNC_DIR,
        });
        campaign = committed.campaign;
        const constraintsObj = (campaign?.constraints && typeof campaign.constraints === "object")
          ? campaign.constraints as Record<string, any>
          : {};
        const validationTargets = parseDomainAllowlist((constraintsObj as any).confidence_domains_targeted);
        const validationMaxTicks = Math.max(1, Math.trunc(Number(campaign?.stop_conditions?.max_ticks ?? Number.MAX_SAFE_INTEGER)));
        const isValidationCampaign = Boolean((constraintsObj as any).tuner_validation_after_apply === true);
        const isValidationCheckpointTick = isValidationCampaign && (
          nextTickIndex === 6
          || nextTickIndex === 12
          || nextTickIndex === validationMaxTicks
        );
        if (isValidationCheckpointTick) {
          const [arenaSnap, transferSnap, metaSnap] = await Promise.all([
            arenaTelemetrySnapshot({ syncDir: SYNC_DIR, limit_domains: 200 }),
            transferDiagnosticsSnapshot({ syncDir: SYNC_DIR }),
            intelligenceMetaSnapshot({ syncDir: SYNC_DIR }),
          ]);
          const domainsArena = Array.isArray((arenaSnap as any)?.snapshot?.domains)
            ? (arenaSnap as any).snapshot.domains
            : [];
          const domainsTransfer = Array.isArray((transferSnap as any)?.snapshot?.per_domain_transfer)
            ? (transferSnap as any).snapshot.per_domain_transfer
            : [];
          const selectedDomains = validationTargets.length > 0
            ? validationTargets
            : Array.from(new Set(
              domainsArena
                .map((d: any) => String(d?.domain_signature ?? "").trim())
                .filter(Boolean)
                .slice(0, 2),
            ));
          const domainMetrics = selectedDomains.map((sig) => {
            const arenaDomain = domainsArena.find((d: any) => String(d?.domain_signature ?? "") === sig) ?? {};
            const transferDomain = domainsTransfer.find((d: any) => String(d?.domain_signature ?? "") === sig) ?? {};
            const domainEntropy = Number(
              arenaDomain?.domain_entropy
              ?? arenaDomain?.strategy_entropy
              ?? NaN,
            );
            const top1Share = Number(arenaDomain?.top1_share ?? arenaDomain?.top_active_share ?? NaN);
            const shadowShare = Number(arenaDomain?.shadow_share ?? NaN);
            return {
              domain_signature: sig,
              domain_entropy: Number.isFinite(domainEntropy) ? Number(domainEntropy.toFixed(6)) : null,
              top1_share: Number.isFinite(top1Share) ? Number(top1Share.toFixed(6)) : null,
              shadow_share: Number.isFinite(shadowShare) ? Number(shadowShare.toFixed(6)) : null,
              transfer_variance: Number.isFinite(Number(transferDomain?.transfer_variance ?? NaN))
                ? Number(Number(transferDomain.transfer_variance).toFixed(6))
                : null,
            };
          });
          const successByDomain = domainMetrics.map((d) => ({
            domain_signature: d.domain_signature,
            top1_share_ok: d.top1_share != null && d.top1_share >= 0.45,
            domain_entropy_ok: d.domain_entropy != null && d.domain_entropy <= 0.92,
          }));
          const safety = {
            gihi_delta_ultra: Number((metaSnap as any)?.snapshot?.gihi_delta_ultra ?? NaN),
            transfer_variance_trend: Number((metaSnap as any)?.snapshot?.transfer_variance_trend ?? NaN),
          };
          const safetyOk = Number.isFinite(safety.gihi_delta_ultra)
            && Number.isFinite(safety.transfer_variance_trend)
            && safety.gihi_delta_ultra >= 0
            && safety.transfer_variance_trend <= 0;
          const domainSignalOk = successByDomain.every((d) => d.top1_share_ok || d.domain_entropy_ok);
          const noteStage = (nextTickIndex >= 12 || nextTickIndex >= validationMaxTicks) ? "validation_final" : "validation_checkpoint";
          await notesUpsert({
            syncDir: SYNC_DIR,
            id: `validation-judge:${campaign.campaign_id}:tick:${nextTickIndex}`,
            title: noteStage,
            content: JSON.stringify({
              campaign_id: campaign.campaign_id,
              tick_index: nextTickIndex,
              stage: noteStage,
              targets: selectedDomains,
              domain_metrics: domainMetrics,
              success_by_domain: successByDomain,
              safety,
              overall_pass: domainSignalOk && safetyOk,
            }, null, 2),
            tags: ["validation", "tuner", noteStage],
          });
        }

        const isThresholdValidationCampaign = Boolean((constraintsObj as any).tuner_threshold_validation_after_apply === true);
        const thresholdValidationMaxTicks = Math.max(1, Math.trunc(Number(campaign?.stop_conditions?.max_ticks ?? Number.MAX_SAFE_INTEGER)));
        const isThresholdValidationCheckpointTick = isThresholdValidationCampaign && (
          nextTickIndex === 6
          || nextTickIndex === 12
          || nextTickIndex >= thresholdValidationMaxTicks
          || String(tickData.status ?? "running") !== "running"
        );
        if (isThresholdValidationCheckpointTick) {
          const metaSnap = await intelligenceMetaSnapshot({ syncDir: SYNC_DIR });
          const m = (metaSnap as any)?.snapshot ?? {};
          const current = {
            arena_entropy: Number(m?.arena_entropy ?? NaN),
            transfer_variance_trend: Number(m?.transfer_variance_trend ?? NaN),
            gihi_delta_ultra: Number(m?.gihi_delta_ultra ?? NaN),
            mutation_roi_trend: Number(m?.mutation_roi_trend ?? NaN),
          };
          const baseline = ((constraintsObj as any)?.threshold_tuner_baseline && typeof (constraintsObj as any).threshold_tuner_baseline === "object")
            ? (constraintsObj as any).threshold_tuner_baseline
            : {};
          const baselineEntropy = Number(baseline?.arena_entropy ?? NaN);
          const baselineVarianceTrend = Number(baseline?.transfer_variance_trend ?? NaN);
          const entropyImproved = Number.isFinite(current.arena_entropy) && (
            Number.isFinite(baselineEntropy)
              ? current.arena_entropy <= baselineEntropy
              : current.arena_entropy <= 0.88
          );
          const varianceImproved = Number.isFinite(current.transfer_variance_trend) && (
            Number.isFinite(baselineVarianceTrend)
              ? current.transfer_variance_trend <= baselineVarianceTrend
              : current.transfer_variance_trend <= 0
          );
          const safetyOk = Number.isFinite(current.gihi_delta_ultra) && current.gihi_delta_ultra >= 0;
          const overallPass = (entropyImproved || varianceImproved) && safetyOk;
          const hardFail = (Number.isFinite(current.gihi_delta_ultra) && current.gihi_delta_ultra < 0)
            || (Number.isFinite(current.transfer_variance_trend) && current.transfer_variance_trend > 0);
          const isFinal = nextTickIndex >= thresholdValidationMaxTicks
            || campaign.status !== "running"
            || String(tickData.status ?? "running") !== "running";
          let rollbackApplied = false;
          if (isFinal && hardFail) {
            const prev = ((constraintsObj as any)?.threshold_tuner_previous_governance && typeof (constraintsObj as any).threshold_tuner_previous_governance === "object")
              ? (constraintsObj as any).threshold_tuner_previous_governance
              : {};
            const rollbackPatch: Record<string, number> = {};
            if (Number.isFinite(Number(prev?.promotion_margin_min ?? NaN))) {
              rollbackPatch.promotion_margin_min = Number(prev.promotion_margin_min);
            }
            if (Number.isFinite(Number(prev?.evolution_cooldown_ms ?? NaN))) {
              rollbackPatch.evolution_cooldown_ms = Math.trunc(Number(prev.evolution_cooldown_ms));
            }
            if (Object.keys(rollbackPatch).length > 0) {
              await governanceSet(SYNC_DIR, rollbackPatch);
              rollbackApplied = true;
            }
          }
          await notesUpsert({
            syncDir: SYNC_DIR,
            id: `threshold-validation-judge:${campaign.campaign_id}:tick:${nextTickIndex}`,
            title: isFinal ? "threshold_validation_final" : "threshold_validation_checkpoint",
            content: JSON.stringify({
              campaign_id: campaign.campaign_id,
              tick_index: nextTickIndex,
              baseline,
              current,
              entropy_improved: entropyImproved,
              variance_improved: varianceImproved,
              safety_ok: safetyOk,
              overall_pass: overallPass,
              hard_fail: hardFail,
              rollback_applied: rollbackApplied,
            }, null, 2),
            tags: ["validation", "threshold_tuner", isFinal ? "final" : "checkpoint"],
          });
        }

        const isBootstrapTransferCampaign = Boolean((constraintsObj as any).bootstrap_transfer_init === true);
        const bootstrapMaxTicks = Math.max(1, Math.trunc(Number(campaign?.stop_conditions?.max_ticks ?? 6)));
        if (isBootstrapTransferCampaign && nextTickIndex === 1) {
          const targetDomain = validationTargets[0] ?? "";
          const beforeStats = perDomainTransfer.find((d: any) => String(d?.domain_signature ?? "") === targetDomain) ?? null;
          const afterPerDomain = Array.isArray((transfer as any)?.snapshot?.per_domain_transfer)
            ? (transfer as any).snapshot.per_domain_transfer
            : [];
          const afterStats = afterPerDomain.find((d: any) => String(d?.domain_signature ?? "") === targetDomain) ?? null;
          const beforeInit = Number(beforeStats?.transfer_initialized ?? 0);
          const afterInit = Number(afterStats?.transfer_initialized ?? 0);
          const afterExperimentsTotal = Number(afterStats?.experiments_total ?? 0);
          const transferInitializedRatio = afterExperimentsTotal > 0 ? (afterInit / afterExperimentsTotal) : 0;
          const minRequiredRatio = 0.7;
          const afterReason = String(afterStats?.evidence_drop_reason_recent_last ?? "");
          const hasEvidenceGate = Number(afterStats?.evidence_events_seen ?? 0) > 0;
          const hasTransferBackendMapping = afterInit > 0;
          const hasConfidenceObservationsRecent = Number(afterStats?.confidence_observations ?? 0) > 0;
          const hasEvidenceEventsAcceptedRecent = Number(afterStats?.evidence_events_accepted ?? 0) > 0;
          const reasonCode = (() => {
            if (!targetDomain) return "missing_target_domain";
            if (afterReason === "no_evidence_gate") return "missing_evidence_gate";
            if (afterReason === "evidence_observations_missing_or_non_numeric") return "invalid_evidence_payload";
            if (!hasTransferBackendMapping) return "no_transfer_backend";
            if (!hasEvidenceGate) return "missing_evidence_gate";
            if (!hasEvidenceEventsAcceptedRecent) return "no_evidence_acceptance";
            if (!hasConfidenceObservationsRecent) return "no_confidence_observations";
            if (afterReason === "transfer_not_initialized" && transferInitializedRatio < minRequiredRatio) return "init_ratio_below_threshold";
            if (afterReason === "transfer_not_initialized") return "transfer_gate_still_blocking";
            if (afterInit > beforeInit) return "init_progressed";
            if (afterInit > 0 && afterReason.length === 0) return "already_initialized_false_positive";
            return "no_transfer_backend";
          })();
          await notesUpsert({
            syncDir: SYNC_DIR,
            id: `bootstrap-transfer-diag:${campaign.campaign_id}:tick:1`,
            title: "bootstrap_transfer_init_diagnostic",
            content: JSON.stringify({
              campaign_id: campaign.campaign_id,
              tick_index: nextTickIndex,
              domain_signature: targetDomain || null,
              force_transfer_init: Boolean((constraintsObj as any).force_transfer_init === true),
              transfer_initialized_before: Number.isFinite(beforeInit) ? beforeInit : null,
              transfer_initialized_after: Number.isFinite(afterInit) ? afterInit : null,
              transfer_initialized_ratio: Number(transferInitializedRatio.toFixed(6)),
              min_required_ratio: minRequiredRatio,
              has_evidence_gate: hasEvidenceGate,
              has_transfer_backend_mapping: hasTransferBackendMapping,
              has_confidence_observations_recent: hasConfidenceObservationsRecent,
              has_evidence_events_accepted_recent: hasEvidenceEventsAcceptedRecent,
              evidence_drop_reason_recent_last_after: afterReason || null,
              why_not_initialized: reasonCode,
            }, null, 2),
            tags: ["bootstrap", "transfer_init", "diagnostic"],
          });
        }
        const isBootstrapJudgeCheckpointTick = isBootstrapTransferCampaign && (
          nextTickIndex === 6
          || nextTickIndex === 12
          || nextTickIndex >= bootstrapMaxTicks
          || campaign.status !== "running"
        );
        if (isBootstrapJudgeCheckpointTick) {
          const transferSnap = await transferDiagnosticsSnapshot({ syncDir: SYNC_DIR });
          const domainsTransfer = Array.isArray((transferSnap as any)?.snapshot?.per_domain_transfer)
            ? (transferSnap as any).snapshot.per_domain_transfer
            : [];
          const targetDomain = validationTargets[0] ?? "";
          const targetStats = domainsTransfer.find((d: any) => String(d?.domain_signature ?? "") === targetDomain) ?? null;
          const reasonRecent = String(targetStats?.evidence_drop_reason_recent_last ?? "");
          const transferInitializedNow = Number(targetStats?.transfer_initialized ?? 0);
          const diagNoteId = `bootstrap-transfer-diag:${campaign.campaign_id}:tick:1`;
          const diagNote = await notesGet({ syncDir: SYNC_DIR, id: diagNoteId });
          let baselineAfter = Number.NaN;
          if (diagNote.note?.content) {
            try {
              const parsed = JSON.parse(String(diagNote.note.content));
              baselineAfter = Number(parsed?.transfer_initialized_after ?? NaN);
            } catch {
              // ignore parse failure
            }
          }
          const progressObserved = Number.isFinite(baselineAfter)
            ? transferInitializedNow > baselineAfter
            : transferInitializedNow > 0;
          const success = targetDomain.length > 0 && reasonRecent !== "transfer_not_initialized";
          const softSuccess = !success && progressObserved;
          const currentExtendDepth = Math.max(0, Math.trunc(Number((constraintsObj as any).bootstrap_transfer_init_extend_depth ?? 0)));
          const maxExtendDepth = 2;
          let followupCampaignId: string | null = null;
          const isBootstrapFinalStage = nextTickIndex >= bootstrapMaxTicks || campaign.status !== "running";
          const extendAllowed = softSuccess && currentExtendDepth < maxExtendDepth;
          if (extendAllowed && targetDomain && isBootstrapFinalStage) {
            const baseKey = String((constraintsObj as any).bootstrap_transfer_init_key ?? `bootstrap-transfer-init:${targetDomain}`);
            const followupKey = `${baseKey}:extend`;
            const existing = await campaignList({ syncDir: SYNC_DIR, limit: 1000 });
            const reusable = existing.items.find((c: any) => {
              const status = String(c?.status ?? "");
              if (status !== "draft" && status !== "running") return false;
              const cc = (c?.constraints && typeof c.constraints === "object") ? c.constraints : {};
              return String((cc as any).bootstrap_transfer_init_key ?? "") === followupKey;
            });
            if (reusable) {
              followupCampaignId = String((reusable as any).campaign_id ?? "");
            } else {
              const created = await campaignCreate({
                syncDir: SYNC_DIR,
                campaign_id: `cmp_bootstrap_transfer_extend_${targetDomain.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 24)}_${Date.now()}`,
                goal: `Bootstrap transfer init (extended) for ${targetDomain}`,
                objective: "self-heal transfer_not_initialized pipeline (extended)",
                constraints: {
                  confidence_domains_targeted: [targetDomain],
                  auto_advance: true,
                  force_transfer_init: true,
                  bootstrap_transfer_init: true,
                  bootstrap_transfer_init_key: followupKey,
                  bootstrap_transfer_init_extend_depth: currentExtendDepth + 1,
                },
                max_experiments: 48,
                stop_conditions: {
                  max_ticks: 12,
                },
              });
              followupCampaignId = created.campaign.campaign_id;
            }
            if (followupCampaignId) {
              await enqueueCampaignTickJob({
                campaign_id: followupCampaignId,
                max_steps: 1,
                source: "bootstrap-transfer-init-extend",
                idempotency_key: `bootstrap-extend-${targetDomain}-${Date.now()}`,
              });
            }
          }
          await notesUpsert({
            syncDir: SYNC_DIR,
            id: `bootstrap-transfer-judge:${campaign.campaign_id}:tick:${nextTickIndex}`,
            title: success
              ? "bootstrap_transfer_init_success"
              : (softSuccess ? "bootstrap_transfer_init_soft_progress" : "bootstrap_transfer_init_failed"),
            content: JSON.stringify({
              campaign_id: campaign.campaign_id,
              tick_index: nextTickIndex,
              domain_signature: targetDomain || null,
              evidence_drop_reason_recent_last: reasonRecent || null,
              transfer_initialized: targetStats?.transfer_initialized ?? null,
              experiments_total: targetStats?.experiments_total ?? null,
              progress_observed: softSuccess,
              extend_allowed: extendAllowed,
              extend_depth: currentExtendDepth,
              extend_depth_max: maxExtendDepth,
              extended_campaign_id: followupCampaignId,
              success,
            }, null, 2),
            tags: ["bootstrap", "transfer_init", success ? "success" : (softSuccess ? "soft_success" : "failed")],
          });
          if ((!success && !softSuccess && targetDomain) || (softSuccess && !extendAllowed && targetDomain)) {
            await tasksUpsert({
              syncDir: SYNC_DIR,
              title: `Investigate transfer init failure ${targetDomain}`,
              id: `needs-attention:transfer-init:${targetDomain}`,
              description: softSuccess && !extendAllowed
                ? `Bootstrap transfer init reached extension depth limit (${maxExtendDepth}) for ${targetDomain} and did not clear transfer_not_initialized.`
                : `Bootstrap campaign did not clear transfer_not_initialized for ${targetDomain}.`,
              status: "todo",
              labels: ["needs_attention", "transfer_init", targetDomain],
            });
          } else if (success && targetDomain) {
            await tasksUpsert({
              syncDir: SYNC_DIR,
              title: `Investigate transfer init failure ${targetDomain}`,
              id: `needs-attention:transfer-init:${targetDomain}`,
              description: `Resolved: bootstrap campaign cleared transfer_not_initialized for ${targetDomain}.`,
              status: "done",
              labels: ["needs_attention", "transfer_init", targetDomain, "resolved"],
            });
          }
        }
        tickResults.push({
          ...tickData,
          committed: committed.committed,
        });
        if (campaign.status !== "running") break;
      }

      let autoAdvance: {
        queued: boolean;
        job_id?: string;
        next_tick_index?: number;
        not_before_ts?: string;
        reason?: string;
        live_before?: { has_live: boolean; pending: number; running: number };
      } | null = null;
      const autoAdvanceEnabled = (() => {
        const constraints = campaign?.constraints;
        if (!constraints || typeof constraints !== "object") return true;
        const raw = (constraints as any).auto_advance;
        if (typeof raw === "boolean") return raw;
        return true;
      })();
      if (campaign.status === "running" && tickResults.length > 0 && autoAdvanceEnabled) {
        const liveCampaignJob = await queueHasLiveCampaignJob({
          syncDir: SYNC_DIR,
          campaign_id: campaign.campaign_id,
        });
        const hasFuturePendingTick = Number(liveCampaignJob.pending ?? 0) > 0;
        if (hasFuturePendingTick) {
          autoAdvance = {
            queued: false,
            reason: "future_campaign_tick_pending",
            live_before: liveCampaignJob,
          };
        } else {
          const execQ = await queueDepth({ syncDir: SYNC_DIR, logical_queue: "exec" });
          const execInflight = Math.max(0, Number(execQ.pending ?? 0)) + Math.max(0, Number(execQ.running ?? 0));
          const baseDelayMs = 250 + Math.floor(Math.random() * 251);
          const extraDelayMs = execInflight > 0 ? 2_000 : 0;
          const notBeforeTs = new Date(Date.now() + baseDelayMs + extraDelayMs).toISOString();
          const nextTickIndex = Math.max(0, Number(campaign.tick_count ?? 0)) + 1;
          const queued = await enqueueCampaignTickJob({
            campaign_id: campaign.campaign_id,
            max_steps: 1,
            source: "campaign-auto",
            idempotency_key: `auto-${campaign.campaign_id}-${nextTickIndex}`,
            not_before_ts: notBeforeTs,
          });
          autoAdvance = {
            queued: queued.queued,
            job_id: queued.job_id,
            next_tick_index: nextTickIndex,
            not_before_ts: notBeforeTs,
            live_before: liveCampaignJob,
          };
        }
      }

      return {
        campaign,
        steps_requested: steps,
        steps_executed: tickResults.length,
        ticks: tickResults,
        auto_advance: autoAdvance,
      };
    } finally {
      await releaseLock({
        locksDir: path.join(SYNC_DIR, "queue", "locks"),
        name: `campaign_tick_${args.campaign_id}`,
        token: tickLock.token,
      });
    }
  }

  async function runExecutionBindTick(projectId?: string, limit?: number) {
    await ensureSyncDir();
    const graph = await taskGraph({
      syncDir: SYNC_DIR,
      project_id: projectId,
    });
    const maxItems = Math.max(1, Math.min(limit ?? 100, 1000));
    const candidates = graph.items
      .filter((item) => item.status === "in_progress")
      .filter((item) => item.title.toLowerCase().startsWith("exec:"))
      .filter((item) => !item.execution?.job_id)
      .slice(0, maxItems);

    const bindings: Array<{ task_id: string; job_id: string; cmd: string; args: string[] }> = [];
    const errors: Array<{ task_id: string; error: string }> = [];

    for (const task of candidates) {
      const parsed = parseExecCommand(task.title);
      if (!parsed) {
        await taskStatusUpdate({
          syncDir: SYNC_DIR,
          task_id: task.task_id,
          status: "blocked",
        });
        await taskExecutionMarkFinished({
          syncDir: SYNC_DIR,
          task_id: task.task_id,
          exit_code: -1,
          error: "Invalid exec title format",
        });
        errors.push({ task_id: task.task_id, error: "Invalid exec title format" });
        continue;
      }

      const jobId = `exec-bind-${task.task_id}`;
      await queuePush({
        syncDir: SYNC_DIR,
        type: "exec",
        logical_queue: "exec",
        payload: {
          cmd: parsed.cmd,
          args: parsed.args,
          task_id: task.task_id,
          project_id: task.project_id,
          command: parsed.command,
        },
        priority: 10,
        job_id: jobId,
        source: "execution-bind",
      });
      await taskExecutionMarkQueued({
        syncDir: SYNC_DIR,
        task_id: task.task_id,
        command: parsed.command,
        job_id: jobId,
      });

      bindings.push({
        task_id: task.task_id,
        job_id: jobId,
        cmd: parsed.cmd,
        args: parsed.args,
      });
    }

    return {
      project_id: projectId ?? null,
      scanned: candidates.length,
      queued: bindings.length,
      bindings,
      errors,
    };
  }

  async function runRecoveryTick(projectId?: string, limit?: number) {
    await ensureSyncDir();
    const leaseCleanup = await queueCleanupExpiredRunning({
      syncDir: SYNC_DIR,
      max_attempts: 5,
    });
    const reconcile = await campaignReconcileAll({
      syncDir: SYNC_DIR,
      limit: 200,
    });
    const graphBefore = await taskGraph({
      syncDir: SYNC_DIR,
      project_id: projectId,
    });
    const nowMs = Date.now();
    const dueRetry = graphBefore.items
      .filter((item) => item.status === "open")
      .filter((item) => Boolean(item.execution?.next_retry_at))
      .filter((item) => Date.parse(String(item.execution?.next_retry_at)) <= nowMs);

    const orchestrated = await orchestratorTick({
      syncDir: SYNC_DIR,
      project_id: projectId,
      limit,
    });

    return {
      project_id: projectId ?? null,
      campaigns_reconciled: reconcile.reconciled,
      queue_lease_cleanup: leaseCleanup,
      due_retry_count: dueRetry.length,
      due_retry_task_ids: dueRetry.map((x) => x.task_id),
      activated: orchestrated.activated,
      scanned_open: orchestrated.scanned_open,
      remaining_open: orchestrated.remaining_open,
    };
  }

  async function runAgentDispatchTick(projectId?: string, limit?: number) {
    await ensureSyncDir();
    const graph = await taskGraph({ syncDir: SYNC_DIR, project_id: projectId });
    const maxItems = Math.max(1, Math.min(limit ?? 100, 1000));
    const candidates = graph.items
      .filter((item) => item.status === "in_progress")
      .filter((item) => Boolean(item.role))
      .filter((item) => !item.title.toLowerCase().startsWith("exec:"))
      .filter((item) => !(item.execution?.mode === "agent" && item.execution?.job_id))
      .slice(0, maxItems);

    const queued: Array<{ task_id: string; role: string; job_id: string; profile_id: string }> = [];
    const errors: Array<{ task_id: string; error: string }> = [];

    for (const task of candidates) {
      try {
        const role = String(task.role) as AgentRole;
        const profileVersion = await agentGetActiveByRole(SYNC_DIR, role);
        const profile = profileVersion.profile;
        const jobId = `agent-${role}-${task.task_id}`;

        await queuePush({
          syncDir: SYNC_DIR,
          type: "project_task",
          logical_queue: "research",
          job_id: jobId,
          source: "agent-dispatch",
          priority: 5,
          payload: {
            command: "agent_run_task",
            args: {
              task_id: task.task_id,
              project_id: task.project_id,
              role,
              agent_version: profileVersion.version,
              profile,
              title: task.title,
              description: task.description,
            },
          },
        });

        await taskAgentMarkDispatched({
          syncDir: SYNC_DIR,
          task_id: task.task_id,
          role,
          profile_id: profile.profile_id,
          job_id: jobId,
        });

        queued.push({
          task_id: task.task_id,
          role,
          job_id: jobId,
          profile_id: `${profile.profile_id}.v${profileVersion.version}`,
        });
      } catch (e: any) {
        errors.push({
          task_id: task.task_id,
          error: String(e?.message ?? e),
        });
      }
    }

    return {
      project_id: projectId ?? null,
      scanned: candidates.length,
      queued: queued.length,
      bindings: queued,
      errors,
    };
  }

  async function runShadowEvaluationTick(opts?: {
    role?: AgentRole;
    sample_size?: number;
    promote_threshold?: number;
    max_evaluations?: number;
    discard_on_fail?: boolean;
  }) {
    await ensureSyncDir();
    const governance = (await governanceGet(SYNC_DIR)).governance;
    const nowTs = Date.now();
    const dailyPromoteWindowMs = 24 * 60 * 60 * 1000;
    const role = opts?.role;
    const sampleSize = Math.max(1, Math.min(opts?.sample_size ?? governance.min_replay_runs, 200));
    const requiredReplayRuns = governance.min_replay_runs;
    const promoteThreshold = Math.max(0, Math.min(opts?.promote_threshold ?? governance.promotion_margin_min, 1));
    const maxEvaluations = Math.max(1, Math.min(opts?.max_evaluations ?? 20, 500));
    const discardOnFail = opts?.discard_on_fail ?? governance.discard_on_instability;

    const registry = await agentRegistryList(SYNC_DIR, role);
    const shadows = registry.items
      .filter((a) => !a.active && !!a.parent_version)
      .slice(0, maxEvaluations);

    const completedEvents = await eventList({
      syncDir: SYNC_DIR,
      type: "agent.completed",
      limit: Math.max(200, sampleSize * 30),
    });
    const promoteEvents = await eventList({
      syncDir: SYNC_DIR,
      type: "agent.shadow.promoted",
      limit: 500,
    });
    const meta = await intelligenceMetaSnapshot({ syncDir: SYNC_DIR, gihi_window: 120, transfer_window: 120 });
    const metaSnapshot: any = meta?.snapshot ?? {};
    const needsAttentionTasks = await tasksList({ syncDir: SYNC_DIR, status: "todo", limit: 300 });
    const recentNeedsAttention = (needsAttentionTasks.items ?? []).some((t: any) => {
      const title = String(t?.title ?? "").toLowerCase();
      const labels = Array.isArray(t?.labels) ? t.labels.map((x: any) => String(x).toLowerCase()) : [];
      return title.includes("needs_attention") || labels.includes("needs_attention");
    });
    const safetyGate = {
      gihi_delta_ultra: Number(metaSnapshot?.gihi_delta_ultra ?? 0),
      transfer_variance_trend: Number(metaSnapshot?.transfer_variance_trend ?? 0),
      recent_needs_attention: recentNeedsAttention,
    };

    const decisions: any[] = [];

    for (const shadow of shadows) {
      const parent = registry.items.find((a) => a.role === shadow.role && a.version === shadow.parent_version);
      if (!parent) {
        decisions.push({ role: shadow.role, version: shadow.version, decision: "skip", reason: "parent_not_found" });
        continue;
      }

      const roleEvents = completedEvents.items
        .filter((ev) => ev?.payload?.role === shadow.role)
        .filter((ev) => ev?.payload?.status === "done")
        .slice(0, sampleSize);
      const recentPromotesForRole = promoteEvents.items
        .filter((ev) => String(ev?.payload?.role ?? "") === String(shadow.role))
        .filter((ev) => (nowTs - Date.parse(String(ev?.ts ?? 0))) < dailyPromoteWindowMs);

      if (roleEvents.length < requiredReplayRuns) {
        const notBefore = new Date(Date.now() + 2 * 60_000).toISOString();
        const liveRetry = await queueHasLiveShadowEvaluationRetry({
          syncDir: SYNC_DIR,
          role: shadow.role,
          version: shadow.version,
        });
        if (!liveRetry.has_live) {
          await queuePush({
            syncDir: SYNC_DIR,
            type: "project_task",
            logical_queue: "meta",
            source: "shadow-eval",
            job_id: `shadow-eval:retry:${shadow.role}:v${shadow.version}:${Math.floor(Date.now() / 120000)}`,
            payload: {
              command: "shadow_evaluation_tick",
              role: shadow.role,
              version: shadow.version,
              max_evaluations: maxEvaluations,
              sample_size: sampleSize,
              promote_threshold: promoteThreshold,
              discard_on_fail: discardOnFail,
              not_before_ts: notBefore,
            },
          });
        }
        decisions.push({
          role: shadow.role,
          version: shadow.version,
          parent_version: shadow.parent_version,
          decision: "pending_replay",
          reason: "insufficient_replay_runs",
          replay_runs: roleEvents.length,
          required_replay_runs: requiredReplayRuns,
          live_retry_exists: liveRetry.has_live,
          live_retry_pending: liveRetry.pending,
          live_retry_running: liveRetry.running,
          next_evaluation_not_before: notBefore,
        });
        continue;
      }

      const replaySuccessSamples = roleEvents.map((ev) => (ev?.payload?.status === "done" ? 1 : 0));
      const replayDurationSamples = roleEvents
        .map((ev) => Number(ev?.payload?.duration_ms ?? NaN))
        .filter((x) => Number.isFinite(x) && x >= 0);
      const replaySuccessVar = variance(replaySuccessSamples);
      const replayDurationVar = variance(replayDurationSamples.length ? replayDurationSamples : [1000, 1000]);
      const durationMean = replayDurationSamples.length
        ? replayDurationSamples.reduce((a, b) => a + b, 0) / replayDurationSamples.length
        : 1000;
      const durationCV = durationMean > 0 ? Math.sqrt(replayDurationVar) / durationMean : 0;
      const unstable =
        replaySuccessVar > governance.stability_success_variance_max ||
        durationCV > governance.stability_completion_time_variance_max;
      if (unstable && discardOnFail) {
        await agentShadowDiscard({
          syncDir: SYNC_DIR,
          role: shadow.role,
          version: shadow.version,
        });
        decisions.push({
          role: shadow.role,
          version: shadow.version,
          parent_version: shadow.parent_version,
          decision: "discard",
          reason: "instability_detected",
          replay_success_variance: replaySuccessVar,
          replay_completion_cv: Number(durationCV.toFixed(6)),
        });
        continue;
      }

      const parentRuns = Math.max(1, parent.metrics.runs_count);
      const parentSuccessRate = parentRuns > 0 ? parent.metrics.success_count / parentRuns : 0;
      const parentCritic = parent.metrics.critic_score ?? 0;
      const parentAvgMs = parent.metrics.avg_completion_time_ms > 0 ? parent.metrics.avg_completion_time_ms : 1000;
      const parentScore = compositeScore(parentSuccessRate, parentCritic, parentAvgMs, parentAvgMs);

      let shadowSuccessRate = 0;
      let shadowCritic = 0;
      let shadowAvgMs = parentAvgMs;

      if (shadow.metrics.runs_count > 0) {
        const runs = Math.max(1, shadow.metrics.runs_count);
        shadowSuccessRate = shadow.metrics.success_count / runs;
        shadowCritic = shadow.metrics.critic_score ?? 0;
        shadowAvgMs = shadow.metrics.avg_completion_time_ms > 0 ? shadow.metrics.avg_completion_time_ms : parentAvgMs;
      } else {
        // Replay-based synthetic evaluation for shadow mode.
        const tempDiff = Math.abs(shadow.profile.temperature - roleTargetTemperature(shadow.role));
        const promptBonus = shadow.profile.system_prompt.includes("[EVOLUTION_NOTE]") ? 0.05 : 0;
        let strategyBonus = 0;
        if (shadow.role === "research") {
          const parentAdaptive = normalizeAdaptiveProfile((parent.profile as any).adaptive_profile);
          const shadowAdaptive = normalizeAdaptiveProfile((shadow.profile as any).adaptive_profile);
          const researchStats = parent.metrics?.research_stats ?? {};
          const avgConvergenceSteps = Number((researchStats as any).avg_convergence_steps ?? 0);
          const stagnationRate = Number((researchStats as any).stagnation_rate ?? 0);
          const varianceStability = Number((researchStats as any).variance_stability ?? 1);

          if (avgConvergenceSteps > 8) {
            strategyBonus += shadowAdaptive.narrowing_factor < parentAdaptive.narrowing_factor ? 0.05 : -0.02;
            strategyBonus += shadowAdaptive.bootstrap_min < parentAdaptive.bootstrap_min ? 0.03 : -0.01;
          }
          if (stagnationRate > 0.6) {
            strategyBonus += shadowAdaptive.exploration_bias > parentAdaptive.exploration_bias ? 0.05 : -0.01;
          }
          if (varianceStability < 0.7) {
            strategyBonus += shadowAdaptive.patience > parentAdaptive.patience ? 0.04 : -0.01;
          }
          const adaptiveDrift =
            Math.abs(shadowAdaptive.narrowing_factor - parentAdaptive.narrowing_factor) +
            Math.abs(shadowAdaptive.exploration_bias - parentAdaptive.exploration_bias) +
            Math.abs(shadowAdaptive.variance_sensitivity - parentAdaptive.variance_sensitivity);
          if (adaptiveDrift > 0.8) strategyBonus -= 0.03;
        }
        const sampleN = Math.max(1, roleEvents.length);
        shadowSuccessRate = clamp01(0.76 - tempDiff * 0.6 + promptBonus + strategyBonus);
        shadowCritic = clamp01(0.72 - tempDiff * 0.5 + promptBonus + (strategyBonus * 0.8));
        shadowAvgMs = Math.max(100, Math.round(parentAvgMs * (1 + tempDiff * 0.4 - promptBonus * 0.3 - strategyBonus * 0.25)));

        await agentMetricsOverwrite({
          syncDir: SYNC_DIR,
          role: shadow.role,
          version: shadow.version,
          if_empty_only: true,
          metrics: {
            runs_count: sampleN,
            success_count: Math.round(shadowSuccessRate * sampleN),
            failure_count: Math.max(0, sampleN - Math.round(shadowSuccessRate * sampleN)),
            avg_completion_time_ms: shadowAvgMs,
            total_completion_time_ms: shadowAvgMs * sampleN,
            critic_score: shadowCritic,
            iterations_per_task: 1,
            last_run_at: new Date().toISOString(),
            research_fitness: shadow.role === "research"
              ? Number((shadowSuccessRate * 0.5 + shadowCritic * 0.3 + Math.max(0, strategyBonus) * 0.2).toFixed(6))
              : undefined,
          },
        });
      }

      const shadowScore = compositeScore(shadowSuccessRate, shadowCritic, shadowAvgMs, parentAvgMs);
      const delta = Number((shadowScore - parentScore).toFixed(4));

      if (delta > promoteThreshold) {
        if (recentPromotesForRole.length > 0) {
          decisions.push({
            role: shadow.role,
            version: shadow.version,
            parent_version: shadow.parent_version,
            decision: "hold_by_promote_cooldown",
            reason: "daily_promote_limit",
            promote_events_last_24h: recentPromotesForRole.length,
            parent_score: parentScore,
            shadow_score: shadowScore,
            delta,
          });
          continue;
        }
        const safetyOk =
          Number.isFinite(safetyGate.gihi_delta_ultra) &&
          safetyGate.gihi_delta_ultra >= 0 &&
          Number.isFinite(safetyGate.transfer_variance_trend) &&
          safetyGate.transfer_variance_trend <= 0 &&
          !safetyGate.recent_needs_attention;
        if (!safetyOk) {
          decisions.push({
            role: shadow.role,
            version: shadow.version,
            parent_version: shadow.parent_version,
            decision: "hold_by_safety_gate",
            reason: "global_safety_gate_failed",
            safety_gate: safetyGate,
            parent_score: parentScore,
            shadow_score: shadowScore,
            delta,
          });
          continue;
        }
        await agentVersionActivate({
          syncDir: SYNC_DIR,
          role: shadow.role,
          version: shadow.version,
          reason: `shadow_eval_delta=${delta}`,
        });
        await eventPublish({
          syncDir: SYNC_DIR,
          type: "agent.shadow.promoted",
          source: "shadow-evaluation",
          direction: "outbound",
          dedupe_key: `agent-shadow-promoted:${shadow.role}:v${shadow.version}`,
          payload: {
            role: shadow.role,
            version: shadow.version,
            parent_version: shadow.parent_version ?? null,
            delta,
            parent_score: parentScore,
            shadow_score: shadowScore,
          },
        });
        decisions.push({
          role: shadow.role,
          version: shadow.version,
          parent_version: shadow.parent_version,
          decision: "promote",
          parent_score: parentScore,
          shadow_score: shadowScore,
          delta,
        });
      } else if (discardOnFail) {
        await agentShadowDiscard({
          syncDir: SYNC_DIR,
          role: shadow.role,
          version: shadow.version,
        });
        decisions.push({
          role: shadow.role,
          version: shadow.version,
          parent_version: shadow.parent_version,
          decision: "discard",
          parent_score: parentScore,
          shadow_score: shadowScore,
          delta,
        });
      } else {
        decisions.push({
          role: shadow.role,
          version: shadow.version,
          parent_version: shadow.parent_version,
          decision: "keep_shadow",
          parent_score: parentScore,
          shadow_score: shadowScore,
          delta,
        });
      }
    }

    return {
      evaluated: shadows.length,
      promote_threshold: promoteThreshold,
      sample_size: sampleSize,
      governance,
      decisions,
    };
  }

  async function runMetaGovernanceTick(args?: {
    mutation_window?: number;
    transfer_window?: number;
    gihi_window?: number;
    campaign_id?: string;
    apply_all_running?: boolean;
    meta_governance_cooldown_ms?: number;
    min_state_streak?: number;
    scoped_campaign_only?: boolean;
    dry_run?: boolean;
  }) {
    await ensureSyncDir();
    const dryRun = Boolean(args?.dry_run);
    const targetCampaignId = typeof args?.campaign_id === "string" && args.campaign_id.trim()
      ? args.campaign_id.trim()
      : undefined;
    const applyAllRunning = typeof args?.apply_all_running === "boolean"
      ? args.apply_all_running
      : true;
    const scopedCampaignOnly = args?.scoped_campaign_only !== false;
    let cooldownMs = Math.max(
      60_000,
      Math.min(24 * 60 * 60 * 1000, Math.trunc(Number(args?.meta_governance_cooldown_ms ?? 90_000)))
    );
    const minStateStreak = Math.max(1, Math.min(10, Math.trunc(Number(args?.min_state_streak ?? 2))));
    const meta = await intelligenceMetaSnapshot({
      syncDir: SYNC_DIR,
      mutation_window: args?.mutation_window,
      transfer_window: args?.transfer_window,
      gihi_window: args?.gihi_window,
      campaign_id: targetCampaignId,
    });
    const snapshot = meta.snapshot;
    if (snapshot.meta_state === "degenerating" || snapshot.meta_state === "stressed") {
      cooldownMs = Math.min(24 * 60 * 60 * 1000, cooldownMs + 30_000);
    }
    const currentEvolution = (await governanceGet(SYNC_DIR)).governance;

    const adaptivePatch: Record<string, number> = {};
    const metaPatch: Record<string, number> = {};
    const evolutionPatch: Record<string, number> = {};
    const arenaPatch: Record<string, number> = {};
    const campaignPatch: Record<string, number> = {};
    const reasons: string[] = [];

    if (snapshot.gihi_slope < 0 && snapshot.transfer_variance > 0.08) {
      reasons.push("gihi_down_and_transfer_volatile");
      campaignPatch.transfer_threshold = 0;
      adaptivePatch.exploration_bias = 0.06;
      metaPatch.exploration_vs_exploitation_bias = 0.05;
    }

    if (snapshot.arena_entropy < 0.25) {
      reasons.push("low_arena_entropy");
      arenaPatch.max_strategies_per_domain = 5;
      arenaPatch.promotion_margin = 0.02;
    }

    if (snapshot.mutation_roi_trend < -0.0005) {
      reasons.push("negative_mutation_roi");
      metaPatch.mutation_intensity = -0.1;
      evolutionPatch.evolution_cooldown_ms = Math.max(
        20_000,
        Math.round(Number(currentEvolution.evolution_cooldown_ms ?? 0) * 1.15)
      );
    }

    if (snapshot.gihi_slope > 0.0015 && snapshot.transfer_variance < 0.05) {
      reasons.push("gihi_rising_stable");
      arenaPatch.promotion_margin = Math.max(
        0.02,
        Number(arenaPatch.promotion_margin ?? 0.03)
      );
      adaptivePatch.exploration_bias = Math.min(
        Number(adaptivePatch.exploration_bias ?? 0),
        -0.04
      );
      metaPatch.exploration_vs_exploitation_bias = Math.min(
        Number(metaPatch.exploration_vs_exploitation_bias ?? 0),
        -0.04
      );
    }

    if (snapshot.arena_entropy > 0.88) {
      reasons.push("entropy_above_target_high");
      adaptivePatch.exploration_bias = Math.min(
        Number(adaptivePatch.exploration_bias ?? 0),
        -0.06
      );
      metaPatch.exploration_vs_exploitation_bias = Math.min(
        Number(metaPatch.exploration_vs_exploitation_bias ?? 0),
        -0.06
      );
    }

    const priorTicks = await eventList({
      syncDir: SYNC_DIR,
      type: "meta.governance.tick",
      limit: 200,
    });
    const tickStream = (priorTicks.items ?? [])
      .map((ev: any) => {
        const payload = ev?.payload ?? ev?.data ?? {};
        const ts = Date.parse(String(ev?.ts ?? ""));
        return {
          ts: Number.isFinite(ts) ? ts : 0,
          meta_state: typeof payload?.meta_state === "string" ? payload.meta_state : "",
          gihi_slope: Number(payload?.gihi_slope ?? NaN),
        };
      })
      .filter((x: any) => x.ts > 0)
      .sort((a: any, b: any) => b.ts - a.ts);
    const lastTick = tickStream[0];
    const msSinceLastTick = lastTick ? Math.max(0, Date.now() - lastTick.ts) : null;
    let priorStateStreak = 0;
    let negativeSlopeStreak = Number(snapshot.gihi_slope < -0.0015 ? 1 : 0);
    for (const tick of tickStream) {
      if (tick.meta_state === snapshot.meta_state) priorStateStreak += 1;
      else break;
    }
    for (const tick of tickStream) {
      const slope = Number((tick as any)?.gihi_slope ?? NaN);
      if (Number.isFinite(slope) && slope < -0.0015) negativeSlopeStreak += 1;
      else break;
    }
    const observedStateStreak = priorStateStreak + 1;
    const hysteresisPassed = observedStateStreak >= minStateStreak || negativeSlopeStreak >= minStateStreak;

    const actions: Record<string, any> = {
      meta_snapshot: snapshot,
      reasons,
      scope: {
        campaign_id: targetCampaignId ?? null,
        apply_all_running: applyAllRunning,
        scoped_campaign_only: scopedCampaignOnly,
      },
      guards: {
        cooldown_ms: cooldownMs,
        ms_since_last_tick: msSinceLastTick,
        min_state_streak: minStateStreak,
        observed_state_streak: observedStateStreak,
        negative_gihi_slope_streak: negativeSlopeStreak,
        hysteresis_passed: hysteresisPassed,
      },
      dry_run: dryRun,
      applied: {
        research_profile: null as any,
        evolution_governance: null as any,
        arena_governance: null as any,
        forced_rotations: null as any,
        campaigns: [] as any[],
      },
      skipped: [] as string[],
    };

    const publishMetaTick = async () => {
      await eventPublish({
        syncDir: SYNC_DIR,
        type: "meta.governance.tick",
        source: "meta-governance",
        data: {
          reasons,
          meta_state: snapshot.meta_state,
          gihi_slope: snapshot.gihi_slope,
          gihi_delta_ultra: snapshot.gihi_delta_ultra,
          transfer_variance: snapshot.transfer_variance,
          transfer_variance_trend: snapshot.transfer_variance_trend,
          mutation_roi_trend: snapshot.mutation_roi_trend,
          arena_entropy: snapshot.arena_entropy,
          scope: {
            campaign_id: targetCampaignId ?? null,
            apply_all_running: applyAllRunning,
            scoped_campaign_only: scopedCampaignOnly,
          },
          guards: {
            cooldown_ms: cooldownMs,
            min_state_streak: minStateStreak,
            observed_state_streak: observedStateStreak,
            negative_gihi_slope_streak: negativeSlopeStreak,
            hysteresis_passed: hysteresisPassed,
          },
          applied: {
            research_profile_updated: Boolean(actions.applied.research_profile?.updated),
            evolution_governance_updated: Boolean(actions.applied.evolution_governance?.governance),
            arena_governance_updated_count: Number(actions.applied.arena_governance?.updated_count ?? 0),
            circuit_breaker_domains_updated: Number((actions.applied as any).circuit_breaker?.updated_count ?? 0),
            forced_rotations: Number(actions.applied.forced_rotations?.rotated_count ?? 0),
            campaigns_updated: actions.applied.campaigns.length,
          },
          skipped: actions.skipped,
          dry_run: dryRun,
        },
      });
    };

    if (reasons.length === 0) {
      actions.skipped.push("no_adjustment_conditions_matched");
      await publishMetaTick();
      return actions;
    }
    if (msSinceLastTick !== null && msSinceLastTick < cooldownMs) {
      actions.skipped.push("cooldown_active");
      await publishMetaTick();
      return actions;
    }
    if (!hysteresisPassed) {
      actions.skipped.push("hysteresis_not_reached");
      await publishMetaTick();
      return actions;
    }

    if (dryRun) {
      actions.applied.research_profile = { adaptivePatch, metaPatch };
      actions.applied.evolution_governance = evolutionPatch;
      actions.applied.arena_governance = arenaPatch;
      actions.applied.campaigns = [{
        patch: campaignPatch,
        mode: "preview_only",
        scope: targetCampaignId ? "campaign_id" : (applyAllRunning ? "all_running" : "none"),
      }];
      await publishMetaTick();
      return actions;
    }

    if (scopedCampaignOnly) {
      actions.skipped.push("scoped_campaign_only");
      actions.skipped.push("research_profile_noop");
      actions.skipped.push("evolution_governance_noop");
      actions.skipped.push("arena_governance_noop");
    } else if (Object.keys(adaptivePatch).length > 0 || Object.keys(metaPatch).length > 0) {
      const activeResearch = await agentGetActiveByRole(SYNC_DIR, "research");
      const currentAdaptive = normalizeAdaptiveProfile(activeResearch.profile?.adaptive_profile);
      const currentMeta = activeResearch.profile?.meta_profile ?? {};
      const resolvedAdaptivePatch: Record<string, number> = {};
      if (typeof adaptivePatch.exploration_bias === "number") {
        resolvedAdaptivePatch.exploration_bias = Number(clamp01(
          currentAdaptive.exploration_bias + adaptivePatch.exploration_bias
        ).toFixed(4));
      }
      const resolvedMetaPatch: Record<string, number> = {};
      if (typeof metaPatch.exploration_vs_exploitation_bias === "number") {
        const base = Number((currentMeta as any)?.exploration_vs_exploitation_bias ?? 0.5);
        resolvedMetaPatch.exploration_vs_exploitation_bias = Number(clamp01(
          base + metaPatch.exploration_vs_exploitation_bias
        ).toFixed(4));
      }
      if (typeof metaPatch.mutation_intensity === "number") {
        const base = Number((currentMeta as any)?.mutation_intensity ?? 1);
        resolvedMetaPatch.mutation_intensity = Number(
          Math.max(0.5, Math.min(1.5, base * (1 + metaPatch.mutation_intensity))).toFixed(4)
        );
      }
      actions.applied.research_profile = await researchProfileGovernanceTune({
        syncDir: SYNC_DIR,
        adaptive_patch: Object.keys(resolvedAdaptivePatch).length ? resolvedAdaptivePatch as any : undefined,
        meta_patch: Object.keys(resolvedMetaPatch).length ? resolvedMetaPatch as any : undefined,
      });
    } else {
      actions.skipped.push("research_profile_noop");
    }

    if (scopedCampaignOnly) {
      // no-op in scoped mode
    } else if (Object.keys(evolutionPatch).length > 0) {
      actions.applied.evolution_governance = await governanceSet(SYNC_DIR, evolutionPatch as any);
    } else {
      actions.skipped.push("evolution_governance_noop");
    }

    if (scopedCampaignOnly) {
      // no-op in scoped mode
    } else if (Object.keys(arenaPatch).length > 0) {
      const result = await researchMemoryArenaGovernanceSet({
        syncDir: SYNC_DIR,
        patch: arenaPatch as any,
      });
      actions.applied.arena_governance = result;
      if (result.updated_count > 0) {
        await eventPublish({
          syncDir: SYNC_DIR,
          type: "arena.governance.updated",
          source: "meta_governance_tick",
          data: {
            patch: arenaPatch,
            updated_count: result.updated_count,
          },
        });
      }
    } else {
      actions.skipped.push("arena_governance_noop");
    }

    if (Object.keys(campaignPatch).length > 0) {
      const candidates: any[] = [];
      if (targetCampaignId) {
        try {
          const one = await campaignGet({
            syncDir: SYNC_DIR,
            campaign_id: targetCampaignId,
          });
          candidates.push(one.campaign);
        } catch {
          actions.skipped.push("target_campaign_not_found");
        }
      } else if (applyAllRunning) {
        const running = await campaignList({
          syncDir: SYNC_DIR,
          status: "running",
          limit: 1000,
        });
        candidates.push(...running.items);
      } else {
        actions.skipped.push("campaign_scope_not_provided");
      }

      for (const campaign of candidates) {
        const constraints = (campaign.constraints && typeof campaign.constraints === "object")
          ? { ...campaign.constraints }
          : {};
        if (typeof campaignPatch.transfer_threshold === "number") {
          const current = Number(constraints.transfer_threshold ?? 0.16);
          constraints.transfer_threshold = Number(
            Math.max(0, Math.min(1, current - 0.05)).toFixed(4)
          );
        }
        const defaultSearch = { exploration_bias: [0.2, 0.4, 0.6, 0.8], narrowing_factor: [0.8, 1.0, 1.2] };
        const searchSpace = (constraints.search_space && typeof constraints.search_space === "object")
          ? { ...constraints.search_space }
          : { ...defaultSearch };
        const sourceExplore = Array.isArray(searchSpace.exploration_bias)
          ? searchSpace.exploration_bias
          : defaultSearch.exploration_bias;
        const delta = Number(adaptivePatch.exploration_bias ?? 0);
        searchSpace.exploration_bias = sourceExplore
          .map((x: any) => Number(x))
          .filter((x: number) => Number.isFinite(x))
          .map((x: number) => Number(Math.max(0, Math.min(1, x + delta)).toFixed(4)));
        constraints.search_space = searchSpace;
        const saved = await campaignSave({
          syncDir: SYNC_DIR,
          campaign: {
            ...campaign,
            constraints,
          },
        });
        actions.applied.campaigns.push({
          campaign_id: saved.campaign.campaign_id,
          constraints_patch: {
            transfer_threshold: constraints.transfer_threshold,
            search_space: constraints.search_space,
          },
        });
      }
      if (actions.applied.campaigns.length === 0 && !actions.skipped.includes("campaign_scope_not_provided")) {
        actions.skipped.push("no_campaigns_patched");
      }
    } else {
      actions.skipped.push("campaign_patch_noop");
    }

    const highVarianceDomains = Array.isArray((snapshot as any)?.stressed_driver_breakdown?.high_variance_domains)
      ? (snapshot as any).stressed_driver_breakdown.high_variance_domains
        .map((d: any) => String(d?.domain_signature ?? "").trim())
        .filter((s: string) => s.length > 0)
      : [];
    const shouldApplyHardCircuitBreaker =
      snapshot.meta_state === "degenerating" &&
      highVarianceDomains.length > 0;
    const shouldApplySoftAnnealDown =
      (snapshot.meta_state === "stable" || snapshot.meta_state === "stressed") &&
      highVarianceDomains.length > 0 &&
      Number(snapshot.arena_entropy ?? 0) > 0.9;
    if (shouldApplyHardCircuitBreaker) {
      const breaker = await researchMemoryApplyCircuitBreaker({
        syncDir: SYNC_DIR,
        domain_signatures: highVarianceDomains,
        ticks: 3,
        shadow_cap: 0.2,
        variance_lambda_multiplier: 1.75,
        active_only: true,
        freeze_novelty: true,
        reason: "degenerating_high_variance_domains",
      });
      (actions.applied as any).circuit_breaker = breaker;
      await eventPublish({
        syncDir: SYNC_DIR,
        type: "meta.circuit_breaker.applied",
        source: "meta-governance",
        data: {
          meta_state: snapshot.meta_state,
          domains: highVarianceDomains,
          ticks: 3,
          shadow_cap: 0.2,
          variance_lambda_multiplier: 1.75,
          active_only: true,
          freeze_novelty: true,
          updated_count: breaker.updated_count,
        },
      });
    } else if (shouldApplySoftAnnealDown) {
      const breaker = await researchMemoryApplyCircuitBreaker({
        syncDir: SYNC_DIR,
        domain_signatures: highVarianceDomains,
        ticks: 6,
        shadow_cap: 0.25,
        variance_lambda_multiplier: 1.5,
        active_only: false,
        freeze_novelty: false,
        reason: "anneal_down_high_entropy_high_variance",
      });
      (actions.applied as any).circuit_breaker = breaker;
      await eventPublish({
        syncDir: SYNC_DIR,
        type: "meta.circuit_breaker.applied",
        source: "meta-governance",
        data: {
          meta_state: snapshot.meta_state,
          domains: highVarianceDomains,
          ticks: 6,
          shadow_cap: 0.25,
          variance_lambda_multiplier: 1.5,
          active_only: false,
          freeze_novelty: false,
          updated_count: breaker.updated_count,
        },
      });
    } else {
      actions.skipped.push("circuit_breaker_not_triggered");
    }

    const shouldForceRotate =
      snapshot.meta_state === "degenerating" &&
      snapshot.mutation_roi_trend < -0.0005 &&
      observedStateStreak >= 3;
    if (shouldForceRotate) {
      const rotationResult = await researchMemoryForceStrategyRotation({
        syncDir: SYNC_DIR,
        reason: "meta_degenerating_negative_mutation_roi",
      });
      actions.applied.forced_rotations = rotationResult;
      if (rotationResult.rotated_count > 0) {
        await eventPublish({
          syncDir: SYNC_DIR,
          type: "arena.strategy.forced_rotation",
          source: "meta_governance_tick",
          data: {
            reason: "meta_degenerating_negative_mutation_roi",
            observed_state_streak: observedStateStreak,
            mutation_roi_trend: snapshot.mutation_roi_trend,
            rotated_count: rotationResult.rotated_count,
            rotations: rotationResult.rotations,
          },
        });
      }
    } else {
      actions.skipped.push("forced_rotation_not_triggered");
    }

    await eventPublish({
      syncDir: SYNC_DIR,
      type: "meta.governance.tick",
      source: "meta-governance",
      data: {
        reasons,
        meta_state: snapshot.meta_state,
        gihi_slope: snapshot.gihi_slope,
        gihi_delta_ultra: snapshot.gihi_delta_ultra,
        transfer_variance: snapshot.transfer_variance,
        transfer_variance_trend: snapshot.transfer_variance_trend,
        mutation_roi_trend: snapshot.mutation_roi_trend,
        arena_entropy: snapshot.arena_entropy,
        scope: {
          campaign_id: targetCampaignId ?? null,
          apply_all_running: applyAllRunning,
          scoped_campaign_only: scopedCampaignOnly,
        },
        guards: {
          cooldown_ms: cooldownMs,
          min_state_streak: minStateStreak,
          observed_state_streak: observedStateStreak,
          negative_gihi_slope_streak: negativeSlopeStreak,
          hysteresis_passed: hysteresisPassed,
        },
        applied: {
          research_profile_updated: Boolean(actions.applied.research_profile?.updated),
          evolution_governance_updated: Boolean(actions.applied.evolution_governance?.governance),
          arena_governance_updated_count: Number(actions.applied.arena_governance?.updated_count ?? 0),
          circuit_breaker_domains_updated: Number((actions.applied as any).circuit_breaker?.updated_count ?? 0),
          forced_rotations: Number(actions.applied.forced_rotations?.rotated_count ?? 0),
          campaigns_updated: actions.applied.campaigns.length,
        },
      },
    });

    return actions;
  }

  async function runGovernanceTunerTick(args?: {
    dry_run?: boolean;
    cooldown_ms?: number;
    min_state_streak?: number;
    max_changes?: number;
    transfer_window?: number;
    mutation_window?: number;
    gihi_window?: number;
  }) {
    await ensureSyncDir();
    const dryRun = args?.dry_run !== false;
    const cooldownMs = Math.max(
      60_000,
      Math.min(10 * 60_000, Math.trunc(Number(args?.cooldown_ms ?? 90_000)))
    );
    const minStateStreak = Math.max(1, Math.min(6, Math.trunc(Number(args?.min_state_streak ?? 2))));
    const maxChanges = Math.max(1, Math.min(2, Math.trunc(Number(args?.max_changes ?? 2))));

    const [meta, transfer, arena] = await Promise.all([
      intelligenceMetaSnapshot({
        syncDir: SYNC_DIR,
        transfer_window: typeof args?.transfer_window === "number" ? Math.trunc(args.transfer_window) : undefined,
        mutation_window: typeof args?.mutation_window === "number" ? Math.trunc(args.mutation_window) : undefined,
        gihi_window: typeof args?.gihi_window === "number" ? Math.trunc(args.gihi_window) : undefined,
      }),
      transferDiagnosticsSnapshot({ syncDir: SYNC_DIR }),
      arenaTelemetrySnapshot({ syncDir: SYNC_DIR, limit_domains: 20 }),
    ]);

    const snapshot = (meta as any).snapshot ?? {};
    const transferDomains = Array.isArray((transfer as any)?.snapshot?.per_domain_transfer)
      ? (transfer as any).snapshot.per_domain_transfer
      : [];
    const topVarianceDomains = [...transferDomains]
      .sort((a: any, b: any) => Number(b?.transfer_variance ?? 0) - Number(a?.transfer_variance ?? 0))
      .slice(0, 2);
    const transferInitCandidates = [...transferDomains]
      .filter((d: any) => String(d?.evidence_drop_reason_recent_last ?? "") === "transfer_not_initialized")
      .map((d: any) => {
        const experimentsTotal = Math.max(0, Math.trunc(Number(d?.experiments_total ?? 0)));
        const initialized = Math.max(0, Math.trunc(Number(d?.transfer_initialized ?? 0)));
        const initRatio = experimentsTotal > 0 ? initialized / experimentsTotal : 0;
        return {
          domain_signature: String(d?.domain_signature ?? "").trim(),
          experiments_total: experimentsTotal,
          transfer_initialized: initialized,
          transfer_initialized_ratio: Number(initRatio.toFixed(6)),
          evidence_drop_reason_recent_last: "transfer_not_initialized",
        };
      })
      .filter((d: any) => d.domain_signature.length > 0 && d.experiments_total > 0 && d.transfer_initialized_ratio < 0.7)
      .sort((a: any, b: any) => b.experiments_total - a.experiments_total);
    const arenaDomains = Array.isArray((arena as any)?.snapshot?.domains) ? (arena as any).snapshot.domains : [];
    const topActiveShareAvg = arenaDomains.length > 0
      ? arenaDomains.reduce((acc: number, d: any) => acc + Number(d?.top_active_share ?? 0), 0) / arenaDomains.length
      : 0;

    const priorTicks = await eventList({
      syncDir: SYNC_DIR,
      type: "governance.tuner.tick",
      limit: 100,
    });
    const tickStream = (priorTicks.items ?? [])
      .map((ev: any) => {
        const payload = ev?.payload ?? ev?.data ?? {};
        const ts = Date.parse(String(ev?.ts ?? ""));
        return {
          ts: Number.isFinite(ts) ? ts : 0,
          meta_state: typeof payload?.meta_state === "string" ? payload.meta_state : "",
          low_entropy_domain: typeof payload?.low_entropy_domain === "string" ? payload.low_entropy_domain : "",
          low_entropy_signal: payload?.low_entropy_signal === true,
        };
      })
      .filter((x: any) => x.ts > 0)
      .sort((a: any, b: any) => b.ts - a.ts);
    const lastTick = tickStream[0];
    const msSinceLastTick = lastTick ? Math.max(0, Date.now() - lastTick.ts) : null;
    let priorStateStreak = 0;
    for (const tick of tickStream) {
      if (tick.meta_state === String(snapshot.meta_state ?? "")) priorStateStreak += 1;
      else break;
    }
    const observedStateStreak = priorStateStreak + 1;
    const hysteresisPassed = observedStateStreak >= minStateStreak;

    const reasons: string[] = [];
    if (Number(snapshot.arena_entropy ?? 0) > 0.9 && topActiveShareAvg < 0.35) reasons.push("high_entropy_low_top_active_share");
    if (Number(snapshot.transfer_variance_trend ?? 0) > 0) reasons.push("transfer_variance_trend_up");
    if (String(snapshot.meta_state ?? "") === "stressed") reasons.push("meta_state_stressed");
    if (Number(snapshot.mutation_roi_trend ?? 0) < 0) reasons.push("mutation_roi_negative");
    if (transferInitCandidates.length > 0) reasons.push("transfer_not_initialized_recent");

    const proposals: Array<{
      target: "global" | "domain";
      domain_signature?: string;
      patch: Record<string, number>;
      reason: string;
      ttl_ticks?: number;
    }> = [];

    if (reasons.includes("high_entropy_low_top_active_share")) {
      proposals.push({
        target: "global",
        patch: {
          promotion_margin: 0.09,
          arena_evaluation_window: 7,
        },
        reason: "consolidate_portfolio_under_high_entropy",
        ttl_ticks: 4,
      });
    }
    if (reasons.includes("transfer_variance_trend_up")) {
      proposals.push({
        target: "global",
        patch: {
          arena_cooldown_ms: 18 * 60 * 1000,
        },
        reason: "reduce_governance_churn_under_variance_rise",
        ttl_ticks: 3,
      });
    }
    const POLICY_V2_DOMAIN_TOP1_SHARE_TARGET = 0.45;
    const POLICY_V2_DOMAIN_ENTROPY_TARGET = 0.92;
    const POLICY_V2_DOMAIN_ENTROPY_GOOD = 0.9;
    const POLICY_V2_TTL_TICKS = 12;
    const topVarianceDomain = typeof topVarianceDomains[0]?.domain_signature === "string" ? String(topVarianceDomains[0].domain_signature) : "";
    let topVarianceDomainEntropy: number | null = null;
    let topVarianceDomainTop1Share: number | null = null;
    let lowEntropySignalCurrent = false;
    let lowEntropySignalStreak = 0;
    let lowEntropyGuardActive = false;
    if (topVarianceDomain) {
      const arenaDomainEntry = arenaDomains.find((d: any) => String(d?.domain_signature ?? "") === topVarianceDomain) ?? null;
      const currentDomainGovernance = arenaDomainEntry?.arena_state?.governance ?? {};
      const domainEntropyRaw = Number(arenaDomainEntry?.domain_entropy ?? arenaDomainEntry?.strategy_entropy ?? NaN);
      const top1ShareRaw = Number(arenaDomainEntry?.top1_share ?? arenaDomainEntry?.top_active_share ?? NaN);
      topVarianceDomainEntropy = Number.isFinite(domainEntropyRaw) ? domainEntropyRaw : null;
      topVarianceDomainTop1Share = Number.isFinite(top1ShareRaw) ? top1ShareRaw : null;
      lowEntropySignalCurrent = (
        (topVarianceDomainEntropy != null && topVarianceDomainEntropy < 0.75)
        || (topVarianceDomainTop1Share != null && topVarianceDomainTop1Share > 0.8)
      );
      let priorLowEntropyStreak = 0;
      for (const tick of tickStream) {
        if (String((tick as any)?.low_entropy_domain ?? "") !== topVarianceDomain) break;
        if ((tick as any)?.low_entropy_signal === true) priorLowEntropyStreak += 1;
        else break;
      }
      lowEntropySignalStreak = lowEntropySignalCurrent ? (priorLowEntropyStreak + 1) : 0;
      lowEntropyGuardActive = lowEntropySignalCurrent && lowEntropySignalStreak >= 2;
      const loadCurrentShadowCap = async (domainSignature: string) => {
        try {
          const memoryPath = path.join(SYNC_DIR, "agents", "research_memory.json");
          const raw = await fs.readFile(memoryPath, "utf8");
          const parsed = JSON.parse(raw);
          const items = Array.isArray(parsed?.items) ? parsed.items : [];
          const entry = items.find((it: any) => String(it?.domain_signature ?? "") === domainSignature);
          const cap = Number(entry?.stabilization_mode?.shadow_cap ?? NaN);
          if (Number.isFinite(cap)) return cap;
          return 0.2;
        } catch {
          return 0.2;
        }
      };

      const currentShadowCap = await loadCurrentShadowCap(topVarianceDomain);
      const arenaEntropy = Number(snapshot.arena_entropy ?? NaN);
      let proposedShadowCap = currentShadowCap;
      let shadowReason = "stabilize_top_variance_domain_shadow_noop";
      if (Number.isFinite(arenaEntropy) && arenaEntropy > 0.88) {
        proposedShadowCap = currentShadowCap - 0.02;
        shadowReason = "entropy_high_step_down_shadow_cap";
      } else if (Number.isFinite(arenaEntropy) && arenaEntropy < 0.75) {
        proposedShadowCap = currentShadowCap + 0.02;
        shadowReason = "entropy_low_step_up_shadow_cap";
      }
      proposedShadowCap = Math.max(0.1, Math.min(0.4, Number(proposedShadowCap.toFixed(6))));
      if (Math.abs(proposedShadowCap - currentShadowCap) > 1e-9) {
        proposals.push({
          target: "domain",
          domain_signature: topVarianceDomain,
          patch: {
            shadow_cap: proposedShadowCap,
          },
          reason: shadowReason,
          ttl_ticks: POLICY_V2_TTL_TICKS,
        });
      }

      if (Number.isFinite(arenaEntropy) && arenaEntropy > 0.88 && !lowEntropyGuardActive) {
        const currentMaxStrategies = Math.max(2, Math.min(10, Math.trunc(Number(currentDomainGovernance?.max_strategies_per_domain ?? 4))));
        const currentEvalWindow = Math.max(3, Math.min(12, Math.trunc(Number(currentDomainGovernance?.arena_evaluation_window ?? 3))));
        const currentPromotionMargin = Math.max(0.02, Math.min(0.12, Number(currentDomainGovernance?.promotion_margin ?? 0.02)));
        const currentCooldownMs = Math.max(10_000, Math.min(120_000, Math.trunc(Number(currentDomainGovernance?.arena_cooldown_ms ?? 10_000))));
        const nextMaxStrategies = Math.max(2, Math.min(10, Math.min(currentMaxStrategies, 3)));
        const nextEvalWindow = Math.max(3, Math.min(12, Math.max(currentEvalWindow, 9)));
        const nextPromotionMargin = Math.max(0.02, Math.min(0.12, Number(Math.max(currentPromotionMargin, 0.08).toFixed(6))));
        const nextCooldownMs = Math.max(10_000, Math.min(120_000, Math.max(currentCooldownMs, 30_000)));
        let finalMaxStrategies = nextMaxStrategies;
        let finalEvalWindow = nextEvalWindow;
        let finalPromotionMargin = nextPromotionMargin;
        let finalCooldownMs = nextCooldownMs;
        const baselineNoop =
          nextMaxStrategies === currentMaxStrategies
          && nextEvalWindow === currentEvalWindow
          && Math.abs(nextPromotionMargin - currentPromotionMargin) <= 1e-9
          && nextCooldownMs === currentCooldownMs;
        if (baselineNoop && arenaEntropy > 0.9) {
          // Anti-stall: if v2 baseline already active but entropy remains high, tighten one step.
          finalMaxStrategies = Math.max(2, Math.min(10, currentMaxStrategies - 1));
          finalEvalWindow = Math.max(3, Math.min(12, currentEvalWindow + 1));
          finalPromotionMargin = Math.max(0.02, Math.min(0.12, Number((currentPromotionMargin + 0.01).toFixed(6))));
          finalCooldownMs = Math.max(10_000, Math.min(120_000, currentCooldownMs + 5_000));
        }
        if (
          finalMaxStrategies !== currentMaxStrategies
          || finalEvalWindow !== currentEvalWindow
          || Math.abs(finalPromotionMargin - currentPromotionMargin) > 1e-9
          || finalCooldownMs !== currentCooldownMs
        ) {
          proposals.push({
            target: "domain",
            domain_signature: topVarianceDomain,
            patch: {
              max_strategies_per_domain: finalMaxStrategies,
              arena_evaluation_window: finalEvalWindow,
              promotion_margin: finalPromotionMargin,
              arena_cooldown_ms: finalCooldownMs,
            },
            reason: baselineNoop && arenaEntropy > 0.9
              ? "entropy_high_apply_policy_v2_domain_profile_tighten"
              : "entropy_high_apply_policy_v2_domain_profile",
            ttl_ticks: POLICY_V2_TTL_TICKS,
          });
        }
      } else if (Number.isFinite(arenaEntropy) && arenaEntropy < 0.75) {
        const currentMaxStrategies = Math.max(2, Math.min(10, Math.trunc(Number(currentDomainGovernance?.max_strategies_per_domain ?? 4))));
        const currentEvalWindow = Math.max(3, Math.min(12, Math.trunc(Number(currentDomainGovernance?.arena_evaluation_window ?? 3))));
        const currentPromotionMargin = Math.max(0.02, Math.min(0.12, Number(currentDomainGovernance?.promotion_margin ?? 0.02)));
        const currentCooldownMs = Math.max(10_000, Math.min(120_000, Math.trunc(Number(currentDomainGovernance?.arena_cooldown_ms ?? 10_000))));
        const nextMaxStrategies = Math.max(2, Math.min(10, currentMaxStrategies + 1));
        const nextEvalWindow = Math.max(3, Math.min(12, currentEvalWindow - 1));
        const nextPromotionMargin = Math.max(0.02, Math.min(0.12, Number((currentPromotionMargin - 0.01).toFixed(6))));
        const nextCooldownMs = Math.max(10_000, Math.min(120_000, currentCooldownMs - 5_000));
        if (
          nextMaxStrategies !== currentMaxStrategies
          || nextEvalWindow !== currentEvalWindow
          || Math.abs(nextPromotionMargin - currentPromotionMargin) > 1e-9
          || nextCooldownMs !== currentCooldownMs
        ) {
          proposals.push({
            target: "domain",
            domain_signature: topVarianceDomain,
            patch: {
              max_strategies_per_domain: nextMaxStrategies,
              arena_evaluation_window: nextEvalWindow,
              promotion_margin: nextPromotionMargin,
              arena_cooldown_ms: nextCooldownMs,
            },
            reason: "entropy_low_step_down_domain_governance_consolidation",
            ttl_ticks: 4,
          });
        }
      }
      if (lowEntropyGuardActive) {
        const currentMaxStrategies = Math.max(2, Math.min(10, Math.trunc(Number(currentDomainGovernance?.max_strategies_per_domain ?? 4))));
        const currentEvalWindow = Math.max(3, Math.min(12, Math.trunc(Number(currentDomainGovernance?.arena_evaluation_window ?? 3))));
        const currentPromotionMargin = Math.max(0.02, Math.min(0.12, Number(currentDomainGovernance?.promotion_margin ?? 0.02)));
        const currentCooldownMs = Math.max(10_000, Math.min(120_000, Math.trunc(Number(currentDomainGovernance?.arena_cooldown_ms ?? 10_000))));
        const nextShadowCap = Math.max(0.1, Math.min(0.4, Number((currentShadowCap + 0.02).toFixed(6))));
        const nextPromotionMargin = Math.max(0.02, Math.min(0.12, Number((currentPromotionMargin - 0.01).toFixed(6))));
        const nextMaxStrategies = Math.max(2, Math.min(10, Math.max(currentMaxStrategies, 4)));
        const nextEvalWindow = Math.max(3, Math.min(12, Math.max(3, currentEvalWindow - 1)));
        const nextCooldownMs = Math.max(10_000, Math.min(120_000, Math.max(10_000, currentCooldownMs - 5_000)));
        proposals.push({
          target: "domain",
          domain_signature: topVarianceDomain,
          patch: {
            shadow_cap: nextShadowCap,
            max_strategies_per_domain: nextMaxStrategies,
            promotion_margin: nextPromotionMargin,
            arena_evaluation_window: nextEvalWindow,
            arena_cooldown_ms: nextCooldownMs,
          },
          reason: "low_entropy_guard_relax_after_streak",
          ttl_ticks: POLICY_V2_TTL_TICKS,
        });
      }
    }

    const STRICT_TUNER_ALLOWLIST_V2 = true;
    const mergeDomainProposals = (items: Array<{
      target: "global" | "domain";
      domain_signature?: string;
      patch: Record<string, number>;
      reason: string;
      ttl_ticks?: number;
    }>) => {
      const mergedGlobal: typeof items = [];
      const mergedDomain = new Map<string, {
        target: "domain";
        domain_signature: string;
        patch: Record<string, number>;
        reason: string;
        ttl_ticks?: number;
      }>();
      for (const item of items) {
        if (item.target !== "domain" || !item.domain_signature) {
          mergedGlobal.push(item);
          continue;
        }
        const key = String(item.domain_signature);
        const existing = mergedDomain.get(key);
        if (!existing) {
          mergedDomain.set(key, {
            target: "domain",
            domain_signature: key,
            patch: { ...item.patch },
            reason: item.reason,
            ttl_ticks: item.ttl_ticks,
          });
          continue;
        }
        existing.patch = {
          ...existing.patch,
          ...item.patch,
        };
        const reasonParts = new Set(
          `${existing.reason}|${item.reason}`
            .split("|")
            .map((x) => x.trim())
            .filter(Boolean),
        );
        existing.reason = Array.from(reasonParts).join("|");
        existing.ttl_ticks = Math.max(
          Math.trunc(Number(existing.ttl_ticks ?? 0)),
          Math.trunc(Number(item.ttl_ticks ?? 0)),
        ) || existing.ttl_ticks || item.ttl_ticks;
      }
      return [
        ...mergedGlobal,
        ...Array.from(mergedDomain.values()),
      ];
    };

    const mergedProposals = mergeDomainProposals(proposals);
    const applyCandidates = STRICT_TUNER_ALLOWLIST_V2
      ? mergedProposals.filter((p) => p.target === "domain")
      : mergedProposals;
    const limited = applyCandidates.slice(0, maxChanges);
    const skipped: string[] = [];
    if (reasons.length === 0) skipped.push("no_adjustment_conditions_matched");
    if (msSinceLastTick !== null && msSinceLastTick < cooldownMs) skipped.push("cooldown_active");
    if (!hysteresisPassed) skipped.push("hysteresis_not_reached");
    if (STRICT_TUNER_ALLOWLIST_V2 && mergedProposals.some((p) => p.target === "global")) {
      skipped.push("global_proposals_filtered_by_strict_allowlist_v2");
    }
    const blockingSkips = skipped.filter((s) => s !== "global_proposals_filtered_by_strict_allowlist_v2");
    const canApply = !dryRun && blockingSkips.length === 0;
    const applied: any[] = [];
    const afterApply: {
      validation: null | {
        dedupe_key: string;
        affected_domains: string[];
        max_ticks: number;
        campaign_id: string;
        reused_existing_campaign: boolean;
        enqueued: boolean;
        enqueue_job_id?: string;
      };
      bootstrap_transfer_init: null | {
        dedupe_key: string;
        domain_signature: string;
        campaign_id: string;
        reused_existing_campaign: boolean;
        enqueued: boolean;
        enqueue_job_id?: string;
      };
    } = {
      validation: null,
      bootstrap_transfer_init: null,
    };
    if (canApply) {
      for (const p of limited) {
        if (p.target === "global") {
          const patch: Record<string, number> = {};
          if (typeof p.patch.promotion_margin === "number") {
            patch.promotion_margin = Math.max(0.02, Math.min(0.12, Number(p.patch.promotion_margin)));
          }
          if (typeof p.patch.arena_evaluation_window === "number") {
            patch.arena_evaluation_window = Math.max(3, Math.min(10, Math.trunc(p.patch.arena_evaluation_window)));
          }
          if (typeof p.patch.arena_cooldown_ms === "number") {
            patch.arena_cooldown_ms = Math.max(10_000, Math.min(24 * 60 * 60 * 1000, Math.trunc(p.patch.arena_cooldown_ms)));
          }
          const r = await researchMemoryArenaGovernanceSet({
            syncDir: SYNC_DIR,
            patch,
          });
          applied.push({ target: "global", patch, updated_count: r.updated_count, reason: p.reason });
        } else if (p.target === "domain" && p.domain_signature) {
          const domainPatch: Record<string, number> = {};
          if (typeof p.patch.max_strategies_per_domain === "number") {
            domainPatch.max_strategies_per_domain = Math.max(2, Math.min(10, Math.trunc(p.patch.max_strategies_per_domain)));
          }
          if (typeof p.patch.promotion_margin === "number") {
            domainPatch.promotion_margin = Math.max(0.02, Math.min(0.12, Number(p.patch.promotion_margin)));
          }
          if (typeof p.patch.arena_evaluation_window === "number") {
            domainPatch.arena_evaluation_window = Math.max(3, Math.min(12, Math.trunc(p.patch.arena_evaluation_window)));
          }
          if (typeof p.patch.arena_cooldown_ms === "number") {
            domainPatch.arena_cooldown_ms = Math.max(10_000, Math.min(120_000, Math.trunc(p.patch.arena_cooldown_ms)));
          }
          let governanceUpdated = 0;
          if (Object.keys(domainPatch).length > 0) {
            const g = await researchMemoryArenaGovernanceSet({
              syncDir: SYNC_DIR,
              domain_signature: p.domain_signature,
              patch: domainPatch,
            });
            governanceUpdated = Number(g.updated_count ?? 0);
          }
          let breakerUpdated = 0;
          let shadowCap: number | null = null;
          if (typeof p.patch.shadow_cap === "number") {
            shadowCap = Math.max(0.1, Math.min(0.4, Number(p.patch.shadow_cap ?? 0.2)));
            const r = await researchMemoryApplyCircuitBreaker({
              syncDir: SYNC_DIR,
              domain_signatures: [p.domain_signature],
              shadow_cap: shadowCap,
              ticks: Math.max(1, Math.min(6, Math.trunc(Number(p.ttl_ticks ?? 3)))),
              reason: p.reason,
            });
            breakerUpdated = Number(r.updated_count ?? 0);
          }
          applied.push({
            target: "domain",
            domain_signature: p.domain_signature,
            patch: {
              ...domainPatch,
              ...(shadowCap !== null ? { shadow_cap: shadowCap } : {}),
            },
            governance_updated_count: governanceUpdated,
            circuit_breaker_updated_count: breakerUpdated,
            updated_count: governanceUpdated + breakerUpdated,
            reason: p.reason,
          });
        }
      }

      const appliedDomainUpdates = Array.from(new Set(
        applied
          .filter((x: any) => x?.target === "domain" && Number(x?.updated_count ?? 0) > 0)
          .map((x: any) => String(x?.domain_signature ?? "").trim())
          .filter((x: string) => x.length > 0),
      ));

      if (appliedDomainUpdates.length > 0) {
        const appliedDigestPayload = applied
          .filter((x: any) => x?.target === "domain")
          .map((x: any) => ({
            domain_signature: String(x?.domain_signature ?? ""),
            patch: x?.patch ?? {},
            reason: String(x?.reason ?? ""),
            updated_count: Number(x?.updated_count ?? 0),
          }))
          .sort((a: any, b: any) => String(a.domain_signature).localeCompare(String(b.domain_signature)));
        const digest = createHash("sha1")
          .update(JSON.stringify(appliedDigestPayload))
          .digest("hex");
        const dedupeKey = `validate-after-apply:${digest}`;
        const maxTicks = Math.max(6, 6 * appliedDomainUpdates.length);
        const existingCampaigns = await campaignList({
          syncDir: SYNC_DIR,
          limit: 1000,
        });
        const reusable = existingCampaigns.items.find((c: any) => {
          const constraints = (c?.constraints && typeof c.constraints === "object") ? c.constraints : {};
          const status = String(c?.status ?? "");
          if (status !== "draft" && status !== "running") return false;
          return String((constraints as any)?.tuner_validation_dedupe_key ?? "") === dedupeKey;
        });
        let validationCampaignId = "";
        let reusedValidationCampaign = false;
        if (reusable) {
          validationCampaignId = String((reusable as any).campaign_id);
          reusedValidationCampaign = true;
        } else {
          const created = await campaignCreate({
            syncDir: SYNC_DIR,
            campaign_id: `cmp_validate_after_apply_${digest.slice(0, 12)}_${Date.now()}`,
            goal: `Validate tuner apply on ${appliedDomainUpdates.join(", ")}`,
            objective: "validate governance tuner apply stability",
            constraints: {
              confidence_domains_targeted: appliedDomainUpdates,
              auto_advance: true,
              tuner_validation_after_apply: true,
              tuner_validation_dedupe_key: dedupeKey,
            },
            max_experiments: Math.max(24, maxTicks * 4),
            stop_conditions: {
              max_ticks: maxTicks,
            },
          });
          validationCampaignId = created.campaign.campaign_id;
        }
        const queuedValidation = await enqueueCampaignTickJob({
          campaign_id: validationCampaignId,
          max_steps: 1,
          source: "governance_tuner_after_apply_validation",
          idempotency_key: `validate-start-${dedupeKey}`,
        });
        afterApply.validation = {
          dedupe_key: dedupeKey,
          affected_domains: appliedDomainUpdates,
          max_ticks: maxTicks,
          campaign_id: validationCampaignId,
          reused_existing_campaign: reusedValidationCampaign,
          enqueued: Boolean(queuedValidation?.queued),
          enqueue_job_id: queuedValidation?.job_id,
        };
      }

      const bootstrapDomain = String(transferInitCandidates[0]?.domain_signature ?? "").trim();
      if (bootstrapDomain) {
        const dedupeKey = `bootstrap-transfer-init:${bootstrapDomain}`;
        const existingCampaigns = await campaignList({
          syncDir: SYNC_DIR,
          limit: 1000,
        });
        const reusable = existingCampaigns.items.find((c: any) => {
          const constraints = (c?.constraints && typeof c.constraints === "object") ? c.constraints : {};
          const status = String(c?.status ?? "");
          if (status !== "draft" && status !== "running") return false;
          return String((constraints as any)?.bootstrap_transfer_init_key ?? "") === dedupeKey;
        });
        let bootstrapCampaignId = "";
        let reusedBootstrapCampaign = false;
        if (reusable) {
          bootstrapCampaignId = String((reusable as any).campaign_id);
          reusedBootstrapCampaign = true;
        } else {
          const created = await campaignCreate({
            syncDir: SYNC_DIR,
            campaign_id: `cmp_bootstrap_transfer_${bootstrapDomain.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 24)}_${Date.now()}`,
            goal: `Bootstrap transfer init for ${bootstrapDomain}`,
            objective: "self-heal transfer_not_initialized pipeline",
            constraints: {
              confidence_domains_targeted: [bootstrapDomain],
              auto_advance: true,
              force_transfer_init: true,
              bootstrap_transfer_init: true,
              bootstrap_transfer_init_key: dedupeKey,
            },
            max_experiments: 24,
            stop_conditions: {
              max_ticks: 6,
            },
          });
          bootstrapCampaignId = created.campaign.campaign_id;
        }
        const queuedBootstrap = await enqueueCampaignTickJob({
          campaign_id: bootstrapCampaignId,
          max_steps: 1,
          source: "governance_tuner_bootstrap_transfer_init",
          idempotency_key: `bootstrap-start-${dedupeKey}`,
        });
        afterApply.bootstrap_transfer_init = {
          dedupe_key: dedupeKey,
          domain_signature: bootstrapDomain,
          campaign_id: bootstrapCampaignId,
          reused_existing_campaign: reusedBootstrapCampaign,
          enqueued: Boolean(queuedBootstrap?.queued),
          enqueue_job_id: queuedBootstrap?.job_id,
        };
      }
    }

    const preview = {
      dry_run: dryRun,
      guards: {
        cooldown_ms: cooldownMs,
        ms_since_last_tick: msSinceLastTick,
        min_state_streak: minStateStreak,
        observed_state_streak: observedStateStreak,
        hysteresis_passed: hysteresisPassed,
      },
      reasons,
      skipped,
      blocking_skipped: blockingSkips,
      input: {
        meta_state: snapshot.meta_state ?? null,
        arena_entropy: snapshot.arena_entropy ?? null,
        policy_targets: {
          top1_share_target: POLICY_V2_DOMAIN_TOP1_SHARE_TARGET,
          domain_entropy_target: POLICY_V2_DOMAIN_ENTROPY_TARGET,
          domain_entropy_good: POLICY_V2_DOMAIN_ENTROPY_GOOD,
        },
        top_active_share_avg: Number(topActiveShareAvg.toFixed(6)),
        transfer_variance_trend: snapshot.transfer_variance_trend ?? null,
        gihi_delta_ultra: snapshot.gihi_delta_ultra ?? null,
        mutation_roi_trend: snapshot.mutation_roi_trend ?? null,
        top_variance_domains: topVarianceDomains.map((d: any) => ({
          domain_signature: d?.domain_signature ?? null,
          transfer_variance: d?.transfer_variance ?? null,
          evidence_observations_recent_ewma: d?.evidence_observations_recent_ewma ?? null,
        })),
        low_entropy_guard: {
          domain_signature: topVarianceDomain || null,
          domain_entropy: topVarianceDomainEntropy == null ? null : Number(topVarianceDomainEntropy.toFixed(6)),
          top1_share: topVarianceDomainTop1Share == null ? null : Number(topVarianceDomainTop1Share.toFixed(6)),
          signal_streak: lowEntropySignalStreak,
          signal_current: lowEntropySignalCurrent,
          active: lowEntropyGuardActive,
        },
      },
      proposals: limited,
      applied,
      after_apply: afterApply,
      transfer_init_candidates: transferInitCandidates.slice(0, 3),
    };

    await notesUpsert({
      syncDir: SYNC_DIR,
      title: dryRun ? "tuner_preview" : "tuner_apply",
      content: JSON.stringify(preview, null, 2),
      tags: ["governance", "tuner", dryRun ? "preview" : "applied"],
    });

    await eventPublish({
      syncDir: SYNC_DIR,
      type: "governance.tuner.tick",
      source: "governance-tuner",
      data: {
        meta_state: snapshot.meta_state ?? null,
        reasons,
        skipped,
        low_entropy_domain: topVarianceDomain || null,
        low_entropy_signal: lowEntropySignalCurrent,
        low_entropy_signal_streak: lowEntropySignalStreak,
        dry_run: dryRun,
        proposals_count: limited.length,
        applied_count: applied.length,
        after_apply_validation_campaign_id: afterApply.validation?.campaign_id ?? null,
        after_apply_validation_domains: afterApply.validation?.affected_domains ?? [],
        bootstrap_transfer_init_campaign_id: afterApply.bootstrap_transfer_init?.campaign_id ?? null,
      },
    });

    return preview;
  }

  async function runGovernanceThresholdTunerTick(args?: {
    dry_run?: boolean;
    cooldown_ms?: number;
    min_state_streak?: number;
    max_changes?: number;
    ttl_ticks?: number;
    transfer_window?: number;
    mutation_window?: number;
    gihi_window?: number;
  }) {
    await ensureSyncDir();
    const dryRun = args?.dry_run !== false;
    const cooldownMs = Math.max(
      60_000,
      Math.min(10 * 60_000, Math.trunc(Number(args?.cooldown_ms ?? 90_000))),
    );
    const minStateStreak = Math.max(1, Math.min(6, Math.trunc(Number(args?.min_state_streak ?? 2))));
    const maxChanges = Math.max(1, Math.min(1, Math.trunc(Number(args?.max_changes ?? 1))));
    const ttlTicks = Math.max(6, Math.min(24, Math.trunc(Number(args?.ttl_ticks ?? 12))));

    const [meta, arena, transfer, currentGov] = await Promise.all([
      intelligenceMetaSnapshot({
        syncDir: SYNC_DIR,
        transfer_window: typeof args?.transfer_window === "number" ? Math.trunc(args.transfer_window) : undefined,
        mutation_window: typeof args?.mutation_window === "number" ? Math.trunc(args.mutation_window) : undefined,
        gihi_window: typeof args?.gihi_window === "number" ? Math.trunc(args.gihi_window) : undefined,
      }),
      arenaTelemetrySnapshot({ syncDir: SYNC_DIR, limit_domains: 20 }),
      transferDiagnosticsSnapshot({ syncDir: SYNC_DIR }),
      governanceGet(SYNC_DIR),
    ]);

    const snapshot = (meta as any).snapshot ?? {};
    const gov = (currentGov as any)?.governance ?? {};
    const arenaDomains = Array.isArray((arena as any)?.snapshot?.domains) ? (arena as any).snapshot.domains : [];
    const topActiveShareAvg = arenaDomains.length > 0
      ? arenaDomains.reduce((acc: number, d: any) => acc + Number(d?.top_active_share ?? 0), 0) / arenaDomains.length
      : 0;
    const transferDomains = Array.isArray((transfer as any)?.snapshot?.per_domain_transfer)
      ? (transfer as any).snapshot.per_domain_transfer
      : [];
    const validationDomains: string[] = Array.from(new Set<string>(
      transferDomains
        .map((d: any) => String(d?.domain_signature ?? "").trim())
        .filter((sig: string) => sig.length > 0 && sig !== "unknown")
        .slice(0, 2),
    ));

    const priorTicks = await eventList({
      syncDir: SYNC_DIR,
      type: "governance.threshold_tuner.tick",
      limit: 100,
    });
    const tickStream = (priorTicks.items ?? [])
      .map((ev: any) => {
        const payload = ev?.payload ?? ev?.data ?? {};
        const ts = Date.parse(String(ev?.ts ?? ""));
        return {
          ts: Number.isFinite(ts) ? ts : 0,
          meta_state: typeof payload?.meta_state === "string" ? payload.meta_state : "",
        };
      })
      .filter((x: any) => x.ts > 0)
      .sort((a: any, b: any) => b.ts - a.ts);
    const lastTick = tickStream[0];
    const msSinceLastTick = lastTick ? Math.max(0, Date.now() - lastTick.ts) : null;
    let priorStateStreak = 0;
    for (const tick of tickStream) {
      if (tick.meta_state === String(snapshot.meta_state ?? "")) priorStateStreak += 1;
      else break;
    }
    const observedStateStreak = priorStateStreak + 1;
    const hysteresisPassed = observedStateStreak >= minStateStreak;

    const arenaEntropy = Number(snapshot.arena_entropy ?? NaN);
    const transferVarianceTrend = Number(snapshot.transfer_variance_trend ?? NaN);
    const gihiDeltaUltra = Number(snapshot.gihi_delta_ultra ?? NaN);
    const mutationRoiTrend = Number(snapshot.mutation_roi_trend ?? NaN);

    const reasons: string[] = [];
    const proposals: Array<{ patch: Record<string, number>; reason: string; ttl_ticks: number }> = [];

    if (
      Number.isFinite(arenaEntropy) && Number.isFinite(gihiDeltaUltra) && Number.isFinite(transferVarianceTrend)
      && arenaEntropy > 0.9 && gihiDeltaUltra >= 0 && transferVarianceTrend <= 0
    ) {
      reasons.push("entropy_high_with_safe_trends");
      const currentMinMargin = Number(gov?.promotion_margin_min ?? 0.05);
      proposals.push({
        patch: {
          promotion_margin_min: Math.max(0.02, Math.min(0.12, Number((currentMinMargin + 0.01).toFixed(6)))),
        },
        reason: "raise_promotion_margin_min_for_global_viscosity",
        ttl_ticks: ttlTicks,
      });
    } else if (
      Number.isFinite(mutationRoiTrend) && mutationRoiTrend < 0
    ) {
      reasons.push("mutation_roi_negative");
      const currentCooldown = Math.max(60_000, Math.trunc(Number(gov?.evolution_cooldown_ms ?? 3_600_000)));
      proposals.push({
        patch: {
          evolution_cooldown_ms: Math.max(60_000, Math.min(7 * 24 * 60 * 60 * 1000, Math.trunc(currentCooldown * 1.1))),
        },
        reason: "slow_evolution_under_negative_mutation_roi",
        ttl_ticks: ttlTicks,
      });
    } else if (
      Number.isFinite(arenaEntropy) && Number.isFinite(topActiveShareAvg)
      && arenaEntropy < 0.8 && topActiveShareAvg > 0.75
    ) {
      reasons.push("global_low_entropy_overconcentrated");
      const currentMinMargin = Number(gov?.promotion_margin_min ?? 0.05);
      proposals.push({
        patch: {
          promotion_margin_min: Math.max(0.02, Math.min(0.12, Number((currentMinMargin - 0.01).toFixed(6)))),
        },
        reason: "relax_promotion_margin_min_under_low_entropy",
        ttl_ticks: ttlTicks,
      });
    }

    const limited = proposals.slice(0, maxChanges);
    const skipped: string[] = [];
    if (reasons.length === 0) skipped.push("no_adjustment_conditions_matched");
    if (msSinceLastTick !== null && msSinceLastTick < cooldownMs) skipped.push("cooldown_active");
    if (!hysteresisPassed) skipped.push("hysteresis_not_reached");
    const canApply = !dryRun && skipped.length === 0;

    const applied: any[] = [];
    const afterApply: {
      validation: null | {
        dedupe_key: string;
        campaign_id: string;
        max_ticks: number;
        targets: string[];
        enqueued: boolean;
        enqueue_job_id?: string;
        reused_existing_campaign: boolean;
      };
    } = { validation: null };

    if (canApply && limited.length > 0) {
      const proposal = limited[0];
      const previous = {
        promotion_margin_min: Number(gov?.promotion_margin_min ?? 0.05),
        evolution_cooldown_ms: Math.trunc(Number(gov?.evolution_cooldown_ms ?? 3_600_000)),
      };
      const patch: Record<string, number> = {};
      if (typeof proposal.patch.promotion_margin_min === "number") {
        patch.promotion_margin_min = Math.max(0.02, Math.min(0.12, Number(proposal.patch.promotion_margin_min)));
      }
      if (typeof proposal.patch.evolution_cooldown_ms === "number") {
        patch.evolution_cooldown_ms = Math.max(60_000, Math.min(7 * 24 * 60 * 60 * 1000, Math.trunc(proposal.patch.evolution_cooldown_ms)));
      }
      const updated = await governanceSet(SYNC_DIR, patch);
      applied.push({
        patch,
        previous_governance: previous,
        governance: updated.governance,
        updated_count: 1,
        reason: proposal.reason,
        ttl_ticks: proposal.ttl_ticks,
      });

      const digest = createHash("sha1")
        .update(JSON.stringify({
          patch,
          reason: proposal.reason,
          previous,
        }))
        .digest("hex");
      const dedupeKey = `threshold-validate-after-apply:${digest}`;
      const targets = validationDomains.length > 0 ? validationDomains : ["small|low|low|p2"];
      const maxTicks = Math.max(6, 6 * targets.length);

      const existingCampaigns = await campaignList({ syncDir: SYNC_DIR, limit: 1000 });
      const reusable = existingCampaigns.items.find((c: any) => {
        const constraints = (c?.constraints && typeof c.constraints === "object") ? c.constraints : {};
        const status = String(c?.status ?? "");
        if (status !== "draft" && status !== "running") return false;
        return String((constraints as any)?.threshold_tuner_apply_dedupe_key ?? "") === dedupeKey;
      });

      let validationCampaignId = "";
      let reused = false;
      if (reusable) {
        validationCampaignId = String((reusable as any).campaign_id ?? "");
        reused = true;
      } else {
        const created = await campaignCreate({
          syncDir: SYNC_DIR,
          campaign_id: `cmp_threshold_validate_${digest.slice(0, 12)}_${Date.now()}`,
          goal: "Validate threshold tuner global patch",
          objective: "judge global threshold patch outcome",
          constraints: {
            confidence_domains_targeted: targets,
            auto_advance: true,
            tuner_threshold_validation_after_apply: true,
            threshold_tuner_apply_dedupe_key: dedupeKey,
            threshold_tuner_previous_governance: previous,
            threshold_tuner_applied_patch: patch,
            threshold_tuner_baseline: {
              arena_entropy: Number.isFinite(arenaEntropy) ? arenaEntropy : null,
              transfer_variance_trend: Number.isFinite(transferVarianceTrend) ? transferVarianceTrend : null,
              gihi_delta_ultra: Number.isFinite(gihiDeltaUltra) ? gihiDeltaUltra : null,
              mutation_roi_trend: Number.isFinite(mutationRoiTrend) ? mutationRoiTrend : null,
            },
          },
          max_experiments: Math.max(24, maxTicks * 4),
          stop_conditions: {
            max_ticks: maxTicks,
          },
        });
        validationCampaignId = created.campaign.campaign_id;
      }
      const queued = await enqueueCampaignTickJob({
        campaign_id: validationCampaignId,
        max_steps: 1,
        source: "governance_threshold_tuner_validation",
        idempotency_key: `threshold-validate-start-${dedupeKey}`,
      });
      afterApply.validation = {
        dedupe_key: dedupeKey,
        campaign_id: validationCampaignId,
        max_ticks: maxTicks,
        targets,
        enqueued: Boolean(queued?.queued),
        enqueue_job_id: queued?.job_id,
        reused_existing_campaign: reused,
      };
    }

    const preview = {
      dry_run: dryRun,
      guards: {
        cooldown_ms: cooldownMs,
        ms_since_last_tick: msSinceLastTick,
        min_state_streak: minStateStreak,
        observed_state_streak: observedStateStreak,
        hysteresis_passed: hysteresisPassed,
      },
      reasons,
      skipped,
      input: {
        meta_state: snapshot.meta_state ?? null,
        arena_entropy: Number.isFinite(arenaEntropy) ? Number(arenaEntropy.toFixed(6)) : null,
        transfer_variance_trend: Number.isFinite(transferVarianceTrend) ? Number(transferVarianceTrend.toFixed(6)) : null,
        gihi_delta_ultra: Number.isFinite(gihiDeltaUltra) ? Number(gihiDeltaUltra.toFixed(6)) : null,
        mutation_roi_trend: Number.isFinite(mutationRoiTrend) ? Number(mutationRoiTrend.toFixed(6)) : null,
        top_active_share_avg: Number(topActiveShareAvg.toFixed(6)),
        governance_current: {
          promotion_margin_min: Number(gov?.promotion_margin_min ?? 0.05),
          evolution_cooldown_ms: Math.trunc(Number(gov?.evolution_cooldown_ms ?? 3_600_000)),
        },
      },
      proposals: limited,
      applied,
      after_apply: afterApply,
    };

    await notesUpsert({
      syncDir: SYNC_DIR,
      title: dryRun ? "threshold_tuner_preview" : "threshold_tuner_apply",
      content: JSON.stringify(preview, null, 2),
      tags: ["governance", "threshold_tuner", dryRun ? "preview" : "applied"],
    });

    await eventPublish({
      syncDir: SYNC_DIR,
      type: "governance.threshold_tuner.tick",
      source: "governance-threshold-tuner",
      data: {
        meta_state: snapshot.meta_state ?? null,
        reasons,
        skipped,
        dry_run: dryRun,
        proposals_count: limited.length,
        applied_count: applied.length,
        after_apply_validation_campaign_id: afterApply.validation?.campaign_id ?? null,
      },
    });

    return preview;
  }

  // Simple router for now
  
  // ---- Diagnostic MCP tools (sleep / async job demo) ----
  const debugJobs = new Map<
    string,
    { status: "running" | "done" | "error"; result?: string; startedAt: number; doneAt?: number; error?: string }
  >();
  const parseDebugMs = (params: any): number => {
    const msRaw =
      params?.arguments?.ms ??
      params?.ms ??
      params?.arguments?.durationMs ??
      params?.durationMs;

    const ms = Number(msRaw);
    if (!Number.isFinite(ms) || ms < 0 || !Number.isInteger(ms) || ms > 600000) {
      throw new Error(`Invalid ms: ${msRaw}`);
    }
    return ms;
  };

  const parseDebugJobId = (params: any): string => {
    const raw =
      params?.arguments?.job_id ??
      params?.job_id ??
      params?.arguments?.id ??
      params?.id ??
      params?.arguments?.handle ??
      params?.handle;

    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new Error(`Invalid job_id: ${raw}`);
    }
    return raw.trim();
  };

  server.tool(
    "debug_sleep_sync",
    "Diagnostic: sleep for ms then return. Use to reproduce client timeouts/ABORT on long tool calls.",
    { ms: z.number().int().min(0).max(600000) },
    async (params: any) => {
      const ms = parseDebugMs(params);
      await new Promise((r) => setTimeout(r, ms));
      return { content: [{ type: "text" as const, text: `slept ${ms}ms` }] };
    }
  );

  server.tool(
    "debug_sleep_auto",
    "Diagnostic: automatically choose sync vs async by latency budget. Returns job_id + status tool for long calls.",
    {
      ms: z.number().int().min(0).max(600000),
      sync_budget_ms: z.number().int().min(500).max(60000).optional(),
      force_async: z.boolean().optional(),
    },
    async (params: any) => {
      const ms = parseDebugMs(params);
      const syncBudgetMs = Number(params?.arguments?.sync_budget_ms ?? params?.sync_budget_ms ?? DEFAULT_SYNC_BUDGET_MS);
      const forceAsync = Boolean(params?.arguments?.force_async ?? params?.force_async ?? false);
      const mode = forceAsync ? "async" : classifyLatencyMode(ms, syncBudgetMs);

      if (mode === "sync") {
        await new Promise((r) => setTimeout(r, ms));
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              mode: "sync",
              status: "done",
              result: `slept ${ms}ms`,
              sync_budget_ms: syncBudgetMs,
            }),
          }],
        };
      }

      const jobId = randomUUID();
      debugJobs.set(jobId, { status: "running", startedAt: Date.now() });
      setTimeout(() => {
        const j = debugJobs.get(jobId);
        if (!j) return;
        j.status = "done";
        j.doneAt = Date.now();
        j.result = `slept ${ms}ms`;
        debugJobs.set(jobId, j);
      }, ms);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(asyncAcceptedResponse({
            job_id: jobId,
            status_tool: "debug_sleep_async_get",
            estimated_wait_ms: ms,
            sync_budget_ms: syncBudgetMs,
          })),
        }],
      };
    }
  );

  server.tool(
    "debug_sleep_async_start",
    "Diagnostic: start an async sleep job and return job_id immediately (pattern for avoiding client timeouts).",
    { ms: z.number().int().min(0).max(600000) },
    async (params: any) => {
      const ms = parseDebugMs(params);
      const jobId = randomUUID();
      debugJobs.set(jobId, { status: "running", startedAt: Date.now() });
      setTimeout(() => {
        const j = debugJobs.get(jobId);
        if (!j) return;
        j.status = "done";
        j.doneAt = Date.now();
        j.result = `slept ${ms}ms`;
        debugJobs.set(jobId, j);
      }, ms);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ job_id: jobId, status: "running", eta_ms: ms }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "debug_sleep_async_get",
    "Diagnostic: get status/result of async sleep job by job_id.",
    { job_id: z.string().min(1) },
    async (params: any) => {
      const job_id = parseDebugJobId(params);
      const j = debugJobs.get(job_id);
      if (!j) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ job_id, status: "missing" }) }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ job_id, ...j }, null, 2) }] };
    }
  );
  // ------------------------------------------------------


server.tool(
    "router_execute_command",
    "Execute command from inbox",
    {},
    async () => {
      await ensureSyncDir();
      
      try {
        const raw = await fs.readFile(INBOX_FILE, 'utf-8').catch(() => "");
        if (!raw.trim()) {
          return {
            content: [{ 
              type: "text" as const, 
              text: JSON.stringify({ 
                message: "No command to execute", 
                status: "idle" 
              })
            }]
          };
        }

        let job: any;
        try { 
          job = JSON.parse(raw); 
        } catch { 
          return {
            content: [{ 
              type: "text" as const, 
              text: JSON.stringify({ 
                message: "Invalid command format", 
                status: "error" 
              })
            }]
          };
        }

        // Normalize command envelopes written by older/newer protocol clients.
        // Supported:
        // 1) { id, command, ... }
        // 2) { command: "{\"id\":\"...\",\"command\":\"sync_status\"}" }
        // 3) { payload: { id, command, ... } }
        if (job && typeof job.payload === "object" && typeof job.payload.command === "string") {
          job = { ...job.payload, id: job.payload.id ?? job.id };
        }

        if (job && typeof job.command === "string") {
          const nested = job.command.trim();
          if (nested.startsWith("{") && nested.endsWith("}")) {
            try {
              const parsedNested = JSON.parse(nested);
              if (parsedNested && typeof parsedNested.command === "string") {
                job = {
                  ...parsedNested,
                  id: parsedNested.id ?? job.id,
                };
              }
            } catch {
              // keep original job as-is
            }
          }
        }

        if (job && !job.id && job.command) {
          job.id = `inbox-${Date.now()}`;
        }

        if (!job.command || !job.id) {
          return {
            content: [{ 
              type: "text" as const, 
              text: JSON.stringify({ 
                message: "Invalid job structure", 
                status: "error" 
              })
            }]
          };
        }

        // Clear inbox
        await fs.writeFile(INBOX_FILE, JSON.stringify({ command: null, timestamp: null }), 'utf-8');

        // Execute based on command type
        let result;
        if (job.command === 'exec') {
          // Simple exec implementation
          const { cmd, args = [], cwd } = job;
          result = { 
            success: true, 
            stdout: `Executed ${cmd} ${args.join(' ')}`,
            stderr: "",
            exit_code: 0 
          };
        } else if (job.command === "sync_outbound_once") {
          result = await runSyncOutboundOnce(job.batch_size);
        } else if (job.command === "sync_inbound_once") {
          result = await runSyncInboundOnce(job.batch_size);
        } else if (job.command === "sync_status") {
          result = await runSyncStatus();
        } else if (job.command === "sync_reconcile") {
          result = await runSyncReconcile();
        } else if (job.command === "enqueue_inbound_response_id") {
          if (!job.conversation_id || !job.response_id) {
            result = {
              success: false,
              error: "enqueue_inbound_response_id requires conversation_id and response_id",
            };
          } else {
            result = await runEnqueueInboundResponseId(
              String(job.conversation_id),
              String(job.response_id),
              job.dedupe_key ? String(job.dedupe_key) : undefined
            );
          }
        } else if (job.command === "experiment_create") {
          if (!job.name) {
            result = { success: false, error: "experiment_create requires name" };
          } else {
            const objectiveInput = (job.objective == null || (typeof job.objective === "string" && !job.objective.trim()))
              ? "maximize score"
              : job.objective;
            const strategyInput = typeof job.search_strategy === "string"
              ? job.search_strategy
              : (typeof (job as any).strategy === "string" ? (job as any).strategy : undefined);
            result = await experimentCreate({
              syncDir: SYNC_DIR,
              experiment_id: typeof job.experiment_id === "string" ? job.experiment_id : undefined,
              name: String(job.name),
              objective: objectiveInput,
              metric_schema: (job.metric_schema && typeof job.metric_schema === "object") ? job.metric_schema : undefined,
              search_space: (job.search_space && typeof job.search_space === "object") ? job.search_space : undefined,
              search_strategy: strategyInput,
              strategy: strategyInput,
              metadata: (job.metadata && typeof job.metadata === "object") ? job.metadata : undefined,
            });
          }
        } else if (job.command === "experiment_run") {
          if (!job.experiment_id || !job.params || typeof job.params !== "object") {
            result = { success: false, error: "experiment_run requires experiment_id and params" };
          } else {
            let taskId: string | null = null;
            if (typeof job.exec_command === "string" && job.exec_command.trim()) {
              const runLabel = typeof job.run_id === "string" ? job.run_id : `run-${Date.now()}`;
              const template = String(job.exec_command);
              const rendered = template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_m: string, key: string) => {
                const val = (job.params as any)[key];
                return val == null ? "" : String(val);
              });
              const taskCreated = await taskCreate({
                syncDir: SYNC_DIR,
                role: "research",
                title: `exec: ${rendered}`,
                description: `Experiment run ${runLabel} for ${String(job.experiment_id)}`,
                status: "open",
              });
              taskId = taskCreated.task.task_id;
            }

            result = await experimentRun({
              syncDir: SYNC_DIR,
              experiment_id: String(job.experiment_id),
              run_id: typeof job.run_id === "string" ? job.run_id : undefined,
              params: job.params,
              metrics: (job.metrics && typeof job.metrics === "object") ? job.metrics : undefined,
              status: typeof job.status === "string" ? job.status : undefined,
              duration_ms: typeof job.duration_ms === "number" ? Math.trunc(job.duration_ms) : undefined,
              task_id: taskId ?? (typeof job.task_id === "string" ? job.task_id : undefined),
              notes: typeof job.notes === "string" ? job.notes : undefined,
            });
          }
        } else if (job.command === "experiment_list") {
          result = await experimentList({
            syncDir: SYNC_DIR,
            status: typeof job.status === "string" ? job.status : undefined,
            limit: typeof job.limit === "number" ? Math.trunc(job.limit) : undefined,
          });
        } else if (job.command === "experiment_compare") {
          if (!job.experiment_id) {
            result = { success: false, error: "experiment_compare requires experiment_id" };
          } else {
            result = await experimentCompare({
              syncDir: SYNC_DIR,
              experiment_id: String(job.experiment_id),
            });
          }
        } else if (job.command === "experiment_leaderboard") {
          if (!job.experiment_id) {
            result = { success: false, error: "experiment_leaderboard requires experiment_id" };
          } else {
            result = await experimentLeaderboard({
              syncDir: SYNC_DIR,
              experiment_id: String(job.experiment_id),
              limit: typeof job.limit === "number" ? Math.trunc(job.limit) : undefined,
            });
          }
        } else if (job.command === "experiment_best") {
          if (!job.experiment_id) {
            result = { success: false, error: "experiment_best requires experiment_id" };
          } else {
            result = await experimentBest({
              syncDir: SYNC_DIR,
              experiment_id: String(job.experiment_id),
            });
          }
        } else if (job.command === "experiment_search_tick") {
          if (!job.experiment_id) {
            result = { success: false, error: "experiment_search_tick requires experiment_id" };
          } else {
            const search = await runExperimentSearchTickWithResearchProfile({
              experiment_id: String(job.experiment_id),
              batch_size: typeof job.batch_size === "number" ? Math.trunc(job.batch_size) : undefined,
            });
            const impact = await applyResearchImpactOnExperimentConverged({
              experiment_id: String(job.experiment_id),
              phase: (search as any).phase,
              stop_reason: (search as any).stop_reason ?? null,
            });
            result = impact ? { ...search, ...impact } : search;
          }
        } else if (job.command === "task_create") {
          result = await taskCreate({
            syncDir: SYNC_DIR,
            task_id: typeof job.task_id === "string" ? job.task_id : undefined,
            project_id: typeof job.project_id === "string" ? job.project_id : undefined,
            role: typeof job.role === "string" ? job.role : undefined,
            title: String(job.title ?? ""),
            description: typeof job.description === "string" ? job.description : undefined,
            status: typeof job.status === "string" ? job.status : undefined,
            depends_on: Array.isArray(job.depends_on) ? job.depends_on.map((x: any) => String(x)) : undefined,
            children: Array.isArray(job.children) ? job.children.map((x: any) => String(x)) : undefined,
            execution_policy:
              job.execution_policy && typeof job.execution_policy === "object"
                ? {
                    max_attempts:
                      typeof job.execution_policy.max_attempts === "number"
                        ? Math.trunc(job.execution_policy.max_attempts)
                        : undefined,
                    retry_delay_ms:
                      typeof job.execution_policy.retry_delay_ms === "number"
                        ? Math.trunc(job.execution_policy.retry_delay_ms)
                        : undefined,
                    backoff_multiplier:
                      typeof job.execution_policy.backoff_multiplier === "number"
                        ? job.execution_policy.backoff_multiplier
                        : undefined,
                  }
                : undefined,
          });
        } else if (job.command === "task_link") {
          if (!job.task_id) {
            result = { success: false, error: "task_link requires task_id" };
          } else {
            result = await taskLink({
              syncDir: SYNC_DIR,
              task_id: String(job.task_id),
              depends_on: Array.isArray(job.depends_on) ? job.depends_on.map((x: any) => String(x)) : undefined,
              children: Array.isArray(job.children) ? job.children.map((x: any) => String(x)) : undefined,
            });
          }
        } else if (job.command === "task_graph") {
          result = await taskGraph({
            syncDir: SYNC_DIR,
            project_id: typeof job.project_id === "string" ? job.project_id : undefined,
          });
        } else if (job.command === "task_plan_generate") {
          if (!job.goal) {
            result = { success: false, error: "task_plan_generate requires goal" };
          } else {
            result = await taskPlanGenerate({
              syncDir: SYNC_DIR,
              goal: String(job.goal),
              project_id: typeof job.project_id === "string" ? job.project_id : undefined,
              max_tasks:
                typeof job.max_tasks === "number" && Number.isFinite(job.max_tasks)
                  ? Math.trunc(job.max_tasks)
                  : undefined,
            });
          }
        } else if (job.command === "task_status_update") {
          if (!job.task_id || !job.status) {
            result = { success: false, error: "task_status_update requires task_id and status" };
          } else {
            const allowedTaskStatuses = new Set(["open", "in_progress", "blocked", "done", "canceled"]);
            if (!allowedTaskStatuses.has(String(job.status))) {
              result = { success: false, error: "task_status_update status must be one of: open, in_progress, blocked, done, canceled" };
            } else {
            result = await taskStatusUpdate({
              syncDir: SYNC_DIR,
              task_id: String(job.task_id),
              status: String(job.status) as any,
            });
            }
          }
        } else if (job.command === "orchestrator_tick") {
          result = await orchestratorTick({
            syncDir: SYNC_DIR,
            project_id: typeof job.project_id === "string" ? job.project_id : undefined,
            limit:
              typeof job.limit === "number" && Number.isFinite(job.limit)
                ? Math.trunc(job.limit)
                : undefined,
          });
        } else if (job.command === "execution_bind_tick") {
          result = await runExecutionBindTick(
            typeof job.project_id === "string" ? job.project_id : undefined,
            typeof job.limit === "number" && Number.isFinite(job.limit) ? Math.trunc(job.limit) : undefined
          );
        } else if (job.command === "recovery_tick") {
          result = await runRecoveryTick(
            typeof job.project_id === "string" ? job.project_id : undefined,
            typeof job.limit === "number" && Number.isFinite(job.limit) ? Math.trunc(job.limit) : undefined
          );
        } else if (job.command === "governance_get") {
          result = await governanceGet(SYNC_DIR);
        } else if (job.command === "governance_set") {
          const patch = (job.patch && typeof job.patch === "object") ? job.patch : job;
          result = await governanceSet(SYNC_DIR, patch);
        } else if (job.command === "arena_governance_get") {
          result = await researchMemoryArenaGovernanceGet({
            syncDir: SYNC_DIR,
          });
        } else if (job.command === "arena_governance_set") {
          const patch = (job.patch && typeof job.patch === "object") ? job.patch : job;
          result = await researchMemoryArenaGovernanceSet({
            syncDir: SYNC_DIR,
            patch,
            domain_signature: typeof job.domain_signature === "string" ? job.domain_signature : undefined,
          });
          await eventPublish({
            syncDir: SYNC_DIR,
            type: "arena.governance.updated",
            source: "router_execute_command",
            data: {
              domain_signature: typeof job.domain_signature === "string" ? job.domain_signature : null,
              patch,
              updated_count: Number((result as any)?.updated_count ?? 0),
            },
          });
        } else if (job.command === "arena_telemetry_snapshot") {
          result = await arenaTelemetrySnapshot({
            syncDir: SYNC_DIR,
            limit_domains: typeof job.limit_domains === "number" ? Math.trunc(job.limit_domains) : undefined,
          });
        } else if (job.command === "mutation_effectiveness_snapshot") {
          result = await mutationEffectivenessSnapshot({
            syncDir: SYNC_DIR,
          });
        } else if (job.command === "transfer_diagnostics") {
          result = await transferDiagnosticsSnapshot({
            syncDir: SYNC_DIR,
          });
        } else if (job.command === "intelligence_health_snapshot") {
          result = await intelligenceHealthSnapshot({
            syncDir: SYNC_DIR,
          });
        } else if (job.command === "intelligence_meta_snapshot") {
          result = await intelligenceMetaSnapshot({
            syncDir: SYNC_DIR,
            mutation_window: typeof job.mutation_window === "number" ? Math.trunc(job.mutation_window) : undefined,
            transfer_window: typeof job.transfer_window === "number" ? Math.trunc(job.transfer_window) : undefined,
            gihi_window: typeof job.gihi_window === "number" ? Math.trunc(job.gihi_window) : undefined,
            campaign_id: typeof job.campaign_id === "string" ? job.campaign_id : undefined,
          });
        } else if (job.command === "meta_governance_tick") {
          result = await runMetaGovernanceTick({
            mutation_window: typeof job.mutation_window === "number" ? Math.trunc(job.mutation_window) : undefined,
            transfer_window: typeof job.transfer_window === "number" ? Math.trunc(job.transfer_window) : undefined,
            gihi_window: typeof job.gihi_window === "number" ? Math.trunc(job.gihi_window) : undefined,
            campaign_id: typeof job.campaign_id === "string" ? job.campaign_id : undefined,
            apply_all_running: typeof job.apply_all_running === "boolean" ? job.apply_all_running : undefined,
            meta_governance_cooldown_ms: typeof job.meta_governance_cooldown_ms === "number" ? Math.trunc(job.meta_governance_cooldown_ms) : undefined,
            min_state_streak: typeof job.min_state_streak === "number" ? Math.trunc(job.min_state_streak) : undefined,
            scoped_campaign_only: typeof job.scoped_campaign_only === "boolean" ? job.scoped_campaign_only : undefined,
            dry_run: typeof job.dry_run === "boolean" ? job.dry_run : undefined,
          });
        } else if (job.command === "governance_tuner_tick") {
          result = await runGovernanceTunerTick({
            dry_run: typeof job.dry_run === "boolean" ? job.dry_run : undefined,
            cooldown_ms: typeof job.cooldown_ms === "number" ? Math.trunc(job.cooldown_ms) : undefined,
            min_state_streak: typeof job.min_state_streak === "number" ? Math.trunc(job.min_state_streak) : undefined,
            max_changes: typeof job.max_changes === "number" ? Math.trunc(job.max_changes) : undefined,
            transfer_window: typeof job.transfer_window === "number" ? Math.trunc(job.transfer_window) : undefined,
            mutation_window: typeof job.mutation_window === "number" ? Math.trunc(job.mutation_window) : undefined,
            gihi_window: typeof job.gihi_window === "number" ? Math.trunc(job.gihi_window) : undefined,
          });
        } else if (job.command === "governance_threshold_tuner_tick") {
          result = await runGovernanceThresholdTunerTick({
            dry_run: typeof job.dry_run === "boolean" ? job.dry_run : undefined,
            cooldown_ms: typeof job.cooldown_ms === "number" ? Math.trunc(job.cooldown_ms) : undefined,
            min_state_streak: typeof job.min_state_streak === "number" ? Math.trunc(job.min_state_streak) : undefined,
            max_changes: typeof job.max_changes === "number" ? Math.trunc(job.max_changes) : undefined,
            ttl_ticks: typeof job.ttl_ticks === "number" ? Math.trunc(job.ttl_ticks) : undefined,
            transfer_window: typeof job.transfer_window === "number" ? Math.trunc(job.transfer_window) : undefined,
            mutation_window: typeof job.mutation_window === "number" ? Math.trunc(job.mutation_window) : undefined,
            gihi_window: typeof job.gihi_window === "number" ? Math.trunc(job.gihi_window) : undefined,
          });
        } else if (job.command === "research_agenda_tick") {
          result = await runResearchAgendaTick({
            project_id: typeof job.project_id === "string" ? job.project_id : undefined,
            campaign_id: typeof job.campaign_id === "string" ? job.campaign_id : undefined,
            top_domains: typeof job.top_domains === "number" ? Math.trunc(job.top_domains) : undefined,
            transfer_window: typeof job.transfer_window === "number" ? Math.trunc(job.transfer_window) : undefined,
            mutation_window: typeof job.mutation_window === "number" ? Math.trunc(job.mutation_window) : undefined,
            gihi_window: typeof job.gihi_window === "number" ? Math.trunc(job.gihi_window) : undefined,
            publish_only: typeof job.publish_only === "boolean" ? job.publish_only : undefined,
            dry_run: typeof job.dry_run === "boolean" ? job.dry_run : undefined,
            batch_size: typeof job.batch_size === "number" ? Math.trunc(job.batch_size) : undefined,
          });
        } else if (job.command === "patch_proposal_tick") {
          result = await runPatchProposalTick({
            project_id: typeof job.project_id === "string" ? job.project_id : undefined,
            top_domains: typeof job.top_domains === "number" ? Math.trunc(job.top_domains) : undefined,
            transfer_window: typeof job.transfer_window === "number" ? Math.trunc(job.transfer_window) : undefined,
            mutation_window: typeof job.mutation_window === "number" ? Math.trunc(job.mutation_window) : undefined,
            gihi_window: typeof job.gihi_window === "number" ? Math.trunc(job.gihi_window) : undefined,
            publish_only: typeof job.publish_only === "boolean" ? job.publish_only : undefined,
            dry_run: typeof job.dry_run === "boolean" ? job.dry_run : undefined,
            batch_size: typeof job.batch_size === "number" ? Math.trunc(job.batch_size) : undefined,
          });
        } else if (job.command === "patch_test_tick") {
          result = await runPatchTestTick({
            limit: typeof job.limit === "number" ? Math.trunc(job.limit) : undefined,
            timeout_ms: typeof job.timeout_ms === "number" ? Math.trunc(job.timeout_ms) : undefined,
            max_commands: typeof job.max_commands === "number" ? Math.trunc(job.max_commands) : undefined,
          });
        } else if (job.command === "patch_governance_tick") {
          result = await runPatchGovernanceTick({
            dry_run: typeof job.dry_run === "boolean" ? job.dry_run : undefined,
            limit: typeof job.limit === "number" ? Math.trunc(job.limit) : undefined,
            auto_activate: typeof job.auto_activate === "boolean" ? job.auto_activate : undefined,
            auto_apply_repo: typeof job.auto_apply_repo === "boolean" ? job.auto_apply_repo : undefined,
            auto_commit_repo: typeof job.auto_commit_repo === "boolean" ? job.auto_commit_repo : undefined,
            timeout_ms: typeof job.timeout_ms === "number" ? Math.trunc(job.timeout_ms) : undefined,
            max_commands: typeof job.max_commands === "number" ? Math.trunc(job.max_commands) : undefined,
          });
        } else if (job.command === "lineage_snapshot") {
          result = await lineageSnapshot({
            syncDir: SYNC_DIR,
            role: typeof job.role === "string" ? job.role as AgentRole : undefined,
            limit: typeof job.limit === "number" ? Math.trunc(job.limit) : undefined,
          });
        } else if (job.command === "campaign_create") {
          if (!job.goal) {
            result = { success: false, error: "campaign_create requires goal" };
          } else {
            const objectiveInput = (job.objective == null || (typeof job.objective === "string" && !job.objective.trim()))
              ? "maximize score"
              : job.objective;
            result = await campaignCreate({
              syncDir: SYNC_DIR,
              campaign_id: typeof job.campaign_id === "string" ? job.campaign_id : undefined,
              goal: String(job.goal),
              objective: objectiveInput,
              constraints: (job.constraints && typeof job.constraints === "object") ? job.constraints : undefined,
              max_experiments: typeof job.max_experiments === "number" ? Math.trunc(job.max_experiments) : undefined,
              stop_conditions: (job.stop_conditions && typeof job.stop_conditions === "object")
                ? job.stop_conditions
                : undefined,
            });
          }
        } else if (job.command === "campaign_tick") {
          if (!job.campaign_id) {
            result = { success: false, error: "campaign_tick requires campaign_id" };
          } else {
            try {
              result = await runCampaignTick({
                campaign_id: String(job.campaign_id),
                max_steps: typeof job.max_steps === "number" ? Math.trunc(job.max_steps) : undefined,
                retry_count: typeof job.retry_count === "number" ? Math.trunc(job.retry_count) : undefined,
              });
            } catch (e: any) {
                const msg = String(e?.message ?? e);
                if (isLockBusyErrorMessage(msg)) {
                  const retryCount = Math.max(0, Math.trunc(Number(job.retry_count ?? 0)));
                  const nextRetryCount = retryCount + 1;
                  const requeued = await enqueueCampaignRetryWithCoalescing({
                    campaign_id: String(job.campaign_id),
                    max_steps: typeof job.max_steps === "number" ? Math.trunc(job.max_steps) : undefined,
                    source: "campaign-retry",
                    retry_count: nextRetryCount,
                    not_before_ts: computeRetryNotBeforeTs(nextRetryCount),
                });
                result = {
                  success: false,
                  retryable: true,
                  retry_count: nextRetryCount,
                  requeued,
                  error: msg,
                };
              } else {
                throw e;
              }
            }
          }
        } else if (job.command === "campaign_report_generate") {
          if (!job.campaign_id) {
            result = { success: false, error: "campaign_report_generate requires campaign_id" };
          } else {
            const snapshot = await buildCampaignSnapshot(await campaignGet({
              syncDir: SYNC_DIR,
              campaign_id: String(job.campaign_id),
            }).then((x) => x.campaign));
            result = await campaignReportGenerate({
              syncDir: SYNC_DIR,
              campaign_id: String(job.campaign_id),
              snapshot,
            });
          }
        } else if (job.command === "campaign_list") {
          result = await campaignList({
            syncDir: SYNC_DIR,
            status: typeof job.status === "string" ? job.status as any : undefined,
            limit: typeof job.limit === "number" ? Math.trunc(job.limit) : undefined,
          });
        } else if (job.command === "agent_registry") {
          const role = typeof job.role === "string" ? job.role as AgentRole : undefined;
          result = await agentRegistryList(SYNC_DIR, role);
        } else if (job.command === "agent_metrics_snapshot") {
          const role = typeof job.role === "string" ? job.role as AgentRole : undefined;
          result = await agentMetricsSnapshot(SYNC_DIR, role);
        } else if (job.command === "agent_version_create") {
          if (!job.role) {
            result = { success: false, error: "agent_version_create requires role" };
          } else {
            result = await agentVersionCreate({
              syncDir: SYNC_DIR,
              role: String(job.role) as AgentRole,
              model: typeof job.model === "string" ? job.model : undefined,
              temperature: typeof job.temperature === "number" ? job.temperature : undefined,
              system_prompt: typeof job.system_prompt === "string" ? job.system_prompt : undefined,
              activate: typeof job.activate === "boolean" ? job.activate : undefined,
              parent_version: typeof job.parent_version === "number" ? Math.trunc(job.parent_version) : undefined,
            });
          }
        } else if (job.command === "agent_version_activate") {
          if (!job.role || typeof job.version !== "number") {
            result = { success: false, error: "agent_version_activate requires role and version" };
          } else {
            result = await agentVersionActivate({
              syncDir: SYNC_DIR,
              role: String(job.role) as AgentRole,
              version: Math.trunc(job.version),
            });
          }
        } else if (job.command === "evolution_tick") {
          const role = typeof job.role === "string" ? job.role as AgentRole : undefined;
          result = await agentEvolutionTick({
            syncDir: SYNC_DIR,
            role,
            min_runs: typeof job.min_runs === "number" ? Math.trunc(job.min_runs) : undefined,
            failure_rate_gt: typeof job.failure_rate_gt === "number" ? job.failure_rate_gt : undefined,
            critic_score_lt: typeof job.critic_score_lt === "number" ? job.critic_score_lt : undefined,
            avg_completion_time_ms_gt:
              typeof job.avg_completion_time_ms_gt === "number" ? Math.trunc(job.avg_completion_time_ms_gt) : undefined,
            research_fitness_lt: typeof (job as any).research_fitness_lt === "number" ? (job as any).research_fitness_lt : undefined,
            stagnation_rate_gt: typeof (job as any).stagnation_rate_gt === "number" ? (job as any).stagnation_rate_gt : undefined,
            convergence_steps_gt: typeof (job as any).convergence_steps_gt === "number" ? (job as any).convergence_steps_gt : undefined,
            max_new_versions: typeof job.max_new_versions === "number" ? Math.trunc(job.max_new_versions) : undefined,
            shadow_mode: typeof job.shadow_mode === "boolean" ? job.shadow_mode : undefined,
          });
        } else if (job.command === "shadow_evaluation_tick") {
          result = await runShadowEvaluationTick({
            role: typeof job.role === "string" ? job.role as AgentRole : undefined,
            sample_size: typeof job.sample_size === "number" ? Math.trunc(job.sample_size) : undefined,
            promote_threshold: typeof job.promote_threshold === "number" ? job.promote_threshold : undefined,
            max_evaluations: typeof job.max_evaluations === "number" ? Math.trunc(job.max_evaluations) : undefined,
            discard_on_fail: typeof job.discard_on_fail === "boolean" ? job.discard_on_fail : undefined,
          });
        } else if (job.command === "agent_dispatch_tick") {
          result = await runAgentDispatchTick(
            typeof job.project_id === "string" ? job.project_id : undefined,
            typeof job.limit === "number" && Number.isFinite(job.limit) ? Math.trunc(job.limit) : undefined
          );
        } else {
          result = { 
            success: false, 
            error: `Unknown command: ${job.command}` 
          };
        }

        // Update status
        await fs.writeFile(STATUS_FILE, JSON.stringify({
          status: "done",
          last_command: job.id,
          last_run: new Date().toISOString(),
          error: null
        }, null, 2), 'utf-8');

        return {
          content: [{ 
            type: "text" as const, 
            text: JSON.stringify({
              status: "done",
              command_id: job.id,
              result
            })
          }]
        };
        
      } catch (error: any) {
        return {
          content: [{ 
            type: "text" as const, 
            text: JSON.stringify({ error: `Router failed: ${error.message}` })
          }],
          isError: true
        };
      }
    }
  );

  // Queue system tools
  server.tool(
    "fs_lock_acquire",
    "Acquire a lock with optional TTL",
    {
      name: z.string(),
      ttl_ms: z.number().optional().default(30000)
    },
    async ({ name, ttl_ms }) => {
      const result = await acquireLock({
        locksDir: path.join(SYNC_DIR, 'queue', 'locks'),
        name,
        ttl_ms
      });
      
      if (result.ok) {
        return {
          content: [{ 
            type: "text" as const, 
            text: JSON.stringify({
              ok: true,
              token: result.token,
              expires_at: result.expires_at
            })
          }]
        };
      } else {
        return {
          content: [{ 
            type: "text" as const, 
            text: JSON.stringify({
              ok: false,
              reason: result.reason,
              expires_at: result.expires_at
            })
          }]
        };
      }
    }
  );

  server.tool(
    "fs_lock_release",
    "Release a lock with token",
    {
      name: z.string(),
      token: z.string()
    },
    async ({ name, token }) => {
      const result = await releaseLock({
        locksDir: path.join(SYNC_DIR, 'queue', 'locks'),
        name,
        token
      });
      
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify(result)
        }]
      };
    }
  );

  server.tool(
    "queue_push",
    "Push a job to queue",
    {
      type: z.enum(["exec", "project_task", "custom"]),
      payload: z.any(),
      priority: z.number().optional().default(0),
      job_id: z.string().optional(),
      logical_queue: z.string().optional(),
    },
    async ({ type, payload, priority, job_id, logical_queue }) => {
      const result = await queuePush({
        syncDir: SYNC_DIR,
        type,
        payload,
        priority,
        job_id,
        logical_queue,
        source: 'windsurf'
      });
      
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify(result)
        }]
      };
    }
  );

  server.tool(
    "queue_pop",
    "Pop/claim a job from queue with lease",
    {
      worker: z.string().optional().default("windsurf"),
      max_lease_ms: z.number().optional().default(60000),
      logical_queue: z.union([z.string(), z.array(z.string())]).optional(),
    },
    async ({ worker, max_lease_ms, logical_queue }) => {
      const result = await queuePop({
        syncDir: SYNC_DIR,
        worker,
        max_lease_ms,
        logical_queue,
      });
      
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify(result)
        }]
      };
    }
  );

  server.tool(
    "queue_ack",
    "Acknowledge job completion with status and artifacts",
    {
      job_id: z.string(),
      lease_token: z.string(),
      status: z.enum(["done", "error", "canceled"]),
      result: z.any().optional(),
      report_md: z.string().optional(),
      logs: z.string().optional()
    },
    async ({ job_id, lease_token, status, result, report_md, logs }) => {
      const ackResult = await queueAck({
        syncDir: SYNC_DIR,
        job_id,
        lease_token,
        status,
        result,
        report_md,
        logs
      });
      
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify(ackResult)
        }]
      };
    }
  );

  server.tool(
    "job_history_list",
    "List job history with status and artifacts",
    {
      limit: z.number().optional().default(50),
      status: z.enum(["pending", "running", "done", "error", "canceled"]).optional(),
      logical_queue: z.string().optional(),
    },
    async ({ limit, status, logical_queue }) => {
      const result = await jobHistoryList({
        syncDir: SYNC_DIR,
        limit,
        status,
        logical_queue,
      });
      
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify(result)
        }]
      };
    }
  );

  // Internal exec function for queue router
  async function runExecInternal(payload: any) {
    const { cmd, cwd, timeout_ms = 120000 } = payload;
    const args = normalizeNodeEArgs(String(cmd), Array.isArray(payload?.args) ? payload.args : []);
    
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const useShell = process.platform === "win32" && /\.cmd$/i.test(String(cmd));
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cmd, args, {
          cwd: cwd || undefined,
          shell: useShell,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (e: any) {
        resolve({
          success: false,
          exit_code: -2,
          duration_ms: Date.now() - startedAt,
          stdout: "",
          stderr: String(e?.message ?? e),
        });
        return;
      }
      
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: any) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      
      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
      child.on("error", (err: any) => {
        clearTimeout(timeout);
        finish({
          success: false,
          exit_code: -2,
          duration_ms: Date.now() - startedAt,
          stdout,
          stderr: `${stderr}${stderr ? "\n" : ""}${String(err?.message ?? err)}`,
        });
      });
      
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        finish({
          success: false,
          exit_code: -1,
          duration_ms: Date.now() - startedAt,
          stdout,
          stderr: 'Command timed out'
        });
      }, timeout_ms);
      
      child.on('close', (code) => {
        clearTimeout(timeout);
        finish({
          success: code === 0,
          exit_code: code || 0,
          duration_ms: Date.now() - startedAt,
          stdout,
          stderr
        });
      });
    });
  }

  // Real project task handler
  async function handleProjectTask(payload: any) {
    const verifySweClaims = async (claimsInput: any[]): Promise<{ ok: boolean; total: number; passed: number; failed: number; results: SweGuardClaimResult[] }> => {
      const claims = Array.isArray(claimsInput) ? claimsInput : [];
      const results: SweGuardClaimResult[] = [];
      for (const raw of claims) {
        const claim = parseSweGuardClaim(raw);
        if (!claim) {
          results.push({ ok: false, type: String(raw?.type ?? "unknown"), claim: raw, error: "invalid_claim" });
          continue;
        }
        try {
          if (claim.type === "file_exists") {
            try {
              await fs.access(claim.path);
              results.push({ ok: true, type: claim.type, claim, evidence: { path: claim.path, exists: true } });
            } catch {
              results.push({ ok: false, type: claim.type, claim, error: "file_not_found" });
            }
            continue;
          }

          if (claim.type === "file_contains") {
            const content = await fs.readFile(claim.path, "utf8");
            let matched = false;
            if (typeof claim.substring === "string" && claim.substring.length > 0) {
              matched = content.includes(claim.substring);
            } else if (typeof claim.regex === "string" && claim.regex.length > 0) {
              const re = new RegExp(claim.regex, claim.flags ?? "");
              matched = re.test(content);
            }
            results.push({
              ok: matched,
              type: claim.type,
              claim,
              evidence: { path: claim.path, matched },
              error: matched ? undefined : "pattern_not_found",
            });
            continue;
          }

          if (claim.type === "command_succeeds") {
            const parsed = parseExecCommand(`exec:${claim.cmd}`);
            if (!parsed) {
              results.push({ ok: false, type: claim.type, claim, error: "invalid_command" });
              continue;
            }
            const execResult: any = await runExecInternal({
              cmd: parsed.cmd,
              args: parsed.args,
              cwd: claim.cwd ?? process.cwd(),
              timeout_ms: claim.timeout_ms ?? 60_000,
            });
            const ok = Boolean(execResult?.success === true);
            results.push({
              ok,
              type: claim.type,
              claim,
              evidence: {
                exit_code: Number(execResult?.exit_code ?? -1),
                stdout_tail: String(execResult?.stdout ?? "").slice(-400),
                stderr_tail: String(execResult?.stderr ?? "").slice(-400),
              },
              error: ok ? undefined : "command_failed",
            });
            continue;
          }

          if (claim.type === "job_done") {
            const list = await jobHistoryList({
              syncDir: SYNC_DIR,
              logical_queue: claim.logical_queue,
              status: "done",
              limit: 20000,
            });
            let matched: any = null;
            if (claim.job_id) {
              matched = list.items.find((j: any) => String(j?.job_id ?? "") === claim.job_id);
            } else {
              matched = list.items.find((j: any) =>
                (!claim.source || String(j?.source ?? "") === claim.source) &&
                (!claim.logical_queue || String(j?.logical_queue ?? "") === claim.logical_queue)
              );
            }
            results.push({
              ok: Boolean(matched),
              type: claim.type,
              claim,
              evidence: matched
                ? {
                    job_id: matched.job_id,
                    status: matched.status,
                    logical_queue: matched.logical_queue,
                    source: matched.source,
                    result_ref: matched.result_ref ?? null,
                  }
                : null,
              error: matched ? undefined : "job_not_done",
            });
            continue;
          }

          if (claim.type === "metrics_at_least") {
            const snap = await agentMetricsSnapshot(SYNC_DIR, claim.role);
            const candidate = (claim.version != null)
              ? snap.items.find((x: any) => Number(x?.version) === Number(claim.version))
              : snap.items.find((x: any) => Boolean(x?.active)) ?? snap.items[0];
            if (!candidate) {
              results.push({ ok: false, type: claim.type, claim, error: "metrics_not_found" });
              continue;
            }
            const runs = Number(candidate?.metrics?.runs_count ?? 0);
            const successCount = Number(candidate?.metrics?.success_count ?? 0);
            const failureCount = Number(candidate?.metrics?.failure_count ?? 0);
            const denom = Math.max(1, successCount + failureCount);
            const successRate = successCount / denom;
            const critic = Number(candidate?.metrics?.critic_score ?? 0);
            const ok = (
              (claim.runs_count == null || runs >= claim.runs_count) &&
              (claim.success_rate == null || successRate >= claim.success_rate) &&
              (claim.critic_score == null || critic >= claim.critic_score)
            );
            results.push({
              ok,
              type: claim.type,
              claim,
              evidence: {
                role: candidate.role,
                version: candidate.version,
                runs_count: runs,
                success_rate: Number(successRate.toFixed(4)),
                critic_score: critic,
              },
              error: ok ? undefined : "metrics_below_threshold",
            });
            continue;
          }

          if (claim.type === "task_status") {
            const t = await tasksGet({ syncDir: SYNC_DIR, id: claim.task_id });
            const status = String((t as any)?.task?.status ?? "");
            const ok = status === claim.status;
            results.push({
              ok,
              type: claim.type,
              claim,
              evidence: { task_id: claim.task_id, status },
              error: ok ? undefined : "task_status_mismatch",
            });
            continue;
          }

          results.push({ ok: false, type: (claim as any).type, claim, error: "unsupported_claim_type" });
        } catch (e: any) {
          results.push({
            ok: false,
            type: (claim as any).type,
            claim,
            error: `claim_check_error:${String(e?.message ?? e)}`,
          });
        }
      }
      const passed = results.filter((r) => r.ok).length;
      const failed = results.length - passed;
      return { ok: failed === 0, total: results.length, passed, failed, results };
    };
    let normalizedPayload: any = payload;
    if (typeof payload === "string") {
      const trimmed = payload.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          normalizedPayload = JSON.parse(trimmed);
        } catch {
          normalizedPayload = payload;
        }
      }
    }
    // Backward/forward compatible payload contract for queued project_task jobs.
    // Supports:
    // 1) { task: "...", ... }
    // 2) { command: "...", args: { ... } }
    // 3) { type: "...", input: { ... } }
    const base = (normalizedPayload && typeof normalizedPayload === "object") ? normalizedPayload : {};
    const nestedArgs = (base.args && typeof base.args === "object") ? base.args : {};
    const nestedInput = (base.input && typeof base.input === "object") ? base.input : {};
    const merged = { ...base, ...nestedInput, ...nestedArgs };

    const task = String(merged.task ?? merged.command ?? merged.type ?? "").trim();
    const project_path = typeof merged.project_path === "string" ? merged.project_path : undefined;
    const spec_path = typeof merged.spec_path === "string" ? merged.spec_path : undefined;

    if (!task) {
      return {
        success: false,
        error: "Missing task/command/type in project_task payload",
        report_md: "# Invalid Project Task Payload\n\nExpected one of: `task`, `command`, `type`.",
        logs: `Invalid project_task payload: ${JSON.stringify(normalizedPayload)}`,
      };
    }

    if (task === "create_website") {
      if (!project_path) {
        return {
          success: false,
          task,
          error: "create_website requires project_path",
          report_md: "# Invalid Project Task Payload\n\n`create_website` requires `project_path`.",
          logs: `Missing project_path for task: ${task}`,
        };
      }
      const websitePath = `${project_path}/website`;
      
      // Create website directory
      await fs.mkdir(websitePath, { recursive: true });
      
      // Create index.html
      const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Generated Website</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .container { max-width: 800px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 40px; }
        .content { background: #f5f5f5; padding: 20px; border-radius: 8px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Generated Website</h1>
            <p>Created by MCP Project Task</p>
        </div>
        <div class="content">
            <h2>Welcome!</h2>
            <p>This website was automatically generated for project: ${project_path}</p>
            <p>Generated at: ${new Date().toISOString()}</p>
        </div>
    </div>
</body>
</html>`;
      
      await fs.writeFile(`${websitePath}/index.html`, indexHtml);
      
      // Create package.json
      const packageJson = {
        name: "generated-website",
        version: "1.0.0",
        description: "Website generated by MCP project task",
        scripts: {
          start: "npx serve ."
        },
        devDependencies: {
          serve: "^14.2.0"
        }
      };
      
      await fs.writeFile(`${websitePath}/package.json`, JSON.stringify(packageJson, null, 2));
      
      // Create README.md
      const readme = `# Generated Website

This website was automatically generated by MCP project task.

## Project Details
- **Task:** ${task}
- **Path:** ${project_path}
- **Generated:** ${new Date().toISOString()}

## How to Run
\`\`\`bash
cd website
npm install
npm start
\`\`\`

## Files Created
- \`index.html\` - Main HTML page
- \`package.json\` - Node.js project configuration
- \`README.md\` - This file
`;
      
      await fs.writeFile(`${websitePath}/README.md`, readme);
      
      return {
        success: true,
        task,
        project_path,
        website_path: websitePath,
        files_created: ["index.html", "package.json", "README.md"],
        report_md: `# Website Created Successfully\n\n**Task:** ${task}\n**Project Path:** ${project_path}\n**Website Path:** ${websitePath}\n\n## Files Created:\n- index.html\n- package.json\n- README.md\n\n## Next Steps:\n1. \`cd ${websitePath}\`\n2. \`npm install\`\n3. \`npm start\`\n`,
        logs: `Created website at ${websitePath} with 3 files`
      };
    }

    if (task === "task_create") {
      if (!merged.title) {
        return {
          success: false,
          task,
          error: "task_create requires title",
          report_md: "# Invalid Task Graph Payload\n\n`task_create` requires `title`.",
          logs: `Missing title for task_create payload: ${JSON.stringify(payload)}`,
        };
      }
      const result = await taskCreate({
        syncDir: SYNC_DIR,
        task_id: typeof merged.task_id === "string" ? merged.task_id : undefined,
        project_id: typeof merged.project_id === "string" ? merged.project_id : undefined,
        role: typeof merged.role === "string" ? merged.role as any : undefined,
        title: String(merged.title),
        description: typeof merged.description === "string" ? merged.description : undefined,
        status: typeof merged.status === "string" ? merged.status as any : undefined,
        depends_on: Array.isArray(merged.depends_on) ? merged.depends_on.map((x: any) => String(x)) : undefined,
        children: Array.isArray(merged.children) ? merged.children.map((x: any) => String(x)) : undefined,
        execution_policy:
          merged.execution_policy && typeof merged.execution_policy === "object"
            ? {
                max_attempts:
                  typeof merged.execution_policy.max_attempts === "number"
                    ? Math.trunc(merged.execution_policy.max_attempts)
                    : undefined,
                retry_delay_ms:
                  typeof merged.execution_policy.retry_delay_ms === "number"
                    ? Math.trunc(merged.execution_policy.retry_delay_ms)
                    : undefined,
                backoff_multiplier:
                  typeof merged.execution_policy.backoff_multiplier === "number"
                    ? merged.execution_policy.backoff_multiplier
                    : undefined,
              }
            : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Task Created\n\n**task:** ${task}\n\n**task_id:** ${result.task.task_id}\n`,
        logs: `Created task graph node: ${result.task.task_id}`,
      };
    }

    if (task === "agent_registry") {
      const role = typeof merged.role === "string" ? merged.role as AgentRole : undefined;
      const registry = await agentRegistryList(SYNC_DIR, role);
      return {
        success: true,
        task_name: task,
        ...registry,
        report_md: `# Agent Registry\n\n**profiles:** ${registry.items.length}\n`,
        logs: "agent_registry listed profiles",
      };
    }

    if (task === "agent_metrics_snapshot") {
      const role = typeof merged.role === "string" ? merged.role as AgentRole : undefined;
      const metrics = await agentMetricsSnapshot(SYNC_DIR, role);
      return {
        success: true,
        task_name: task,
        ...metrics,
        report_md: `# Agent Metrics\n\n**items:** ${metrics.items.length}\n`,
        logs: "agent_metrics_snapshot generated",
      };
    }

    if (task === "swe_guard_verify_claims" || task === "truth_gate") {
      const claims = Array.isArray(merged.claims) ? merged.claims : [];
      const checked = await verifySweClaims(claims);
      return {
        success: checked.ok,
        task_name: task,
        ...checked,
        report_md:
          `# SWE Guard Verify Claims\n\n` +
          `- total: ${checked.total}\n` +
          `- passed: ${checked.passed}\n` +
          `- failed: ${checked.failed}\n` +
          `- verdict: ${checked.ok ? "allow" : "block"}\n`,
        logs: `swe_guard claims total=${checked.total} passed=${checked.passed} failed=${checked.failed}`,
      };
    }

    if (task === "swe_truth_check") {
      const role = typeof merged.role === "string" ? merged.role as AgentRole : "dev";
      const versionRaw = Number(merged.version ?? NaN);
      const targetVersion = Number.isFinite(versionRaw) ? Math.trunc(versionRaw) : null;
      const metrics = await agentMetricsSnapshot(SYNC_DIR, role);
      const target = metrics.items.find((item: any) =>
        Number(item?.version) === Number(targetVersion) && String(item?.role) === String(role)
      );
      const active = metrics.items.find((item: any) => Boolean(item?.active));
      const selected = target ?? active ?? metrics.items[0] ?? null;

      const benchTasks = await tasksList({ syncDir: SYNC_DIR, limit: 5000, query: "benchmark" });
      const grouped = { todo: 0, doing: 0, done: 0, blocked: 0 };
      for (const t of (benchTasks.items ?? [])) {
        const st = String((t as any)?.status ?? "todo");
        if (st === "doing") grouped.doing += 1;
        else if (st === "done") grouped.done += 1;
        else if (st === "blocked") grouped.blocked += 1;
        else grouped.todo += 1;
      }

      const history = await jobHistoryList({ syncDir: SYNC_DIR, logical_queue: "meta", limit: 20000 });
      const shadowRetryPending = history.items.filter((j: any) =>
        String(j?.status) === "pending" && String(j?.job_id ?? "").startsWith("shadow-eval:retry:")
      ).length;
      const shadowRetryRunning = history.items.filter((j: any) =>
        String(j?.status) === "running" && String(j?.job_id ?? "").startsWith("shadow-eval:retry:")
      ).length;
      const metaDepth = await queueDepth({ syncDir: SYNC_DIR, logical_queue: "meta" });

      const runsCount = selected
        ? Number((selected as any)?.metrics?.runs_count ?? 0)
        : 0;
      const metricsKnown = runsCount > 0;
      const evidenceStatus = {
        metrics_known: metricsKnown,
        runs_count: runsCount,
        benchmark_tasks_done: grouped.done,
        benchmark_tasks_total: grouped.todo + grouped.doing + grouped.done + grouped.blocked,
      };
      const verdict = (
        evidenceStatus.metrics_known &&
        evidenceStatus.runs_count >= 5 &&
        evidenceStatus.benchmark_tasks_done >= 3 &&
        metaDepth.pending < 2000
      ) ? "validated" : "insufficient_evidence";

      const summary = {
        role,
        requested_version: targetVersion,
        selected_agent: selected
          ? {
              role: selected.role,
              version: selected.version,
              active: selected.active,
              runs_count: selected.metrics?.runs_count ?? 0,
              success_count: selected.metrics?.success_count ?? 0,
              failure_count: selected.metrics?.failure_count ?? 0,
              avg_completion_time_ms: selected.metrics?.avg_completion_time_ms ?? 0,
              critic_score: selected.metrics?.critic_score ?? 0,
            }
          : null,
        benchmark_tasks: grouped,
        meta_queue: {
          depth: metaDepth,
          shadow_eval_retry_pending: shadowRetryPending,
          shadow_eval_retry_running: shadowRetryRunning,
        },
        verdict,
      };

      return {
        success: true,
        task_name: task,
        ...summary,
        report_md: `# SWE Truth Check\n\n` +
          `- role: ${role}\n` +
          `- requested_version: ${targetVersion ?? "n/a"}\n` +
          `- selected_version: ${summary.selected_agent?.version ?? "n/a"}\n` +
          `- runs_count: ${summary.selected_agent?.runs_count ?? 0}\n` +
          `- success_count: ${summary.selected_agent?.success_count ?? 0}\n` +
          `- failure_count: ${summary.selected_agent?.failure_count ?? 0}\n` +
          `- benchmark_done: ${grouped.done}/${grouped.todo + grouped.doing + grouped.done + grouped.blocked}\n` +
          `- meta_pending: ${metaDepth.pending}\n` +
          `- shadow_eval_retry_pending: ${shadowRetryPending}\n` +
          `- verdict: ${verdict}\n`,
        logs: `swe_truth_check verdict=${verdict} role=${role} version=${targetVersion ?? "auto"}`,
      };
    }

    if (task === "agent_version_create") {
      if (!merged.role) {
        return {
          success: false,
          task,
          error: "agent_version_create requires role",
          report_md: "# Invalid Agent Version Payload\n\n`agent_version_create` requires `role`.",
          logs: `Invalid agent_version_create payload: ${JSON.stringify(payload)}`,
        };
      }
      const created = await agentVersionCreate({
        syncDir: SYNC_DIR,
        role: String(merged.role) as AgentRole,
        model: typeof merged.model === "string" ? merged.model : undefined,
        temperature: typeof merged.temperature === "number" ? merged.temperature : undefined,
        system_prompt: typeof merged.system_prompt === "string" ? merged.system_prompt : undefined,
        activate: typeof merged.activate === "boolean" ? merged.activate : undefined,
        parent_version: typeof merged.parent_version === "number" ? Math.trunc(merged.parent_version) : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...created,
        report_md: `# Agent Version Created\n\n**role:** ${created.agent.role}\n\n**version:** ${created.agent.version}\n`,
        logs: `agent_version_create created v${created.agent.version} for ${created.agent.role}`,
      };
    }

    if (task === "agent_version_activate") {
      if (!merged.role || typeof merged.version !== "number") {
        return {
          success: false,
          task,
          error: "agent_version_activate requires role and version",
          report_md: "# Invalid Agent Version Payload\n\n`agent_version_activate` requires `role` and `version`.",
          logs: `Invalid agent_version_activate payload: ${JSON.stringify(payload)}`,
        };
      }
      const activated = await agentVersionActivate({
        syncDir: SYNC_DIR,
        role: String(merged.role) as AgentRole,
        version: Math.trunc(merged.version),
      });
      return {
        success: true,
        task_name: task,
        ...activated,
        report_md: `# Agent Version Activated\n\n**role:** ${activated.agent.role}\n\n**version:** ${activated.agent.version}\n`,
        logs: `agent_version_activate activated v${activated.agent.version} for ${activated.agent.role}`,
      };
    }

    if (task === "evolution_tick") {
      const role = typeof merged.role === "string" ? merged.role as AgentRole : undefined;
      const evolved = await agentEvolutionTick({
        syncDir: SYNC_DIR,
        role,
        min_runs: typeof merged.min_runs === "number" ? Math.trunc(merged.min_runs) : undefined,
        failure_rate_gt: typeof merged.failure_rate_gt === "number" ? merged.failure_rate_gt : undefined,
        critic_score_lt: typeof merged.critic_score_lt === "number" ? merged.critic_score_lt : undefined,
        avg_completion_time_ms_gt:
          typeof merged.avg_completion_time_ms_gt === "number" ? Math.trunc(merged.avg_completion_time_ms_gt) : undefined,
        research_fitness_lt: typeof merged.research_fitness_lt === "number" ? merged.research_fitness_lt : undefined,
        stagnation_rate_gt: typeof merged.stagnation_rate_gt === "number" ? merged.stagnation_rate_gt : undefined,
        convergence_steps_gt: typeof merged.convergence_steps_gt === "number" ? merged.convergence_steps_gt : undefined,
        max_new_versions: typeof merged.max_new_versions === "number" ? Math.trunc(merged.max_new_versions) : undefined,
        shadow_mode: typeof merged.shadow_mode === "boolean" ? merged.shadow_mode : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...evolved,
        report_md: `# Evolution Tick\n\n**created:** ${evolved.created.length}\n\n**skipped:** ${evolved.skipped.length}\n`,
        logs: `evolution_tick created ${evolved.created.length} versions`,
      };
    }

    if (task === "shadow_evaluation_tick") {
      const evaluated = await runShadowEvaluationTick({
        role: typeof merged.role === "string" ? merged.role as AgentRole : undefined,
        sample_size: typeof merged.sample_size === "number" ? Math.trunc(merged.sample_size) : undefined,
        promote_threshold: typeof merged.promote_threshold === "number" ? merged.promote_threshold : undefined,
        max_evaluations: typeof merged.max_evaluations === "number" ? Math.trunc(merged.max_evaluations) : undefined,
        discard_on_fail: typeof merged.discard_on_fail === "boolean" ? merged.discard_on_fail : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...evaluated,
        report_md: `# Shadow Evaluation Tick\n\n**evaluated:** ${evaluated.evaluated}\n`,
        logs: `shadow_evaluation_tick evaluated ${evaluated.evaluated} shadow versions`,
      };
    }

    if (task === "task_link") {
      if (!merged.task_id) {
        return {
          success: false,
          task,
          error: "task_link requires task_id",
          report_md: "# Invalid Task Graph Payload\n\n`task_link` requires `task_id`.",
          logs: `Missing task_id for task_link payload: ${JSON.stringify(payload)}`,
        };
      }
      const result = await taskLink({
        syncDir: SYNC_DIR,
        task_id: String(merged.task_id),
        depends_on: Array.isArray(merged.depends_on) ? merged.depends_on.map((x: any) => String(x)) : undefined,
        children: Array.isArray(merged.children) ? merged.children.map((x: any) => String(x)) : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Task Linked\n\n**task_id:** ${result.task.task_id}\n`,
        logs: `Linked task graph node: ${result.task.task_id}`,
      };
    }

    if (task === "task_graph") {
      const result = await taskGraph({
        syncDir: SYNC_DIR,
        project_id: typeof merged.project_id === "string" ? merged.project_id : undefined,
      });
      return {
        success: true,
        task,
        ...result,
        report_md: `# Task Graph\n\n**items:** ${result.items.length}\n`,
        logs: `Fetched task graph (${result.items.length} items)`,
      };
    }

    if (task === "task_plan_generate") {
      if (!merged.goal) {
        return {
          success: false,
          task,
          error: "task_plan_generate requires goal",
          report_md: "# Invalid Task Graph Payload\n\n`task_plan_generate` requires `goal`.",
          logs: `Missing goal for task_plan_generate payload: ${JSON.stringify(payload)}`,
        };
      }
      const result = await taskPlanGenerate({
        syncDir: SYNC_DIR,
        goal: String(merged.goal),
        project_id: typeof merged.project_id === "string" ? merged.project_id : undefined,
        max_tasks:
          typeof merged.max_tasks === "number" && Number.isFinite(merged.max_tasks)
            ? Math.trunc(merged.max_tasks)
            : undefined,
      });
      return {
        success: true,
        task,
        ...result,
        report_md: `# Task Plan Generated\n\n**project_id:** ${result.project_id}\n\n**created:** ${result.created.length}\n`,
        logs: `Generated task plan with ${result.created.length} tasks`,
      };
    }

    if (task === "task_status_update") {
      if (!merged.task_id || !merged.status) {
        return {
          success: false,
          task,
          error: "task_status_update requires task_id and status",
          report_md: "# Invalid Task Graph Payload\n\n`task_status_update` requires `task_id` and `status`.",
          logs: `Missing task_id/status for task_status_update payload: ${JSON.stringify(payload)}`,
        };
      }
      const allowedTaskStatuses = new Set(["open", "in_progress", "blocked", "done", "canceled"]);
      if (!allowedTaskStatuses.has(String(merged.status))) {
        return {
          success: false,
          task,
          error: "status must be one of: open, in_progress, blocked, done, canceled",
          report_md: "# Invalid Task Graph Payload\n\nInvalid status value.",
          logs: `Invalid status for task_status_update payload: ${JSON.stringify(payload)}`,
        };
      }
      const result = await taskStatusUpdate({
        syncDir: SYNC_DIR,
        task_id: String(merged.task_id),
        status: String(merged.status) as any,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Task Status Updated\n\n**task_id:** ${result.task.task_id}\n\n**status:** ${result.task.status}\n`,
        logs: `Updated task status: ${result.task.task_id} -> ${result.task.status}`,
      };
    }

    if (task === "orchestrator_tick") {
      const result = await orchestratorTick({
        syncDir: SYNC_DIR,
        project_id: typeof merged.project_id === "string" ? merged.project_id : undefined,
        limit:
          typeof merged.limit === "number" && Number.isFinite(merged.limit)
            ? Math.trunc(merged.limit)
            : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Orchestrator Tick\n\n**activated:** ${result.activated.length}\n\n**remaining_open:** ${result.remaining_open}\n`,
        logs: `orchestrator_tick activated ${result.activated.length} tasks`,
      };
    }

    if (task === "execution_bind_tick") {
      const result = await runExecutionBindTick(
        typeof merged.project_id === "string" ? merged.project_id : undefined,
        typeof merged.limit === "number" && Number.isFinite(merged.limit)
          ? Math.trunc(merged.limit)
          : undefined
      );
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Execution Bind Tick\n\n**queued:** ${result.queued}\n\n**scanned:** ${result.scanned}\n`,
        logs: `execution_bind_tick queued ${result.queued} exec jobs`,
      };
    }

    if (task === "recovery_tick") {
      const result = await runRecoveryTick(
        typeof merged.project_id === "string" ? merged.project_id : undefined,
        typeof merged.limit === "number" && Number.isFinite(merged.limit)
          ? Math.trunc(merged.limit)
          : undefined
      );
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Recovery Tick\n\n**due_retry_count:** ${result.due_retry_count}\n\n**activated:** ${result.activated.length}\n`,
        logs: `recovery_tick activated ${result.activated.length} tasks`,
      };
    }

    if (task === "governance_get") {
      const result = await governanceGet(SYNC_DIR);
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: "# Governance\n\nReturned governance config.",
        logs: "governance_get returned config",
      };
    }

    if (task === "governance_set") {
      const patch = (merged.patch && typeof merged.patch === "object") ? merged.patch : merged;
      const result = await governanceSet(SYNC_DIR, patch);
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: "# Governance Updated\n\nApplied governance patch.",
        logs: "governance_set applied patch",
      };
    }

    if (task === "arena_governance_get") {
      const result = await researchMemoryArenaGovernanceGet({
        syncDir: SYNC_DIR,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Arena Governance\n\n**domains_count:** ${result.domains_count}\n`,
        logs: `arena_governance_get domains ${result.domains_count}`,
      };
    }

    if (task === "arena_governance_set") {
      const patch = (merged.patch && typeof merged.patch === "object") ? merged.patch : merged;
      const result = await researchMemoryArenaGovernanceSet({
        syncDir: SYNC_DIR,
        patch,
        domain_signature: typeof merged.domain_signature === "string" ? merged.domain_signature : undefined,
      });
      await eventPublish({
        syncDir: SYNC_DIR,
        type: "arena.governance.updated",
        source: "project_task",
        data: {
          domain_signature: typeof merged.domain_signature === "string" ? merged.domain_signature : null,
          patch,
          updated_count: result.updated_count,
        },
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: "# Arena Governance Updated\n\nApplied arena governance patch.",
        logs: `arena_governance_set updated ${result.updated_count} domains`,
      };
    }

    if (task === "agent_dispatch_tick") {
      const result = await runAgentDispatchTick(
        typeof merged.project_id === "string" ? merged.project_id : undefined,
        typeof merged.limit === "number" && Number.isFinite(merged.limit)
          ? Math.trunc(merged.limit)
          : undefined
      );
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Agent Dispatch Tick\n\n**queued:** ${result.queued}\n\n**scanned:** ${result.scanned}\n`,
        logs: `agent_dispatch_tick queued ${result.queued} agent jobs`,
      };
    }

    if (task === "arena_telemetry_snapshot") {
      const result = await arenaTelemetrySnapshot({
        syncDir: SYNC_DIR,
        limit_domains: typeof merged.limit_domains === "number" ? Math.trunc(merged.limit_domains) : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: result.report_md,
        logs: `arena_telemetry_snapshot scanned ${result.snapshot.domains_count} domains`,
      };
    }

    if (task === "mutation_effectiveness_snapshot") {
      const result = await mutationEffectivenessSnapshot({
        syncDir: SYNC_DIR,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: result.report_md,
        logs: `mutation_effectiveness_snapshot ratio ${result.snapshot.overall.mutation_effectiveness_ratio}`,
      };
    }

    if (task === "transfer_diagnostics") {
      const result = await transferDiagnosticsSnapshot({
        syncDir: SYNC_DIR,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: result.report_md,
        logs: `transfer_diagnostics success_rate ${result.snapshot.transfer_success_rate}`,
      };
    }

    if (task === "intelligence_health_snapshot") {
      const result = await intelligenceHealthSnapshot({
        syncDir: SYNC_DIR,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: result.report_md,
        logs: `intelligence_health_snapshot gihi ${result.snapshot.global_intelligence_health_index}`,
      };
    }

    if (task === "intelligence_meta_snapshot") {
      const result = await intelligenceMetaSnapshot({
        syncDir: SYNC_DIR,
        mutation_window: typeof merged.mutation_window === "number" ? Math.trunc(merged.mutation_window) : undefined,
        transfer_window: typeof merged.transfer_window === "number" ? Math.trunc(merged.transfer_window) : undefined,
        gihi_window: typeof merged.gihi_window === "number" ? Math.trunc(merged.gihi_window) : undefined,
        campaign_id: typeof merged.campaign_id === "string" ? merged.campaign_id : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: result.report_md,
        logs: `intelligence_meta_snapshot state ${result.snapshot.meta_state}`,
      };
    }

    if (task === "meta_governance_tick") {
      const result = await runMetaGovernanceTick({
        mutation_window: typeof merged.mutation_window === "number" ? Math.trunc(merged.mutation_window) : undefined,
        transfer_window: typeof merged.transfer_window === "number" ? Math.trunc(merged.transfer_window) : undefined,
        gihi_window: typeof merged.gihi_window === "number" ? Math.trunc(merged.gihi_window) : undefined,
        campaign_id: typeof merged.campaign_id === "string" ? merged.campaign_id : undefined,
        apply_all_running: typeof merged.apply_all_running === "boolean" ? merged.apply_all_running : undefined,
        meta_governance_cooldown_ms: typeof merged.meta_governance_cooldown_ms === "number" ? Math.trunc(merged.meta_governance_cooldown_ms) : undefined,
        min_state_streak: typeof merged.min_state_streak === "number" ? Math.trunc(merged.min_state_streak) : undefined,
        scoped_campaign_only: typeof merged.scoped_campaign_only === "boolean" ? merged.scoped_campaign_only : undefined,
        dry_run: typeof merged.dry_run === "boolean" ? merged.dry_run : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Meta Governance Tick\n\n- reasons: ${(result.reasons ?? []).join(", ") || "none"}\n- meta_state: ${result.meta_snapshot?.meta_state ?? "unknown"}\n`,
        logs: `meta_governance_tick reasons ${(result.reasons ?? []).length}`,
      };
    }

    if (task === "governance_tuner_tick") {
      const result = await runGovernanceTunerTick({
        dry_run: typeof merged.dry_run === "boolean" ? merged.dry_run : undefined,
        cooldown_ms: typeof merged.cooldown_ms === "number" ? Math.trunc(merged.cooldown_ms) : undefined,
        min_state_streak: typeof merged.min_state_streak === "number" ? Math.trunc(merged.min_state_streak) : undefined,
        max_changes: typeof merged.max_changes === "number" ? Math.trunc(merged.max_changes) : undefined,
        transfer_window: typeof merged.transfer_window === "number" ? Math.trunc(merged.transfer_window) : undefined,
        mutation_window: typeof merged.mutation_window === "number" ? Math.trunc(merged.mutation_window) : undefined,
        gihi_window: typeof merged.gihi_window === "number" ? Math.trunc(merged.gihi_window) : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Governance Tuner Tick\n\n- dry_run: ${Boolean(result.dry_run)}\n- reasons: ${(result.reasons ?? []).join(", ") || "none"}\n- proposals: ${Number((result.proposals ?? []).length)}\n- applied: ${Number((result.applied ?? []).length)}\n`,
        logs: `governance_tuner_tick proposals ${Number((result.proposals ?? []).length)} applied ${Number((result.applied ?? []).length)}`,
      };
    }

    if (task === "governance_threshold_tuner_tick") {
      const result = await runGovernanceThresholdTunerTick({
        dry_run: typeof merged.dry_run === "boolean" ? merged.dry_run : undefined,
        cooldown_ms: typeof merged.cooldown_ms === "number" ? Math.trunc(merged.cooldown_ms) : undefined,
        min_state_streak: typeof merged.min_state_streak === "number" ? Math.trunc(merged.min_state_streak) : undefined,
        max_changes: typeof merged.max_changes === "number" ? Math.trunc(merged.max_changes) : undefined,
        ttl_ticks: typeof merged.ttl_ticks === "number" ? Math.trunc(merged.ttl_ticks) : undefined,
        transfer_window: typeof merged.transfer_window === "number" ? Math.trunc(merged.transfer_window) : undefined,
        mutation_window: typeof merged.mutation_window === "number" ? Math.trunc(merged.mutation_window) : undefined,
        gihi_window: typeof merged.gihi_window === "number" ? Math.trunc(merged.gihi_window) : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Governance Threshold Tuner Tick\n\n- dry_run: ${Boolean(result.dry_run)}\n- reasons: ${(result.reasons ?? []).join(", ") || "none"}\n- proposals: ${Number((result.proposals ?? []).length)}\n- applied: ${Number((result.applied ?? []).length)}\n`,
        logs: `governance_threshold_tuner_tick proposals ${Number((result.proposals ?? []).length)} applied ${Number((result.applied ?? []).length)}`,
      };
    }

    if (task === "research_agenda_tick") {
      const result = await runResearchAgendaTick({
        project_id: typeof merged.project_id === "string" ? merged.project_id : undefined,
        campaign_id: typeof merged.campaign_id === "string" ? merged.campaign_id : undefined,
        top_domains: typeof merged.top_domains === "number" ? Math.trunc(merged.top_domains) : undefined,
        transfer_window: typeof merged.transfer_window === "number" ? Math.trunc(merged.transfer_window) : undefined,
        mutation_window: typeof merged.mutation_window === "number" ? Math.trunc(merged.mutation_window) : undefined,
        gihi_window: typeof merged.gihi_window === "number" ? Math.trunc(merged.gihi_window) : undefined,
        publish_only: typeof merged.publish_only === "boolean" ? merged.publish_only : undefined,
        dry_run: typeof merged.dry_run === "boolean" ? merged.dry_run : undefined,
        batch_size: typeof merged.batch_size === "number" ? Math.trunc(merged.batch_size) : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Research Agenda Tick\n\n- meta_state: ${result.summary?.meta_state ?? "unknown"}\n- arena_entropy: ${result.summary?.arena_entropy ?? "n/a"}\n- published: ${Boolean(result.published?.ok)}\n`,
        logs: `research_agenda_tick published ${Boolean(result.published?.ok)} sync_processed ${Number(result.sync_outbound?.processed ?? 0)}`,
      };
    }

    if (task === "patch_proposal_tick") {
      const result = await runPatchProposalTick({
        project_id: typeof merged.project_id === "string" ? merged.project_id : undefined,
        top_domains: typeof merged.top_domains === "number" ? Math.trunc(merged.top_domains) : undefined,
        transfer_window: typeof merged.transfer_window === "number" ? Math.trunc(merged.transfer_window) : undefined,
        mutation_window: typeof merged.mutation_window === "number" ? Math.trunc(merged.mutation_window) : undefined,
        gihi_window: typeof merged.gihi_window === "number" ? Math.trunc(merged.gihi_window) : undefined,
        publish_only: typeof merged.publish_only === "boolean" ? merged.publish_only : undefined,
        dry_run: typeof merged.dry_run === "boolean" ? merged.dry_run : undefined,
        batch_size: typeof merged.batch_size === "number" ? Math.trunc(merged.batch_size) : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Patch Proposal Tick\n\n- meta_state: ${result.summary?.meta_state ?? "unknown"}\n- published: ${Boolean(result.published?.ok)}\n- proposals_recent: ${Number((result.proposals_recent ?? []).length)}\n`,
        logs: `patch_proposal_tick published ${Boolean(result.published?.ok)} sync_processed ${Number(result.sync_outbound?.processed ?? 0)}`,
      };
    }

    if (task === "patch_test_tick") {
      const result = await runPatchTestTick({
        limit: typeof merged.limit === "number" ? Math.trunc(merged.limit) : undefined,
        timeout_ms: typeof merged.timeout_ms === "number" ? Math.trunc(merged.timeout_ms) : undefined,
        max_commands: typeof merged.max_commands === "number" ? Math.trunc(merged.max_commands) : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Patch Test Tick\n\n- scanned: ${Number(result.scanned ?? 0)}\n- processed: ${Number(result.processed_count ?? 0)}\n`,
        logs: `patch_test_tick processed ${Number(result.processed_count ?? 0)} proposals`,
      };
    }

    if (task === "patch_governance_tick") {
      const result = await runPatchGovernanceTick({
        dry_run: typeof merged.dry_run === "boolean" ? merged.dry_run : undefined,
        limit: typeof merged.limit === "number" ? Math.trunc(merged.limit) : undefined,
        auto_activate: typeof merged.auto_activate === "boolean" ? merged.auto_activate : undefined,
        auto_apply_repo: typeof merged.auto_apply_repo === "boolean" ? merged.auto_apply_repo : undefined,
        auto_commit_repo: typeof merged.auto_commit_repo === "boolean" ? merged.auto_commit_repo : undefined,
        timeout_ms: typeof merged.timeout_ms === "number" ? Math.trunc(merged.timeout_ms) : undefined,
        max_commands: typeof merged.max_commands === "number" ? Math.trunc(merged.max_commands) : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Patch Governance Tick\n\n- dry_run: ${Boolean(result.dry_run)}\n- decisions: ${Number(result.decisions_count ?? 0)}\n`,
        logs: `patch_governance_tick decisions ${Number(result.decisions_count ?? 0)}`,
      };
    }

    if (task === "lineage_snapshot") {
      const result = await lineageSnapshot({
        syncDir: SYNC_DIR,
        role: typeof merged.role === "string" ? merged.role as AgentRole : undefined,
        limit: typeof merged.limit === "number" && Number.isFinite(merged.limit)
          ? Math.trunc(merged.limit)
          : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: result.report_md,
        logs: `lineage_snapshot nodes ${result.snapshot.nodes_count}`,
      };
    }

    if (task === "campaign_create") {
      if (!merged.goal) {
        return {
          success: false,
          task,
          error: "campaign_create requires goal",
          report_md: "# Invalid Campaign Payload\n\n`campaign_create` requires `goal`.",
          logs: `Invalid campaign_create payload: ${JSON.stringify(payload)}`,
        };
      }
      const objectiveInput = (merged.objective == null || (typeof merged.objective === "string" && !merged.objective.trim()))
        ? "maximize score"
        : merged.objective;
      const result = await campaignCreate({
        syncDir: SYNC_DIR,
        campaign_id: typeof merged.campaign_id === "string" ? merged.campaign_id : undefined,
        goal: String(merged.goal),
        objective: objectiveInput,
        constraints: (merged.constraints && typeof merged.constraints === "object") ? merged.constraints : undefined,
        max_experiments: typeof merged.max_experiments === "number" ? Math.trunc(merged.max_experiments) : undefined,
        stop_conditions: (merged.stop_conditions && typeof merged.stop_conditions === "object")
          ? merged.stop_conditions
          : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Campaign Created\n\n**campaign_id:** ${result.campaign.campaign_id}\n`,
        logs: `campaign_create created ${result.campaign.campaign_id}`,
      };
    }

    if (task === "campaign_tick") {
      if (!merged.campaign_id) {
        return {
          success: false,
          task,
          error: "campaign_tick requires campaign_id",
          report_md: "# Invalid Campaign Payload\n\n`campaign_tick` requires `campaign_id`.",
          logs: `Invalid campaign_tick payload: ${JSON.stringify(payload)}`,
        };
      }
      let result: any;
      try {
        result = await runCampaignTick({
          campaign_id: String(merged.campaign_id),
          max_steps: typeof merged.max_steps === "number" ? Math.trunc(merged.max_steps) : undefined,
          retry_count: typeof (merged as any).retry_count === "number" ? Math.trunc((merged as any).retry_count) : undefined,
        });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (isLockBusyErrorMessage(msg)) {
          const retryCount = Math.max(0, Math.trunc(Number((merged as any).retry_count ?? 0)));
          const nextRetryCount = retryCount + 1;
          const requeued = await enqueueCampaignRetryWithCoalescing({
            campaign_id: String(merged.campaign_id),
            max_steps: typeof merged.max_steps === "number" ? Math.trunc(merged.max_steps) : undefined,
            source: "campaign-retry",
            retry_count: nextRetryCount,
            not_before_ts: computeRetryNotBeforeTs(nextRetryCount),
          });
          return {
            success: false,
            task_name: task,
            retryable: true,
            retry_count: nextRetryCount,
            requeued,
            error: msg,
            report_md: `# Campaign Tick Retry\n\n**retry_count:** ${nextRetryCount}\n\n**reason:** ${msg}\n`,
            logs: `campaign_tick lock busy, requeued retry=${nextRetryCount}`,
          };
        }
        throw e;
      }
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Campaign Tick\n\n**steps_executed:** ${result.steps_executed}\n\n**status:** ${result.campaign.status}\n`,
        logs: `campaign_tick executed ${result.steps_executed} steps`,
      };
    }

    if (task === "campaign_report_generate") {
      if (!merged.campaign_id) {
        return {
          success: false,
          task,
          error: "campaign_report_generate requires campaign_id",
          report_md: "# Invalid Campaign Payload\n\n`campaign_report_generate` requires `campaign_id`.",
          logs: `Invalid campaign_report_generate payload: ${JSON.stringify(payload)}`,
        };
      }
      const campaign = await campaignGet({
        syncDir: SYNC_DIR,
        campaign_id: String(merged.campaign_id),
      }).then((x) => x.campaign);
      const snapshot = await buildCampaignSnapshot(campaign);
      const result = await campaignReportGenerate({
        syncDir: SYNC_DIR,
        campaign_id: campaign.campaign_id,
        snapshot,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: result.report.markdown,
        logs: `campaign_report_generate wrote ${result.report.md_path}`,
      };
    }

    if (task === "campaign_list") {
      const result = await campaignList({
        syncDir: SYNC_DIR,
        status: typeof merged.status === "string" ? merged.status as any : undefined,
        limit: typeof merged.limit === "number" ? Math.trunc(merged.limit) : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...result,
        report_md: `# Campaign List\n\n**items:** ${result.items.length}\n`,
        logs: `campaign_list returned ${result.items.length}`,
      };
    }

  if (task === "agent_run_task") {
      if (!merged.task_id || !merged.role) {
        return {
          success: false,
          task,
          error: "agent_run_task requires task_id and role",
          report_md: "# Invalid Agent Payload\n\n`agent_run_task` requires `task_id` and `role`.",
          logs: `Invalid agent_run_task payload: ${JSON.stringify(payload)}`,
        };
      }

      const role = String(merged.role) as AgentRole;
      const startedAt = Date.now();
      const strictGuardDefault = String(process.env.SWE_GUARD_STRICT ?? "1").trim() === "1";
      const requireEvidence = (merged.require_evidence == null)
        ? (strictGuardDefault && role === "dev")
        : Boolean(merged.require_evidence);
      if (requireEvidence) {
        const claims = Array.isArray(merged.claims) ? merged.claims : [];
        const checked = await verifySweClaims(claims);
        if (!checked.ok) {
          return {
            success: false,
            task_name: task,
            error: "swe_guard_blocked",
            claims: checked,
            report_md:
              `# SWE Guard Blocked\n\n` +
              `Task cannot be marked done without verified evidence.\n\n` +
              `- total_claims: ${checked.total}\n` +
              `- passed: ${checked.passed}\n` +
              `- failed: ${checked.failed}\n`,
            logs: `swe_guard_blocked role=${role} task_id=${String(merged.task_id)} failed=${checked.failed}`,
          };
        }
      }
      const active = await agentGetActiveByRole(SYNC_DIR, role);
      const profile = merged.profile ?? active.profile;
      const agentVersion = typeof merged.agent_version === "number" ? Math.trunc(merged.agent_version) : active.version;
      const criticScoreDefault = role === "critic" ? 0.9 : role === "dev" ? 0.85 : role === "planner" ? 0.82 : 0.8;
      const criticScore = typeof merged.critic_score === "number" ? merged.critic_score : criticScoreDefault;
      const prompt = {
        task_id: String(merged.task_id),
        role,
        title: String(merged.title ?? ""),
        description: String(merged.description ?? ""),
        project_id: typeof merged.project_id === "string" ? merged.project_id : null,
      };

      await eventPublish({
        syncDir: SYNC_DIR,
        type: "agent.request",
        source: "agent-dispatch",
        direction: "outbound",
        conversation_id: String(merged.task_id),
        dedupe_key: `agent-request:${merged.task_id}:${profile.profile_id}`,
        payload: {
          profile,
          prompt,
        },
      });

      await taskStatusUpdate({
        syncDir: SYNC_DIR,
        task_id: String(merged.task_id),
        status: "done",
      });

      await eventPublish({
        syncDir: SYNC_DIR,
        type: "agent.completed",
        source: "agent-dispatch",
        direction: "outbound",
        dedupe_key: `agent-complete:${merged.task_id}`,
        payload: {
          task_id: String(merged.task_id),
          role,
          agent_version: agentVersion,
          profile_id: `${profile.profile_id}.v${agentVersion}`,
          status: "done",
          duration_ms: Date.now() - startedAt,
          critic_score: criticScore,
        },
      });

      await agentMetricsRecordRun({
        syncDir: SYNC_DIR,
        role,
        version: agentVersion,
        success: true,
        duration_ms: Date.now() - startedAt,
        iterations_per_task: 1,
        critic_score: criticScore,
      });

      return {
        success: true,
        task_name: task,
        task_id: String(merged.task_id),
        role,
        profile_id: profile.profile_id,
        report_md: `# Agent Task Completed\n\n**task_id:** ${merged.task_id}\n\n**role:** ${role}\n`,
        logs: `agent_run_task completed: ${merged.task_id}`,
      };
    }

    if (task === "experiment_create") {
      if (!merged.name) {
        return {
          success: false,
          task,
          error: "experiment_create requires name",
          report_md: "# Invalid Experiment Payload\n\n`experiment_create` requires `name`.",
          logs: `Invalid experiment_create payload: ${JSON.stringify(payload)}`,
        };
      }
      const objectiveInput = (merged.objective == null || (typeof merged.objective === "string" && !merged.objective.trim()))
        ? "maximize score"
        : merged.objective;
      const created = await experimentCreate({
        syncDir: SYNC_DIR,
        experiment_id: typeof merged.experiment_id === "string" ? merged.experiment_id : undefined,
        name: String(merged.name),
        objective: objectiveInput,
        metric_schema: (merged.metric_schema && typeof merged.metric_schema === "object") ? merged.metric_schema : undefined,
        search_space: (merged.search_space && typeof merged.search_space === "object") ? merged.search_space : undefined,
        search_strategy: typeof merged.search_strategy === "string"
          ? merged.search_strategy
          : (typeof (merged as any).strategy === "string" ? (merged as any).strategy : undefined),
        strategy: typeof (merged as any).strategy === "string" ? (merged as any).strategy : undefined,
        metadata: (merged.metadata && typeof merged.metadata === "object") ? merged.metadata : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...created,
        report_md: `# Experiment Created\n\n**experiment_id:** ${created.experiment.experiment_id}\n`,
        logs: `experiment_create created ${created.experiment.experiment_id}`,
      };
    }

    if (task === "experiment_run") {
      if (!merged.experiment_id || !merged.params || typeof merged.params !== "object") {
        return {
          success: false,
          task,
          error: "experiment_run requires experiment_id and params",
          report_md: "# Invalid Experiment Payload\n\n`experiment_run` requires `experiment_id` and `params`.",
          logs: `Invalid experiment_run payload: ${JSON.stringify(payload)}`,
        };
      }
      let taskId: string | null = null;
      if (typeof merged.exec_command === "string" && merged.exec_command.trim()) {
        const template = String(merged.exec_command);
        const rendered = template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_m: string, key: string) => {
          const val = (merged.params as any)[key];
          return val == null ? "" : String(val);
        });
        const t = await taskCreate({
          syncDir: SYNC_DIR,
          role: "research",
          title: `exec: ${rendered}`,
          description: `Experiment run for ${String(merged.experiment_id)}`,
          status: "open",
        });
        taskId = t.task.task_id;
      }
      const run = await experimentRun({
        syncDir: SYNC_DIR,
        experiment_id: String(merged.experiment_id),
        run_id: typeof merged.run_id === "string" ? merged.run_id : undefined,
        params: merged.params,
        metrics: (merged.metrics && typeof merged.metrics === "object") ? merged.metrics : undefined,
        status: typeof merged.status === "string" ? merged.status : undefined,
        duration_ms: typeof merged.duration_ms === "number" ? Math.trunc(merged.duration_ms) : undefined,
        task_id: taskId ?? (typeof merged.task_id === "string" ? merged.task_id : undefined),
        notes: typeof merged.notes === "string" ? merged.notes : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...run,
        report_md: `# Experiment Run\n\n**run_id:** ${run.run.run_id}\n`,
        logs: `experiment_run updated ${run.run.run_id}`,
      };
    }

    if (task === "experiment_list") {
      const list = await experimentList({
        syncDir: SYNC_DIR,
        status: typeof merged.status === "string" ? merged.status : undefined,
        limit: typeof merged.limit === "number" ? Math.trunc(merged.limit) : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...list,
        report_md: `# Experiment List\n\n**count:** ${list.items.length}\n`,
        logs: `experiment_list returned ${list.items.length} items`,
      };
    }

    if (task === "experiment_compare") {
      if (!merged.experiment_id) {
        return {
          success: false,
          task,
          error: "experiment_compare requires experiment_id",
          report_md: "# Invalid Experiment Payload\n\n`experiment_compare` requires `experiment_id`.",
          logs: `Invalid experiment_compare payload: ${JSON.stringify(payload)}`,
        };
      }
      const compared = await experimentCompare({
        syncDir: SYNC_DIR,
        experiment_id: String(merged.experiment_id),
      });
      return {
        success: true,
        task_name: task,
        ...compared,
        report_md: `# Experiment Compare\n\n**runs:** ${compared.runs_count}\n`,
        logs: `experiment_compare for ${merged.experiment_id}`,
      };
    }

    if (task === "experiment_leaderboard") {
      if (!merged.experiment_id) {
        return {
          success: false,
          task,
          error: "experiment_leaderboard requires experiment_id",
          report_md: "# Invalid Experiment Payload\n\n`experiment_leaderboard` requires `experiment_id`.",
          logs: `Invalid experiment_leaderboard payload: ${JSON.stringify(payload)}`,
        };
      }
      const board = await experimentLeaderboard({
        syncDir: SYNC_DIR,
        experiment_id: String(merged.experiment_id),
        limit: typeof merged.limit === "number" ? Math.trunc(merged.limit) : undefined,
      });
      return {
        success: true,
        task_name: task,
        ...board,
        report_md: `# Experiment Leaderboard\n\n**items:** ${board.items.length}\n`,
        logs: `experiment_leaderboard for ${merged.experiment_id}`,
      };
    }

    if (task === "experiment_best") {
      if (!merged.experiment_id) {
        return {
          success: false,
          task,
          error: "experiment_best requires experiment_id",
          report_md: "# Invalid Experiment Payload\n\n`experiment_best` requires `experiment_id`.",
          logs: `Invalid experiment_best payload: ${JSON.stringify(payload)}`,
        };
      }
      const best = await experimentBest({
        syncDir: SYNC_DIR,
        experiment_id: String(merged.experiment_id),
      });
      return {
        success: true,
        task_name: task,
        ...best,
        report_md: "# Experiment Best\n\nReturned best run.",
        logs: `experiment_best for ${merged.experiment_id}`,
      };
    }

    if (task === "experiment_search_tick") {
      if (!merged.experiment_id) {
        return {
          success: false,
          task,
          error: "experiment_search_tick requires experiment_id",
          report_md: "# Invalid Experiment Payload\n\n`experiment_search_tick` requires `experiment_id`.",
          logs: `Invalid experiment_search_tick payload: ${JSON.stringify(payload)}`,
        };
      }
      const search = await runExperimentSearchTickWithResearchProfile({
        experiment_id: String(merged.experiment_id),
        batch_size: typeof merged.batch_size === "number" ? Math.trunc(merged.batch_size) : undefined,
      });
      const impact = await applyResearchImpactOnExperimentConverged({
        experiment_id: String(merged.experiment_id),
        phase: (search as any).phase,
        stop_reason: (search as any).stop_reason ?? null,
      });
      return {
        success: true,
        task_name: task,
        ...(impact ? { ...search, ...impact } : search),
        report_md: `# Experiment Search Tick\n\n**created_count:** ${search.created_count}\n`,
        logs: `experiment_search_tick created ${search.created_count} runs`,
      };
    }
    
    // Default fallback for unknown tasks
    return {
      success: false,
      task,
      project_path,
      error: `Unknown task: ${task}`,
      report_md: `# Unknown Task\n\nTask: ${task}\nPath: ${project_path}\n\n**Error:** Unknown task type`,
      logs: `Failed to execute unknown task: ${task}`
    };
  }

  // New queue-based router
  const onQueueExecFinished = async ({ job, payload, result }: {
    job: any;
    payload: any;
    result: any;
  }) => {
    const taskId = (payload as any)?.task_id;
    if (!taskId || typeof taskId !== "string") return;

    const exitCode = Number((result as any)?.exit_code ?? -1);
    const completion = await taskExecutionHandleResult({
      syncDir: SYNC_DIR,
      task_id: taskId,
      exit_code: exitCode,
      error: exitCode === 0 ? undefined : String((result as any)?.stderr ?? "exec failed"),
    });
    const runStatus = exitCode === 0
      ? "completed"
      : (completion.outcome === "retry" ? "running" : "failed");
    let ingestStdout = typeof (result as any)?.stdout === "string" ? (result as any).stdout : "";
    let ingestStderr = typeof (result as any)?.stderr === "string" ? (result as any).stderr : "";
    if (!ingestStdout.trim() && typeof job?.job_id === "string" && job.job_id.trim()) {
      try {
        for (const dirName of queueRunDirCandidates(String(job.job_id))) {
          const resultPath = path.join(SYNC_DIR, "queue", "runs", dirName, "result.json");
          try {
            const raw = await fs.readFile(resultPath, "utf8");
            const parsed = JSON.parse(raw);
            if (typeof parsed?.stdout === "string" && parsed.stdout.trim()) ingestStdout = parsed.stdout;
            if (typeof parsed?.stderr === "string" && parsed.stderr.trim()) ingestStderr = parsed.stderr;
            if (ingestStdout.trim() || ingestStderr.trim()) break;
          } catch {
            // Try next candidate path.
          }
        }
      } catch {
        // Keep original stdout/stderr from in-memory result.
      }
    }

    const ingest = await experimentIngestExecResultByTask({
      syncDir: SYNC_DIR,
      task_id: taskId,
      stdout: ingestStdout,
      stderr: ingestStderr,
      exit_code: exitCode,
      duration_ms: typeof (result as any)?.duration_ms === "number" ? Math.trunc((result as any).duration_ms) : null,
      status: runStatus,
    });
    const impact = ingest.matched
      ? await applyResearchImpactOnExperimentConverged({
        experiment_id: ingest.experiment_id,
        phase: "exec_ingest",
        stop_reason: null,
        force_check: true,
      })
      : null;
    const arenaEvaluatedAfterImpact = Boolean(
      (impact as any)?.transfer_memory_update?.arena?.evaluated === true
    );

    await eventPublish({
      syncDir: SYNC_DIR,
      type: "task.exec.completed",
      source: "execution-bind",
      direction: "outbound",
      dedupe_key: `exec-complete:${job.job_id}`,
      payload: {
        task_id: taskId,
        job_id: job.job_id,
        exit_code: exitCode,
        status: completion.task.status,
        outcome: completion.outcome,
        attempts: completion.attempts,
        max_attempts: completion.max_attempts,
        next_retry_at: completion.next_retry_at ?? null,
        cmd: (payload as any)?.cmd ?? null,
        args: (payload as any)?.args ?? [],
        experiment_linked: ingest.matched,
        experiment_id: ingest.matched ? ingest.experiment_id : null,
        run_id: ingest.matched ? ingest.run_id : null,
        extracted_metrics: ingest.matched ? ingest.extracted_metrics : {},
        metric_extraction_warnings: ingest.matched ? ingest.metric_extraction_warnings : [],
        run_score: ingest.matched ? ingest.run.score : null,
        best_run_id: ingest.matched ? ingest.best_run_id : null,
        research_impact_applied: Boolean(impact),
        research_fitness: impact ? impact.research_fitness : null,
        arena_evaluated_after_impact: arenaEvaluatedAfterImpact,
      },
    });

    if (completion.outcome === "blocked") {
      await eventPublish({
        syncDir: SYNC_DIR,
        type: "task.failed",
        source: "execution-bind",
        direction: "outbound",
        dedupe_key: `task-failed:${taskId}:${completion.attempts}`,
        payload: {
          task_id: taskId,
          job_id: job.job_id,
          attempts: completion.attempts,
          max_attempts: completion.max_attempts,
          last_error: completion.task.execution?.last_error ?? null,
        },
      });
    }
  };

  async function runRouterExecuteFromQueue(logicalQueue?: string | string[]) {
    return executeOneFromQueue({
      syncDir: SYNC_DIR,
      worker: "windsurf-router",
      max_lease_ms: 60000,
      logical_queue: logicalQueue,
      runExecInternal,
      handleProjectTask,
      onExecFinished: onQueueExecFinished,
    });
  }

  function isLockBusyErrorMessage(message: string) {
    const msg = message.toLowerCase();
    return (
      msg.includes("lock busy") ||
      msg.includes("write lock busy") ||
      msg.includes("write_lock_busy") ||
      msg.includes("elock") ||
      msg.includes("ebusy") ||
      msg.includes("eperm")
    );
  }

  function computeRetryNotBeforeTs(retryCount: number) {
    const base = 250;
    const jitter = Math.floor(Math.random() * 251);
    const exp = Math.min(30_000, base * Math.pow(2, Math.max(0, retryCount)));
    return new Date(Date.now() + exp + jitter).toISOString();
  }

  async function enqueueCampaignTickJob(args: {
    campaign_id: string;
    max_steps?: number;
    source?: string;
    idempotency_key?: string;
    retry_count?: number;
    not_before_ts?: string;
    priority?: number;
  }) {
    const jobId = `campaign-tick-${args.campaign_id}-${args.idempotency_key ?? randomUUID()}`;
    const source = args.source ?? "campaign-api";
    const isRetrySource = /retry/i.test(source);
    const priority = Number.isFinite(Number(args.priority))
      ? Math.trunc(Number(args.priority))
      : (isRetrySource ? 1 : 6);
    await queuePush({
      syncDir: SYNC_DIR,
      type: "project_task",
      logical_queue: "campaign",
      source,
      priority,
      job_id: jobId,
      payload: {
        command: "campaign_tick",
        campaign_id: args.campaign_id,
        max_steps: typeof args.max_steps === "number" ? Math.max(1, Math.min(50, Math.trunc(args.max_steps))) : undefined,
        retry_count: Math.max(0, Math.trunc(Number(args.retry_count ?? 0))),
        not_before_ts: typeof args.not_before_ts === "string" ? args.not_before_ts : undefined,
      },
    });
    return { queued: true, job_id: jobId };
  }

  async function enqueueCampaignRetryWithCoalescing(args: {
    campaign_id: string;
    max_steps?: number;
    retry_count: number;
    source?: string;
    not_before_ts?: string;
    idempotency_key?: string;
  }): Promise<{
    queued: boolean;
    job_id?: string;
    coalesced?: boolean;
    live_before?: { has_live: boolean; pending: number; running: number };
  }> {
    const live = await queueHasLiveCampaignJob({
      syncDir: SYNC_DIR,
      campaign_id: args.campaign_id,
    });
    if (live.has_live) {
      return { queued: false, coalesced: true, live_before: live };
    }
    return await enqueueCampaignTickJob({
      campaign_id: args.campaign_id,
      max_steps: args.max_steps,
      source: args.source ?? "campaign-retry",
      idempotency_key: args.idempotency_key,
      retry_count: args.retry_count,
      not_before_ts: args.not_before_ts,
      priority: 1,
    });
  }

  async function runCampaignWatchdogTick(args?: {
    idle_ms?: number;
    cooldown_ms?: number;
    limit?: number;
    dry_run?: boolean;
  }) {
    const idleMs = Math.max(5_000, Math.min(10 * 60_000, Math.trunc(Number(args?.idle_ms ?? 45_000))));
    const cooldownMs = Math.max(5_000, Math.min(10 * 60_000, Math.trunc(Number(args?.cooldown_ms ?? 20_000))));
    const limit = Math.max(1, Math.min(1000, Math.trunc(Number(args?.limit ?? 200))));
    const dryRun = Boolean(args?.dry_run);
    const now = Date.now();
    const running = await campaignList({
      syncDir: SYNC_DIR,
      status: "running",
      limit,
    });
    const actions: Array<{
      campaign_id: string;
      idle_ms: number;
      live_before: { has_live: boolean; pending: number; running: number };
      enqueued_not_before_ts: string;
      job_id?: string;
    }> = [];

    for (const campaign of running.items) {
      const history = Array.isArray((campaign as any)?.history) ? (campaign as any).history : [];
      const lastTick = [...history].reverse().find((h: any) => h?.type === "campaign.tick");
      const lastActivityRaw = String(
        lastTick?.ts
        ?? (campaign as any)?.updated_at
        ?? (campaign as any)?.started_at
        ?? (campaign as any)?.created_at
        ?? ""
      );
      const lastActivityTs = Date.parse(lastActivityRaw);
      const idleFor = Number.isFinite(lastActivityTs) ? (now - lastActivityTs) : 0;
      if (idleFor < idleMs) continue;

      const live = await queueHasLiveCampaignJob({
        syncDir: SYNC_DIR,
        campaign_id: String((campaign as any)?.campaign_id ?? ""),
      });
      if (live.has_live) continue;

      const lastWatchdogEnqueued = [...history].reverse().find((h: any) => h?.type === "campaign.watchdog.enqueued");
      const lastWatchdogTs = Date.parse(String(lastWatchdogEnqueued?.ts ?? ""));
      if (Number.isFinite(lastWatchdogTs) && (now - lastWatchdogTs) < cooldownMs) continue;

      const jitterMs = Math.floor(Math.random() * 2000);
      const backoffMs = Math.min(60_000, Math.floor(idleFor * 0.25));
      const notBeforeTs = new Date(now + jitterMs + backoffMs).toISOString();

      const action = {
        campaign_id: String((campaign as any)?.campaign_id ?? ""),
        idle_ms: idleFor,
        live_before: live,
        enqueued_not_before_ts: notBeforeTs,
      };
      actions.push(action);
      if (dryRun) continue;

      const queued = await enqueueCampaignTickJob({
        campaign_id: action.campaign_id,
        max_steps: 1,
        source: "campaign_watchdog_tick",
        idempotency_key: `watchdog-${now}-${randomUUID().slice(0, 8)}`,
        not_before_ts: notBeforeTs,
      });

      await campaignAppendHistory({
        syncDir: SYNC_DIR,
        campaign_id: action.campaign_id,
        type: "campaign.watchdog.enqueued",
        data: {
          idle_ms: idleFor,
          backoff_ms: backoffMs,
          jitter_ms: jitterMs,
          not_before_ts: notBeforeTs,
          live_before: live,
          job_id: queued.job_id,
        },
      });
      (action as any).job_id = queued.job_id;
    }

    return {
      scanned: running.items.length,
      idle_ms: idleMs,
      cooldown_ms: cooldownMs,
      actions,
      dry_run: dryRun,
    };
  }

  async function runMetaQueueAutoGuard() {
    const highWatermark = Math.max(100, Math.trunc(Number(process.env.META_GUARD_HIGH_WATERMARK ?? "300")));
    const lowWatermark = Math.max(0, Math.min(highWatermark - 1, Math.trunc(Number(process.env.META_GUARD_LOW_WATERMARK ?? "80"))));
    const activateStreakNeed = Math.max(1, Math.trunc(Number(process.env.META_GUARD_ACTIVATE_STREAK ?? "2")));
    const recoverStreakNeed = Math.max(1, Math.trunc(Number(process.env.META_GUARD_RECOVER_STREAK ?? "3")));
    const switchCooldownMs = Math.max(10_000, Math.trunc(Number(process.env.META_GUARD_SWITCH_COOLDOWN_MS ?? "120000")));
    const now = Date.now();
    const depth = await queueDepth({ syncDir: SYNC_DIR, logical_queue: "meta" });
    const pending = Number(depth.pending ?? 0);

    if (pending >= highWatermark) {
      metaGuardOverloadStreak += 1;
      metaGuardHealthyStreak = 0;
    } else if (pending <= lowWatermark) {
      metaGuardHealthyStreak += 1;
      metaGuardOverloadStreak = 0;
    } else {
      metaGuardHealthyStreak = 0;
      metaGuardOverloadStreak = 0;
    }

    if (!metaGuardSafeModeEnabled) {
      if (metaGuardOverloadStreak < activateStreakNeed) return;
      if ((now - metaGuardLastSwitchAt) < switchCooldownMs) return;

      const current = await governanceGet(SYNC_DIR);
      const currentGov: any = (current && typeof current.governance === "object") ? { ...current.governance } : {};
      if (!metaGuardBaselineGovernance) {
        metaGuardBaselineGovernance = { ...currentGov };
      }
      const safePatch = {
        max_shadow_per_role: 1,
        evolution_cooldown_ms: Math.max(180_000, Number(currentGov.evolution_cooldown_ms ?? 0)),
        min_replay_runs: 2,
        max_evolution_attempts_per_day: Math.min(4, Math.max(1, Number(currentGov.max_evolution_attempts_per_day ?? 4))),
      };
      await governanceSet(SYNC_DIR, safePatch);
      metaGuardSafeModeEnabled = true;
      metaGuardLastSwitchAt = now;
      metaGuardOverloadStreak = 0;

      await notesUpsert({
        syncDir: SYNC_DIR,
        title: "meta_guard_activated",
        content: JSON.stringify({
          ts: new Date().toISOString(),
          pending,
          high_watermark: highWatermark,
          applied_patch: safePatch,
          baseline: metaGuardBaselineGovernance,
        }, null, 2),
        tags: ["meta_guard", "governance", "auto"],
      });
      return;
    }

    if (metaGuardHealthyStreak < recoverStreakNeed) return;
    if ((now - metaGuardLastSwitchAt) < switchCooldownMs) return;
    if (!metaGuardBaselineGovernance) return;

    const restorePatch = {
      max_shadow_per_role: Number(metaGuardBaselineGovernance.max_shadow_per_role ?? 1),
      evolution_cooldown_ms: Number(metaGuardBaselineGovernance.evolution_cooldown_ms ?? 180_000),
      min_replay_runs: Number(metaGuardBaselineGovernance.min_replay_runs ?? 2),
      max_evolution_attempts_per_day: Number(metaGuardBaselineGovernance.max_evolution_attempts_per_day ?? 4),
    };
    await governanceSet(SYNC_DIR, restorePatch);
    metaGuardSafeModeEnabled = false;
    metaGuardLastSwitchAt = now;
    metaGuardHealthyStreak = 0;

    await notesUpsert({
      syncDir: SYNC_DIR,
      title: "meta_guard_recovered",
      content: JSON.stringify({
        ts: new Date().toISOString(),
        pending,
        low_watermark: lowWatermark,
        restored_patch: restorePatch,
      }, null, 2),
      tags: ["meta_guard", "governance", "auto"],
    });
  }

  if (!backgroundWorkerManager) {
    const manager = new WorkerManager();
    manager.addWorker(new Worker({
      name: "exec",
      fn: () => runRouterExecuteFromQueue("exec"),
      interval_ms: 100,
      concurrency: 2,
      idle_backoff_ms: 250,
      max_idle_backoff_ms: 2_000,
      queue_depth_fn: async () => (await queueDepth({ syncDir: SYNC_DIR, logical_queue: "exec" })).pending,
      stuck_job_threshold_ms: 60_000,
    }));
    manager.addWorker(new Worker({
      name: "research",
      fn: () => runRouterExecuteFromQueue("research"),
      interval_ms: 250,
      concurrency: 1,
      idle_backoff_ms: 500,
      max_idle_backoff_ms: 3_000,
      queue_depth_fn: async () => (await queueDepth({ syncDir: SYNC_DIR, logical_queue: "research" })).pending,
      stuck_job_threshold_ms: 90_000,
    }));
    manager.addWorker(new Worker({
      name: "campaign",
      fn: () => runRouterExecuteFromQueue("campaign"),
      interval_ms: 250,
      concurrency: 1,
      idle_backoff_ms: 500,
      max_idle_backoff_ms: 3_000,
      queue_depth_fn: async () => (await queueDepth({ syncDir: SYNC_DIR, logical_queue: "campaign" })).pending,
      stuck_job_threshold_ms: 120_000,
    }));
    manager.addWorker(new Worker({
      name: "meta",
      fn: () => runRouterExecuteFromQueue("meta"),
      interval_ms: 500,
      concurrency: 1,
      idle_backoff_ms: 750,
      max_idle_backoff_ms: 4_000,
      queue_depth_fn: async () => (await queueDepth({ syncDir: SYNC_DIR, logical_queue: "meta" })).pending,
      stuck_job_threshold_ms: 120_000,
    }));
    manager.startAll();
    backgroundWorkerManager = manager;
    backgroundWorkerStartedAt = new Date().toISOString();

    if (!backgroundWorkerAdaptiveTimer) {
      backgroundWorkerAdaptiveTimer = setInterval(async () => {
        try {
          const managerRef = backgroundWorkerManager;
          if (!managerRef) return;
          const [execQ, researchQ] = await Promise.all([
            queueDepth({ syncDir: SYNC_DIR, logical_queue: "exec" }),
            queueDepth({ syncDir: SYNC_DIR, logical_queue: "research" }),
          ]);
          const metaDiag = await intelligenceMetaSnapshot({
            syncDir: SYNC_DIR,
            mutation_window: 30,
            transfer_window: 40,
            gihi_window: 30,
          }).catch(() => null);

          const execWorker = managerRef.getWorker("exec");
          const researchWorker = managerRef.getWorker("research");
          const campaignWorker = managerRef.getWorker("campaign");
          const metaWorker = managerRef.getWorker("meta");
          if (!execWorker || !researchWorker || !campaignWorker || !metaWorker) return;

          const metrics = managerRef.metrics();
          const byName = new Map<string, any>((metrics.workers ?? []).map((m: any) => [String(m?.name ?? ""), m]));
          const execM = byName.get("exec");
          const researchM = byName.get("research");

          const execDepth = Number(execQ.pending ?? 0);
          let nextExec = execWorker.getConcurrency();
          if (execDepth > 200) nextExec += 1;
          else if (execDepth < 50) nextExec -= 1;
          nextExec = Math.max(1, Math.min(8, nextExec));

          const execErrorRate = Number(execM?.worker_error_rate ?? 0);
          const execLatency = Number(execM?.avg_exec_latency_ms ?? execM?.avg_latency_ms ?? 0);
          const execStuck = Boolean(execM?.stuck_job_detection?.is_stuck);
          const execStress = execErrorRate > 0.25 || execLatency > 45_000 || execStuck;
          if (execStress) {
            nextExec = Math.max(1, nextExec - 1);
            execWorker.setThrottleMs(1_500);
          } else {
            execWorker.setThrottleMs(0);
          }
          execWorker.setConcurrency(nextExec);

          const transferVariance = Number(metaDiag?.snapshot?.transfer_variance ?? NaN);
          const arenaEntropy = Number(metaDiag?.snapshot?.arena_entropy ?? NaN);
          const researchDepth = Number(researchQ.pending ?? 0);

          let nextResearch = researchWorker.getConcurrency();
          if (Number.isFinite(transferVariance) && transferVariance > 0.12) nextResearch += 1;
          if (Number.isFinite(arenaEntropy) && arenaEntropy < 0.25) nextResearch += 1;
          if (
            researchDepth < 10 &&
            Number.isFinite(transferVariance) && transferVariance < 0.05 &&
            Number.isFinite(arenaEntropy) && arenaEntropy > 0.45
          ) {
            nextResearch -= 1;
          }
          nextResearch = Math.max(1, Math.min(4, nextResearch));

          const researchErrorRate = Number(researchM?.worker_error_rate ?? 0);
          const researchStuck = Boolean(researchM?.stuck_job_detection?.is_stuck);
          if (researchErrorRate > 0.2 || researchStuck) {
            nextResearch = Math.max(1, nextResearch - 1);
            researchWorker.setThrottleMs(1_000);
          } else {
            researchWorker.setThrottleMs(0);
          }
          researchWorker.setConcurrency(nextResearch);

          campaignWorker.setConcurrency(1);
          metaWorker.setConcurrency(1);
          const globalStress = execStress || researchErrorRate > 0.2 || researchStuck;
          metaWorker.setThrottleMs(globalStress ? 2_000 : 0);

          if ((Date.now() - lastCampaignWatchdogRunAt) >= 15_000) {
            lastCampaignWatchdogRunAt = Date.now();
            await runCampaignWatchdogTick({
              idle_ms: 45_000,
              cooldown_ms: 20_000,
              limit: 200,
              dry_run: false,
            });
          }
          await runMetaQueueAutoGuard();
        } catch {
          // Isolated adaptive loop; errors should not affect workers.
        }
      }, 5000);
    }
  }

  server.tool(
    "router_execute_from_queue",
    "Execute one job from queue",
    {},
    async () => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify(await runRouterExecuteFromQueue()),
      }],
    }),
  );

  server.tool(
    "router_execute_exec_queue",
    "Execute one job from exec logical queue",
    {},
    async () => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify(await runRouterExecuteFromQueue("exec")),
      }],
    }),
  );

  server.tool(
    "router_execute_research_queue",
    "Execute one job from research logical queue",
    {},
    async () => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify(await runRouterExecuteFromQueue("research")),
      }],
    }),
  );

  server.tool(
    "router_execute_campaign_queue",
    "Execute one job from campaign logical queue",
    {},
    async () => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify(await runRouterExecuteFromQueue("campaign")),
      }],
    }),
  );

  server.tool(
    "router_execute_meta_queue",
    "Execute one job from meta logical queue",
    {},
    async () => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify(await runRouterExecuteFromQueue("meta")),
      }],
    }),
  );

  server.tool(
    "worker_metrics_snapshot",
    "Worker manager telemetry snapshot",
    {},
    async () => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify(buildWorkerSnapshot()),
      }],
    }),
  );

  // --- Phase 2: Exec Tool ---
  const ALLOWED_COMMANDS = new Set(['git', 'node', 'npm', 'pnpm', 'yarn', 'python', 'pip', 'powershell', 'pwsh']);
  const DANGEROUS_PATTERNS = [
    /-EncodedCommand/i,
    /rm\s+-rf/i,
    /del\s+\/[sS]/i,
    /format\s+/i,
    /fdisk/i,
    /mkfs/i,
    /reg\s+(delete|add|import)/i
  ];

  server.tool(
    "exec",
    "Execute command with security restrictions.",
    {
      cmd: z.string(),
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      timeout_ms: z.number().int().min(1000).max(300000).default(60000), // 60s default
      max_output_bytes: z.number().int().min(1024).max(10*1024*1024).default(2*1024*1024) // 2MB default
    },
    async ({ cmd, args = [], cwd, env = {}, timeout_ms, max_output_bytes }) => {
      // Security checks
      const baseCmd = cmd.split(' ')[0].toLowerCase();
      
      if (!ALLOWED_COMMANDS.has(baseCmd)) {
        return errText(`Command not allowed: ${cmd}`);
      }

      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(cmd)) {
          return errText(`Dangerous command pattern detected: ${cmd}`);
        }
      }

      // Check cwd is within allowed roots
      let workingDir = cwd || process.cwd();
      if (cwd) {
        workingDir = path.resolve(cwd);
        const isAllowed = ROOTS_FINAL.some(root => workingDir.startsWith(root));
        if (!isAllowed) {
          return errText(`Working directory outside allowed roots: ${cwd}`);
        }
      }

      try {
        return new Promise((resolve) => {
          const startTime = Date.now();
          const child = spawn(cmd, args, {
            cwd: workingDir,
            env: { ...process.env, ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false
          });

          let stdout = '';
          let stderr = '';
          let stdoutBytes = 0;
          let stderrBytes = 0;

          const timeout = setTimeout(() => {
            child.kill('SIGTERM');
            resolve(okText({
              exit_code: -1,
              stdout: stdout.slice(0, max_output_bytes),
              stderr: stderr.slice(0, max_output_bytes),
              duration_ms: Date.now() - startTime,
              timed_out: true
            }));
          }, timeout_ms);

          child.stdout?.on('data', (chunk: Buffer) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes <= max_output_bytes) {
              stdout += chunk.toString();
            }
          });

          child.stderr?.on('data', (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes <= max_output_bytes) {
              stderr += chunk.toString();
            }
          });

          child.on('close', (code: number | null) => {
            clearTimeout(timeout);
            resolve(okText({
              exit_code: code || 0,
              stdout: stdout.slice(0, max_output_bytes),
              stderr: stderr.slice(0, max_output_bytes),
              duration_ms: Date.now() - startTime,
              cmd: `${cmd} ${args.join(' ')}`.trim()
            }));
          });

          child.on('error', (error: Error) => {
            clearTimeout(timeout);
            resolve(errText(`Failed to execute command: ${error.message}`));
          });
        });
      } catch (error: any) {
        return errText(`Execution error: ${(error as Error).message}`);
      }
    }
  );

  // --- Phase 3: Event Tools ---
  server.tool(
    "event_publish",
    "Publish an event to events.jsonl",
    {
      type: z.string(),
      payload: z.any().optional(),
      data: z.any().optional(),
      source: z.string().optional(),
      event_id: z.string().optional(),
      conversation_id: z.string().optional(),
      direction: z.enum(["outbound", "inbound"]).optional(),
      dedupe_key: z.string().optional(),
    },
    async ({ type, payload, data, source, event_id, conversation_id, direction, dedupe_key }) => {
      const result = await eventPublish({
        syncDir: SYNC_DIR,
        type,
        payload: payload ?? data,
        source: source ?? "windsurf",
        event_id,
        conversation_id,
        direction,
        dedupe_key,
      });
      return okText(result);
    }
  );

  server.tool(
    "event_list",
    "List events from events.jsonl",
    {
      limit: z.number().int().min(1).max(1000).optional(),
      type: z.string().optional(),
      since_ts: z.string().optional(),
      source: z.string().optional(),
      event_id: z.string().optional(),
      conversation_id: z.string().optional(),
      direction: z.enum(["outbound", "inbound"]).optional(),
      dedupe_key: z.string().optional(),
    },
    async ({ limit, type, since_ts, source, event_id, conversation_id, direction, dedupe_key }) => {
      const result = await eventList({
        syncDir: SYNC_DIR,
        limit,
        type,
        since_ts,
        source,
        event_id,
        conversation_id,
        direction,
        dedupe_key,
      });
      return okText(result);
    }
  );

  // --- Phase 3.5: Experiment Tools ---
  server.tool(
    "experiment_create",
    "Create or update an experiment",
    {
      experiment_id: z.string().optional(),
      name: z.string(),
      objective: z.union([
        z.string(),
        z.object({
          metric: z.string().min(1),
          mode: z.enum(["maximize", "minimize"]),
        }),
      ]),
      metric_schema: z.record(z.string(), z.record(z.string(), z.any())).optional(),
      search_space: z.record(z.string(), z.array(z.any())).optional(),
      search_strategy: z.enum(["grid", "random", "adaptive"]).optional(),
      strategy: z.enum(["grid", "random", "adaptive"]).optional(),
      metadata: z.record(z.string(), z.any()).optional(),
    },
    async ({ experiment_id, name, objective, metric_schema, search_space, search_strategy, strategy, metadata }) => {
      const strategyInput = search_strategy ?? strategy;
      const result = await experimentCreate({
        syncDir: SYNC_DIR,
        experiment_id,
        name,
        objective,
        metric_schema,
        search_space,
        search_strategy: strategyInput,
        strategy: strategyInput,
        metadata,
      });
      return okText(result);
    }
  );

  server.tool(
    "experiment_run",
    "Create/update experiment run; optionally create exec task from template",
    {
      experiment_id: z.string(),
      run_id: z.string().optional(),
      params: z.record(z.string(), z.any()),
      metrics: z.record(z.string(), z.number()).optional(),
      status: z.enum(["pending", "running", "completed", "failed"]).optional(),
      duration_ms: z.number().int().min(0).optional(),
      task_id: z.string().optional(),
      notes: z.string().optional(),
      exec_command: z.string().optional(),
    },
    async ({ experiment_id, run_id, params, metrics, status, duration_ms, task_id, notes, exec_command }) => {
      let linkedTaskId: string | null = null;
      if (exec_command && exec_command.trim()) {
        const rendered = exec_command.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_m, key) => {
          const val = (params as any)[key];
          return val == null ? "" : String(val);
        });
        const createdTask = await taskCreate({
          syncDir: SYNC_DIR,
          role: "research",
          title: `exec: ${rendered}`,
          description: `Experiment run for ${experiment_id}`,
          status: "open",
        });
        linkedTaskId = createdTask.task.task_id;
      }
      const result = await experimentRun({
        syncDir: SYNC_DIR,
        experiment_id,
        run_id,
        params,
        metrics,
        status,
        duration_ms,
        task_id: linkedTaskId ?? task_id,
        notes,
      });
      return okText(result);
    }
  );

  server.tool(
    "experiment_list",
    "List experiments",
    {
      status: z.enum(["draft", "running", "completed", "archived"]).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    async ({ status, limit }) => {
      const result = await experimentList({
        syncDir: SYNC_DIR,
        status,
        limit,
      });
      return okText(result);
    }
  );

  server.tool(
    "experiment_compare",
    "Compare runs and return best/second delta",
    {
      experiment_id: z.string(),
    },
    async ({ experiment_id }) => {
      const result = await experimentCompare({
        syncDir: SYNC_DIR,
        experiment_id,
      });
      return okText(result);
    }
  );

  server.tool(
    "experiment_leaderboard",
    "Get sorted leaderboard for experiment",
    {
      experiment_id: z.string(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    async ({ experiment_id, limit }) => {
      const result = await experimentLeaderboard({
        syncDir: SYNC_DIR,
        experiment_id,
        limit,
      });
      return okText(result);
    }
  );

  server.tool(
    "experiment_best",
    "Get best run for experiment",
    {
      experiment_id: z.string(),
    },
    async ({ experiment_id }) => {
      const result = await experimentBest({
        syncDir: SYNC_DIR,
        experiment_id,
      });
      return okText(result);
    }
  );

  server.tool(
    "experiment_search_tick",
    "Generate pending runs from search space (grid/random/adaptive)",
    {
      experiment_id: z.string(),
      batch_size: z.number().int().min(1).max(200).optional(),
    },
    async ({ experiment_id, batch_size }) => {
      const search = await runExperimentSearchTickWithResearchProfile({
        experiment_id,
        batch_size,
      });
      const impact = await applyResearchImpactOnExperimentConverged({
        experiment_id,
        phase: (search as any).phase,
        stop_reason: (search as any).stop_reason ?? null,
      });
      return okText(impact ? { ...search, ...impact } : search);
    }
  );

  // --- Compact Multiplexer Tools ---
  server.tool(
    "notes",
    "Notes multiplexer: list/get/upsert/delete",
    {
      op: z.enum(["list", "get", "upsert", "delete"]),
      id: z.string().optional(),
      title: z.string().optional(),
      content: z.string().optional(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (args) => {
      switch (args.op) {
        case "list":
          return okText(await notesList({ syncDir: SYNC_DIR, limit: args.limit, query: args.query }));
        case "get":
          if (!args.id) return errText("notes(op=get) requires id");
          return okText(await notesGet({ syncDir: SYNC_DIR, id: args.id }));
        case "upsert":
          if (!args.title) return errText("notes(op=upsert) requires title");
          return okText(await notesUpsert({
            syncDir: SYNC_DIR,
            id: args.id,
            title: args.title,
            content: args.content ?? args.body,
            tags: args.tags,
          }));
        case "delete":
          if (!args.id) return errText("notes(op=delete) requires id");
          return okText(await notesDelete({ syncDir: SYNC_DIR, id: args.id }));
      }
    }
  );

  server.tool(
    "tasks",
    "Tasks multiplexer: CRUD + task graph operations",
    {
      op: z.enum(["list", "get", "upsert", "delete", "create", "link", "graph", "plan_generate", "status_update", "orchestrator_tick", "execution_bind_tick", "recovery_tick"]),
      id: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      labels: z.array(z.string()).optional(),
      status: z.string().optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      task_id: z.string().optional(),
      project_id: z.string().optional(),
      role: z.enum(["planner", "dev", "research", "critic"]).optional(),
      depends_on: z.array(z.string()).optional(),
      children: z.array(z.string()).optional(),
      execution_policy: z.object({
        max_attempts: z.number().int().min(1).max(100).optional(),
        retry_delay_ms: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
        backoff_multiplier: z.number().min(1).max(10).optional(),
      }).optional(),
      goal: z.string().optional(),
      max_tasks: z.number().int().min(1).max(20).optional(),
    },
    async (args) => {
      switch (args.op) {
        case "list":
          return okText(await tasksList({ syncDir: SYNC_DIR, limit: args.limit, query: args.query, status: args.status as any }));
        case "get":
          if (!args.id) return errText("tasks(op=get) requires id");
          return okText(await tasksGet({ syncDir: SYNC_DIR, id: args.id }));
        case "upsert":
          if (!args.title) return errText("tasks(op=upsert) requires title");
          return okText(await tasksUpsert({
            syncDir: SYNC_DIR,
            id: args.id,
            title: args.title,
            description: args.description,
            status: args.status as any,
            labels: args.labels,
          }));
        case "delete":
          if (!args.id) return errText("tasks(op=delete) requires id");
          return okText(await tasksDelete({ syncDir: SYNC_DIR, id: args.id }));
        case "create":
          if (!args.title) return errText("tasks(op=create) requires title");
          return okText(await taskCreate({
            syncDir: SYNC_DIR,
            task_id: args.task_id,
            project_id: args.project_id,
            role: args.role,
            title: args.title,
            description: args.description,
            status: args.status as any,
            depends_on: args.depends_on,
            children: args.children,
            execution_policy: args.execution_policy,
          }));
        case "link":
          if (!args.task_id) return errText("tasks(op=link) requires task_id");
          return okText(await taskLink({ syncDir: SYNC_DIR, task_id: args.task_id, depends_on: args.depends_on, children: args.children }));
        case "graph":
          return okText(await taskGraph({ syncDir: SYNC_DIR, project_id: args.project_id }));
        case "plan_generate":
          if (!args.goal) return errText("tasks(op=plan_generate) requires goal");
          return okText(await taskPlanGenerate({ syncDir: SYNC_DIR, goal: args.goal, project_id: args.project_id, max_tasks: args.max_tasks }));
        case "status_update":
          if (!args.task_id || !args.status) return errText("tasks(op=status_update) requires task_id and status");
          return okText(await taskStatusUpdate({ syncDir: SYNC_DIR, task_id: args.task_id, status: args.status as any }));
        case "orchestrator_tick":
          return okText(await orchestratorTick({ syncDir: SYNC_DIR, project_id: args.project_id, limit: args.limit }));
        case "execution_bind_tick":
          return okText(await runExecutionBindTick(args.project_id, args.limit));
        case "recovery_tick":
          return okText(await runRecoveryTick(args.project_id, args.limit));
      }
    }
  );

  server.tool(
    "swe_guard",
    "SWE truth gate: verify claims via lab tools and block unproven completion",
    {
      op: z.enum(["verify_claims"]),
      claims: z.array(z.any()),
    },
    async (args) => {
      switch (args.op) {
        case "verify_claims":
          return okText(await handleProjectTask({ task: "swe_guard_verify_claims", claims: args.claims }));
      }
    }
  );

  server.tool(
    "swe_bridge",
    "Realtime bridge between controller and SWE via queue/events with ACK loop",
    {
      op: z.enum(["send", "poll", "drain", "feedback", "status"]),
      session_id: z.string().optional(),
      instruction: z.string().optional(),
      role: z.enum(["planner", "dev", "research", "critic"]).optional(),
      project_id: z.string().optional(),
      task_id: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      require_evidence: z.boolean().optional(),
      claims: z.array(z.any()).optional(),
      execute_now: z.boolean().optional(),
      drain_limit: z.number().int().min(1).max(100).optional(),
      events_limit: z.number().int().min(1).max(200).optional(),
      verdict: z.enum(["approved", "rejected", "needs_revision"]).optional(),
      note: z.string().optional(),
    },
    async (args) => {
      const op = args.op;
      const eventsLimit = Math.max(1, Math.min(200, Math.trunc(Number(args.events_limit ?? 30))));
      const sessionId = (typeof args.session_id === "string" && args.session_id.trim())
        ? args.session_id.trim()
        : `swe-bridge:${new Date().toISOString().slice(0, 10)}`;
      const getGraphTask = async (taskId?: string | null) => {
        const id = String(taskId ?? "").trim();
        if (!id) return null;
        try {
          const graph = await taskGraph({ syncDir: SYNC_DIR, project_id: args.project_id });
          const items = Array.isArray((graph as any)?.items)
            ? (graph as any).items
            : (Array.isArray((graph as any)?.nodes) ? (graph as any).nodes : []);
          return items.find((n: any) => String(n?.task_id ?? "") === id) ?? null;
        } catch {
          return null;
        }
      };

      if (op === "status") {
        const [research, meta, campaign] = await Promise.all([
          queueDepth({ syncDir: SYNC_DIR, logical_queue: "research" }),
          queueDepth({ syncDir: SYNC_DIR, logical_queue: "meta" }),
          queueDepth({ syncDir: SYNC_DIR, logical_queue: "campaign" }),
        ]);
        const protocol = await protocolReadCommand();
        const recent = await eventList({
          syncDir: SYNC_DIR,
          conversation_id: sessionId,
          limit: eventsLimit,
        });
        return okText({
          session_id: sessionId,
          queue_depth: {
            research: Number(research.pending ?? 0) + Number(research.running ?? 0),
            meta: Number(meta.pending ?? 0) + Number(meta.running ?? 0),
            campaign: Number(campaign.pending ?? 0) + Number(campaign.running ?? 0),
          },
          protocol,
          recent_events: recent.items ?? [],
        });
      }

      if (op === "send") {
        const instruction = String(args.instruction ?? "").trim();
        if (!instruction) return errText("swe_bridge(op=send) requires instruction");
        const role = (args.role ?? "dev") as AgentRole;
        const taskId = (typeof args.task_id === "string" && args.task_id.trim())
          ? args.task_id.trim()
          : `swe-bridge-task-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const title = String(args.title ?? `SWE Bridge: ${instruction.slice(0, 96)}`);
        const description = String(args.description ?? instruction);
        const requireEvidence = args.require_evidence ?? (role === "dev");
        const claims = Array.isArray(args.claims) ? args.claims : [];

        await taskCreate({
          syncDir: SYNC_DIR,
          task_id: taskId,
          project_id: args.project_id,
          role,
          title,
          description,
          status: "open",
        });

        const queued = await queuePush({
          syncDir: SYNC_DIR,
          type: "project_task",
          logical_queue: "research",
          source: "swe-bridge",
          payload: {
            command: "agent_run_task",
            task_id: taskId,
            role,
            title,
            description,
            project_id: args.project_id,
            require_evidence: requireEvidence,
            claims,
          },
        });

        await eventPublish({
          syncDir: SYNC_DIR,
          type: "swe.bridge.command",
          source: "codex-bridge",
          direction: "outbound",
          conversation_id: sessionId,
          dedupe_key: `swe-bridge:command:${taskId}`,
          payload: {
            task_id: taskId,
            role,
            instruction,
            require_evidence: requireEvidence,
            claims_count: claims.length,
            job_id: queued.job_id,
          },
        });

        const executeNow = args.execute_now !== false;
        const immediate = executeNow ? await runRouterExecuteFromQueue("research") : { status: "queued_only" };
        const task = await getGraphTask(taskId);
        return okText({
          session_id: sessionId,
          task_id: taskId,
          role,
          queued,
          immediate,
          task,
        });
      }

      if (op === "drain") {
        const limit = Math.max(1, Math.min(100, Math.trunc(Number(args.drain_limit ?? 5))));
        const results: any[] = [];
        for (let i = 0; i < limit; i += 1) {
          const step = await runRouterExecuteFromQueue("research");
          results.push(step);
          if (String(step?.status ?? "") === "idle") break;
        }
        const recent = await eventList({
          syncDir: SYNC_DIR,
          conversation_id: sessionId,
          limit: eventsLimit,
        });
        return okText({
          session_id: sessionId,
          drain_limit: limit,
          steps: results,
          recent_events: recent.items ?? [],
        });
      }

      if (op === "poll") {
        const taskId = String(args.task_id ?? "").trim();
        const recent = await eventList({
          syncDir: SYNC_DIR,
          conversation_id: sessionId,
          limit: eventsLimit,
        });
        const task = await getGraphTask(taskId);
        const history = await jobHistoryList({
          syncDir: SYNC_DIR,
          logical_queue: "research",
          limit: 20,
        });
        return okText({
          session_id: sessionId,
          task_id: taskId || null,
          task,
          recent_events: recent.items ?? [],
          research_history: history.items ?? [],
        });
      }

      if (op === "feedback") {
        const taskId = String(args.task_id ?? "").trim();
        if (!taskId) return errText("swe_bridge(op=feedback) requires task_id");
        const verdict = args.verdict ?? "needs_revision";
        const note = String(args.note ?? "");
        const nextStatus = verdict === "approved" ? "done" : verdict === "rejected" ? "error" : "in_progress";
        await taskStatusUpdate({
          syncDir: SYNC_DIR,
          task_id: taskId,
          status: nextStatus as any,
        });
        const event = await eventPublish({
          syncDir: SYNC_DIR,
          type: "swe.bridge.feedback",
          source: "codex-bridge",
          direction: "outbound",
          conversation_id: sessionId,
          dedupe_key: `swe-bridge:feedback:${taskId}:${verdict}`,
          payload: { task_id: taskId, verdict, note },
        });
        const task = await tasksGet({ syncDir: SYNC_DIR, id: taskId });
        return okText({
          session_id: sessionId,
          task_id: taskId,
          verdict,
          event,
          task,
        });
      }

      return errText(`Unknown swe_bridge op: ${String(op)}`);
    }
  );

  server.tool(
    "fs",
    "Filesystem multiplexer: list/read/write/mkdir/exists/read_content/write_content",
    {
      op: z.enum(["list", "read", "write", "mkdir", "exists", "read_content", "write_content"]),
      dir: z.string().optional(),
      path: z.string().optional(),
      url: z.string().optional(),
      limit: z.number().int().min(1).max(5000).optional(),
      max_bytes: z.number().int().min(1).max(2_000_000).optional(),
      content: z.any().optional(),
      create: z.boolean().optional(),
      create_empty: z.boolean().optional(),
    },
    async (args) => {
      const normalizeFsContent = (value: unknown): string => {
        if (typeof value === "string") return value;
        if (value == null) return "";
        if (typeof value === "number" || typeof value === "boolean") return String(value);
        try {
          return JSON.stringify(value, null, 2);
        } catch {
          return String(value);
        }
      };
      switch (args.op) {
        case "list": {
          if (!args.dir) return errText("fs(op=list) requires dir");
          const base = assertInAllowedRoots(args.dir);
          const entries = await fs.readdir(base, { withFileTypes: true });
          const out = entries.slice(0, args.limit ?? 2000).map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
          return okText({ dir: base, entries: out });
        }
        case "read": {
          if (!args.path) return errText("fs(op=read) requires path");
          const rp = assertInAllowedRoots(args.path);
          const st = await fs.stat(rp);
          const limit = args.max_bytes ?? 500_000;
          if (st.size > limit) return errText(`File too large (${st.size} bytes), limit=${limit}`);
          const content = await fs.readFile(rp, "utf8");
          return okText({ path: rp, content, size: st.size });
        }
        case "write": {
          if (!args.path) return errText("fs(op=write) requires path");
          if (args.content === undefined) return errText("fs(op=write) requires content");
          const rp = assertInAllowedRoots(args.path);
          const dir = path.dirname(rp);
          await fs.mkdir(dir, { recursive: true });
          if (args.create === false) {
            try { await fs.access(rp); } catch { return errText("File does not exist (create=false)"); }
          }
          const out = normalizeFsContent(args.content);
          await fs.writeFile(rp, out, "utf8");
          return okText({ written: true, path: rp, bytes: Buffer.byteLength(out, "utf8") });
        }
        case "mkdir": {
          if (!args.path) return errText("fs(op=mkdir) requires path");
          const resolved = path.resolve(args.path);
          const isAllowed = ROOTS_FINAL.some(root => resolved.startsWith(root));
          if (!isAllowed) return errText(`Path outside allowed roots: ${args.path}`);
          await fs.mkdir(resolved, { recursive: true });
          return okText({ created: true, path: resolved });
        }
        case "exists": {
          if (!args.path) return errText("fs(op=exists) requires path");
          const resolved = path.resolve(args.path);
          const isAllowed = ROOTS_FINAL.some(root => resolved.startsWith(root));
          if (!isAllowed) return errText(`Path outside allowed roots: ${args.path}`);
          try {
            const stat = await fs.stat(resolved);
            return okText({ exists: true, type: stat.isDirectory() ? "dir" : "file" });
          } catch (error: any) {
            if (error.code === "ENOENT") return okText({ exists: false, type: null });
            return errText(`Failed to check path: ${error.message}`);
          }
        }
        case "read_content": {
          const p = args.url ?? args.path;
          if (!p) return errText("fs(op=read_content) requires url/path");
          const content = await fs.readFile(p, "utf-8");
          return okText({ path: p, content });
        }
        case "write_content": {
          if (!args.path) return errText("fs(op=write_content) requires path");
          const resolved = assertInAllowedRoots(args.path);
          const dir = path.dirname(resolved);
          await fs.mkdir(dir, { recursive: true });
          if (args.create_empty) await fs.writeFile(resolved, "", "utf-8");
          else await fs.writeFile(resolved, normalizeFsContent(args.content), "utf-8");
          return okText({ written: true, path: resolved });
        }
      }
    }
  );

  server.tool(
    "protocol",
    "Protocol multiplexer: init/read/write/status/report/logs",
    {
      op: z.enum(["init", "write_command", "read_command", "update_status", "write_report", "write_logs"]),
      command: z.string().optional(),
      status: z.enum(["idle", "running", "done", "error"]).optional(),
      error: z.string().optional(),
      title: z.string().optional(),
      content: z.string().optional(),
      logs: z.string().optional(),
    },
    async (args) => {
      switch (args.op) {
        case "init":
          return await protocolInit();
        case "write_command":
          if (!args.command) return errText("protocol(op=write_command) requires command");
          return await protocolWriteCommand(args.command);
        case "read_command":
          return await protocolReadCommand();
        case "update_status":
          if (!args.status) return errText("protocol(op=update_status) requires status");
          return await protocolUpdateStatus(args.status, args.error);
        case "write_report":
          if (!args.title || typeof args.content !== "string") return errText("protocol(op=write_report) requires title and content");
          return await protocolWriteReport(args.title, args.content);
        case "write_logs":
          if (typeof args.logs !== "string") return errText("protocol(op=write_logs) requires logs");
          return await protocolWriteLogs(args.logs);
      }
    }
  );

  server.tool(
    "sync",
    "Sync multiplexer: outbound/inbound/status/reconcile/enqueue_inbound",
    {
      op: z.enum(["outbound_once", "inbound_once", "status", "reconcile", "enqueue_inbound"]),
      batch_size: z.number().int().min(1).max(500).optional(),
      conversation_id: z.string().optional(),
      response_id: z.string().optional(),
      dedupe_key: z.string().optional(),
    },
    async (args) => {
      switch (args.op) {
        case "outbound_once":
          return okText(await runSyncOutboundOnce(args.batch_size));
        case "inbound_once":
          return okText(await runSyncInboundOnce(args.batch_size));
        case "status":
          return okText(await runSyncStatus());
        case "reconcile":
          return okText(await runSyncReconcile());
        case "enqueue_inbound":
          if (!args.conversation_id || !args.response_id) return errText("sync(op=enqueue_inbound) requires conversation_id and response_id");
          return okText(await runEnqueueInboundResponseId(args.conversation_id, args.response_id, args.dedupe_key));
      }
    }
  );

  async function runSearchWeb(args: any) {
    const query = String(args?.query ?? "").trim();
    if (!query) throw new Error("search_web requires query");
    const maxResults = Math.max(1, Math.min(8, Number(args?.max_results ?? 5) || 5));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const res = await fetch(url, { signal: controller.signal });
      const raw = await res.text();
      if (!res.ok) {
        throw new Error(`search_web HTTP ${res.status}: ${raw.slice(0, 300)}`);
      }
      const json = raw ? JSON.parse(raw) : {};
      const related = Array.isArray(json?.RelatedTopics) ? json.RelatedTopics : [];
      const flat: Array<{ text: string; url?: string }> = [];
      for (const item of related) {
        if (item && typeof item.Text === "string") {
          flat.push({ text: item.Text, url: item.FirstURL });
        } else if (item && Array.isArray(item.Topics)) {
          for (const sub of item.Topics) {
            if (sub && typeof sub.Text === "string") {
              flat.push({ text: sub.Text, url: sub.FirstURL });
            }
          }
        }
        if (flat.length >= maxResults) break;
      }
      return {
        query,
        heading: String(json?.Heading ?? ""),
        abstract: String(json?.AbstractText ?? ""),
        answer: String(json?.Answer ?? ""),
        results: flat.slice(0, maxResults),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function runReadUrlContent(args: any) {
    const urlRaw = String(args?.url ?? "").trim();
    if (!urlRaw) throw new Error("read_url_content requires url");
    const parsed = new URL(urlRaw);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`Unsupported protocol: ${parsed.protocol}`);
    }
    const maxChars = Math.max(500, Math.min(200_000, Number(args?.max_chars ?? 30_000) || 30_000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(parsed.toString(), { signal: controller.signal });
      const raw = await res.text();
      if (!res.ok) {
        throw new Error(`read_url_content HTTP ${res.status}: ${raw.slice(0, 300)}`);
      }
      const normalized = raw.replace(/\r\n/g, "\n");
      return {
        url: parsed.toString(),
        final_url: res.url || parsed.toString(),
        status: res.status,
        content_type: String(res.headers.get("content-type") ?? ""),
        content_length: normalized.length,
        content: normalized.slice(0, maxChars),
        truncated: normalized.length > maxChars,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function runViewContentChunk(args: any) {
    const start = Math.max(0, Number(args?.start ?? 0) || 0);
    const length = Math.max(100, Math.min(50_000, Number(args?.length ?? 2_000) || 2_000));
    let content = String(args?.content ?? "");
    let source = "";
    if (!content) {
      const read = await runReadUrlContent({ url: args?.url, max_chars: Math.max(start + length, 10_000) });
      content = String(read.content ?? "");
      source = String(read.final_url ?? read.url ?? "");
    }
    const total = content.length;
    const from = Math.min(start, total);
    const to = Math.min(from + length, total);
    return {
      source,
      total_length: total,
      start: from,
      end: to,
      length: to - from,
      chunk: content.slice(from, to),
      has_more: to < total,
    };
  }

  async function runFsProjects(args: any) {
    const root = "C:\\Users\\anani\\Projects";
    const inputPath = String(args?.path ?? "").trim();
    const target = inputPath
      ? (path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(root, inputPath))
      : root;
    const isAllowed = target === root || target.startsWith(root + path.sep);
    if (!isAllowed) throw new Error(`Path outside allowed root: ${target}`);
    const limit = Math.max(1, Math.min(200, Number(args?.limit ?? 100) || 100));
    const entries = await fs.readdir(target, { withFileTypes: true });
    const out = entries
      .slice(0, limit)
      .map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
        path: path.join(target, e.name),
      }));
    return { root, target, count: out.length, entries: out };
  }

  const terminalCommandCache = new Map<string, {
    command_id: string;
    cmd: string;
    cwd: string;
    exit_code: number;
    stdout: string;
    stderr: string;
    started_at: string;
    finished_at: string;
    duration_ms: number;
  }>();

  async function runTerminalBash(args: any) {
    const cmdText = String(args?.cmd ?? "").trim();
    if (!cmdText) throw new Error("bash requires cmd");
    const cwdRaw = String(args?.cwd ?? process.cwd());
    const cwd = path.resolve(cwdRaw);
    const isAllowed = ROOTS_FINAL.some(root => cwd.startsWith(root));
    if (!isAllowed) throw new Error(`cwd outside allowed roots: ${cwd}`);
    const commandId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const started = new Date();
    const timeoutMs = Math.max(1000, Math.min(180_000, Number(args?.timeout_ms ?? 60_000) || 60_000));
    const maxOut = Math.max(2048, Math.min(2_000_000, Number(args?.max_output_bytes ?? 400_000) || 400_000));

    const result = await new Promise<{
      exit_code: number;
      stdout: string;
      stderr: string;
      duration_ms: number;
      timed_out: boolean;
    }>((resolve) => {
      const child = spawn("powershell", ["-NoProfile", "-Command", cmdText], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const t0 = Date.now();
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch {}
      }, timeoutMs);
      child.stdout?.on("data", (buf: Buffer) => {
        if (stdout.length < maxOut) stdout += buf.toString("utf8");
      });
      child.stderr?.on("data", (buf: Buffer) => {
        if (stderr.length < maxOut) stderr += buf.toString("utf8");
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({
          exit_code: code ?? 0,
          stdout: stdout.slice(0, maxOut),
          stderr: stderr.slice(0, maxOut),
          duration_ms: Date.now() - t0,
          timed_out: timedOut,
        });
      });
      child.on("error", (err: Error) => {
        clearTimeout(timer);
        resolve({
          exit_code: -1,
          stdout,
          stderr: String(err.message || err),
          duration_ms: Date.now() - t0,
          timed_out: timedOut,
        });
      });
    });

    const finished = new Date();
    terminalCommandCache.set(commandId, {
      command_id: commandId,
      cmd: cmdText,
      cwd,
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
      duration_ms: result.duration_ms,
    });

    return {
      command_id: commandId,
      cmd: cmdText,
      cwd,
      ...result,
    };
  }

  async function runTerminalFindByName(args: any) {
    const rootRaw = String(args?.root ?? process.cwd()).trim();
    const root = assertInAllowedRoots(rootRaw);
    const needle = String(args?.name ?? "").trim().toLowerCase();
    if (!needle) throw new Error("find_by_name requires name");
    const maxResults = Math.max(1, Math.min(500, Number(args?.max_results ?? 100) || 100));
    const out: string[] = [];
    const stack: string[] = [root];
    while (stack.length > 0 && out.length < maxResults) {
      const dir = stack.pop() as string;
      let entries: any[] = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (out.length >= maxResults) break;
        const full = path.join(dir, e.name);
        if (e.name.toLowerCase().includes(needle)) out.push(full);
        if (e.isDirectory()) stack.push(full);
      }
    }
    return { root, name: needle, count: out.length, matches: out };
  }

  async function runTerminalGrep(args: any) {
    const pattern = String(args?.pattern ?? "").trim();
    if (!pattern) throw new Error("grep_search requires pattern");
    const rootRaw = String(args?.root ?? process.cwd()).trim();
    const root = assertInAllowedRoots(rootRaw);
    const maxResults = Math.max(1, Math.min(1000, Number(args?.max_results ?? 200) || 200));
    const regex = new RegExp(pattern, "i");
    const files: string[] = [];
    const stack: string[] = [root];
    const maxFiles = Math.max(10, Math.min(3000, Number(args?.max_files ?? 500) || 500));
    while (stack.length > 0 && files.length < maxFiles) {
      const dir = stack.pop() as string;
      let entries: any[] = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) files.push(full);
        if (files.length >= maxFiles) break;
      }
    }
    const hits: Array<{ path: string; line: number; text: string }> = [];
    for (const f of files) {
      if (hits.length >= maxResults) break;
      let txt = "";
      try { txt = await fs.readFile(f, "utf8"); } catch { continue; }
      const lines = txt.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (regex.test(lines[i])) {
          hits.push({ path: f, line: i + 1, text: lines[i].slice(0, 300) });
          if (hits.length >= maxResults) break;
        }
      }
    }
    return { root, pattern, scanned_files: files.length, count: hits.length, hits };
  }

  server.tool(
    "terminal_swe",
    "Terminal SWE compatibility multiplexer (IDE-like ops mapped to MCP).",
    {
      op: z.enum([
        "read_file", "write_to_file", "edit", "multi_edit", "read_notebook", "edit_notebook",
        "list_dir", "find_by_name", "grep_search",
        "search_web", "read_url_content", "view_content_chunk",
        "bash", "command_status", "read_terminal",
        "browser_preview",
        "todo_list", "create_memory",
        "list_resources", "read_resource"
      ]),
      path: z.string().optional(),
      root: z.string().optional(),
      name: z.string().optional(),
      pattern: z.string().optional(),
      max_results: z.number().int().min(1).max(1000).optional(),
      max_files: z.number().int().min(1).max(5000).optional(),
      content: z.string().optional(),
      old_text: z.string().optional(),
      new_text: z.string().optional(),
      replace_all: z.boolean().optional(),
      edits: z.array(z.object({ old_text: z.string(), new_text: z.string(), replace_all: z.boolean().optional() })).optional(),
      cell_index: z.number().int().min(0).optional(),
      query: z.string().optional(),
      url: z.string().optional(),
      start: z.number().int().min(0).optional(),
      length: z.number().int().min(100).max(50_000).optional(),
      cmd: z.string().optional(),
      cwd: z.string().optional(),
      timeout_ms: z.number().int().min(1000).max(180000).optional(),
      command_id: z.string().optional(),
      list_limit: z.number().int().min(1).max(500).optional(),
      action: z.enum(["list", "add", "update", "delete"]).optional(),
      id: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(["todo", "doing", "done", "blocked"]).optional(),
      labels: z.array(z.string()).optional(),
      project_id: z.string().optional(),
      type: z.string().optional(),
      tags: z.array(z.string()).optional(),
      memory_content: z.string().optional(),
      uri: z.string().optional(),
    },
    async (args) => {
      switch (args.op) {
        case "read_file":
          return okText(await fs.readFile(assertInAllowedRoots(String(args.path ?? "")), "utf8"));
        case "write_to_file": {
          const p = assertInAllowedRoots(String(args.path ?? ""));
          await fs.mkdir(path.dirname(p), { recursive: true });
          await fs.writeFile(p, String(args.content ?? ""), "utf8");
          return okText({ written: true, path: p });
        }
        case "edit": {
          const p = assertInAllowedRoots(String(args.path ?? ""));
          const oldText = String(args.old_text ?? "");
          const newText = String(args.new_text ?? "");
          if (!oldText) return errText("edit requires old_text");
          const src = await fs.readFile(p, "utf8");
          const replaced = args.replace_all ? src.split(oldText).join(newText) : src.replace(oldText, newText);
          if (replaced === src) return errText("edit: old_text not found");
          await fs.writeFile(p, replaced, "utf8");
          return okText({ edited: true, path: p });
        }
        case "multi_edit": {
          const p = assertInAllowedRoots(String(args.path ?? ""));
          const edits = Array.isArray(args.edits) ? args.edits : [];
          if (edits.length === 0) return errText("multi_edit requires edits[]");
          let src = await fs.readFile(p, "utf8");
          let changed = 0;
          for (const e of edits) {
            const oldText = String(e.old_text ?? "");
            const newText = String(e.new_text ?? "");
            const next = e.replace_all ? src.split(oldText).join(newText) : src.replace(oldText, newText);
            if (next !== src) changed += 1;
            src = next;
          }
          await fs.writeFile(p, src, "utf8");
          return okText({ edited: true, path: p, edits_applied: changed });
        }
        case "read_notebook": {
          const p = assertInAllowedRoots(String(args.path ?? ""));
          const raw = await fs.readFile(p, "utf8");
          const nb = JSON.parse(raw);
          const cells = Array.isArray(nb?.cells) ? nb.cells : [];
          return okText({
            path: p,
            nbformat: nb?.nbformat ?? null,
            cell_count: cells.length,
            cells: cells.map((c: any, i: number) => ({ index: i, cell_type: c?.cell_type, source: String((Array.isArray(c?.source) ? c.source.join("") : c?.source ?? "")).slice(0, 500) })),
          });
        }
        case "edit_notebook": {
          const p = assertInAllowedRoots(String(args.path ?? ""));
          const idx = Number(args.cell_index ?? -1);
          if (idx < 0) return errText("edit_notebook requires cell_index");
          const raw = await fs.readFile(p, "utf8");
          const nb = JSON.parse(raw);
          const cells = Array.isArray(nb?.cells) ? nb.cells : [];
          if (idx >= cells.length) return errText(`edit_notebook cell_index out of range: ${idx}`);
          cells[idx].source = String(args.content ?? "");
          nb.cells = cells;
          await fs.writeFile(p, JSON.stringify(nb, null, 2), "utf8");
          return okText({ edited: true, path: p, cell_index: idx });
        }
        case "list_dir": {
          const dir = assertInAllowedRoots(String(args.path ?? args.root ?? process.cwd()));
          const entries = await fs.readdir(dir, { withFileTypes: true });
          const out = entries.slice(0, args.list_limit ?? 200).map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other" }));
          return okText({ dir, entries: out, count: out.length });
        }
        case "find_by_name":
          return okText(await runTerminalFindByName(args));
        case "grep_search":
          return okText(await runTerminalGrep(args));
        case "search_web":
          return okText(await runSearchWeb(args));
        case "read_url_content":
          return okText(await runReadUrlContent(args));
        case "view_content_chunk":
          return okText(await runViewContentChunk(args));
        case "bash":
          return okText(await runTerminalBash(args));
        case "command_status": {
          const id = String(args.command_id ?? "");
          if (!id) return errText("command_status requires command_id");
          const item = terminalCommandCache.get(id);
          if (!item) return errText(`command_id not found: ${id}`);
          return okText(item);
        }
        case "read_terminal": {
          const id = String(args.command_id ?? "");
          if (!id) return errText("read_terminal requires command_id");
          const item = terminalCommandCache.get(id);
          if (!item) return errText(`command_id not found: ${id}`);
          return okText({ command_id: id, stdout: item.stdout, stderr: item.stderr, exit_code: item.exit_code });
        }
        case "browser_preview": {
          const url = String(args.url ?? "").trim();
          if (!url) return errText("browser_preview requires url");
          return okText({ preview_url: url, note: "IDE-native browser preview is not available via MCP server; returning URL." });
        }
        case "todo_list": {
          const action = String(args.action ?? "list");
          if (action === "list") return okText(await tasksList({ syncDir: SYNC_DIR, limit: args.list_limit ?? 50 }));
          if (action === "add") {
            if (!args.title) return errText("todo_list(action=add) requires title");
            return okText(await tasksUpsert({
              syncDir: SYNC_DIR,
              id: args.id,
              title: String(args.title),
              description: String(args.description ?? ""),
              status: args.status ?? "todo",
              labels: args.labels,
            }));
          }
          if (action === "update") {
            if (!args.id || !args.title) return errText("todo_list(action=update) requires id and title");
            return okText(await tasksUpsert({
              syncDir: SYNC_DIR,
              id: String(args.id),
              title: String(args.title),
              description: String(args.description ?? ""),
              status: args.status ?? "todo",
              labels: args.labels,
            }));
          }
          if (action === "delete") {
            if (!args.id) return errText("todo_list(action=delete) requires id");
            return okText(await tasksDelete({ syncDir: SYNC_DIR, id: String(args.id) }));
          }
          return errText(`Unsupported todo_list action: ${action}`);
        }
        case "create_memory": {
          if (!args.memory_content && !args.content) return errText("create_memory requires memory_content/content");
          return okText(await memoryStore({
            syncDir: SYNC_DIR,
            project_id: String(args.project_id ?? "global"),
            type: String(args.type ?? "note"),
            tags: args.tags,
            content: String(args.memory_content ?? args.content ?? ""),
          }));
        }
        case "list_resources":
          return okText({
            roots: ROOTS_FINAL,
            resources: [
              { uri: "file://_sync/CAPABILITIES.md", type: "file", note: "Capabilities source" },
              { uri: "file://_sync/events.jsonl", type: "file", note: "Event log" },
              { uri: "file://_sync/tools_snapshot.json", type: "file", note: "Tools snapshot" },
            ],
          });
        case "read_resource": {
          const uri = String(args.uri ?? "");
          if (!uri) return errText("read_resource requires uri");
          const p = uri.startsWith("file://") ? uri.replace(/^file:\/\//, "") : uri;
          const resolved = assertInAllowedRoots(path.isAbsolute(p) ? p : path.join(process.cwd(), p));
          const content = await fs.readFile(resolved, "utf8");
          return okText({ uri, path: resolved, content });
        }
      }
    }
  );

  server.tool(
    "web",
    "Web multiplexer: search/read/chunk (internet helper for SWE and agents)",
    {
      op: z.enum(["search", "read", "chunk"]),
      query: z.string().optional(),
      max_results: z.number().int().min(1).max(8).optional(),
      url: z.string().optional(),
      max_chars: z.number().int().min(500).max(200_000).optional(),
      content: z.string().optional(),
      start: z.number().int().min(0).optional(),
      length: z.number().int().min(100).max(50_000).optional(),
    },
    async (args) => {
      switch (args.op) {
        case "search":
          return okText(await runSearchWeb(args));
        case "read":
          return okText(await runReadUrlContent(args));
        case "chunk":
          return okText(await runViewContentChunk(args));
      }
    }
  );

  server.tool(
    "search_web",
    "Search web by query (compat alias).",
    {
      query: z.string(),
      max_results: z.number().int().min(1).max(8).optional(),
    },
    async (args) => okText(await runSearchWeb(args))
  );

  server.tool(
    "read_url_content",
    "Read web page content by URL (compat alias).",
    {
      url: z.string(),
      max_chars: z.number().int().min(500).max(200_000).optional(),
    },
    async (args) => okText(await runReadUrlContent(args))
  );

  server.tool(
    "view_content_chunk",
    "View a chunk from content or URL (compat alias).",
    {
      url: z.string().optional(),
      content: z.string().optional(),
      start: z.number().int().min(0).optional(),
      length: z.number().int().min(100).max(50_000).optional(),
    },
    async (args) => okText(await runViewContentChunk(args))
  );

  server.tool(
    "fs_projects",
    "List files/dirs under C:\\Users\\anani\\Projects (compat helper).",
    {
      path: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (args) => okText(await runFsProjects(args))
  );

  registerLlmAgentChatTool({
    server,
    okText,
    errText,
    tools: {
      sync_status: async () => runSyncStatus(),
      intelligence_meta_snapshot: async (args) =>
        intelligenceMetaSnapshot({
          syncDir: SYNC_DIR,
          mutation_window: typeof args.mutation_window === "number" ? Math.trunc(args.mutation_window) : undefined,
          transfer_window: typeof args.transfer_window === "number" ? Math.trunc(args.transfer_window) : undefined,
          gihi_window: typeof args.gihi_window === "number" ? Math.trunc(args.gihi_window) : undefined,
          campaign_id: typeof args.campaign_id === "string" ? args.campaign_id : undefined,
        }),
      intelligence_health_snapshot: async () =>
        intelligenceHealthSnapshot({ syncDir: SYNC_DIR }),
      arena_telemetry_snapshot: async (args) =>
        arenaTelemetrySnapshot({
          syncDir: SYNC_DIR,
          limit_domains: typeof args.limit_domains === "number" ? Math.trunc(args.limit_domains) : undefined,
        }),
      transfer_diagnostics: async () =>
        transferDiagnosticsSnapshot({ syncDir: SYNC_DIR }),
      mutation_effectiveness_snapshot: async () =>
        mutationEffectivenessSnapshot({ syncDir: SYNC_DIR }),
      lineage_snapshot: async (args) =>
        lineageSnapshot({
          syncDir: SYNC_DIR,
          role: typeof args.role === "string" ? args.role as AgentRole : undefined,
          limit: typeof args.limit === "number" ? Math.trunc(args.limit) : undefined,
        }),
      research_agenda_tick: async (args) =>
        runResearchAgendaTick({
          project_id: typeof args.project_id === "string" ? args.project_id : undefined,
          campaign_id: typeof args.campaign_id === "string" ? args.campaign_id : undefined,
          top_domains: typeof args.top_domains === "number" ? Math.trunc(args.top_domains) : undefined,
          transfer_window: typeof args.transfer_window === "number" ? Math.trunc(args.transfer_window) : undefined,
          mutation_window: typeof args.mutation_window === "number" ? Math.trunc(args.mutation_window) : undefined,
          gihi_window: typeof args.gihi_window === "number" ? Math.trunc(args.gihi_window) : undefined,
          publish_only: typeof args.publish_only === "boolean" ? args.publish_only : undefined,
          dry_run: typeof args.dry_run === "boolean" ? args.dry_run : undefined,
          batch_size: typeof args.batch_size === "number" ? Math.trunc(args.batch_size) : undefined,
        }),
      patch_proposal_tick: async (args) =>
        runPatchProposalTick({
          project_id: typeof args.project_id === "string" ? args.project_id : undefined,
          top_domains: typeof args.top_domains === "number" ? Math.trunc(args.top_domains) : undefined,
          transfer_window: typeof args.transfer_window === "number" ? Math.trunc(args.transfer_window) : undefined,
          mutation_window: typeof args.mutation_window === "number" ? Math.trunc(args.mutation_window) : undefined,
          gihi_window: typeof args.gihi_window === "number" ? Math.trunc(args.gihi_window) : undefined,
          publish_only: typeof args.publish_only === "boolean" ? args.publish_only : undefined,
          dry_run: typeof args.dry_run === "boolean" ? args.dry_run : undefined,
          batch_size: typeof args.batch_size === "number" ? Math.trunc(args.batch_size) : undefined,
        }),
      patch_test_tick: async (args) =>
        runPatchTestTick({
          limit: typeof args.limit === "number" ? Math.trunc(args.limit) : undefined,
          timeout_ms: typeof args.timeout_ms === "number" ? Math.trunc(args.timeout_ms) : undefined,
          max_commands: typeof args.max_commands === "number" ? Math.trunc(args.max_commands) : undefined,
        }),
      patch_governance_tick: async (args) =>
        runPatchGovernanceTick({
          dry_run: typeof args.dry_run === "boolean" ? args.dry_run : undefined,
          limit: typeof args.limit === "number" ? Math.trunc(args.limit) : undefined,
          auto_activate: typeof args.auto_activate === "boolean" ? args.auto_activate : undefined,
          auto_apply_repo: typeof args.auto_apply_repo === "boolean" ? args.auto_apply_repo : undefined,
          auto_commit_repo: typeof args.auto_commit_repo === "boolean" ? args.auto_commit_repo : undefined,
          timeout_ms: typeof args.timeout_ms === "number" ? Math.trunc(args.timeout_ms) : undefined,
          max_commands: typeof args.max_commands === "number" ? Math.trunc(args.max_commands) : undefined,
        }),
      search_web: async (args) => runSearchWeb(args),
      read_url_content: async (args) => runReadUrlContent(args),
      view_content_chunk: async (args) => runViewContentChunk(args),
      fs_projects: async (args) => runFsProjects(args),
      web: async (args) => {
        const op = String(args.op ?? "").trim();
        if (op === "search") return runSearchWeb(args);
        if (op === "read") return runReadUrlContent(args);
        if (op === "chunk") return runViewContentChunk(args);
        throw new Error("web tool requires op=search|read|chunk");
      },
    },
  });

  server.tool(
    "experiment",
    "Experiment multiplexer: create/run/list/compare/leaderboard/best/search_tick",
    {
      op: z.enum(["create", "run", "list", "compare", "leaderboard", "best", "search_tick"]),
      experiment_id: z.string().optional(),
      name: z.string().optional(),
      objective: z.string().optional(),
      metadata: z.record(z.any()).optional(),
      metric_schema: z.record(z.any()).optional(),
      search_space: z.record(z.any()).optional(),
      search_strategy: z.string().optional(),
      strategy: z.string().optional(),
      params: z.record(z.any()).optional(),
      run_id: z.string().optional(),
      status: z.string().optional(),
      metrics: z.record(z.any()).optional(),
      notes: z.string().optional(),
      duration_ms: z.number().optional(),
      task_id: z.string().optional(),
      exec_command: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      batch_size: z.number().int().min(1).max(200).optional(),
    },
    async (args) => {
      switch (args.op) {
        case "create":
          if (!args.name || !args.objective) return errText("experiment(op=create) requires name and objective");
          return okText(await experimentCreate({
            syncDir: SYNC_DIR,
            experiment_id: args.experiment_id,
            name: args.name,
            objective: args.objective,
            metadata: args.metadata,
            metric_schema: args.metric_schema,
            search_space: args.search_space,
            search_strategy: args.search_strategy as any,
            strategy: args.strategy as any,
          }));
        case "run":
          if (!args.experiment_id || !args.params) return errText("experiment(op=run) requires experiment_id and params");
          return okText(await experimentRun({
            syncDir: SYNC_DIR,
            experiment_id: args.experiment_id,
            params: args.params,
            run_id: args.run_id,
            status: args.status as any,
            metrics: args.metrics,
            notes: args.notes,
            duration_ms: args.duration_ms,
            task_id: args.task_id,
          }));
        case "list":
          return okText(await experimentList({ syncDir: SYNC_DIR, status: args.status as any, limit: args.limit }));
        case "compare":
          if (!args.experiment_id) return errText("experiment(op=compare) requires experiment_id");
          return okText(await experimentCompare({ syncDir: SYNC_DIR, experiment_id: args.experiment_id }));
        case "leaderboard":
          if (!args.experiment_id) return errText("experiment(op=leaderboard) requires experiment_id");
          return okText(await experimentLeaderboard({ syncDir: SYNC_DIR, experiment_id: args.experiment_id, limit: args.limit }));
        case "best":
          if (!args.experiment_id) return errText("experiment(op=best) requires experiment_id");
          return okText(await experimentBest({ syncDir: SYNC_DIR, experiment_id: args.experiment_id }));
        case "search_tick":
          if (!args.experiment_id) return errText("experiment(op=search_tick) requires experiment_id");
          return okText(await runExperimentSearchTickWithResearchProfile({ experiment_id: args.experiment_id, batch_size: args.batch_size }));
      }
    }
  );

  server.tool(
    "campaign",
    "Campaign multiplexer: create/tick/watchdog/report/list",
    {
      op: z.enum(["create", "tick", "watchdog_tick", "report_generate", "list"]),
      campaign_id: z.string().optional(),
      goal: z.string().optional(),
      objective: z.any().optional(),
      constraints: z.record(z.any()).optional(),
      max_experiments: z.number().int().min(1).max(10000).optional(),
      stop_conditions: z.object({
        convergence_detected: z.boolean().optional(),
        min_gihi: z.number().min(0).max(1).optional(),
        gihi_below_threshold: z.number().min(0).max(1).optional(),
        max_experiments: z.number().int().min(1).max(10000).optional(),
        stagnation_rate_gt: z.number().min(0).max(1).optional(),
        max_ticks: z.number().int().min(1).max(100000).optional(),
        gihi_grace_ticks: z.number().int().min(0).max(1000).optional(),
      }).optional(),
      max_steps: z.number().int().min(1).max(50).optional(),
      status: z.enum(["draft", "running", "completed", "stopped", "failed"]).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      idle_ms: z.number().int().min(5_000).max(10 * 60_000).optional(),
      cooldown_ms: z.number().int().min(5_000).max(10 * 60_000).optional(),
      dry_run: z.boolean().optional(),
    },
    async (args) => {
      switch (args.op) {
        case "create":
          if (!args.goal) return errText("campaign(op=create) requires goal");
          return okText(await campaignCreate({
            syncDir: SYNC_DIR,
            campaign_id: args.campaign_id,
            goal: args.goal,
            objective: args.objective,
            constraints: args.constraints,
            max_experiments: args.max_experiments,
            stop_conditions: args.stop_conditions,
          }));
        case "tick":
          if (!args.campaign_id) return errText("campaign(op=tick) requires campaign_id");
          return okText(await enqueueCampaignTickJob({
            campaign_id: args.campaign_id,
            max_steps: args.max_steps,
            source: "campaign-api",
          }));
        case "watchdog_tick":
          return okText(await runCampaignWatchdogTick({
            idle_ms: args.idle_ms,
            cooldown_ms: args.cooldown_ms,
            limit: args.limit,
            dry_run: args.dry_run,
          }));
        case "report_generate":
          if (!args.campaign_id) return errText("campaign(op=report_generate) requires campaign_id");
          return okText(await campaignReportGenerate({
            syncDir: SYNC_DIR,
            campaign_id: args.campaign_id,
            snapshot: await buildCampaignSnapshot(await campaignGet({ syncDir: SYNC_DIR, campaign_id: args.campaign_id }).then((x) => x.campaign)),
          }));
        case "list":
          return okText(await campaignList({ syncDir: SYNC_DIR, status: args.status, limit: args.limit }));
      }
    }
  );

  // --- Phase 4: Notes Tools ---
  server.tool(
    "notes_upsert",
    "Create or update a note",
    {
      id: z.string().optional(),
      title: z.string(),
      content: z.string().optional(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    async ({ id, title, content, tags, body }) => {
      const result = await notesUpsert({
        syncDir: SYNC_DIR,
        id,
        title,
        content: content ?? body,
        tags,
      });
      return okText(result);
    }
  );

  server.tool(
    "notes_get",
    "Get a note by ID",
    {
      id: z.string(),
    },
    async ({ id }) => {
      const result = await notesGet({
        syncDir: SYNC_DIR,
        id,
      });
      return okText(result);
    }
  );

  server.tool(
    "notes_delete",
    "Delete a note by ID",
    {
      id: z.string(),
    },
    async ({ id }) => {
      const result = await notesDelete({
        syncDir: SYNC_DIR,
        id,
      });
      return okText(result);
    }
  );

  server.tool(
    "notes_list",
    "List notes with optional filtering",
    {
      limit: z.number().int().min(1).max(100).optional(),
      query: z.string().optional(),
    },
    async ({ limit, query }) => {
      const result = await notesList({
        syncDir: SYNC_DIR,
        limit,
        query,
      });
      return okText(result);
    }
  );

  // --- Phase 5: Tasks Tools ---
  server.tool(
    "tasks_upsert",
    "Create or update a task",
    {
      id: z.string().optional(),
      title: z.string(),
      description: z.string().optional(),
      status: z.enum(["todo", "doing", "done", "blocked"]).optional(),
      labels: z.array(z.string()).optional(),
    },
    async ({ id, title, description, status, labels }) => {
      const result = await tasksUpsert({
        syncDir: SYNC_DIR,
        id,
        title,
        description,
        status,
        labels,
      });
      return okText(result);
    }
  );

  server.tool(
    "tasks_get",
    "Get a task by ID",
    {
      id: z.string(),
    },
    async ({ id }) => {
      const result = await tasksGet({
        syncDir: SYNC_DIR,
        id,
      });
      return okText(result);
    }
  );

  server.tool(
    "tasks_delete",
    "Delete a task by ID",
    {
      id: z.string(),
    },
    async ({ id }) => {
      const result = await tasksDelete({
        syncDir: SYNC_DIR,
        id,
      });
      return okText(result);
    }
  );

  server.tool(
    "tasks_list",
    "List tasks with optional filtering",
    {
      limit: z.number().int().min(1).max(100).optional(),
      query: z.string().optional(),
      status: z.enum(["todo", "doing", "done", "blocked"]).optional(),
    },
    async ({ limit, query, status }) => {
      const result = await tasksList({
        syncDir: SYNC_DIR,
        limit,
        query,
        status,
      });
      return okText(result);
    }
  );

  // --- Phase 5.4: Task Graph Tools ---
  server.tool(
    "task_create",
    "Create a task graph node",
    {
      task_id: z.string().optional(),
      project_id: z.string().optional(),
      role: z.enum(["planner", "dev", "research", "critic"]).optional(),
      title: z.string(),
      description: z.string().optional(),
      status: z.enum(["open", "in_progress", "blocked", "done", "canceled"]).optional(),
      depends_on: z.array(z.string()).optional(),
      children: z.array(z.string()).optional(),
      execution_policy: z.object({
        max_attempts: z.number().int().min(1).max(100).optional(),
        retry_delay_ms: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
        backoff_multiplier: z.number().min(1).max(10).optional(),
      }).optional(),
    },
    async ({ task_id, project_id, role, title, description, status, depends_on, children, execution_policy }) => {
      const result = await taskCreate({
        syncDir: SYNC_DIR,
        task_id,
        project_id,
        role,
        title,
        description,
        status,
        depends_on,
        children,
        execution_policy,
      });
      return okText(result);
    }
  );

  server.tool(
    "task_link",
    "Link dependencies/children for a task",
    {
      task_id: z.string(),
      depends_on: z.array(z.string()).optional(),
      children: z.array(z.string()).optional(),
    },
    async ({ task_id, depends_on, children }) => {
      const result = await taskLink({
        syncDir: SYNC_DIR,
        task_id,
        depends_on,
        children,
      });
      return okText(result);
    }
  );

  server.tool(
    "task_graph",
    "Get task dependency graph",
    {
      project_id: z.string().optional(),
    },
    async ({ project_id }) => {
      const result = await taskGraph({
        syncDir: SYNC_DIR,
        project_id,
      });
      return okText(result);
    }
  );

  server.tool(
    "task_plan_generate",
    "Generate a task plan from a goal",
    {
      goal: z.string(),
      project_id: z.string().optional(),
      max_tasks: z.number().int().min(1).max(20).optional(),
    },
    async ({ goal, project_id, max_tasks }) => {
      const result = await taskPlanGenerate({
        syncDir: SYNC_DIR,
        goal,
        project_id,
        max_tasks,
      });
      return okText(result);
    }
  );

  server.tool(
    "task_status_update",
    "Update status of a task graph node",
    {
      task_id: z.string(),
      status: z.enum(["open", "in_progress", "blocked", "done", "canceled"]),
    },
    async ({ task_id, status }) => {
      const result = await taskStatusUpdate({
        syncDir: SYNC_DIR,
        task_id,
        status,
      });
      return okText(result);
    }
  );

  server.tool(
    "orchestrator_tick",
    "Promote eligible open tasks to in_progress (all dependencies done)",
    {
      project_id: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    async ({ project_id, limit }) => {
      const result = await orchestratorTick({
        syncDir: SYNC_DIR,
        project_id,
        limit,
      });
      return okText(result);
    }
  );

  server.tool(
    "execution_bind_tick",
    "Bind in_progress exec:* tasks to queue exec jobs",
    {
      project_id: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    async ({ project_id, limit }) => {
      const result = await runExecutionBindTick(project_id, limit);
      return okText(result);
    }
  );

  server.tool(
    "recovery_tick",
    "Re-activate retry-eligible open tasks (next_retry_at <= now) via orchestrator",
    {
      project_id: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    async ({ project_id, limit }) => {
      const result = await runRecoveryTick(project_id, limit);
      return okText(result);
    }
  );

  server.tool(
    "governance_get",
    "Get evolution governance constraints",
    {},
    async () => {
      return okText(await governanceGet(SYNC_DIR));
    }
  );

  server.tool(
    "governance_set",
    "Update evolution governance constraints",
    {
      max_versions_per_role: z.number().int().min(1).max(100).optional(),
      max_shadow_per_role: z.number().int().min(1).max(10).optional(),
      evolution_cooldown_ms: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000).optional(),
      min_replay_runs: z.number().int().min(1).max(500).optional(),
      promotion_margin_min: z.number().min(0).max(1).optional(),
      discard_on_instability: z.boolean().optional(),
      max_evolution_attempts_per_day: z.number().int().min(1).max(1000).optional(),
      stability_success_variance_max: z.number().min(0).max(1).optional(),
      stability_completion_time_variance_max: z.number().min(0).max(5).optional(),
      rollback_eval_runs: z.number().int().min(1).max(50).optional(),
      rollback_failure_delta: z.number().min(0).max(1).optional(),
      rollback_critic_delta: z.number().min(0).max(1).optional(),
    },
    async (patch) => {
      return okText(await governanceSet(SYNC_DIR, patch));
    }
  );

  server.tool(
    "arena_governance_get",
    "Get per-domain arena governance from research memory",
    {},
    async () => {
      return okText(await researchMemoryArenaGovernanceGet({
        syncDir: SYNC_DIR,
      }));
    }
  );

  server.tool(
    "arena_governance_set",
    "Update per-domain arena governance in research memory",
    {
      domain_signature: z.string().optional(),
      max_strategies_per_domain: z.number().int().min(1).max(10).optional(),
      arena_evaluation_window: z.number().int().min(2).max(50).optional(),
      promotion_margin: z.number().min(0.01).max(0.5).optional(),
      arena_cooldown_ms: z.number().int().min(10_000).max(24 * 60 * 60 * 1000).optional(),
    },
    async ({ domain_signature, max_strategies_per_domain, arena_evaluation_window, promotion_margin, arena_cooldown_ms }) => {
      const patch = {
        ...(typeof max_strategies_per_domain === "number" ? { max_strategies_per_domain } : {}),
        ...(typeof arena_evaluation_window === "number" ? { arena_evaluation_window } : {}),
        ...(typeof promotion_margin === "number" ? { promotion_margin } : {}),
        ...(typeof arena_cooldown_ms === "number" ? { arena_cooldown_ms } : {}),
      };
      const result = await researchMemoryArenaGovernanceSet({
        syncDir: SYNC_DIR,
        patch,
        domain_signature,
      });
      await eventPublish({
        syncDir: SYNC_DIR,
        type: "arena.governance.updated",
        source: "tool",
        data: {
          domain_signature: domain_signature ?? null,
          patch,
          updated_count: result.updated_count,
        },
      });
      return okText(result);
    }
  );

  server.tool(
    "agent_registry",
    "List available agent roles, versions, and active profiles",
    {
      role: z.enum(["planner", "dev", "research", "critic"]).optional(),
    },
    async ({ role }) => {
      return okText(await agentRegistryList(SYNC_DIR, role));
    }
  );

  server.tool(
    "agent_metrics_snapshot",
    "Get agent metrics snapshot by role/version",
    {
      role: z.enum(["planner", "dev", "research", "critic"]).optional(),
    },
    async ({ role }) => {
      return okText(await agentMetricsSnapshot(SYNC_DIR, role));
    }
  );

  server.tool(
    "agent_version_create",
    "Create a new agent version for role (v2/v3...)",
    {
      role: z.enum(["planner", "dev", "research", "critic"]),
      model: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
      system_prompt: z.string().optional(),
      activate: z.boolean().optional(),
      parent_version: z.number().int().min(1).optional(),
    },
    async ({ role, model, temperature, system_prompt, activate, parent_version }) => {
      return okText(await agentVersionCreate({
        syncDir: SYNC_DIR,
        role,
        model,
        temperature,
        system_prompt,
        activate,
        parent_version,
      }));
    }
  );

  server.tool(
    "agent_version_activate",
    "Activate specific agent version for role (rollback/promotion control)",
    {
      role: z.enum(["planner", "dev", "research", "critic"]),
      version: z.number().int().min(1),
    },
    async ({ role, version }) => {
      return okText(await agentVersionActivate({
        syncDir: SYNC_DIR,
        role,
        version,
      }));
    }
  );

  server.tool(
    "evolution_tick",
    "Run evolution trigger rules and create mutated agent versions",
    {
      role: z.enum(["planner", "dev", "research", "critic"]).optional(),
      min_runs: z.number().int().min(1).optional(),
      failure_rate_gt: z.number().min(0).max(1).optional(),
      critic_score_lt: z.number().min(0).max(1).optional(),
      avg_completion_time_ms_gt: z.number().int().min(0).optional(),
      research_fitness_lt: z.number().optional(),
      stagnation_rate_gt: z.number().min(0).max(1).optional(),
      convergence_steps_gt: z.number().min(1).optional(),
      max_new_versions: z.number().int().min(1).optional(),
      shadow_mode: z.boolean().optional(),
    },
    async ({ role, min_runs, failure_rate_gt, critic_score_lt, avg_completion_time_ms_gt, research_fitness_lt, stagnation_rate_gt, convergence_steps_gt, max_new_versions, shadow_mode }) => {
      return okText(await agentEvolutionTick({
        syncDir: SYNC_DIR,
        role,
        min_runs,
        failure_rate_gt,
        critic_score_lt,
        avg_completion_time_ms_gt,
        research_fitness_lt,
        stagnation_rate_gt,
        convergence_steps_gt,
        max_new_versions,
        shadow_mode,
      }));
    }
  );

  server.tool(
    "shadow_evaluation_tick",
    "Evaluate shadow versions on replay data and auto promote/discard",
    {
      role: z.enum(["planner", "dev", "research", "critic"]).optional(),
      sample_size: z.number().int().min(1).max(200).optional(),
      promote_threshold: z.number().min(0).max(1).optional(),
      max_evaluations: z.number().int().min(1).max(500).optional(),
      discard_on_fail: z.boolean().optional(),
    },
    async ({ role, sample_size, promote_threshold, max_evaluations, discard_on_fail }) => {
      return okText(await runShadowEvaluationTick({
        role,
        sample_size,
        promote_threshold,
        max_evaluations,
        discard_on_fail,
      }));
    }
  );

  server.tool(
    "agent_dispatch_tick",
    "Dispatch in_progress role-based tasks to agent queue handlers",
    {
      project_id: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    async ({ project_id, limit }) => {
      const result = await runAgentDispatchTick(project_id, limit);
      return okText(result);
    }
  );

  server.tool(
    "arena_telemetry_snapshot",
    "Per-domain strategy heatmap with arena status and strategy metrics",
    {
      limit_domains: z.number().int().min(1).max(500).optional(),
    },
    async ({ limit_domains }) => {
      const result = await arenaTelemetrySnapshot({
        syncDir: SYNC_DIR,
        limit_domains,
      });
      return okText(result);
    }
  );

  server.tool(
    "mutation_effectiveness_snapshot",
    "Mutation effectiveness index for adaptive and meta mutation paths",
    {},
    async () => {
      const result = await mutationEffectivenessSnapshot({
        syncDir: SYNC_DIR,
      });
      return okText(result);
    }
  );

  server.tool(
    "transfer_diagnostics",
    "Transfer effectiveness monitor with confidence, block, and anomaly rates",
    {},
    async () => {
      const result = await transferDiagnosticsSnapshot({
        syncDir: SYNC_DIR,
      });
      return okText(result);
    }
  );

  server.tool(
    "intelligence_health_snapshot",
    "Global Intelligence Health Index and fitness trajectory snapshot",
    {},
    async () => {
      const result = await intelligenceHealthSnapshot({
        syncDir: SYNC_DIR,
      });
      return okText(result);
    }
  );

  server.tool(
    "intelligence_meta_snapshot",
    "Meta-intelligence diagnostics (entropy, specialization, mutation/transfer trends, GIHI slope)",
    {
      mutation_window: z.number().int().min(5).max(500).optional(),
      transfer_window: z.number().int().min(5).max(500).optional(),
      gihi_window: z.number().int().min(5).max(500).optional(),
      campaign_id: z.string().optional(),
    },
    async ({ mutation_window, transfer_window, gihi_window, campaign_id }) => {
      const result = await intelligenceMetaSnapshot({
        syncDir: SYNC_DIR,
        mutation_window,
        transfer_window,
        gihi_window,
        campaign_id,
      });
      return okText(result);
    }
  );

  server.tool(
    "meta_governance_tick",
    "Auto-tune governance based on meta-intelligence snapshot",
    {
      mutation_window: z.number().int().min(5).max(500).optional(),
      transfer_window: z.number().int().min(5).max(500).optional(),
      gihi_window: z.number().int().min(5).max(500).optional(),
      campaign_id: z.string().optional(),
      apply_all_running: z.boolean().optional(),
      meta_governance_cooldown_ms: z.number().int().min(60_000).max(24 * 60 * 60 * 1000).optional(),
      min_state_streak: z.number().int().min(1).max(10).optional(),
      scoped_campaign_only: z.boolean().optional(),
      dry_run: z.boolean().optional(),
    },
    async ({ mutation_window, transfer_window, gihi_window, campaign_id, apply_all_running, meta_governance_cooldown_ms, min_state_streak, scoped_campaign_only, dry_run }) => {
      const result = await runMetaGovernanceTick({
        mutation_window,
        transfer_window,
        gihi_window,
        campaign_id,
        apply_all_running,
        meta_governance_cooldown_ms,
        min_state_streak,
        scoped_campaign_only,
        dry_run,
      });
      return okText(result);
    }
  );

  server.tool(
    "governance_tuner_tick",
    "Preview/apply small governance knob adjustments from recent metrics (safe allowlist).",
    {
      dry_run: z.boolean().optional(),
      cooldown_ms: z.number().int().min(60_000).max(10 * 60_000).optional(),
      min_state_streak: z.number().int().min(1).max(6).optional(),
      max_changes: z.number().int().min(1).max(2).optional(),
      transfer_window: z.number().int().min(5).max(500).optional(),
      mutation_window: z.number().int().min(5).max(500).optional(),
      gihi_window: z.number().int().min(5).max(500).optional(),
    },
    async ({ dry_run, cooldown_ms, min_state_streak, max_changes, transfer_window, mutation_window, gihi_window }) => {
      const result = await runGovernanceTunerTick({
        dry_run,
        cooldown_ms,
        min_state_streak,
        max_changes,
        transfer_window,
        mutation_window,
        gihi_window,
      });
      return okText(result);
    }
  );

  server.tool(
    "governance_threshold_tuner_tick",
    "Preview/apply small global threshold tuning changes with validation and rollback guards.",
    {
      dry_run: z.boolean().optional(),
      cooldown_ms: z.number().int().min(60_000).max(10 * 60_000).optional(),
      min_state_streak: z.number().int().min(1).max(6).optional(),
      max_changes: z.number().int().min(1).max(1).optional(),
      ttl_ticks: z.number().int().min(6).max(24).optional(),
      transfer_window: z.number().int().min(5).max(500).optional(),
      mutation_window: z.number().int().min(5).max(500).optional(),
      gihi_window: z.number().int().min(5).max(500).optional(),
    },
    async ({ dry_run, cooldown_ms, min_state_streak, max_changes, ttl_ticks, transfer_window, mutation_window, gihi_window }) => {
      const result = await runGovernanceThresholdTunerTick({
        dry_run,
        cooldown_ms,
        min_state_streak,
        max_changes,
        ttl_ticks,
        transfer_window,
        mutation_window,
        gihi_window,
      });
      return okText(result);
    }
  );

  server.tool(
    "research_agenda_tick",
    "Build compact diagnostics brief and send one LLM agenda request (journal/tasks helper mode).",
    {
      project_id: z.string().optional(),
      campaign_id: z.string().optional(),
      top_domains: z.number().int().min(1).max(10).optional(),
      transfer_window: z.number().int().min(5).max(500).optional(),
      mutation_window: z.number().int().min(5).max(500).optional(),
      gihi_window: z.number().int().min(5).max(500).optional(),
      publish_only: z.boolean().optional(),
      dry_run: z.boolean().optional(),
      batch_size: z.number().int().min(1).max(20).optional(),
    },
    async ({ project_id, campaign_id, top_domains, transfer_window, mutation_window, gihi_window, publish_only, dry_run, batch_size }) => {
      const result = await runResearchAgendaTick({
        project_id,
        campaign_id,
        top_domains,
        transfer_window,
        mutation_window,
        gihi_window,
        publish_only,
        dry_run,
        batch_size,
      });
      return okText(result);
    }
  );

  server.tool(
    "patch_proposal_tick",
    "Generate patch proposals (PatchEnvelope) via LLM and store proposal notes (proposal-only).",
    {
      project_id: z.string().optional(),
      top_domains: z.number().int().min(1).max(6).optional(),
      transfer_window: z.number().int().min(5).max(500).optional(),
      mutation_window: z.number().int().min(5).max(500).optional(),
      gihi_window: z.number().int().min(5).max(500).optional(),
      publish_only: z.boolean().optional(),
      dry_run: z.boolean().optional(),
      batch_size: z.number().int().min(1).max(20).optional(),
    },
    async ({ project_id, top_domains, transfer_window, mutation_window, gihi_window, publish_only, dry_run, batch_size }) => {
      const result = await runPatchProposalTick({
        project_id,
        top_domains,
        transfer_window,
        mutation_window,
        gihi_window,
        publish_only,
        dry_run,
        batch_size,
      });
      return okText(result);
    }
  );

  server.tool(
    "patch_test_tick",
    "Run smoke/tests for fresh patch proposals and write patch_test_report notes.",
    {
      limit: z.number().int().min(1).max(10).optional(),
      timeout_ms: z.number().int().min(10_000).max(10 * 60_000).optional(),
      max_commands: z.number().int().min(1).max(4).optional(),
    },
    async ({ limit, timeout_ms, max_commands }) => {
      const result = await runPatchTestTick({
        limit,
        timeout_ms,
        max_commands,
      });
      return okText(result);
    }
  );

  server.tool(
    "patch_governance_tick",
    "Apply tested patches: prompt patches create shadow versions; repo patches can be auto-applied with tests+rollback guards.",
    {
      dry_run: z.boolean().optional(),
      limit: z.number().int().min(1).max(3).optional(),
      auto_activate: z.boolean().optional(),
      auto_apply_repo: z.boolean().optional(),
      auto_commit_repo: z.boolean().optional(),
      timeout_ms: z.number().int().min(10_000).max(10 * 60 * 1000).optional(),
      max_commands: z.number().int().min(1).max(4).optional(),
    },
    async ({ dry_run, limit, auto_activate, auto_apply_repo, auto_commit_repo, timeout_ms, max_commands }) => {
      const result = await runPatchGovernanceTick({
        dry_run,
        limit,
        auto_activate,
        auto_apply_repo,
        auto_commit_repo,
        timeout_ms,
        max_commands,
      });
      return okText(result);
    }
  );

  server.tool(
    "lineage_snapshot",
    "Strategy lineage graph from mutation history",
    {
      role: z.enum(["planner", "dev", "research", "critic"]).optional(),
      limit: z.number().int().min(1).max(5000).optional(),
    },
    async ({ role, limit }) => {
      const result = await lineageSnapshot({
        syncDir: SYNC_DIR,
        role,
        limit,
      });
      return okText(result);
    }
  );

  server.tool(
    "campaign_create",
    "Create autonomous research campaign definition",
    {
      campaign_id: z.string().optional(),
      goal: z.string(),
      objective: z.any(),
      constraints: z.record(z.any()).optional(),
      max_experiments: z.number().int().min(1).max(10000).optional(),
      stop_conditions: z.object({
        convergence_detected: z.boolean().optional(),
        min_gihi: z.number().min(0).max(1).optional(),
        gihi_below_threshold: z.number().min(0).max(1).optional(),
        max_experiments: z.number().int().min(1).max(10000).optional(),
        stagnation_rate_gt: z.number().min(0).max(1).optional(),
        max_ticks: z.number().int().min(1).max(100000).optional(),
        gihi_grace_ticks: z.number().int().min(0).max(1000).optional(),
      }).optional(),
    },
    async ({ campaign_id, goal, objective, constraints, max_experiments, stop_conditions }) => {
      const constraintsObj = (constraints && typeof constraints === "object")
        ? { ...(constraints as Record<string, any>) }
        : {};
      const confidenceAllow = validateDomainAllowlist((constraintsObj as any).confidence_domains_targeted);
      const signatureAllow = validateDomainAllowlist((constraintsObj as any).domain_signature);
      const hasAnyDomainConstraint = confidenceAllow.candidates.length > 0 || signatureAllow.candidates.length > 0;
      const mergedValid = Array.from(new Set([
        ...confidenceAllow.valid,
        ...signatureAllow.valid,
      ]));
      const mergedInvalid = Array.from(new Set([
        ...confidenceAllow.invalid,
        ...signatureAllow.invalid,
      ]));
      if (hasAnyDomainConstraint && mergedValid.length === 0) {
        throw new Error(`invalid_campaign_constraints: no valid domain signatures; invalid=${JSON.stringify(mergedInvalid)}`);
      }
      if (mergedValid.length > 0) {
        (constraintsObj as any).confidence_domains_targeted = mergedValid;
        if (mergedInvalid.length > 0) {
          (constraintsObj as any).confidence_domains_targeted_invalid = mergedInvalid;
        }
      }
      const result = await campaignCreate({
        syncDir: SYNC_DIR,
        campaign_id,
        goal,
        objective,
        constraints: constraintsObj,
        max_experiments,
        stop_conditions,
      });
      return okText(result);
    }
  );

  server.tool(
    "campaign_tick",
    "Run autonomous research campaign control loop for N steps",
    {
      campaign_id: z.string(),
      max_steps: z.number().int().min(1).max(50).optional(),
    },
    async ({ campaign_id, max_steps }) => {
      const result = await enqueueCampaignTickJob({
        campaign_id,
        max_steps,
        source: "campaign-api",
      });
      return okText(result);
    }
  );

  server.tool(
    "campaign_watchdog_tick",
    "Watchdog: re-enqueue campaign_tick if a running campaign has no live queue job",
    {
      idle_ms: z.number().int().min(5_000).max(10 * 60_000).optional(),
      cooldown_ms: z.number().int().min(5_000).max(10 * 60_000).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      dry_run: z.boolean().optional(),
    },
    async ({ idle_ms, cooldown_ms, limit, dry_run }) => {
      const result = await runCampaignWatchdogTick({
        idle_ms,
        cooldown_ms,
        limit,
        dry_run,
      });
      return okText(result);
    }
  );

  server.tool(
    "campaign_report_generate",
    "Generate final campaign report (Markdown + JSON snapshot)",
    {
      campaign_id: z.string(),
    },
    async ({ campaign_id }) => {
      const campaign = await campaignGet({
        syncDir: SYNC_DIR,
        campaign_id,
      }).then((x) => x.campaign);
      const snapshot = await buildCampaignSnapshot(campaign);
      const result = await campaignReportGenerate({
        syncDir: SYNC_DIR,
        campaign_id,
        snapshot,
      });
      return okText(result);
    }
  );

  server.tool(
    "campaign_list",
    "List autonomous research campaigns",
    {
      status: z.enum(["draft", "running", "completed", "stopped", "failed"]).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    async ({ status, limit }) => {
      const result = await campaignList({
        syncDir: SYNC_DIR,
        status,
        limit,
      });
      return okText(result);
    }
  );

  // --- Phase 5.5: Project Context Tools ---
  server.tool(
    "project_create",
    "Create or update a project context root",
    {
      project_id: z.string(),
      description: z.string().optional(),
      stack: z.array(z.string()).optional(),
    },
    async ({ project_id, description, stack }) => {
      const result = await projectCreate({
        syncDir: SYNC_DIR,
        project_id,
        description,
        stack,
      });
      return okText(result);
    }
  );

  server.tool(
    "project_list",
    "List known projects and active project",
    {},
    async () => {
      const result = await projectList({
        syncDir: SYNC_DIR,
      });
      return okText(result);
    }
  );

  server.tool(
    "project_switch",
    "Switch active project",
    {
      project_id: z.string(),
    },
    async ({ project_id }) => {
      const result = await projectSwitch({
        syncDir: SYNC_DIR,
        project_id,
      });
      return okText(result);
    }
  );

  server.tool(
    "project_context_set",
    "Set project context/roadmap/constraints",
    {
      project_id: z.string().optional(),
      context: z.any().optional(),
      roadmap: z.any().optional(),
      constraints: z.any().optional(),
    },
    async ({ project_id, context, roadmap, constraints }) => {
      const result = await projectContextSet({
        syncDir: SYNC_DIR,
        project_id,
        context,
        roadmap,
        constraints,
      });
      return okText(result);
    }
  );

  server.tool(
    "project_context_get",
    "Get full project context package",
    {
      project_id: z.string().optional(),
    },
    async ({ project_id }) => {
      const result = await projectContextGet({
        syncDir: SYNC_DIR,
        project_id,
      });
      return okText(result);
    }
  );

  // --- Phase 5.6: Persistent Memory Tools ---
  server.tool(
    "memory_store",
    "Store a persistent memory record",
    {
      project_id: z.string(),
      type: z.string(),
      tags: z.array(z.string()).optional(),
      content: z.string(),
    },
    async ({ project_id, type, tags, content }) => {
      const result = await memoryStore({
        syncDir: SYNC_DIR,
        project_id,
        type,
        tags,
        content,
      });
      return okText(result);
    }
  );

  server.tool(
    "memory_query",
    "Query persistent memory records",
    {
      project_id: z.string().optional(),
      type: z.string().optional(),
      tags: z.array(z.string()).optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    async ({ project_id, type, tags, query, limit }) => {
      const result = await memoryQuery({
        syncDir: SYNC_DIR,
        project_id,
        type,
        tags,
        query,
        limit,
      });
      return okText(result);
    }
  );

  server.tool(
    "memory_update",
    "Update an existing memory record",
    {
      memory_id: z.string(),
      content: z.string().optional(),
      tags: z.array(z.string()).optional(),
      type: z.string().optional(),
    },
    async ({ memory_id, content, tags, type }) => {
      const result = await memoryUpdate({
        syncDir: SYNC_DIR,
        memory_id,
        content,
        tags,
        type,
      });
      return okText(result);
    }
  );

  server.tool(
    "memory_prune",
    "Delete memory records by age/project",
    {
      older_than_ts: z.number().optional(),
      project_id: z.string().optional(),
      limit: z.number().int().min(1).max(10_000).optional(),
    },
    async ({ older_than_ts, project_id, limit }) => {
      const result = await memoryPrune({
        syncDir: SYNC_DIR,
        older_than_ts,
        project_id,
        limit,
      });
      return okText(result);
    }
  );

  // --- Phase 6: Protocol Tools ---
  server.tool(
    "protocol_init",
    "Initialize protocol files for Windsurf automation.",
    {},
    async () => {
      return await protocolInit();
    }
  );

  server.tool(
    "protocol_write_command",
    "Write a command to inbox_command.json for Windsurf to execute.",
    {
      command: z.string(),
    },
    async ({ command }) => {
      return await protocolWriteCommand(command);
    }
  );

  server.tool(
    "protocol_read_command",
    "Read the current command from inbox_command.json.",
    {},
    async () => {
      return await protocolReadCommand();
    }
  );

  server.tool(
    "protocol_update_status",
    "Update the status.json file.",
    {
      status: z.enum(['idle', 'running', 'done', 'error']),
      error: z.string().optional(),
    },
    async ({ status, error }) => {
      return await protocolUpdateStatus(status, error);
    }
  );

  server.tool(
    "protocol_write_report",
    "Write a report to last_report.md.",
    {
      title: z.string(),
      content: z.string(),
    },
    async ({ title, content }) => {
      return await protocolWriteReport(title, content);
    }
  );

  server.tool(
    "protocol_write_logs",
    "Write logs to last_logs.txt.",
    {
      logs: z.string(),
    },
    async ({ logs }) => {
      return await protocolWriteLogs(logs);
    }
  );

  // --- Phase 7: Sync Tools ---
  server.tool(
    "sync_outbound_once",
    "Run one outbound sync batch (events -> OpenAI -> inbound events).",
    {
      batch_size: z.number().int().min(1).max(500).optional(),
    },
    async ({ batch_size }) => {
      return okText(await runSyncOutboundOnce(batch_size));
    }
  );

  server.tool(
    "sync_inbound_once",
    "Run one inbound sync batch (pending response IDs -> events).",
    {
      batch_size: z.number().int().min(1).max(500).optional(),
    },
    async ({ batch_size }) => {
      return okText(await runSyncInboundOnce(batch_size));
    }
  );

  server.tool(
    "enqueue_inbound_response_id",
    "Queue a remote OpenAI response ID for inbound synchronization.",
    {
      conversation_id: z.string(),
      response_id: z.string(),
      dedupe_key: z.string().optional(),
    },
    async ({ conversation_id, response_id, dedupe_key }) => {
      return okText(await runEnqueueInboundResponseId(conversation_id, response_id, dedupe_key));
    }
  );

  server.tool(
    "sync_status",
    "Show sync cursors, mapping stats, dedupe stats, and last event activity.",
    {},
    async () => {
      return okText(await runSyncStatus());
    }
  );

  server.tool(
    "sync_reconcile",
    "Reconcile sync metadata (cursor sanity + mapping normalization).",
    {},
    async () => {
      return okText(await runSyncReconcile());
    }
  );

  // --- Phase 1: File System Tools ---

  // fs_list
  server.tool(
    "fs_list",
    "List files under a directory (limited to allowed roots).",
    {
      dir: z.string(),
      limit: z.number().int().min(1).max(5000).optional(),
    },
    async ({ dir, limit }) => {
      const base = assertInAllowedRoots(dir);
      const entries = await fs.readdir(base, { withFileTypes: true });
      const out = entries
        .slice(0, limit ?? 2000)
        .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
      return okText({ dir: base, entries: out });
    }
  );

  // fs_read
  server.tool(
    "fs_read",
    "Read a UTF-8 text file (limited size).",
    { path: z.string(), max_bytes: z.number().int().min(1).max(2_000_000).optional() },
    async ({ path: p, max_bytes }) => {
      const rp = assertInAllowedRoots(p);
      const st = await fs.stat(rp);
      const limit = max_bytes ?? 500_000;
      if (st.size > limit) return errText(`File too large (${st.size} bytes), limit=${limit}`);
      const content = await fs.readFile(rp, "utf8");
      return okText({ path: rp, content, size: st.size });
    }
  );

  // fs_write
  server.tool(
    "fs_write",
    "Write a UTF-8 text file. If create=false and file missing -> error.",
    {
      path: z.string(),
      content: z.string(),
      create: z.boolean().optional(),
    },
    async ({ path: p, content, create }) => {
      const rp = assertInAllowedRoots(p);
      const dir = path.dirname(rp);
      await fs.mkdir(dir, { recursive: true });
      if (create === false) {
        try {
          await fs.access(rp);
        } catch {
          return errText("File does not exist (create=false)");
        }
      }
      await fs.writeFile(rp, content, "utf8");
      return okText({ written: true, path: rp, bytes: Buffer.byteLength(content, "utf8") });
    }
  );

  // fs_mkdir
  server.tool(
    "fs_mkdir",
    "Create directory recursively inside allowed roots.",
    { path: z.string() },
    async ({ path: inputPath }) => {
      const resolved = path.resolve(inputPath);
      const isAllowed = ROOTS_FINAL.some(root => resolved.startsWith(root));
      if (!isAllowed) {
        return errText(`Path outside allowed roots: ${inputPath}`);
      }

      try {
        await fs.mkdir(resolved, { recursive: true });
        return okText({ created: true, path: resolved });
      } catch (error: any) {
        return errText(`Failed to create directory: ${error.message}`);
      }
    }
  );

  // fs_exists
  server.tool(
    "fs_exists",
    "Check if path exists and its type inside allowed roots.",
    { path: z.string() },
    async ({ path: inputPath }) => {
      const resolved = path.resolve(inputPath);
      const isAllowed = ROOTS_FINAL.some(root => resolved.startsWith(root));
      if (!isAllowed) {
        return errText(`Path outside allowed roots: ${inputPath}`);
      }

      try {
        const stat = await fs.stat(resolved);
        return okText({ 
          exists: true, 
          type: stat.isDirectory() ? "dir" : "file" 
        });
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return okText({ exists: false, type: null });
        }
        return errText(`Failed to check path: ${error.message}`);
      }
    }
  );

  // search_in_files
  server.tool(
    "search_in_files",
    "Search for text/regex in files within allowed roots.",
    { 
      pattern: z.string(),
      max_files: z.number().int().min(1).max(1000).default(100),
      max_file_size: z.number().int().min(1024).max(10*1024*1024).default(2*1024*1024), // 2MB
      max_results: z.number().int().min(1).max(10000).default(500)
    },
    async ({ pattern, max_files, max_file_size, max_results }) => {
      const results: any[] = [];
      const regex = new RegExp(pattern, 'gi');
      let fileCount = 0;
      let resultCount = 0;

      async function searchDirectory(dir: string) {
        if (fileCount >= max_files || resultCount >= max_results) return;

        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          
          for (const entry of entries) {
            if (fileCount >= max_files || resultCount >= max_results) break;
            
            const fullPath = path.join(dir, entry.name);
            const resolved = path.resolve(fullPath);
            
            // Check if within allowed roots
            if (!ROOTS_FINAL.some(root => resolved.startsWith(root))) continue;

            if (entry.isDirectory()) {
              await searchDirectory(fullPath);
            } else if (entry.isFile()) {
              try {
                const stat = await fs.stat(fullPath);
                if (stat.size > max_file_size) return;
                
                fileCount++;
                const content = await fs.readFile(fullPath, 'utf-8');
                const lines = content.split('\n');
                
                for (let i = 0; i < lines.length && resultCount < max_results; i++) {
                  const line = lines[i];
                  const matches = [...line.matchAll(regex)];
                  
                  if (matches.length > 0) {
                    results.push({
                      path: fullPath,
                      line: i + 1,
                      content: line.trim(),
                      matches: matches.map(m => ({
                        text: m[0],
                        index: m.index,
                        length: m[0].length
                      }))
                    });
                    resultCount += matches.length;
                  }
                }
              } catch (error: any) {
                // Skip files that can't be read
                return;
              }
            }
          }
        } catch (error: any) {
          // Skip directories that can't be read
          return;
        }
      }

      // Search in all allowed roots
      for (const root of ROOTS_FINAL) {
        await searchDirectory(root);
      }

      return okText({
        results: results.slice(0, max_results),
        total_files_scanned: fileCount,
        total_matches: resultCount
      });
    }
  );

  // fs_read_content
  server.tool(
    "fs_read_content",
    "Read content from URL or file",
    { url: z.string() },
    async ({ url }) => {
      try {
        // For now, just treat as file path
        const content = await fs.readFile(url, 'utf-8');
        return okText({ url, content });
      } catch (error: any) {
        return errText(`Failed to read content: ${error.message}`);
      }
    }
  );

  // fs_write_content  
  server.tool(
    "fs_write_content",
    "Write content to file",
    { 
      path: z.string(),
      content: z.string(),
      create_empty: z.boolean().optional().default(false)
    },
    async ({ path: filePath, content, create_empty }) => {
      try {
        const resolved = assertInAllowedRoots(filePath);
        const dir = path.dirname(resolved);
        await fs.mkdir(dir, { recursive: true });
        
        if (create_empty) {
          await fs.writeFile(resolved, '', 'utf-8');
        } else {
          await fs.writeFile(resolved, content, 'utf-8');
        }
        
        return okText({ written: true, path: resolved });
      } catch (error: any) {
        return errText(`Failed to write content: ${error.message}`);
      }
    }
  );

  return server;
}

// HTTP server setup
const app = express();

// ---- health + request timing (added by assistant) ----
app.use((req, res, next) => {
  const start = Date.now();
  const url = req.originalUrl || req.url || '';
  const rid = Math.random().toString(16).slice(2, 8);
  const ua = String(req.headers['user-agent'] || '');
  const ray = String(req.headers['cf-ray'] || '');
  const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '');
  let done = false;
  function log(tag: string) {
    if (done) return;
    done = true;
    const ms = Date.now() - start;
    const extra =
      (ip ? ' ip=' + ip : '') +
      (ray ? ' ray=' + ray : '') +
      (ua ? ' ua=' + ua : '');
    console.log(tag + ' #' + rid + ' ' + req.method + ' ' + url + ' -> ' + res.statusCode + ' (' + ms + 'ms)' + extra);
  }
  res.on('finish', () => log('FINISH'));
  res.on('close', () => { if (!res.writableEnded) log('CLOSE'); });
  req.on('aborted', () => log('ABORT'));
  next();
});

app.get('/health', (req, res) => {
  res.status(200).type('text/plain').send('ok');
});

// Diagnostic: hold connection for N ms without sending data.
app.get('/debug/sleep', (req, res) => {
  const msRaw = String((req.query && req.query.ms) ?? '30000');
  const ms = Math.max(0, Math.min(600000, Number(msRaw) || 0));
  setTimeout(() => {
    res.status(200).type('text/plain').send('slept ' + ms + 'ms');
  }, ms);
});

// Diagnostic: stream a heartbeat every interval ms for total ms.
app.get('/debug/stream', (req, res) => {
  const totalRaw = String((req.query && req.query.ms) ?? '120000');
  const intervalRaw = String((req.query && req.query.interval) ?? '15000');
  const total = Math.max(0, Math.min(600000, Number(totalRaw) || 0));
  const interval = Math.max(1000, Math.min(60000, Number(intervalRaw) || 15000));
  res.status(200);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const start = Date.now();
  let n = 0;
  const t = setInterval(() => {
    n++;
    res.write('tick ' + n + ' +' + (Date.now() - start) + 'ms\n');
    if (Date.now() - start >= total) {
      clearInterval(t);
      res.end('done\n');
    }
  }, interval);
  req.on('aborted', () => { try { clearInterval(t); } catch {} });
  res.on('close', () => { try { clearInterval(t); } catch {} });
});
// ------------------------------------------------------





app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    CORS_ALLOW_HEADERS
  );
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  next();
});

// Bearer auth middleware for MCP endpoints.
app.use((req, res, next) => {
  if (!AUTH_ENABLED) {
    next();
    return;
  }

  if (!isAuthProtectedPath(req.path)) {
    next();
    return;
  }

  if (!MCP_SYNC_TOKEN) {
    res.status(500).json({ error: "Server auth misconfigured: MCP_SYNC_TOKEN is empty" });
    return;
  }

  const authHeader = req.headers.authorization;
  const parts = typeof authHeader === "string" ? authHeader.trim().split(/\s+/) : [];
  const isBearer = parts.length === 2 && parts[0].toLowerCase() === "bearer";
  const token = isBearer ? parts[1].trim() : "";

  if (!isBearer || !isValidBearerToken(token, MCP_SYNC_TOKEN)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="mcp-sync-server"');
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
});

const transports: Record<string, WebStandardStreamableHTTPServerTransport> = {};
const sseTransports: Record<string, SSEServerTransport> = {};

// Unified /mcp handler for all methods (GET, POST, DELETE)
app.all("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const acceptHeader = String(req.headers["accept"] ?? "");

    // Fail fast for clients that do not accept SSE, to avoid opaque decode-body errors.
    if (!acceptHeader.toLowerCase().includes("text/event-stream")) {
      res.status(406).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Not Acceptable: MCP requires Accept: text/event-stream" },
        id: null,
      });
      return;
    }

      console.log(`[${req.method}] /mcp Request received`, {
      sessionId,
      accept: acceptHeader,
      ua: req.headers["user-agent"],
    });

    // Check if this is an initialize request
    const isInitialize =
      req.method === "POST" &&
      req.body?.method === "initialize" &&
      req.body?.jsonrpc === "2.0";

    let transport = sessionId ? transports[sessionId] : undefined;

    if (!transport && isInitialize) {
      // Create new transport
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport!;
        },
      });

      transport.onclose = () => {
        if (transport?.sessionId) delete transports[transport.sessionId];
      };

      const server = createMcpServer();
      await server.connect(transport);
    }

    if (!transport) {
      console.log(`[${req.method}] /mcp Invalid session`, { sessionId, hasSession: !!transports[sessionId!] });
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }

    // In compact mode, block direct calls to legacy tool names.
    if (
      !EXPOSE_LEGACY_TOOLS &&
      req.method === "POST" &&
      req.body?.method === "tools/call" &&
      isLegacyToolName(req.body?.params?.name)
    ) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32601, message: `Tool not found: ${String(req.body?.params?.name)}` },
        id: req.body?.id ?? null,
      });
      return;
    }

    // Convert Express request to Fetch request
    const fetchReq = toFetchRequest(req);
    const opts = req.method === "POST" ? { parsedBody: req.body } : undefined;

    // Disable timeouts for long-lived MCP requests (GET/POST)
    req.socket.setTimeout(0);
    (res as any).setTimeout?.(0);

const webRes = await transport.handleRequest(fetchReq, opts as any);
    await sendFetchResponseToExpress(webRes, res, req.body?.method);

  } catch (e: any) {
    console.error(`[${req.method}] /mcp handler error:`, e);
    res.status(500).send("Internal Server Error");
  }
});




// Simple SSE endpoint for testing
app.get("/sse-simple", async (req, res) => {
  console.log(`[GET /sse-simple] Request received. Headers:`, req.headers);
  
  try {
    // Set SSE headers manually
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform, no-store',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
      'X-Accel-Buffering': 'no' // Disable nginx buffering
    });

    // Disable socket timeout
    req.socket.setTimeout(0);
    
    const sessionId = randomUUID();
    console.log(`[GET /sse-simple] Created simple SSE session: ${sessionId}`);
    
    // Send initial event
    res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
    console.log(`[GET /sse-simple] Sent endpoint event for session ${sessionId}`);

    // Add heartbeat every 25 seconds
    let heartbeatCount = 0;
    const heartbeat = setInterval(() => {
      try {
        heartbeatCount++;
        const pingMsg = `: ping ${Date.now()}\n\n`;
        res.write(pingMsg);
        console.log(`[GET /sse-simple] Sent heartbeat #${heartbeatCount} for session ${sessionId}`);
      } catch (error) {
        console.log(`[GET /sse-simple] Heartbeat error for session ${sessionId}:`, error);
        clearInterval(heartbeat);
      }
    }, 25000);

    req.on("close", () => {
      console.log(`[GET /sse-simple] Request closed for session ${sessionId}`);
      clearInterval(heartbeat);
    });

  } catch (error: any) {
    console.error('[GET /sse-simple] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'SSE initialization failed' });
    }
  }
});

// SSE MCP endpoint
app.get("/sse", async (req, res) => {
  try {
    // Disable socket timeout
    req.socket.setTimeout(0);

    const transport = new SSEServerTransport("/messages", res);
    const sid = randomUUID();
    sseTransports[sid] = transport;

    (transport as any).onclose = () => {
      delete sseTransports[sid];
    };

    // Add heartbeat every 25 seconds to prevent Cloudflare timeout
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch (error) {
        clearInterval(heartbeat);
      }
    }, 25000);

    req.on("close", () => {
      clearInterval(heartbeat);
    });

    const server = createMcpServer();
    await server.connect(transport);
  } catch (error: any) {
    console.error('SSE endpoint error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'SSE initialization failed' });
    }
  }
});

app.post("/messages", async (req, res) => {
  const active = Object.values(sseTransports);
  if (!active.length) {
    res.status(400).send("No active SSE session");
    return;
  }

  // Send to first active SSE session
  await (active[0] as any).handleRequest(req, res);
});

// Add JSON error handler
app.use((err: any, _req: any, res: any, next: any) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  next(err);
});

const httpServer = app.listen(PORT, () => {
  console.log(`MCP Sync Server listening on port ${PORT}`);
  console.log(`Auth: ${AUTH_ENABLED ? 'enabled' : 'disabled'}`);
  if (AUTH_ENABLED_FROM_ENV === undefined && AUTH_ENABLED_RAW) {
    console.log(`AUTH_ENABLED value "${AUTH_ENABLED_RAW}" is invalid; fallback is token-based auto mode.`);
  }
  console.log(`Auth protected paths: /mcp, /messages, /sse, /sse-simple`);
  console.log(`Sync dir: ${SYNC_DIR}`);
});

httpServer.keepAliveTimeout = 75_000;
httpServer.headersTimeout = 80_000;

let shuttingDown = false;
async function shutdownGracefully(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}. Starting graceful shutdown...`);

  if (backgroundWorkerAdaptiveTimer) {
    clearInterval(backgroundWorkerAdaptiveTimer);
    backgroundWorkerAdaptiveTimer = null;
  }
  if (backgroundWorkerManager) {
    await backgroundWorkerManager.stopAll();
    backgroundWorkerManager = null;
  }

  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdownGracefully("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdownGracefully("SIGTERM");
});
