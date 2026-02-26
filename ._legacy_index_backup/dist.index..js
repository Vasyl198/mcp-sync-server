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
import { acquireLock, releaseLock } from "./locks.js";
import { ensureQueueLayout, queuePush, queuePop, queueAck, queueCleanupExpiredRunning, jobHistoryList, queueDepth } from "./queue.js";
import { executeOneFromQueue } from "./router_queue.js";
import { Worker, WorkerManager } from "./workers.js";
import { ensureSyncState, eventPublish, eventList, getInboundCursorPath, getOutboundCursorPath } from "./events.js";
import { notesList, notesGet, notesUpsert, notesDelete } from "./notes.js";
import { tasksList, tasksGet, tasksUpsert, tasksDelete } from "./tasks.js";
import { experimentBest, experimentCompare, experimentComputeResearchMetrics, experimentCreate, experimentIngestExecResultByTask, experimentLeaderboard, experimentList, experimentRun, experimentSearchTick, } from "./experiments.js";
import { projectCreate, projectList, projectSwitch, projectContextSet, projectContextGet } from "./projects.js";
import { memoryStore, memoryQuery, memoryUpdate, memoryPrune } from "./memory.js";
import { normalizeAdaptiveProfile, normalizeAdaptiveProfilesByDomain } from "./agent/registry.js";
import { computeDomainSignature, researchMemoryAdvanceCircuitBreakerTick, researchMemoryApplyCircuitBreaker, researchMemoryArenaEvaluationTick, researchMemoryArenaGovernanceGet, researchMemoryArenaGovernanceSet, researchMemoryForceStrategyRotation, researchMemoryUpsertFromOutcome } from "./agent/research_memory.js";
import { arenaTelemetrySnapshot, intelligenceMetaSnapshot, intelligenceHealthSnapshot, lineageSnapshot, mutationEffectivenessSnapshot, transferDiagnosticsSnapshot } from "./agent/telemetry.js";
import { campaignAppendHistory, campaignCommitPreparedTick, campaignCreate, campaignGet, campaignList, campaignMarkRunning, campaignReconcileAll, campaignReportGenerate, campaignSave, campaignTickRecordWrite, } from "./campaigns.js";
import { agentVersionActivate, agentShadowDiscard, agentGetActiveByRole, agentEvolutionTick, governanceGet, governanceSet, agentMetricsOverwrite, agentMetricsRecordResearchImpact, agentMetricsRecordRun, agentMetricsSnapshot, agentRegistryList, researchProfileGovernanceTune, agentVersionCreate, } from "./agent/store.js";
import { taskCreate, taskLink, taskGraph, taskPlanGenerate, taskStatusUpdate, orchestratorTick, taskExecutionMarkQueued, taskExecutionMarkFinished, taskExecutionHandleResult, taskAgentMarkDispatched, } from "./task_graph.js";
import { protocolInit, protocolWriteCommand, protocolReadCommand, protocolUpdateStatus, protocolWriteReport, protocolWriteLogs } from "./protocol.js";
import { OPENAI_MODEL, PORT, SYNC_BATCH_SIZE, SYNC_DIR, SYNC_ENABLED, SYNC_MOCK_MODE, SYNC_POLL_MS } from "./config.js";
import { InboundSyncWorker } from "./sync/inbound_worker.js";
import { OutboundSyncWorker } from "./sync/outbound_worker.js";
import { enqueueInboundResponseId, getMappingStoreStats, hasDedupeKey, reconcileMappingStore, } from "./sync/mapping_store.js";
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
function parseBooleanEnv(value) {
    if (!value)
        return undefined;
    if (["1", "true", "yes", "on", "enabled"].includes(value))
        return true;
    if (["0", "false", "no", "off", "disabled"].includes(value))
        return false;
    return undefined;
}
const AUTH_ENABLED_FROM_ENV = parseBooleanEnv(AUTH_ENABLED_RAW);
const AUTH_ENABLED = AUTH_ENABLED_FROM_ENV ?? MCP_SYNC_TOKEN.length > 0;
const CORS_ALLOW_HEADERS = "Content-Type, Accept, mcp-session-id, mcp-protocol-version, Last-Event-ID, Authorization";
let backgroundWorkerManager = null;
let backgroundWorkerAdaptiveTimer = null;
let backgroundWorkerStartedAt = null;
function normalizeRoutePath(routePath) {
    if (!routePath)
        return "/";
    if (routePath === "/")
        return routePath;
    return routePath.replace(/\/+$/, "");
}
function isAuthProtectedPath(routePath) {
    const normalized = normalizeRoutePath(routePath);
    return (normalized === "/mcp" ||
        normalized.startsWith("/mcp/") ||
        normalized === "/messages" ||
        normalized.startsWith("/messages/") ||
        normalized === "/sse" ||
        normalized.startsWith("/sse/") ||
        normalized === "/sse-simple" ||
        normalized.startsWith("/sse-simple/"));
}
function isValidBearerToken(candidate, expected) {
    const candidateBuffer = Buffer.from(candidate, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    if (candidateBuffer.length !== expectedBuffer.length)
        return false;
    return timingSafeEqual(candidateBuffer, expectedBuffer);
}
// Explicit paths to avoid confusion
const ROOTS = ["C:\\Users\\anani\\Projects", "C:\\", "D:\\"];
const ALLOWED_ROOTS = (process.env.MCP_ALLOWED_ROOTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => {
    if (path.isAbsolute(p))
        return p;
    // Handle relative paths relative to each root
    if (p.startsWith("C:") || p.startsWith("D:"))
        return path.resolve(p);
    return path.resolve("C:\\Users\\anani\\Projects", p);
});
const ROOTS_FINAL = ALLOWED_ROOTS.length ? ALLOWED_ROOTS : ROOTS;
// Utility functions to convert Express <-> Fetch Request/Response
function toFetchHeaders(h) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(h)) {
        if (v === undefined)
            continue;
        if (Array.isArray(v))
            headers.set(k, v.join(", "));
        else
            headers.set(k, String(v));
    }
    return headers;
}
function toFetchRequest(req) {
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
async function sendFetchResponseToExpress(webRes, res) {
    res.status(webRes.status);
    webRes.headers.forEach((value, key) => {
        res.setHeader(key, value);
    });
    // Send headers immediately
    res.flushHeaders?.();
    // Handle connection close for proper cleanup
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
            if (done || closed)
                break;
            if (value) {
                const ok = res.write(Buffer.from(value));
                // Handle backpressure - wait for drain if buffer is full
                if (!ok) {
                    await new Promise((resolve) => res.once("drain", resolve));
                }
            }
        }
    }
    finally {
        if (!closed) {
            res.end();
        }
        try {
            reader.releaseLock();
        }
        catch { }
    }
}
function isInsideRoot(root, target) {
    const r = path.resolve(root);
    const t = path.resolve(target);
    // Windows: case-insensitive comparison for drive letters
    const rel = path.relative(r, t);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
function assertInAllowedRoots(p) {
    const rp = path.resolve(p);
    for (const root of ROOTS_FINAL) {
        if (isInsideRoot(root, rp))
            return rp;
    }
    throw new Error(`Path is outside allowed roots: ${rp}`);
}
function sha1(s) {
    return createHash("sha1").update(s).digest("hex");
}
function tryNormalizeNodeEExecCommand(template) {
    const s = String(template ?? "").trim();
    const m = s.match(/^node\s+-e\s+([\s\S]+)$/i);
    if (!m)
        return null;
    let payload = m[1].trim();
    const unwrap = (q) => {
        if (payload.startsWith(q) && payload.endsWith(q) && payload.length >= 2) {
            payload = payload.slice(1, -1);
            return true;
        }
        return false;
    };
    if (payload.startsWith('\\"') && payload.endsWith('\\"') && payload.length >= 4) {
        payload = payload.slice(2, -2);
    }
    else {
        unwrap('"') || unwrap("'") || unwrap("`");
    }
    payload = payload
        .replace(/\\"/g, '"')
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\\\/g, "\\");
    return { cmd: "node", args: ["-e", payload] };
}
function normalizeNodeEArgs(cmd, args) {
    if (String(cmd).toLowerCase() !== "node")
        return args;
    if (!Array.isArray(args) || args.length < 2)
        return args;
    if (String(args[0]) !== "-e")
        return args;
    const joined = args.slice(1).join(" ").trim();
    if (!joined)
        return args;
    const normalized = tryNormalizeNodeEExecCommand(`node -e ${joined}`);
    if (!normalized)
        return args;
    return normalized.args;
}
function parseExecCommand(rawTitle) {
    if (!rawTitle.toLowerCase().startsWith("exec:"))
        return null;
    const command = rawTitle.slice(5).trim();
    if (!command)
        return null;
    const normalizedNodeE = tryNormalizeNodeEExecCommand(command);
    if (normalizedNodeE) {
        return {
            cmd: normalizedNodeE.cmd,
            args: normalizedNodeE.args,
            command,
        };
    }
    const tokens = [];
    const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`|([^\s]+)/g;
    let match = null;
    while ((match = re.exec(command))) {
        const token = match[1] ?? match[2] ?? match[3] ?? match[4];
        if (typeof token === "string" && token.length > 0) {
            tokens.push(token.replace(/\\(["'`\\])/g, "$1"));
        }
    }
    if (tokens.length === 0)
        return null;
    return {
        cmd: tokens[0],
        args: tokens.slice(1),
        command,
    };
}
function clamp01(v) {
    if (!Number.isFinite(v))
        return 0;
    return Math.max(0, Math.min(1, v));
}
function roleTargetTemperature(role) {
    if (role === "research")
        return 0.45;
    if (role === "dev")
        return 0.1;
    if (role === "planner")
        return 0.15;
    return 0.2;
}
function compositeScore(successRate, criticScore, avgMs, parentAvgMs) {
    const s = clamp01(successRate);
    const c = clamp01(criticScore);
    const speedRatio = parentAvgMs > 0 && avgMs > 0 ? Math.max(0, Math.min(2, parentAvgMs / avgMs)) : 1;
    const speed = clamp01(speedRatio / 2);
    return Number((s * 0.5 + c * 0.3 + speed * 0.2).toFixed(4));
}
function variance(values) {
    if (values.length <= 1)
        return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const v = values.reduce((acc, x) => acc + Math.pow(x - mean, 2), 0) / values.length;
    return Number(v.toFixed(8));
}
function okText(obj) {
    return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}
function errText(message) {
    return { isError: true, content: [{ type: "text", text: message }] };
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
async function readCursorState(cursorPath) {
    try {
        const raw = await fs.readFile(cursorPath, "utf8");
        const parsed = JSON.parse(raw);
        return {
            cursor: typeof parsed?.cursor === "string" ? parsed.cursor : null,
            updated_at: typeof parsed?.updated_at === "string" ? parsed.updated_at : null,
        };
    }
    catch {
        return { cursor: null, updated_at: null };
    }
}
function buildWorkerSnapshot() {
    const metrics = backgroundWorkerManager?.metrics() ?? { started: false, workers: [] };
    return {
        started: metrics.started,
        started_at: backgroundWorkerStartedAt,
        workers: metrics.workers,
    };
}
// Create MCP server
function createMcpServer() {
    const server = new McpServer({
        name: "mcp-sync-server",
        version: "1.0.0",
    }, {
        capabilities: {
            tools: { listChanged: true },
        },
    });
    // Basic tools
    server.tool("whoami", "Get server info and available roots", {}, async () => {
        return {
            content: [{
                    type: "text",
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
                        ]
                    })
                }]
        };
    });
    async function runSyncOutboundOnce(batchSize) {
        await ensureSyncDir();
        const worker = new OutboundSyncWorker({
            syncDir: SYNC_DIR,
            batchSize: batchSize ?? SYNC_BATCH_SIZE,
        });
        return worker.runOnce();
    }
    async function runSyncInboundOnce(batchSize) {
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
    async function runEnqueueInboundResponseId(conversationId, responseId, dedupeKey) {
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
    async function applyResearchImpactOnExperimentConverged(search) {
        if (!search.force_check && search.phase !== "converged")
            return null;
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
        if (!allowImpact)
            return null;
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
        let transfer_memory_update = null;
        try {
            const adaptiveByDomain = normalizeAdaptiveProfilesByDomain(research.profile?.adaptive_profiles_by_domain, research.profile?.adaptive_profile);
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
        }
        catch (e) {
            transfer_memory_update = {
                updated: false,
                reason: "memory_update_error",
                error: String(e?.message ?? e),
            };
        }
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
    async function runExperimentSearchTickWithResearchProfile(args) {
        let adaptiveProfile = undefined;
        let adaptiveProfilesByDomain = undefined;
        try {
            const activeResearch = await agentGetActiveByRole(SYNC_DIR, "research");
            adaptiveProfile = activeResearch.profile?.adaptive_profile;
            adaptiveProfilesByDomain = normalizeAdaptiveProfilesByDomain(activeResearch.profile?.adaptive_profiles_by_domain, activeResearch.profile?.adaptive_profile);
        }
        catch {
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
    function extractObjectiveMetricName(objective) {
        if (objective && typeof objective === "object" && typeof objective.metric === "string") {
            const metric = objective.metric.trim();
            return metric || null;
        }
        if (typeof objective === "string") {
            const m = objective.trim().match(/^(maximize|minimize)\s+([a-zA-Z0-9_.-]+)$/i);
            if (m && m[2])
                return m[2];
        }
        return null;
    }
    function buildDefaultMetricSchemaForObjective(objective) {
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
    function extractTemplateKeys(template) {
        const keys = new Set();
        const re = /\{([a-zA-Z0-9_.-]+)\}/g;
        let match = null;
        while ((match = re.exec(template))) {
            if (match[1])
                keys.add(match[1]);
        }
        return [...keys];
    }
    function isTemplateCompatibleWithSearchSpace(template, searchSpace) {
        const keys = extractTemplateKeys(template);
        if (keys.length === 0)
            return true;
        const available = new Set(Object.keys(searchSpace ?? {}));
        return keys.every((k) => available.has(k));
    }
    async function inferExecTemplateForCampaign(opts) {
        const objectiveMetric = extractObjectiveMetricName(opts.objective);
        const paramCount = Object.keys(opts.searchSpace ?? {}).length;
        const listed = await experimentList({ syncDir: SYNC_DIR, limit: 2000 });
        const candidates = listed.items
            .filter((e) => e?.metadata?.campaign_id !== opts.campaignId)
            .map((e) => {
            const templateRaw = typeof e?.metadata?.exec_command === "string"
                ? e.metadata.exec_command.trim()
                : "";
            if (!templateRaw)
                return null;
            if (!isTemplateCompatibleWithSearchSpace(templateRaw, opts.searchSpace))
                return null;
            const metric = extractObjectiveMetricName(e.objective);
            const score = (objectiveMetric && metric === objectiveMetric ? 2 : 0) +
                (Object.keys(e.search_space ?? {}).length === paramCount ? 1 : 0);
            return {
                experiment_id: e.experiment_id,
                template: templateRaw,
                score,
                updated_at: e.updated_at,
            };
        })
            .filter((x) => Boolean(x));
        if (candidates.length === 0)
            return null;
        candidates.sort((a, b) => {
            if (b.score !== a.score)
                return b.score - a.score;
            return Date.parse(b.updated_at) - Date.parse(a.updated_at);
        });
        const best = candidates[0];
        return {
            template: best.template,
            source_experiment_id: best.experiment_id,
        };
    }
    async function ensureCampaignPrimaryExperiment(campaign) {
        const terminalExperimentStatuses = new Set(["completed", "archived", "failed", "stopped"]);
        const expList = await experimentList({ syncDir: SYNC_DIR, limit: 500 });
        const campaignExperiments = expList.items.filter((e) => e?.metadata?.campaign_id === campaign.campaign_id);
        if (typeof campaign.primary_experiment_id === "string" && campaign.primary_experiment_id.trim()) {
            const primary = expList.items.find((e) => e.experiment_id === campaign.primary_experiment_id);
            if (primary && !terminalExperimentStatuses.has(String(primary.status ?? ""))) {
                return campaign.primary_experiment_id;
            }
        }
        const activeExisting = campaignExperiments.find((e) => !terminalExperimentStatuses.has(String(e?.status ?? "")));
        if (activeExisting?.experiment_id) {
            campaign.primary_experiment_id = activeExisting.experiment_id;
            if (!Array.isArray(campaign.experiment_ids))
                campaign.experiment_ids = [];
            if (!campaign.experiment_ids.includes(activeExisting.experiment_id)) {
                campaign.experiment_ids.push(activeExisting.experiment_id);
            }
            await campaignSave({
                syncDir: SYNC_DIR,
                campaign,
            });
            return activeExisting.experiment_id;
        }
        const objective = campaign.objective ?? { metric: "score", mode: "maximize" };
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
        const nextExperimentIndex = Math.max(1, (Array.isArray(campaign.experiment_ids) ? campaign.experiment_ids.length : campaignExperiments.length) + 1);
        const name = typeof constraints.experiment_name === "string"
            ? constraints.experiment_name
            : `campaign_${campaign.campaign_id}_exp_${nextExperimentIndex}`;
        const metadata = {
            campaign_id: campaign.campaign_id,
            campaign_goal: campaign.goal,
            campaign_mode: "autonomous",
        };
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
        if (!Array.isArray(campaign.experiment_ids))
            campaign.experiment_ids = [];
        if (!campaign.experiment_ids.includes(experimentId))
            campaign.experiment_ids.push(experimentId);
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
    function renderExecCommandTemplate(template, params) {
        return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_m, key) => {
            const val = params?.[key];
            return val == null ? "" : String(val);
        }).trim();
    }
    function resolveCampaignExecTemplate(campaign, experiment) {
        const fromExperiment = typeof experiment?.metadata?.exec_command === "string"
            ? experiment.metadata.exec_command.trim()
            : "";
        if (fromExperiment)
            return fromExperiment;
        const fromCampaign = typeof campaign?.constraints?.exec_command === "string"
            ? campaign.constraints.exec_command.trim()
            : "";
        return fromCampaign || null;
    }
    async function bindCreatedRunsToExecTasks(args) {
        const template = resolveCampaignExecTemplate(args.campaign, args.experiment);
        const result = {
            scanned: args.createdRuns.length,
            task_created: 0,
            run_linked: 0,
            skipped_no_template: 0,
            skipped_has_task_id: 0,
            skipped_empty_command: 0,
            errors: [],
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
            }
            catch (e) {
                result.errors.push({
                    run_id: String(run?.run_id ?? "unknown"),
                    error: String(e?.message ?? e),
                });
            }
        }
        return result;
    }
    function buildQuotaEvalParams(input) {
        const out = {};
        const searchSpace = (input.searchSpace && typeof input.searchSpace === "object") ? input.searchSpace : {};
        const keys = Object.keys(searchSpace).sort();
        let idx = 0;
        for (const key of keys) {
            const values = Array.isArray(searchSpace[key]) ? searchSpace[key] : [];
            if (values.length === 0)
                continue;
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
    async function buildCampaignSnapshot(campaign) {
        const expList = await experimentList({ syncDir: SYNC_DIR, limit: 500 });
        const campaignExperiments = expList.items.filter((e) => e?.metadata?.campaign_id === campaign.campaign_id);
        const bestParams = [];
        const convergenceSummary = [];
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
        const bestStrategyPerDomain = (arena.snapshot?.domains ?? []).map((d) => ({
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
    async function runCampaignTick(args) {
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
            const tickResults = [];
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
            await ensureCampaignPrimaryExperiment(campaign);
            for (let i = 0; i < steps; i += 1) {
                campaign = (await campaignGet({
                    syncDir: SYNC_DIR,
                    campaign_id: args.campaign_id,
                })).campaign;
                if (campaign.status !== "running")
                    break;
                const nextTickIndex = Math.max(0, Number(campaign.tick_count ?? 0)) + 1;
                const nextTickId = `${campaign.campaign_id}:${nextTickIndex}`;
                const duplicateTick = (campaign.history ?? []).some((h) => h?.type === "campaign.tick" &&
                    (String(h?.data?.tick_id ?? "") === nextTickId ||
                        Number(h?.data?.tick_index ?? NaN) === nextTickIndex));
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
                const campaignExperiments = expList.items.filter((e) => e?.metadata?.campaign_id === campaign.campaign_id);
                const transferDiagBeforeTick = await transferDiagnosticsSnapshot({ syncDir: SYNC_DIR });
                const perDomainTransfer = Array.isArray(transferDiagBeforeTick.snapshot?.per_domain_transfer)
                    ? transferDiagBeforeTick.snapshot?.per_domain_transfer
                    : [];
                const bootstrapQuotaMode = Number(transferDiagBeforeTick.snapshot?.impact_applied_share ?? 0) <= 0;
                const recentTargetedDomains = new Set();
                for (const h of [...(campaign.history ?? [])].reverse()) {
                    if (h?.type !== "campaign.tick")
                        continue;
                    const arr = Array.isArray(h?.data?.confidence_domains_targeted)
                        ? h.data.confidence_domains_targeted
                        : [];
                    for (const item of arr) {
                        const sig = String(item ?? "").trim();
                        if (sig)
                            recentTargetedDomains.add(sig);
                    }
                    if (recentTargetedDomains.size >= 4)
                        break;
                }
                const totalDomainTraffic = Math.max(1, perDomainTransfer.reduce((acc, d) => acc + Math.max(0, Number(d?.experiments_total ?? 0)), 0));
                const totalTransferAttempts = Math.max(1, perDomainTransfer.reduce((acc, d) => acc + Math.max(0, Number(d?.transfer_initialized ?? 0)), 0));
                const scoredLowConfidence = perDomainTransfer
                    .map((d) => ({
                    domain_signature: String(d?.domain_signature ?? "").trim(),
                    confidence: Number(d?.average_transfer_evidence_confidence ?? d?.average_transfer_confidence ?? NaN),
                    observations: Math.max(0, Math.trunc(Number(d?.evidence_observations ?? d?.confidence_observations ?? 0))),
                    impact_applied_share: clamp01(Number(d?.impact_applied_share ?? 0)),
                    transfer_initialized: Math.max(0, Number(d?.transfer_initialized ?? 0)),
                    experiments_total: Math.max(0, Number(d?.experiments_total ?? 0)),
                }))
                    .filter((d) => d.domain_signature.length > 0 && d.domain_signature !== "unknown")
                    .map((d) => {
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
                    .filter((d) => d.deficit > 0)
                    .sort((a, b) => {
                    if (b.score !== a.score)
                        return b.score - a.score;
                    if (a.confidence !== b.confidence)
                        return a.confidence - b.confidence;
                    return a.observations - b.observations;
                })
                    .slice(0, 8);
                const isP5Domain = (domainSignature) => domainSignature.endsWith("|p5") || domainSignature.includes("|p5");
                const isP2Domain = (domainSignature) => domainSignature.endsWith("|p2") || domainSignature.includes("|p2");
                const selectedLowConfidence = [];
                const p5Priority = scoredLowConfidence.find((d) => isP5Domain(String(d.domain_signature ?? "")));
                if (p5Priority)
                    selectedLowConfidence.push(p5Priority);
                if (bootstrapQuotaMode) {
                    const secondP5 = scoredLowConfidence.find((d) => isP5Domain(String(d.domain_signature ?? ""))
                        && !selectedLowConfidence.some((x) => x.domain_signature === d.domain_signature));
                    if (secondP5)
                        selectedLowConfidence.push(secondP5);
                }
                const secondPass = bootstrapQuotaMode
                    ? [
                        ...scoredLowConfidence.filter((d) => isP5Domain(String(d.domain_signature ?? ""))),
                        ...scoredLowConfidence.filter((d) => isP2Domain(String(d.domain_signature ?? ""))),
                        ...scoredLowConfidence,
                    ]
                    : scoredLowConfidence;
                for (const candidate of secondPass) {
                    if (selectedLowConfidence.some((x) => x.domain_signature === candidate.domain_signature))
                        continue;
                    selectedLowConfidence.push(candidate);
                    if (selectedLowConfidence.length >= 2)
                        break;
                }
                const lowConfidenceDomains = selectedLowConfidence.slice(0, 2);
                const confidenceQuotaByDomain = new Map();
                for (const d of lowConfidenceDomains) {
                    const needObs = Math.max(0, 5 - d.observations);
                    const isVeryLow = Number.isFinite(d.confidence) && d.confidence < 0.12;
                    const rawRuns = bootstrapQuotaMode
                        ? Math.min(4, Math.max(2, needObs > 0 ? needObs : 2))
                        : (needObs > 0 ? Math.min(4, Math.max(1, needObs)) : 1);
                    let minRuns = rawRuns;
                    if (isVeryLow)
                        minRuns = Math.min(4, minRuns + 1);
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
                const confidenceQuotaDiagnostics = [];
                let createdTotal = 0;
                let autobindScanned = 0;
                let autobindTaskCreated = 0;
                let autobindRunLinked = 0;
                let autobindSkippedNoTemplate = 0;
                let autobindSkippedHasTaskId = 0;
                let autobindSkippedEmptyCommand = 0;
                const autobindErrors = [];
                const confidenceQuotaHits = [];
                const impacted = [];
                for (const exp of campaignExperiments) {
                    if (exp.status === "completed" || exp.status === "archived")
                        continue;
                    const expDomainProfile = (exp?.metadata?.domain_profile && typeof exp.metadata.domain_profile === "object")
                        ? exp.metadata.domain_profile
                        : null;
                    const expDomainSignature = expDomainProfile ? computeDomainSignature(expDomainProfile) : "";
                    const quota = confidenceQuotaByDomain.get(expDomainSignature);
                    const requestedBatch = quota
                        ? Math.max(1, Number(quota.min_runs ?? 1))
                        : 10;
                    let search = await runExperimentSearchTickWithResearchProfile({
                        experiment_id: exp.experiment_id,
                        batch_size: requestedBatch,
                    });
                    let createdForQuota = Number(search.created_count ?? 0);
                    let createdRuns = Array.isArray(search.created) ? [...search.created] : [];
                    if (quota) {
                        const createdAfterInitialSearch = createdForQuota;
                        let topupGuard = 0;
                        while (createdForQuota < quota.min_runs && topupGuard < 3 && search.phase !== "converged") {
                            const needed = Math.max(1, quota.min_runs - createdForQuota);
                            const topup = await runExperimentSearchTickWithResearchProfile({
                                experiment_id: exp.experiment_id,
                                batch_size: needed,
                            });
                            createdForQuota += Number(topup.created_count ?? 0);
                            if (Array.isArray(topup.created)) {
                                createdRuns.push(...topup.created);
                            }
                            topupGuard += 1;
                            search = {
                                ...search,
                                created_count: createdForQuota,
                                created: createdRuns,
                            };
                            if (Number(topup.created_count ?? 0) <= 0)
                                break;
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
                            if (materialized >= 8)
                                break;
                        }
                        search = {
                            ...search,
                            created_count: createdForQuota,
                            created: createdRuns,
                        };
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
                        phase: search.phase,
                        stop_reason: search.stop_reason ?? null,
                    });
                    if (impact)
                        impacted.push(impact);
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
                const activeResearch = (metricsSnap.items ?? []).find((it) => it.active) ?? (metricsSnap.items ?? [])[0];
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
                const gihiLow = gihiGuardActive && (Number(nextMetrics.gihi ?? 0) < Number(campaign.stop_conditions?.min_gihi ?? 0));
                const stagnated = Number(nextMetrics.stagnation_rate ?? 0) > Number(campaign.stop_conditions?.stagnation_rate_gt ?? 1);
                const maxTicksReached = projectedTickCount >= Number(campaign.stop_conditions?.max_ticks ?? Number.MAX_SAFE_INTEGER);
                let stopReason = null;
                if (converged)
                    stopReason = "convergence_detected";
                else if (maxExperimentsReached)
                    stopReason = "max_experiments_reached";
                else if (gihiLow)
                    stopReason = "gihi_below_threshold";
                else if (stagnated)
                    stopReason = "stagnation_too_high";
                else if (maxTicksReached)
                    stopReason = "max_ticks_reached";
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
                    confidence_domains_targeted: lowConfidenceDomains.map((d) => d.domain_signature),
                    confidence_quota_hits: confidenceQuotaHits,
                    confidence_quota_diagnostics: confidenceQuotaDiagnostics,
                    status,
                    stop_reason: stopReason,
                };
                const commitLock = await acquireLock({
                    locksDir: path.join(SYNC_DIR, "queue", "locks"),
                    name: "campaign_commit",
                    ttl_ms: 5_000,
                });
                const commitToken = commitLock.token;
                if (!commitLock.ok || !commitToken) {
                    throw new Error("campaign_commit lock busy");
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
                    }
                    finally {
                        await releaseLock({
                            locksDir: path.join(SYNC_DIR, "queue", "locks"),
                            name: "campaign_commit",
                            token: commitToken,
                        });
                    }
                })();
                await researchMemoryAdvanceCircuitBreakerTick({
                    syncDir: SYNC_DIR,
                });
                campaign = committed.campaign;
                tickResults.push({
                    ...tickData,
                    committed: committed.committed,
                });
                if (campaign.status !== "running")
                    break;
            }
            let autoAdvance = null;
            const autoAdvanceEnabled = (() => {
                const constraints = campaign?.constraints;
                if (!constraints || typeof constraints !== "object")
                    return true;
                const raw = constraints.auto_advance;
                if (typeof raw === "boolean")
                    return raw;
                return true;
            })();
            if (campaign.status === "running" && tickResults.length > 0 && autoAdvanceEnabled) {
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
                    idempotency_key: `auto-${nextTickIndex}`,
                    not_before_ts: notBeforeTs,
                });
                autoAdvance = {
                    queued: queued.queued,
                    job_id: queued.job_id,
                    next_tick_index: nextTickIndex,
                    not_before_ts: notBeforeTs,
                };
            }
            return {
                campaign,
                steps_requested: steps,
                steps_executed: tickResults.length,
                ticks: tickResults,
                auto_advance: autoAdvance,
            };
        }
        finally {
            await releaseLock({
                locksDir: path.join(SYNC_DIR, "queue", "locks"),
                name: `campaign_tick_${args.campaign_id}`,
                token: tickLock.token,
            });
        }
    }
    async function runExecutionBindTick(projectId, limit) {
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
        const bindings = [];
        const errors = [];
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
    async function runRecoveryTick(projectId, limit) {
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
    async function runAgentDispatchTick(projectId, limit) {
        await ensureSyncDir();
        const graph = await taskGraph({ syncDir: SYNC_DIR, project_id: projectId });
        const maxItems = Math.max(1, Math.min(limit ?? 100, 1000));
        const candidates = graph.items
            .filter((item) => item.status === "in_progress")
            .filter((item) => Boolean(item.role))
            .filter((item) => !item.title.toLowerCase().startsWith("exec:"))
            .filter((item) => !(item.execution?.mode === "agent" && item.execution?.job_id))
            .slice(0, maxItems);
        const queued = [];
        const errors = [];
        for (const task of candidates) {
            try {
                const role = String(task.role);
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
            }
            catch (e) {
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
    async function runShadowEvaluationTick(opts) {
        await ensureSyncDir();
        const governance = (await governanceGet(SYNC_DIR)).governance;
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
        const decisions = [];
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
            if (roleEvents.length < requiredReplayRuns) {
                if (discardOnFail) {
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
                        reason: "insufficient_replay_runs",
                        replay_runs: roleEvents.length,
                        required_replay_runs: requiredReplayRuns,
                    });
                }
                else {
                    decisions.push({
                        role: shadow.role,
                        version: shadow.version,
                        parent_version: shadow.parent_version,
                        decision: "keep_shadow",
                        reason: "insufficient_replay_runs",
                        replay_runs: roleEvents.length,
                        required_replay_runs: requiredReplayRuns,
                    });
                }
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
            const unstable = replaySuccessVar > governance.stability_success_variance_max ||
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
            }
            else {
                // Replay-based synthetic evaluation for shadow mode.
                const tempDiff = Math.abs(shadow.profile.temperature - roleTargetTemperature(shadow.role));
                const promptBonus = shadow.profile.system_prompt.includes("[EVOLUTION_NOTE]") ? 0.05 : 0;
                let strategyBonus = 0;
                if (shadow.role === "research") {
                    const parentAdaptive = normalizeAdaptiveProfile(parent.profile.adaptive_profile);
                    const shadowAdaptive = normalizeAdaptiveProfile(shadow.profile.adaptive_profile);
                    const researchStats = parent.metrics?.research_stats ?? {};
                    const avgConvergenceSteps = Number(researchStats.avg_convergence_steps ?? 0);
                    const stagnationRate = Number(researchStats.stagnation_rate ?? 0);
                    const varianceStability = Number(researchStats.variance_stability ?? 1);
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
                    const adaptiveDrift = Math.abs(shadowAdaptive.narrowing_factor - parentAdaptive.narrowing_factor) +
                        Math.abs(shadowAdaptive.exploration_bias - parentAdaptive.exploration_bias) +
                        Math.abs(shadowAdaptive.variance_sensitivity - parentAdaptive.variance_sensitivity);
                    if (adaptiveDrift > 0.8)
                        strategyBonus -= 0.03;
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
                await agentVersionActivate({
                    syncDir: SYNC_DIR,
                    role: shadow.role,
                    version: shadow.version,
                    reason: `shadow_eval_delta=${delta}`,
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
            }
            else if (discardOnFail) {
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
            }
            else {
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
    async function runMetaGovernanceTick(args) {
        await ensureSyncDir();
        const dryRun = Boolean(args?.dry_run);
        const targetCampaignId = typeof args?.campaign_id === "string" && args.campaign_id.trim()
            ? args.campaign_id.trim()
            : undefined;
        const applyAllRunning = typeof args?.apply_all_running === "boolean"
            ? args.apply_all_running
            : true;
        const scopedCampaignOnly = args?.scoped_campaign_only !== false;
        let cooldownMs = Math.max(60_000, Math.min(24 * 60 * 60 * 1000, Math.trunc(Number(args?.meta_governance_cooldown_ms ?? 90_000))));
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
        const adaptivePatch = {};
        const metaPatch = {};
        const evolutionPatch = {};
        const arenaPatch = {};
        const campaignPatch = {};
        const reasons = [];
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
            evolutionPatch.evolution_cooldown_ms = Math.max(20_000, Math.round(Number(currentEvolution.evolution_cooldown_ms ?? 0) * 1.15));
        }
        if (snapshot.gihi_slope > 0.0015 && snapshot.transfer_variance < 0.05) {
            reasons.push("gihi_rising_stable");
            arenaPatch.promotion_margin = Math.max(0.02, Number(arenaPatch.promotion_margin ?? 0.03));
            adaptivePatch.exploration_bias = Math.min(Number(adaptivePatch.exploration_bias ?? 0), -0.04);
            metaPatch.exploration_vs_exploitation_bias = Math.min(Number(metaPatch.exploration_vs_exploitation_bias ?? 0), -0.04);
        }
        if (snapshot.arena_entropy > 0.88) {
            reasons.push("entropy_above_target_high");
            adaptivePatch.exploration_bias = Math.min(Number(adaptivePatch.exploration_bias ?? 0), -0.06);
            metaPatch.exploration_vs_exploitation_bias = Math.min(Number(metaPatch.exploration_vs_exploitation_bias ?? 0), -0.06);
        }
        const priorTicks = await eventList({
            syncDir: SYNC_DIR,
            type: "meta.governance.tick",
            limit: 200,
        });
        const tickStream = (priorTicks.items ?? [])
            .map((ev) => {
            const payload = ev?.payload ?? ev?.data ?? {};
            const ts = Date.parse(String(ev?.ts ?? ""));
            return {
                ts: Number.isFinite(ts) ? ts : 0,
                meta_state: typeof payload?.meta_state === "string" ? payload.meta_state : "",
                gihi_slope: Number(payload?.gihi_slope ?? NaN),
            };
        })
            .filter((x) => x.ts > 0)
            .sort((a, b) => b.ts - a.ts);
        const lastTick = tickStream[0];
        const msSinceLastTick = lastTick ? Math.max(0, Date.now() - lastTick.ts) : null;
        let priorStateStreak = 0;
        let negativeSlopeStreak = Number(snapshot.gihi_slope < -0.0015 ? 1 : 0);
        for (const tick of tickStream) {
            if (tick.meta_state === snapshot.meta_state)
                priorStateStreak += 1;
            else
                break;
        }
        for (const tick of tickStream) {
            const slope = Number(tick?.gihi_slope ?? NaN);
            if (Number.isFinite(slope) && slope < -0.0015)
                negativeSlopeStreak += 1;
            else
                break;
        }
        const observedStateStreak = priorStateStreak + 1;
        const hysteresisPassed = observedStateStreak >= minStateStreak || negativeSlopeStreak >= minStateStreak;
        const actions = {
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
                research_profile: null,
                evolution_governance: null,
                arena_governance: null,
                forced_rotations: null,
                campaigns: [],
            },
            skipped: [],
        };
        if (reasons.length === 0) {
            actions.skipped.push("no_adjustment_conditions_matched");
            return actions;
        }
        if (msSinceLastTick !== null && msSinceLastTick < cooldownMs) {
            actions.skipped.push("cooldown_active");
            return actions;
        }
        if (!hysteresisPassed) {
            actions.skipped.push("hysteresis_not_reached");
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
            return actions;
        }
        if (scopedCampaignOnly) {
            actions.skipped.push("scoped_campaign_only");
            actions.skipped.push("research_profile_noop");
            actions.skipped.push("evolution_governance_noop");
            actions.skipped.push("arena_governance_noop");
        }
        else if (Object.keys(adaptivePatch).length > 0 || Object.keys(metaPatch).length > 0) {
            const activeResearch = await agentGetActiveByRole(SYNC_DIR, "research");
            const currentAdaptive = normalizeAdaptiveProfile(activeResearch.profile?.adaptive_profile);
            const currentMeta = activeResearch.profile?.meta_profile ?? {};
            const resolvedAdaptivePatch = {};
            if (typeof adaptivePatch.exploration_bias === "number") {
                resolvedAdaptivePatch.exploration_bias = Number(clamp01(currentAdaptive.exploration_bias + adaptivePatch.exploration_bias).toFixed(4));
            }
            const resolvedMetaPatch = {};
            if (typeof metaPatch.exploration_vs_exploitation_bias === "number") {
                const base = Number(currentMeta?.exploration_vs_exploitation_bias ?? 0.5);
                resolvedMetaPatch.exploration_vs_exploitation_bias = Number(clamp01(base + metaPatch.exploration_vs_exploitation_bias).toFixed(4));
            }
            if (typeof metaPatch.mutation_intensity === "number") {
                const base = Number(currentMeta?.mutation_intensity ?? 1);
                resolvedMetaPatch.mutation_intensity = Number(Math.max(0.5, Math.min(1.5, base * (1 + metaPatch.mutation_intensity))).toFixed(4));
            }
            actions.applied.research_profile = await researchProfileGovernanceTune({
                syncDir: SYNC_DIR,
                adaptive_patch: Object.keys(resolvedAdaptivePatch).length ? resolvedAdaptivePatch : undefined,
                meta_patch: Object.keys(resolvedMetaPatch).length ? resolvedMetaPatch : undefined,
            });
        }
        else {
            actions.skipped.push("research_profile_noop");
        }
        if (scopedCampaignOnly) {
            // no-op in scoped mode
        }
        else if (Object.keys(evolutionPatch).length > 0) {
            actions.applied.evolution_governance = await governanceSet(SYNC_DIR, evolutionPatch);
        }
        else {
            actions.skipped.push("evolution_governance_noop");
        }
        if (scopedCampaignOnly) {
            // no-op in scoped mode
        }
        else if (Object.keys(arenaPatch).length > 0) {
            const result = await researchMemoryArenaGovernanceSet({
                syncDir: SYNC_DIR,
                patch: arenaPatch,
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
        }
        else {
            actions.skipped.push("arena_governance_noop");
        }
        if (Object.keys(campaignPatch).length > 0) {
            const candidates = [];
            if (targetCampaignId) {
                try {
                    const one = await campaignGet({
                        syncDir: SYNC_DIR,
                        campaign_id: targetCampaignId,
                    });
                    candidates.push(one.campaign);
                }
                catch {
                    actions.skipped.push("target_campaign_not_found");
                }
            }
            else if (applyAllRunning) {
                const running = await campaignList({
                    syncDir: SYNC_DIR,
                    status: "running",
                    limit: 1000,
                });
                candidates.push(...running.items);
            }
            else {
                actions.skipped.push("campaign_scope_not_provided");
            }
            for (const campaign of candidates) {
                const constraints = (campaign.constraints && typeof campaign.constraints === "object")
                    ? { ...campaign.constraints }
                    : {};
                if (typeof campaignPatch.transfer_threshold === "number") {
                    const current = Number(constraints.transfer_threshold ?? 0.16);
                    constraints.transfer_threshold = Number(Math.max(0, Math.min(1, current - 0.05)).toFixed(4));
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
                    .map((x) => Number(x))
                    .filter((x) => Number.isFinite(x))
                    .map((x) => Number(Math.max(0, Math.min(1, x + delta)).toFixed(4)));
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
        }
        else {
            actions.skipped.push("campaign_patch_noop");
        }
        const highVarianceDomains = Array.isArray(snapshot?.stressed_driver_breakdown?.high_variance_domains)
            ? snapshot.stressed_driver_breakdown.high_variance_domains
                .map((d) => String(d?.domain_signature ?? "").trim())
                .filter((s) => s.length > 0)
            : [];
        const shouldApplyHardCircuitBreaker = snapshot.meta_state === "degenerating" &&
            highVarianceDomains.length > 0;
        const shouldApplySoftAnnealDown = (snapshot.meta_state === "stable" || snapshot.meta_state === "stressed") &&
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
            actions.applied.circuit_breaker = breaker;
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
        }
        else if (shouldApplySoftAnnealDown) {
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
            actions.applied.circuit_breaker = breaker;
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
        }
        else {
            actions.skipped.push("circuit_breaker_not_triggered");
        }
        const shouldForceRotate = snapshot.meta_state === "degenerating" &&
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
        }
        else {
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
                transfer_variance: snapshot.transfer_variance,
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
                    circuit_breaker_domains_updated: Number(actions.applied.circuit_breaker?.updated_count ?? 0),
                    forced_rotations: Number(actions.applied.forced_rotations?.rotated_count ?? 0),
                    campaigns_updated: actions.applied.campaigns.length,
                },
            },
        });
        return actions;
    }
    // Simple router for now
    // ---- Diagnostic MCP tools (sleep / async job demo) ----
    const debugJobs = new Map();
    const parseDebugMs = (params) => {
        const msRaw = params?.arguments?.ms ??
            params?.ms ??
            params?.arguments?.durationMs ??
            params?.durationMs;
        const ms = Number(msRaw);
        if (!Number.isFinite(ms) || ms < 0 || !Number.isInteger(ms) || ms > 600000) {
            throw new Error(`Invalid ms: ${msRaw}`);
        }
        return ms;
    };
    const parseDebugJobId = (params) => {
        const raw = params?.arguments?.job_id ??
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
    server.tool("debug_sleep_sync", "Diagnostic: sleep for ms then return. Use to reproduce client timeouts/ABORT on long tool calls.", { ms: z.number().int().min(0).max(600000) }, async (params) => {
        const ms = parseDebugMs(params);
        await new Promise((r) => setTimeout(r, ms));
        return { content: [{ type: "text", text: `slept ${ms}ms` }] };
    });
    server.tool("debug_sleep_async_start", "Diagnostic: start an async sleep job and return job_id immediately (pattern for avoiding client timeouts).", { ms: z.number().int().min(0).max(600000) }, async (params) => {
        const ms = parseDebugMs(params);
        const jobId = randomUUID();
        debugJobs.set(jobId, { status: "running", startedAt: Date.now() });
        setTimeout(() => {
            const j = debugJobs.get(jobId);
            if (!j)
                return;
            j.status = "done";
            j.doneAt = Date.now();
            j.result = `slept ${ms}ms`;
            debugJobs.set(jobId, j);
        }, ms);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ job_id: jobId, status: "running", eta_ms: ms }, null, 2),
                },
            ],
        };
    });
    server.tool("debug_sleep_async_get", "Diagnostic: get status/result of async sleep job by job_id.", { job_id: z.string().min(1) }, async (params) => {
        const job_id = parseDebugJobId(params);
        const j = debugJobs.get(job_id);
        if (!j) {
            return { content: [{ type: "text", text: JSON.stringify({ job_id, status: "missing" }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ job_id, ...j }, null, 2) }] };
    });
    // ------------------------------------------------------
    server.tool("router_execute_command", "Execute command from inbox", {}, async () => {
        await ensureSyncDir();
        try {
            const raw = await fs.readFile(INBOX_FILE, 'utf-8').catch(() => "");
            if (!raw.trim()) {
                return {
                    content: [{
                            type: "text",
                            text: JSON.stringify({
                                message: "No command to execute",
                                status: "idle"
                            })
                        }]
                };
            }
            let job;
            try {
                job = JSON.parse(raw);
            }
            catch {
                return {
                    content: [{
                            type: "text",
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
                    }
                    catch {
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
                            type: "text",
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
            }
            else if (job.command === "sync_outbound_once") {
                result = await runSyncOutboundOnce(job.batch_size);
            }
            else if (job.command === "sync_inbound_once") {
                result = await runSyncInboundOnce(job.batch_size);
            }
            else if (job.command === "sync_status") {
                result = await runSyncStatus();
            }
            else if (job.command === "sync_reconcile") {
                result = await runSyncReconcile();
            }
            else if (job.command === "enqueue_inbound_response_id") {
                if (!job.conversation_id || !job.response_id) {
                    result = {
                        success: false,
                        error: "enqueue_inbound_response_id requires conversation_id and response_id",
                    };
                }
                else {
                    result = await runEnqueueInboundResponseId(String(job.conversation_id), String(job.response_id), job.dedupe_key ? String(job.dedupe_key) : undefined);
                }
            }
            else if (job.command === "experiment_create") {
                if (!job.name) {
                    result = { success: false, error: "experiment_create requires name" };
                }
                else {
                    const objectiveInput = (job.objective == null || (typeof job.objective === "string" && !job.objective.trim()))
                        ? "maximize score"
                        : job.objective;
                    const strategyInput = typeof job.search_strategy === "string"
                        ? job.search_strategy
                        : (typeof job.strategy === "string" ? job.strategy : undefined);
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
            }
            else if (job.command === "experiment_run") {
                if (!job.experiment_id || !job.params || typeof job.params !== "object") {
                    result = { success: false, error: "experiment_run requires experiment_id and params" };
                }
                else {
                    let taskId = null;
                    if (typeof job.exec_command === "string" && job.exec_command.trim()) {
                        const runLabel = typeof job.run_id === "string" ? job.run_id : `run-${Date.now()}`;
                        const template = String(job.exec_command);
                        const rendered = template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_m, key) => {
                            const val = job.params[key];
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
            }
            else if (job.command === "experiment_list") {
                result = await experimentList({
                    syncDir: SYNC_DIR,
                    status: typeof job.status === "string" ? job.status : undefined,
                    limit: typeof job.limit === "number" ? Math.trunc(job.limit) : undefined,
                });
            }
            else if (job.command === "experiment_compare") {
                if (!job.experiment_id) {
                    result = { success: false, error: "experiment_compare requires experiment_id" };
                }
                else {
                    result = await experimentCompare({
                        syncDir: SYNC_DIR,
                        experiment_id: String(job.experiment_id),
                    });
                }
            }
            else if (job.command === "experiment_leaderboard") {
                if (!job.experiment_id) {
                    result = { success: false, error: "experiment_leaderboard requires experiment_id" };
                }
                else {
                    result = await experimentLeaderboard({
                        syncDir: SYNC_DIR,
                        experiment_id: String(job.experiment_id),
                        limit: typeof job.limit === "number" ? Math.trunc(job.limit) : undefined,
                    });
                }
            }
            else if (job.command === "experiment_best") {
                if (!job.experiment_id) {
                    result = { success: false, error: "experiment_best requires experiment_id" };
                }
                else {
                    result = await experimentBest({
                        syncDir: SYNC_DIR,
                        experiment_id: String(job.experiment_id),
                    });
                }
            }
            else if (job.command === "experiment_search_tick") {
                if (!job.experiment_id) {
                    result = { success: false, error: "experiment_search_tick requires experiment_id" };
                }
                else {
                    const search = await runExperimentSearchTickWithResearchProfile({
                        experiment_id: String(job.experiment_id),
                        batch_size: typeof job.batch_size === "number" ? Math.trunc(job.batch_size) : undefined,
                    });
                    const impact = await applyResearchImpactOnExperimentConverged({
                        experiment_id: String(job.experiment_id),
                        phase: search.phase,
                        stop_reason: search.stop_reason ?? null,
                    });
                    result = impact ? { ...search, ...impact } : search;
                }
            }
            else if (job.command === "task_create") {
                result = await taskCreate({
                    syncDir: SYNC_DIR,
                    task_id: typeof job.task_id === "string" ? job.task_id : undefined,
                    project_id: typeof job.project_id === "string" ? job.project_id : undefined,
                    role: typeof job.role === "string" ? job.role : undefined,
                    title: String(job.title ?? ""),
                    description: typeof job.description === "string" ? job.description : undefined,
                    status: typeof job.status === "string" ? job.status : undefined,
                    depends_on: Array.isArray(job.depends_on) ? job.depends_on.map((x) => String(x)) : undefined,
                    children: Array.isArray(job.children) ? job.children.map((x) => String(x)) : undefined,
                    execution_policy: job.execution_policy && typeof job.execution_policy === "object"
                        ? {
                            max_attempts: typeof job.execution_policy.max_attempts === "number"
                                ? Math.trunc(job.execution_policy.max_attempts)
                                : undefined,
                            retry_delay_ms: typeof job.execution_policy.retry_delay_ms === "number"
                                ? Math.trunc(job.execution_policy.retry_delay_ms)
                                : undefined,
                            backoff_multiplier: typeof job.execution_policy.backoff_multiplier === "number"
                                ? job.execution_policy.backoff_multiplier
                                : undefined,
                        }
                        : undefined,
                });
            }
            else if (job.command === "task_link") {
                if (!job.task_id) {
                    result = { success: false, error: "task_link requires task_id" };
                }
                else {
                    result = await taskLink({
                        syncDir: SYNC_DIR,
                        task_id: String(job.task_id),
                        depends_on: Array.isArray(job.depends_on) ? job.depends_on.map((x) => String(x)) : undefined,
                        children: Array.isArray(job.children) ? job.children.map((x) => String(x)) : undefined,
                    });
                }
            }
            else if (job.command === "task_graph") {
                result = await taskGraph({
                    syncDir: SYNC_DIR,
                    project_id: typeof job.project_id === "string" ? job.project_id : undefined,
                });
            }
            else if (job.command === "task_plan_generate") {
                if (!job.goal) {
                    result = { success: false, error: "task_plan_generate requires goal" };
                }
                else {
                    result = await taskPlanGenerate({
                        syncDir: SYNC_DIR,
                        goal: String(job.goal),
                        project_id: typeof job.project_id === "string" ? job.project_id : undefined,
                        max_tasks: typeof job.max_tasks === "number" && Number.isFinite(job.max_tasks)
                            ? Math.trunc(job.max_tasks)
                            : undefined,
                    });
                }
            }
            else if (job.command === "task_status_update") {
                if (!job.task_id || !job.status) {
                    result = { success: false, error: "task_status_update requires task_id and status" };
                }
                else {
                    const allowedTaskStatuses = new Set(["open", "in_progress", "blocked", "done", "canceled"]);
                    if (!allowedTaskStatuses.has(String(job.status))) {
                        result = { success: false, error: "task_status_update status must be one of: open, in_progress, blocked, done, canceled" };
                    }
                    else {
                        result = await taskStatusUpdate({
                            syncDir: SYNC_DIR,
                            task_id: String(job.task_id),
                            status: String(job.status),
                        });
                    }
                }
            }
            else if (job.command === "orchestrator_tick") {
                result = await orchestratorTick({
                    syncDir: SYNC_DIR,
                    project_id: typeof job.project_id === "string" ? job.project_id : undefined,
                    limit: typeof job.limit === "number" && Number.isFinite(job.limit)
                        ? Math.trunc(job.limit)
                        : undefined,
                });
            }
            else if (job.command === "execution_bind_tick") {
                result = await runExecutionBindTick(typeof job.project_id === "string" ? job.project_id : undefined, typeof job.limit === "number" && Number.isFinite(job.limit) ? Math.trunc(job.limit) : undefined);
            }
            else if (job.command === "recovery_tick") {
                result = await runRecoveryTick(typeof job.project_id === "string" ? job.project_id : undefined, typeof job.limit === "number" && Number.isFinite(job.limit) ? Math.trunc(job.limit) : undefined);
            }
            else if (job.command === "governance_get") {
                result = await governanceGet(SYNC_DIR);
            }
            else if (job.command === "governance_set") {
                const patch = (job.patch && typeof job.patch === "object") ? job.patch : job;
                result = await governanceSet(SYNC_DIR, patch);
            }
            else if (job.command === "arena_governance_get") {
                result = await researchMemoryArenaGovernanceGet({
                    syncDir: SYNC_DIR,
                });
            }
            else if (job.command === "arena_governance_set") {
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
                        updated_count: Number(result?.updated_count ?? 0),
                    },
                });
            }
            else if (job.command === "arena_telemetry_snapshot") {
                result = await arenaTelemetrySnapshot({
                    syncDir: SYNC_DIR,
                    limit_domains: typeof job.limit_domains === "number" ? Math.trunc(job.limit_domains) : undefined,
                });
            }
            else if (job.command === "mutation_effectiveness_snapshot") {
                result = await mutationEffectivenessSnapshot({
                    syncDir: SYNC_DIR,
                });
            }
            else if (job.command === "transfer_diagnostics") {
                result = await transferDiagnosticsSnapshot({
                    syncDir: SYNC_DIR,
                });
            }
            else if (job.command === "intelligence_health_snapshot") {
                result = await intelligenceHealthSnapshot({
                    syncDir: SYNC_DIR,
                });
            }
            else if (job.command === "intelligence_meta_snapshot") {
                result = await intelligenceMetaSnapshot({
                    syncDir: SYNC_DIR,
                    mutation_window: typeof job.mutation_window === "number" ? Math.trunc(job.mutation_window) : undefined,
                    transfer_window: typeof job.transfer_window === "number" ? Math.trunc(job.transfer_window) : undefined,
                    gihi_window: typeof job.gihi_window === "number" ? Math.trunc(job.gihi_window) : undefined,
                    campaign_id: typeof job.campaign_id === "string" ? job.campaign_id : undefined,
                });
            }
            else if (job.command === "meta_governance_tick") {
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
            }
            else if (job.command === "lineage_snapshot") {
                result = await lineageSnapshot({
                    syncDir: SYNC_DIR,
                    role: typeof job.role === "string" ? job.role : undefined,
                    limit: typeof job.limit === "number" ? Math.trunc(job.limit) : undefined,
                });
            }
            else if (job.command === "campaign_create") {
                if (!job.goal) {
                    result = { success: false, error: "campaign_create requires goal" };
                }
                else {
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
            }
            else if (job.command === "campaign_tick") {
                if (!job.campaign_id) {
                    result = { success: false, error: "campaign_tick requires campaign_id" };
                }
                else {
                    try {
                        result = await runCampaignTick({
                            campaign_id: String(job.campaign_id),
                            max_steps: typeof job.max_steps === "number" ? Math.trunc(job.max_steps) : undefined,
                        });
                    }
                    catch (e) {
                        const msg = String(e?.message ?? e);
                        if (isLockBusyErrorMessage(msg)) {
                            const retryCount = Math.max(0, Math.trunc(Number(job.retry_count ?? 0)));
                            const nextRetryCount = retryCount + 1;
                            const requeued = await enqueueCampaignTickJob({
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
                        }
                        else {
                            throw e;
                        }
                    }
                }
            }
            else if (job.command === "campaign_report_generate") {
                if (!job.campaign_id) {
                    result = { success: false, error: "campaign_report_generate requires campaign_id" };
                }
                else {
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
            }
            else if (job.command === "campaign_list") {
                result = await campaignList({
                    syncDir: SYNC_DIR,
                    status: typeof job.status === "string" ? job.status : undefined,
                    limit: typeof job.limit === "number" ? Math.trunc(job.limit) : undefined,
                });
            }
            else if (job.command === "agent_registry") {
                const role = typeof job.role === "string" ? job.role : undefined;
                result = await agentRegistryList(SYNC_DIR, role);
            }
            else if (job.command === "agent_metrics_snapshot") {
                const role = typeof job.role === "string" ? job.role : undefined;
                result = await agentMetricsSnapshot(SYNC_DIR, role);
            }
            else if (job.command === "agent_version_create") {
                if (!job.role) {
                    result = { success: false, error: "agent_version_create requires role" };
                }
                else {
                    result = await agentVersionCreate({
                        syncDir: SYNC_DIR,
                        role: String(job.role),
                        model: typeof job.model === "string" ? job.model : undefined,
                        temperature: typeof job.temperature === "number" ? job.temperature : undefined,
                        system_prompt: typeof job.system_prompt === "string" ? job.system_prompt : undefined,
                        activate: typeof job.activate === "boolean" ? job.activate : undefined,
                        parent_version: typeof job.parent_version === "number" ? Math.trunc(job.parent_version) : undefined,
                    });
                }
            }
            else if (job.command === "agent_version_activate") {
                if (!job.role || typeof job.version !== "number") {
                    result = { success: false, error: "agent_version_activate requires role and version" };
                }
                else {
                    result = await agentVersionActivate({
                        syncDir: SYNC_DIR,
                        role: String(job.role),
                        version: Math.trunc(job.version),
                    });
                }
            }
            else if (job.command === "evolution_tick") {
                const role = typeof job.role === "string" ? job.role : undefined;
                result = await agentEvolutionTick({
                    syncDir: SYNC_DIR,
                    role,
                    min_runs: typeof job.min_runs === "number" ? Math.trunc(job.min_runs) : undefined,
                    failure_rate_gt: typeof job.failure_rate_gt === "number" ? job.failure_rate_gt : undefined,
                    critic_score_lt: typeof job.critic_score_lt === "number" ? job.critic_score_lt : undefined,
                    avg_completion_time_ms_gt: typeof job.avg_completion_time_ms_gt === "number" ? Math.trunc(job.avg_completion_time_ms_gt) : undefined,
                    research_fitness_lt: typeof job.research_fitness_lt === "number" ? job.research_fitness_lt : undefined,
                    stagnation_rate_gt: typeof job.stagnation_rate_gt === "number" ? job.stagnation_rate_gt : undefined,
                    convergence_steps_gt: typeof job.convergence_steps_gt === "number" ? job.convergence_steps_gt : undefined,
                    max_new_versions: typeof job.max_new_versions === "number" ? Math.trunc(job.max_new_versions) : undefined,
                    shadow_mode: typeof job.shadow_mode === "boolean" ? job.shadow_mode : undefined,
                });
            }
            else if (job.command === "shadow_evaluation_tick") {
                result = await runShadowEvaluationTick({
                    role: typeof job.role === "string" ? job.role : undefined,
                    sample_size: typeof job.sample_size === "number" ? Math.trunc(job.sample_size) : undefined,
                    promote_threshold: typeof job.promote_threshold === "number" ? job.promote_threshold : undefined,
                    max_evaluations: typeof job.max_evaluations === "number" ? Math.trunc(job.max_evaluations) : undefined,
                    discard_on_fail: typeof job.discard_on_fail === "boolean" ? job.discard_on_fail : undefined,
                });
            }
            else if (job.command === "agent_dispatch_tick") {
                result = await runAgentDispatchTick(typeof job.project_id === "string" ? job.project_id : undefined, typeof job.limit === "number" && Number.isFinite(job.limit) ? Math.trunc(job.limit) : undefined);
            }
            else {
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
                        type: "text",
                        text: JSON.stringify({
                            status: "done",
                            command_id: job.id,
                            result
                        })
                    }]
            };
        }
        catch (error) {
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({ error: `Router failed: ${error.message}` })
                    }],
                isError: true
            };
        }
    });
    // Queue system tools
    server.tool("fs_lock_acquire", "Acquire a lock with optional TTL", {
        name: z.string(),
        ttl_ms: z.number().optional().default(30000)
    }, async ({ name, ttl_ms }) => {
        const result = await acquireLock({
            locksDir: path.join(SYNC_DIR, 'queue', 'locks'),
            name,
            ttl_ms
        });
        if (result.ok) {
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            ok: true,
                            token: result.token,
                            expires_at: result.expires_at
                        })
                    }]
            };
        }
        else {
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            ok: false,
                            reason: result.reason,
                            expires_at: result.expires_at
                        })
                    }]
            };
        }
    });
    server.tool("fs_lock_release", "Release a lock with token", {
        name: z.string(),
        token: z.string()
    }, async ({ name, token }) => {
        const result = await releaseLock({
            locksDir: path.join(SYNC_DIR, 'queue', 'locks'),
            name,
            token
        });
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify(result)
                }]
        };
    });
    server.tool("queue_push", "Push a job to queue", {
        type: z.enum(["exec", "project_task", "custom"]),
        payload: z.any(),
        priority: z.number().optional().default(0),
        job_id: z.string().optional(),
        logical_queue: z.string().optional(),
    }, async ({ type, payload, priority, job_id, logical_queue }) => {
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
                    type: "text",
                    text: JSON.stringify(result)
                }]
        };
    });
    server.tool("queue_pop", "Pop/claim a job from queue with lease", {
        worker: z.string().optional().default("windsurf"),
        max_lease_ms: z.number().optional().default(60000),
        logical_queue: z.union([z.string(), z.array(z.string())]).optional(),
    }, async ({ worker, max_lease_ms, logical_queue }) => {
        const result = await queuePop({
            syncDir: SYNC_DIR,
            worker,
            max_lease_ms,
            logical_queue,
        });
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify(result)
                }]
        };
    });
    server.tool("queue_ack", "Acknowledge job completion with status and artifacts", {
        job_id: z.string(),
        lease_token: z.string(),
        status: z.enum(["done", "error", "canceled"]),
        result: z.any().optional(),
        report_md: z.string().optional(),
        logs: z.string().optional()
    }, async ({ job_id, lease_token, status, result, report_md, logs }) => {
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
                    type: "text",
                    text: JSON.stringify(ackResult)
                }]
        };
    });
    server.tool("job_history_list", "List job history with status and artifacts", {
        limit: z.number().optional().default(50),
        status: z.enum(["pending", "running", "done", "error", "canceled"]).optional(),
        logical_queue: z.string().optional(),
    }, async ({ limit, status, logical_queue }) => {
        const result = await jobHistoryList({
            syncDir: SYNC_DIR,
            limit,
            status,
            logical_queue,
        });
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify(result)
                }]
        };
    });
    // Internal exec function for queue router
    async function runExecInternal(payload) {
        const { cmd, cwd, timeout_ms = 120000 } = payload;
        const args = normalizeNodeEArgs(String(cmd), Array.isArray(payload?.args) ? payload.args : []);
        return new Promise((resolve) => {
            const startedAt = Date.now();
            const child = spawn(cmd, args, {
                cwd: cwd || undefined,
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            let stdout = '';
            let stderr = '';
            child.stdout?.on('data', (data) => {
                stdout += data.toString();
            });
            child.stderr?.on('data', (data) => {
                stderr += data.toString();
            });
            const timeout = setTimeout(() => {
                child.kill('SIGKILL');
                resolve({
                    success: false,
                    exit_code: -1,
                    duration_ms: Date.now() - startedAt,
                    stdout,
                    stderr: 'Command timed out'
                });
            }, timeout_ms);
            child.on('close', (code) => {
                clearTimeout(timeout);
                resolve({
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
    async function handleProjectTask(payload) {
        // Backward/forward compatible payload contract for queued project_task jobs.
        // Supports:
        // 1) { task: "...", ... }
        // 2) { command: "...", args: { ... } }
        // 3) { type: "...", input: { ... } }
        const base = (payload && typeof payload === "object") ? payload : {};
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
                logs: `Invalid project_task payload: ${JSON.stringify(payload)}`,
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
                role: typeof merged.role === "string" ? merged.role : undefined,
                title: String(merged.title),
                description: typeof merged.description === "string" ? merged.description : undefined,
                status: typeof merged.status === "string" ? merged.status : undefined,
                depends_on: Array.isArray(merged.depends_on) ? merged.depends_on.map((x) => String(x)) : undefined,
                children: Array.isArray(merged.children) ? merged.children.map((x) => String(x)) : undefined,
                execution_policy: merged.execution_policy && typeof merged.execution_policy === "object"
                    ? {
                        max_attempts: typeof merged.execution_policy.max_attempts === "number"
                            ? Math.trunc(merged.execution_policy.max_attempts)
                            : undefined,
                        retry_delay_ms: typeof merged.execution_policy.retry_delay_ms === "number"
                            ? Math.trunc(merged.execution_policy.retry_delay_ms)
                            : undefined,
                        backoff_multiplier: typeof merged.execution_policy.backoff_multiplier === "number"
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
            const role = typeof merged.role === "string" ? merged.role : undefined;
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
            const role = typeof merged.role === "string" ? merged.role : undefined;
            const metrics = await agentMetricsSnapshot(SYNC_DIR, role);
            return {
                success: true,
                task_name: task,
                ...metrics,
                report_md: `# Agent Metrics\n\n**items:** ${metrics.items.length}\n`,
                logs: "agent_metrics_snapshot generated",
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
                role: String(merged.role),
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
                role: String(merged.role),
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
            const role = typeof merged.role === "string" ? merged.role : undefined;
            const evolved = await agentEvolutionTick({
                syncDir: SYNC_DIR,
                role,
                min_runs: typeof merged.min_runs === "number" ? Math.trunc(merged.min_runs) : undefined,
                failure_rate_gt: typeof merged.failure_rate_gt === "number" ? merged.failure_rate_gt : undefined,
                critic_score_lt: typeof merged.critic_score_lt === "number" ? merged.critic_score_lt : undefined,
                avg_completion_time_ms_gt: typeof merged.avg_completion_time_ms_gt === "number" ? Math.trunc(merged.avg_completion_time_ms_gt) : undefined,
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
                role: typeof merged.role === "string" ? merged.role : undefined,
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
                depends_on: Array.isArray(merged.depends_on) ? merged.depends_on.map((x) => String(x)) : undefined,
                children: Array.isArray(merged.children) ? merged.children.map((x) => String(x)) : undefined,
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
                max_tasks: typeof merged.max_tasks === "number" && Number.isFinite(merged.max_tasks)
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
                status: String(merged.status),
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
                limit: typeof merged.limit === "number" && Number.isFinite(merged.limit)
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
            const result = await runExecutionBindTick(typeof merged.project_id === "string" ? merged.project_id : undefined, typeof merged.limit === "number" && Number.isFinite(merged.limit)
                ? Math.trunc(merged.limit)
                : undefined);
            return {
                success: true,
                task_name: task,
                ...result,
                report_md: `# Execution Bind Tick\n\n**queued:** ${result.queued}\n\n**scanned:** ${result.scanned}\n`,
                logs: `execution_bind_tick queued ${result.queued} exec jobs`,
            };
        }
        if (task === "recovery_tick") {
            const result = await runRecoveryTick(typeof merged.project_id === "string" ? merged.project_id : undefined, typeof merged.limit === "number" && Number.isFinite(merged.limit)
                ? Math.trunc(merged.limit)
                : undefined);
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
            const result = await runAgentDispatchTick(typeof merged.project_id === "string" ? merged.project_id : undefined, typeof merged.limit === "number" && Number.isFinite(merged.limit)
                ? Math.trunc(merged.limit)
                : undefined);
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
        if (task === "lineage_snapshot") {
            const result = await lineageSnapshot({
                syncDir: SYNC_DIR,
                role: typeof merged.role === "string" ? merged.role : undefined,
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
            let result;
            try {
                result = await runCampaignTick({
                    campaign_id: String(merged.campaign_id),
                    max_steps: typeof merged.max_steps === "number" ? Math.trunc(merged.max_steps) : undefined,
                });
            }
            catch (e) {
                const msg = String(e?.message ?? e);
                if (isLockBusyErrorMessage(msg)) {
                    const retryCount = Math.max(0, Math.trunc(Number(merged.retry_count ?? 0)));
                    const nextRetryCount = retryCount + 1;
                    const requeued = await enqueueCampaignTickJob({
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
                status: typeof merged.status === "string" ? merged.status : undefined,
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
            const role = String(merged.role);
            const startedAt = Date.now();
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
                    : (typeof merged.strategy === "string" ? merged.strategy : undefined),
                strategy: typeof merged.strategy === "string" ? merged.strategy : undefined,
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
            let taskId = null;
            if (typeof merged.exec_command === "string" && merged.exec_command.trim()) {
                const template = String(merged.exec_command);
                const rendered = template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_m, key) => {
                    const val = merged.params[key];
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
                phase: search.phase,
                stop_reason: search.stop_reason ?? null,
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
    const onQueueExecFinished = async ({ job, payload, result }) => {
        const taskId = payload?.task_id;
        if (!taskId || typeof taskId !== "string")
            return;
        const exitCode = Number(result?.exit_code ?? -1);
        const completion = await taskExecutionHandleResult({
            syncDir: SYNC_DIR,
            task_id: taskId,
            exit_code: exitCode,
            error: exitCode === 0 ? undefined : String(result?.stderr ?? "exec failed"),
        });
        const runStatus = exitCode === 0
            ? "completed"
            : (completion.outcome === "retry" ? "running" : "failed");
        let ingestStdout = typeof result?.stdout === "string" ? result.stdout : "";
        let ingestStderr = typeof result?.stderr === "string" ? result.stderr : "";
        if (!ingestStdout.trim() && typeof job?.job_id === "string" && job.job_id.trim()) {
            try {
                const resultPath = path.join(SYNC_DIR, "queue", "runs", String(job.job_id), "result.json");
                const raw = await fs.readFile(resultPath, "utf8");
                const parsed = JSON.parse(raw);
                if (typeof parsed?.stdout === "string" && parsed.stdout.trim())
                    ingestStdout = parsed.stdout;
                if (typeof parsed?.stderr === "string" && parsed.stderr.trim())
                    ingestStderr = parsed.stderr;
            }
            catch {
                // Keep original stdout/stderr from in-memory result.
            }
        }
        const ingest = await experimentIngestExecResultByTask({
            syncDir: SYNC_DIR,
            task_id: taskId,
            stdout: ingestStdout,
            stderr: ingestStderr,
            exit_code: exitCode,
            duration_ms: typeof result?.duration_ms === "number" ? Math.trunc(result.duration_ms) : null,
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
        const arenaEvaluatedAfterImpact = Boolean(impact?.transfer_memory_update?.arena?.evaluated === true);
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
                cmd: payload?.cmd ?? null,
                args: payload?.args ?? [],
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
    async function runRouterExecuteFromQueue(logicalQueue) {
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
    function isLockBusyErrorMessage(message) {
        const msg = message.toLowerCase();
        return (msg.includes("lock busy") ||
            msg.includes("elock") ||
            msg.includes("ebusy") ||
            msg.includes("eperm"));
    }
    function computeRetryNotBeforeTs(retryCount) {
        const base = 250;
        const jitter = Math.floor(Math.random() * 251);
        const exp = Math.min(30_000, base * Math.pow(2, Math.max(0, retryCount)));
        return new Date(Date.now() + exp + jitter).toISOString();
    }
    async function enqueueCampaignTickJob(args) {
        const jobId = `campaign-tick-${args.campaign_id}-${args.idempotency_key ?? randomUUID()}`;
        await queuePush({
            syncDir: SYNC_DIR,
            type: "project_task",
            logical_queue: "campaign",
            source: args.source ?? "campaign-api",
            priority: 6,
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
                    if (!managerRef)
                        return;
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
                    if (!execWorker || !researchWorker || !campaignWorker || !metaWorker)
                        return;
                    const metrics = managerRef.metrics();
                    const byName = new Map((metrics.workers ?? []).map((m) => [String(m?.name ?? ""), m]));
                    const execM = byName.get("exec");
                    const researchM = byName.get("research");
                    const execDepth = Number(execQ.pending ?? 0);
                    let nextExec = execWorker.getConcurrency();
                    if (execDepth > 200)
                        nextExec += 1;
                    else if (execDepth < 50)
                        nextExec -= 1;
                    nextExec = Math.max(1, Math.min(8, nextExec));
                    const execErrorRate = Number(execM?.worker_error_rate ?? 0);
                    const execLatency = Number(execM?.avg_exec_latency_ms ?? execM?.avg_latency_ms ?? 0);
                    const execStuck = Boolean(execM?.stuck_job_detection?.is_stuck);
                    const execStress = execErrorRate > 0.25 || execLatency > 45_000 || execStuck;
                    if (execStress) {
                        nextExec = Math.max(1, nextExec - 1);
                        execWorker.setThrottleMs(1_500);
                    }
                    else {
                        execWorker.setThrottleMs(0);
                    }
                    execWorker.setConcurrency(nextExec);
                    const transferVariance = Number(metaDiag?.snapshot?.transfer_variance ?? NaN);
                    const arenaEntropy = Number(metaDiag?.snapshot?.arena_entropy ?? NaN);
                    const researchDepth = Number(researchQ.pending ?? 0);
                    let nextResearch = researchWorker.getConcurrency();
                    if (Number.isFinite(transferVariance) && transferVariance > 0.12)
                        nextResearch += 1;
                    if (Number.isFinite(arenaEntropy) && arenaEntropy < 0.25)
                        nextResearch += 1;
                    if (researchDepth < 10 &&
                        Number.isFinite(transferVariance) && transferVariance < 0.05 &&
                        Number.isFinite(arenaEntropy) && arenaEntropy > 0.45) {
                        nextResearch -= 1;
                    }
                    nextResearch = Math.max(1, Math.min(4, nextResearch));
                    const researchErrorRate = Number(researchM?.worker_error_rate ?? 0);
                    const researchStuck = Boolean(researchM?.stuck_job_detection?.is_stuck);
                    if (researchErrorRate > 0.2 || researchStuck) {
                        nextResearch = Math.max(1, nextResearch - 1);
                        researchWorker.setThrottleMs(1_000);
                    }
                    else {
                        researchWorker.setThrottleMs(0);
                    }
                    researchWorker.setConcurrency(nextResearch);
                    campaignWorker.setConcurrency(1);
                    metaWorker.setConcurrency(1);
                    const globalStress = execStress || researchErrorRate > 0.2 || researchStuck;
                    metaWorker.setThrottleMs(globalStress ? 2_000 : 0);
                }
                catch {
                    // Isolated adaptive loop; errors should not affect workers.
                }
            }, 5000);
        }
    }
    server.tool("router_execute_from_queue", "Execute one job from queue", {}, async () => ({
        content: [{
                type: "text",
                text: JSON.stringify(await runRouterExecuteFromQueue()),
            }],
    }));
    server.tool("router_execute_exec_queue", "Execute one job from exec logical queue", {}, async () => ({
        content: [{
                type: "text",
                text: JSON.stringify(await runRouterExecuteFromQueue("exec")),
            }],
    }));
    server.tool("router_execute_research_queue", "Execute one job from research logical queue", {}, async () => ({
        content: [{
                type: "text",
                text: JSON.stringify(await runRouterExecuteFromQueue("research")),
            }],
    }));
    server.tool("router_execute_campaign_queue", "Execute one job from campaign logical queue", {}, async () => ({
        content: [{
                type: "text",
                text: JSON.stringify(await runRouterExecuteFromQueue("campaign")),
            }],
    }));
    server.tool("router_execute_meta_queue", "Execute one job from meta logical queue", {}, async () => ({
        content: [{
                type: "text",
                text: JSON.stringify(await runRouterExecuteFromQueue("meta")),
            }],
    }));
    server.tool("worker_metrics_snapshot", "Worker manager telemetry snapshot", {}, async () => ({
        content: [{
                type: "text",
                text: JSON.stringify(buildWorkerSnapshot()),
            }],
    }));
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
    server.tool("exec", "Execute command with security restrictions.", {
        cmd: z.string(),
        args: z.array(z.string()).optional(),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        timeout_ms: z.number().int().min(1000).max(300000).default(60000), // 60s default
        max_output_bytes: z.number().int().min(1024).max(10 * 1024 * 1024).default(2 * 1024 * 1024) // 2MB default
    }, async ({ cmd, args = [], cwd, env = {}, timeout_ms, max_output_bytes }) => {
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
                child.stdout?.on('data', (chunk) => {
                    stdoutBytes += chunk.length;
                    if (stdoutBytes <= max_output_bytes) {
                        stdout += chunk.toString();
                    }
                });
                child.stderr?.on('data', (chunk) => {
                    stderrBytes += chunk.length;
                    if (stderrBytes <= max_output_bytes) {
                        stderr += chunk.toString();
                    }
                });
                child.on('close', (code) => {
                    clearTimeout(timeout);
                    resolve(okText({
                        exit_code: code || 0,
                        stdout: stdout.slice(0, max_output_bytes),
                        stderr: stderr.slice(0, max_output_bytes),
                        duration_ms: Date.now() - startTime,
                        cmd: `${cmd} ${args.join(' ')}`.trim()
                    }));
                });
                child.on('error', (error) => {
                    clearTimeout(timeout);
                    resolve(errText(`Failed to execute command: ${error.message}`));
                });
            });
        }
        catch (error) {
            return errText(`Execution error: ${error.message}`);
        }
    });
    // --- Phase 3: Event Tools ---
    server.tool("event_publish", "Publish an event to events.jsonl", {
        type: z.string(),
        payload: z.any().optional(),
        data: z.any().optional(),
        source: z.string().optional(),
        event_id: z.string().optional(),
        conversation_id: z.string().optional(),
        direction: z.enum(["outbound", "inbound"]).optional(),
        dedupe_key: z.string().optional(),
    }, async ({ type, payload, data, source, event_id, conversation_id, direction, dedupe_key }) => {
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
    });
    server.tool("event_list", "List events from events.jsonl", {
        limit: z.number().int().min(1).max(1000).optional(),
        type: z.string().optional(),
        since_ts: z.string().optional(),
        source: z.string().optional(),
        event_id: z.string().optional(),
        conversation_id: z.string().optional(),
        direction: z.enum(["outbound", "inbound"]).optional(),
        dedupe_key: z.string().optional(),
    }, async ({ limit, type, since_ts, source, event_id, conversation_id, direction, dedupe_key }) => {
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
    });
    // --- Phase 3.5: Experiment Tools ---
    server.tool("experiment_create", "Create or update an experiment", {
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
    }, async ({ experiment_id, name, objective, metric_schema, search_space, search_strategy, strategy, metadata }) => {
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
    });
    server.tool("experiment_run", "Create/update experiment run; optionally create exec task from template", {
        experiment_id: z.string(),
        run_id: z.string().optional(),
        params: z.record(z.string(), z.any()),
        metrics: z.record(z.string(), z.number()).optional(),
        status: z.enum(["pending", "running", "completed", "failed"]).optional(),
        duration_ms: z.number().int().min(0).optional(),
        task_id: z.string().optional(),
        notes: z.string().optional(),
        exec_command: z.string().optional(),
    }, async ({ experiment_id, run_id, params, metrics, status, duration_ms, task_id, notes, exec_command }) => {
        let linkedTaskId = null;
        if (exec_command && exec_command.trim()) {
            const rendered = exec_command.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_m, key) => {
                const val = params[key];
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
    });
    server.tool("experiment_list", "List experiments", {
        status: z.enum(["draft", "running", "completed", "archived"]).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
    }, async ({ status, limit }) => {
        const result = await experimentList({
            syncDir: SYNC_DIR,
            status,
            limit,
        });
        return okText(result);
    });
    server.tool("experiment_compare", "Compare runs and return best/second delta", {
        experiment_id: z.string(),
    }, async ({ experiment_id }) => {
        const result = await experimentCompare({
            syncDir: SYNC_DIR,
            experiment_id,
        });
        return okText(result);
    });
    server.tool("experiment_leaderboard", "Get sorted leaderboard for experiment", {
        experiment_id: z.string(),
        limit: z.number().int().min(1).max(1000).optional(),
    }, async ({ experiment_id, limit }) => {
        const result = await experimentLeaderboard({
            syncDir: SYNC_DIR,
            experiment_id,
            limit,
        });
        return okText(result);
    });
    server.tool("experiment_best", "Get best run for experiment", {
        experiment_id: z.string(),
    }, async ({ experiment_id }) => {
        const result = await experimentBest({
            syncDir: SYNC_DIR,
            experiment_id,
        });
        return okText(result);
    });
    server.tool("experiment_search_tick", "Generate pending runs from search space (grid/random/adaptive)", {
        experiment_id: z.string(),
        batch_size: z.number().int().min(1).max(200).optional(),
    }, async ({ experiment_id, batch_size }) => {
        const search = await runExperimentSearchTickWithResearchProfile({
            experiment_id,
            batch_size,
        });
        const impact = await applyResearchImpactOnExperimentConverged({
            experiment_id,
            phase: search.phase,
            stop_reason: search.stop_reason ?? null,
        });
        return okText(impact ? { ...search, ...impact } : search);
    });
    // --- Phase 4: Notes Tools ---
    server.tool("notes_upsert", "Create or update a note", {
        id: z.string().optional(),
        title: z.string(),
        content: z.string().optional(),
        body: z.string().optional(),
        tags: z.array(z.string()).optional(),
    }, async ({ id, title, content, tags, body }) => {
        const result = await notesUpsert({
            syncDir: SYNC_DIR,
            id,
            title,
            content: content ?? body,
            tags,
        });
        return okText(result);
    });
    server.tool("notes_get", "Get a note by ID", {
        id: z.string(),
    }, async ({ id }) => {
        const result = await notesGet({
            syncDir: SYNC_DIR,
            id,
        });
        return okText(result);
    });
    server.tool("notes_delete", "Delete a note by ID", {
        id: z.string(),
    }, async ({ id }) => {
        const result = await notesDelete({
            syncDir: SYNC_DIR,
            id,
        });
        return okText(result);
    });
    server.tool("notes_list", "List notes with optional filtering", {
        limit: z.number().int().min(1).max(100).optional(),
        query: z.string().optional(),
    }, async ({ limit, query }) => {
        const result = await notesList({
            syncDir: SYNC_DIR,
            limit,
            query,
        });
        return okText(result);
    });
    // --- Phase 5: Tasks Tools ---
    server.tool("tasks_upsert", "Create or update a task", {
        id: z.string().optional(),
        title: z.string(),
        description: z.string().optional(),
        status: z.enum(["todo", "doing", "done", "blocked"]).optional(),
        labels: z.array(z.string()).optional(),
    }, async ({ id, title, description, status, labels }) => {
        const result = await tasksUpsert({
            syncDir: SYNC_DIR,
            id,
            title,
            description,
            status,
            labels,
        });
        return okText(result);
    });
    server.tool("tasks_get", "Get a task by ID", {
        id: z.string(),
    }, async ({ id }) => {
        const result = await tasksGet({
            syncDir: SYNC_DIR,
            id,
        });
        return okText(result);
    });
    server.tool("tasks_delete", "Delete a task by ID", {
        id: z.string(),
    }, async ({ id }) => {
        const result = await tasksDelete({
            syncDir: SYNC_DIR,
            id,
        });
        return okText(result);
    });
    server.tool("tasks_list", "List tasks with optional filtering", {
        limit: z.number().int().min(1).max(100).optional(),
        query: z.string().optional(),
        status: z.enum(["todo", "doing", "done", "blocked"]).optional(),
    }, async ({ limit, query, status }) => {
        const result = await tasksList({
            syncDir: SYNC_DIR,
            limit,
            query,
            status,
        });
        return okText(result);
    });
    // --- Phase 5.4: Task Graph Tools ---
    server.tool("task_create", "Create a task graph node", {
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
    }, async ({ task_id, project_id, role, title, description, status, depends_on, children, execution_policy }) => {
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
    });
    server.tool("task_link", "Link dependencies/children for a task", {
        task_id: z.string(),
        depends_on: z.array(z.string()).optional(),
        children: z.array(z.string()).optional(),
    }, async ({ task_id, depends_on, children }) => {
        const result = await taskLink({
            syncDir: SYNC_DIR,
            task_id,
            depends_on,
            children,
        });
        return okText(result);
    });
    server.tool("task_graph", "Get task dependency graph", {
        project_id: z.string().optional(),
    }, async ({ project_id }) => {
        const result = await taskGraph({
            syncDir: SYNC_DIR,
            project_id,
        });
        return okText(result);
    });
    server.tool("task_plan_generate", "Generate a task plan from a goal", {
        goal: z.string(),
        project_id: z.string().optional(),
        max_tasks: z.number().int().min(1).max(20).optional(),
    }, async ({ goal, project_id, max_tasks }) => {
        const result = await taskPlanGenerate({
            syncDir: SYNC_DIR,
            goal,
            project_id,
            max_tasks,
        });
        return okText(result);
    });
    server.tool("task_status_update", "Update status of a task graph node", {
        task_id: z.string(),
        status: z.enum(["open", "in_progress", "blocked", "done", "canceled"]),
    }, async ({ task_id, status }) => {
        const result = await taskStatusUpdate({
            syncDir: SYNC_DIR,
            task_id,
            status,
        });
        return okText(result);
    });
    server.tool("orchestrator_tick", "Promote eligible open tasks to in_progress (all dependencies done)", {
        project_id: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
    }, async ({ project_id, limit }) => {
        const result = await orchestratorTick({
            syncDir: SYNC_DIR,
            project_id,
            limit,
        });
        return okText(result);
    });
    server.tool("execution_bind_tick", "Bind in_progress exec:* tasks to queue exec jobs", {
        project_id: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
    }, async ({ project_id, limit }) => {
        const result = await runExecutionBindTick(project_id, limit);
        return okText(result);
    });
    server.tool("recovery_tick", "Re-activate retry-eligible open tasks (next_retry_at <= now) via orchestrator", {
        project_id: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
    }, async ({ project_id, limit }) => {
        const result = await runRecoveryTick(project_id, limit);
        return okText(result);
    });
    server.tool("governance_get", "Get evolution governance constraints", {}, async () => {
        return okText(await governanceGet(SYNC_DIR));
    });
    server.tool("governance_set", "Update evolution governance constraints", {
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
    }, async (patch) => {
        return okText(await governanceSet(SYNC_DIR, patch));
    });
    server.tool("arena_governance_get", "Get per-domain arena governance from research memory", {}, async () => {
        return okText(await researchMemoryArenaGovernanceGet({
            syncDir: SYNC_DIR,
        }));
    });
    server.tool("arena_governance_set", "Update per-domain arena governance in research memory", {
        domain_signature: z.string().optional(),
        max_strategies_per_domain: z.number().int().min(1).max(10).optional(),
        arena_evaluation_window: z.number().int().min(2).max(50).optional(),
        promotion_margin: z.number().min(0.01).max(0.5).optional(),
        arena_cooldown_ms: z.number().int().min(10_000).max(24 * 60 * 60 * 1000).optional(),
    }, async ({ domain_signature, max_strategies_per_domain, arena_evaluation_window, promotion_margin, arena_cooldown_ms }) => {
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
    });
    server.tool("agent_registry", "List available agent roles, versions, and active profiles", {
        role: z.enum(["planner", "dev", "research", "critic"]).optional(),
    }, async ({ role }) => {
        return okText(await agentRegistryList(SYNC_DIR, role));
    });
    server.tool("agent_metrics_snapshot", "Get agent metrics snapshot by role/version", {
        role: z.enum(["planner", "dev", "research", "critic"]).optional(),
    }, async ({ role }) => {
        return okText(await agentMetricsSnapshot(SYNC_DIR, role));
    });
    server.tool("agent_version_create", "Create a new agent version for role (v2/v3...)", {
        role: z.enum(["planner", "dev", "research", "critic"]),
        model: z.string().optional(),
        temperature: z.number().min(0).max(2).optional(),
        system_prompt: z.string().optional(),
        activate: z.boolean().optional(),
        parent_version: z.number().int().min(1).optional(),
    }, async ({ role, model, temperature, system_prompt, activate, parent_version }) => {
        return okText(await agentVersionCreate({
            syncDir: SYNC_DIR,
            role,
            model,
            temperature,
            system_prompt,
            activate,
            parent_version,
        }));
    });
    server.tool("agent_version_activate", "Activate specific agent version for role (rollback/promotion control)", {
        role: z.enum(["planner", "dev", "research", "critic"]),
        version: z.number().int().min(1),
    }, async ({ role, version }) => {
        return okText(await agentVersionActivate({
            syncDir: SYNC_DIR,
            role,
            version,
        }));
    });
    server.tool("evolution_tick", "Run evolution trigger rules and create mutated agent versions", {
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
    }, async ({ role, min_runs, failure_rate_gt, critic_score_lt, avg_completion_time_ms_gt, research_fitness_lt, stagnation_rate_gt, convergence_steps_gt, max_new_versions, shadow_mode }) => {
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
    });
    server.tool("shadow_evaluation_tick", "Evaluate shadow versions on replay data and auto promote/discard", {
        role: z.enum(["planner", "dev", "research", "critic"]).optional(),
        sample_size: z.number().int().min(1).max(200).optional(),
        promote_threshold: z.number().min(0).max(1).optional(),
        max_evaluations: z.number().int().min(1).max(500).optional(),
        discard_on_fail: z.boolean().optional(),
    }, async ({ role, sample_size, promote_threshold, max_evaluations, discard_on_fail }) => {
        return okText(await runShadowEvaluationTick({
            role,
            sample_size,
            promote_threshold,
            max_evaluations,
            discard_on_fail,
        }));
    });
    server.tool("agent_dispatch_tick", "Dispatch in_progress role-based tasks to agent queue handlers", {
        project_id: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
    }, async ({ project_id, limit }) => {
        const result = await runAgentDispatchTick(project_id, limit);
        return okText(result);
    });
    server.tool("arena_telemetry_snapshot", "Per-domain strategy heatmap with arena status and strategy metrics", {
        limit_domains: z.number().int().min(1).max(500).optional(),
    }, async ({ limit_domains }) => {
        const result = await arenaTelemetrySnapshot({
            syncDir: SYNC_DIR,
            limit_domains,
        });
        return okText(result);
    });
    server.tool("mutation_effectiveness_snapshot", "Mutation effectiveness index for adaptive and meta mutation paths", {}, async () => {
        const result = await mutationEffectivenessSnapshot({
            syncDir: SYNC_DIR,
        });
        return okText(result);
    });
    server.tool("transfer_diagnostics", "Transfer effectiveness monitor with confidence, block, and anomaly rates", {}, async () => {
        const result = await transferDiagnosticsSnapshot({
            syncDir: SYNC_DIR,
        });
        return okText(result);
    });
    server.tool("intelligence_health_snapshot", "Global Intelligence Health Index and fitness trajectory snapshot", {}, async () => {
        const result = await intelligenceHealthSnapshot({
            syncDir: SYNC_DIR,
        });
        return okText(result);
    });
    server.tool("intelligence_meta_snapshot", "Meta-intelligence diagnostics (entropy, specialization, mutation/transfer trends, GIHI slope)", {
        mutation_window: z.number().int().min(5).max(500).optional(),
        transfer_window: z.number().int().min(5).max(500).optional(),
        gihi_window: z.number().int().min(5).max(500).optional(),
        campaign_id: z.string().optional(),
    }, async ({ mutation_window, transfer_window, gihi_window, campaign_id }) => {
        const result = await intelligenceMetaSnapshot({
            syncDir: SYNC_DIR,
            mutation_window,
            transfer_window,
            gihi_window,
            campaign_id,
        });
        return okText(result);
    });
    server.tool("meta_governance_tick", "Auto-tune governance based on meta-intelligence snapshot", {
        mutation_window: z.number().int().min(5).max(500).optional(),
        transfer_window: z.number().int().min(5).max(500).optional(),
        gihi_window: z.number().int().min(5).max(500).optional(),
        campaign_id: z.string().optional(),
        apply_all_running: z.boolean().optional(),
        meta_governance_cooldown_ms: z.number().int().min(60_000).max(24 * 60 * 60 * 1000).optional(),
        min_state_streak: z.number().int().min(1).max(10).optional(),
        scoped_campaign_only: z.boolean().optional(),
        dry_run: z.boolean().optional(),
    }, async ({ mutation_window, transfer_window, gihi_window, campaign_id, apply_all_running, meta_governance_cooldown_ms, min_state_streak, scoped_campaign_only, dry_run }) => {
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
    });
    server.tool("lineage_snapshot", "Strategy lineage graph from mutation history", {
        role: z.enum(["planner", "dev", "research", "critic"]).optional(),
        limit: z.number().int().min(1).max(5000).optional(),
    }, async ({ role, limit }) => {
        const result = await lineageSnapshot({
            syncDir: SYNC_DIR,
            role,
            limit,
        });
        return okText(result);
    });
    server.tool("campaign_create", "Create autonomous research campaign definition", {
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
    }, async ({ campaign_id, goal, objective, constraints, max_experiments, stop_conditions }) => {
        const result = await campaignCreate({
            syncDir: SYNC_DIR,
            campaign_id,
            goal,
            objective,
            constraints,
            max_experiments,
            stop_conditions,
        });
        return okText(result);
    });
    server.tool("campaign_tick", "Run autonomous research campaign control loop for N steps", {
        campaign_id: z.string(),
        max_steps: z.number().int().min(1).max(50).optional(),
    }, async ({ campaign_id, max_steps }) => {
        const result = await enqueueCampaignTickJob({
            campaign_id,
            max_steps,
            source: "campaign-api",
        });
        return okText(result);
    });
    server.tool("campaign_report_generate", "Generate final campaign report (Markdown + JSON snapshot)", {
        campaign_id: z.string(),
    }, async ({ campaign_id }) => {
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
    });
    server.tool("campaign_list", "List autonomous research campaigns", {
        status: z.enum(["draft", "running", "completed", "stopped", "failed"]).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
    }, async ({ status, limit }) => {
        const result = await campaignList({
            syncDir: SYNC_DIR,
            status,
            limit,
        });
        return okText(result);
    });
    // --- Phase 5.5: Project Context Tools ---
    server.tool("project_create", "Create or update a project context root", {
        project_id: z.string(),
        description: z.string().optional(),
        stack: z.array(z.string()).optional(),
    }, async ({ project_id, description, stack }) => {
        const result = await projectCreate({
            syncDir: SYNC_DIR,
            project_id,
            description,
            stack,
        });
        return okText(result);
    });
    server.tool("project_list", "List known projects and active project", {}, async () => {
        const result = await projectList({
            syncDir: SYNC_DIR,
        });
        return okText(result);
    });
    server.tool("project_switch", "Switch active project", {
        project_id: z.string(),
    }, async ({ project_id }) => {
        const result = await projectSwitch({
            syncDir: SYNC_DIR,
            project_id,
        });
        return okText(result);
    });
    server.tool("project_context_set", "Set project context/roadmap/constraints", {
        project_id: z.string().optional(),
        context: z.any().optional(),
        roadmap: z.any().optional(),
        constraints: z.any().optional(),
    }, async ({ project_id, context, roadmap, constraints }) => {
        const result = await projectContextSet({
            syncDir: SYNC_DIR,
            project_id,
            context,
            roadmap,
            constraints,
        });
        return okText(result);
    });
    server.tool("project_context_get", "Get full project context package", {
        project_id: z.string().optional(),
    }, async ({ project_id }) => {
        const result = await projectContextGet({
            syncDir: SYNC_DIR,
            project_id,
        });
        return okText(result);
    });
    // --- Phase 5.6: Persistent Memory Tools ---
    server.tool("memory_store", "Store a persistent memory record", {
        project_id: z.string(),
        type: z.string(),
        tags: z.array(z.string()).optional(),
        content: z.string(),
    }, async ({ project_id, type, tags, content }) => {
        const result = await memoryStore({
            syncDir: SYNC_DIR,
            project_id,
            type,
            tags,
            content,
        });
        return okText(result);
    });
    server.tool("memory_query", "Query persistent memory records", {
        project_id: z.string().optional(),
        type: z.string().optional(),
        tags: z.array(z.string()).optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
    }, async ({ project_id, type, tags, query, limit }) => {
        const result = await memoryQuery({
            syncDir: SYNC_DIR,
            project_id,
            type,
            tags,
            query,
            limit,
        });
        return okText(result);
    });
    server.tool("memory_update", "Update an existing memory record", {
        memory_id: z.string(),
        content: z.string().optional(),
        tags: z.array(z.string()).optional(),
        type: z.string().optional(),
    }, async ({ memory_id, content, tags, type }) => {
        const result = await memoryUpdate({
            syncDir: SYNC_DIR,
            memory_id,
            content,
            tags,
            type,
        });
        return okText(result);
    });
    server.tool("memory_prune", "Delete memory records by age/project", {
        older_than_ts: z.number().optional(),
        project_id: z.string().optional(),
        limit: z.number().int().min(1).max(10_000).optional(),
    }, async ({ older_than_ts, project_id, limit }) => {
        const result = await memoryPrune({
            syncDir: SYNC_DIR,
            older_than_ts,
            project_id,
            limit,
        });
        return okText(result);
    });
    // --- Phase 6: Protocol Tools ---
    server.tool("protocol_init", "Initialize protocol files for Windsurf automation.", {}, async () => {
        return await protocolInit();
    });
    server.tool("protocol_write_command", "Write a command to inbox_command.json for Windsurf to execute.", {
        command: z.string(),
    }, async ({ command }) => {
        return await protocolWriteCommand(command);
    });
    server.tool("protocol_read_command", "Read the current command from inbox_command.json.", {}, async () => {
        return await protocolReadCommand();
    });
    server.tool("protocol_update_status", "Update the status.json file.", {
        status: z.enum(['idle', 'running', 'done', 'error']),
        error: z.string().optional(),
    }, async ({ status, error }) => {
        return await protocolUpdateStatus(status, error);
    });
    server.tool("protocol_write_report", "Write a report to last_report.md.", {
        title: z.string(),
        content: z.string(),
    }, async ({ title, content }) => {
        return await protocolWriteReport(title, content);
    });
    server.tool("protocol_write_logs", "Write logs to last_logs.txt.", {
        logs: z.string(),
    }, async ({ logs }) => {
        return await protocolWriteLogs(logs);
    });
    // --- Phase 7: Sync Tools ---
    server.tool("sync_outbound_once", "Run one outbound sync batch (events -> OpenAI -> inbound events).", {
        batch_size: z.number().int().min(1).max(500).optional(),
    }, async ({ batch_size }) => {
        return okText(await runSyncOutboundOnce(batch_size));
    });
    server.tool("sync_inbound_once", "Run one inbound sync batch (pending response IDs -> events).", {
        batch_size: z.number().int().min(1).max(500).optional(),
    }, async ({ batch_size }) => {
        return okText(await runSyncInboundOnce(batch_size));
    });
    server.tool("enqueue_inbound_response_id", "Queue a remote OpenAI response ID for inbound synchronization.", {
        conversation_id: z.string(),
        response_id: z.string(),
        dedupe_key: z.string().optional(),
    }, async ({ conversation_id, response_id, dedupe_key }) => {
        return okText(await runEnqueueInboundResponseId(conversation_id, response_id, dedupe_key));
    });
    server.tool("sync_status", "Show sync cursors, mapping stats, dedupe stats, and last event activity.", {}, async () => {
        return okText(await runSyncStatus());
    });
    server.tool("sync_reconcile", "Reconcile sync metadata (cursor sanity + mapping normalization).", {}, async () => {
        return okText(await runSyncReconcile());
    });
    // --- Phase 1: File System Tools ---
    // fs_list
    server.tool("fs_list", "List files under a directory (limited to allowed roots).", {
        dir: z.string(),
        limit: z.number().int().min(1).max(5000).optional(),
    }, async ({ dir, limit }) => {
        const base = assertInAllowedRoots(dir);
        const entries = await fs.readdir(base, { withFileTypes: true });
        const out = entries
            .slice(0, limit ?? 2000)
            .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
        return okText({ dir: base, entries: out });
    });
    // fs_read
    server.tool("fs_read", "Read a UTF-8 text file (limited size).", { path: z.string(), max_bytes: z.number().int().min(1).max(2_000_000).optional() }, async ({ path: p, max_bytes }) => {
        const rp = assertInAllowedRoots(p);
        const st = await fs.stat(rp);
        const limit = max_bytes ?? 500_000;
        if (st.size > limit)
            return errText(`File too large (${st.size} bytes), limit=${limit}`);
        const content = await fs.readFile(rp, "utf8");
        return okText({ path: rp, content, size: st.size });
    });
    // fs_write
    server.tool("fs_write", "Write a UTF-8 text file. If create=false and file missing -> error.", {
        path: z.string(),
        content: z.string(),
        create: z.boolean().optional(),
    }, async ({ path: p, content, create }) => {
        const rp = assertInAllowedRoots(p);
        const dir = path.dirname(rp);
        await fs.mkdir(dir, { recursive: true });
        if (create === false) {
            try {
                await fs.access(rp);
            }
            catch {
                return errText("File does not exist (create=false)");
            }
        }
        await fs.writeFile(rp, content, "utf8");
        return okText({ written: true, path: rp, bytes: Buffer.byteLength(content, "utf8") });
    });
    // fs_mkdir
    server.tool("fs_mkdir", "Create directory recursively inside allowed roots.", { path: z.string() }, async ({ path: inputPath }) => {
        const resolved = path.resolve(inputPath);
        const isAllowed = ROOTS_FINAL.some(root => resolved.startsWith(root));
        if (!isAllowed) {
            return errText(`Path outside allowed roots: ${inputPath}`);
        }
        try {
            await fs.mkdir(resolved, { recursive: true });
            return okText({ created: true, path: resolved });
        }
        catch (error) {
            return errText(`Failed to create directory: ${error.message}`);
        }
    });
    // fs_exists
    server.tool("fs_exists", "Check if path exists and its type inside allowed roots.", { path: z.string() }, async ({ path: inputPath }) => {
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
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return okText({ exists: false, type: null });
            }
            return errText(`Failed to check path: ${error.message}`);
        }
    });
    // search_in_files
    server.tool("search_in_files", "Search for text/regex in files within allowed roots.", {
        pattern: z.string(),
        max_files: z.number().int().min(1).max(1000).default(100),
        max_file_size: z.number().int().min(1024).max(10 * 1024 * 1024).default(2 * 1024 * 1024), // 2MB
        max_results: z.number().int().min(1).max(10000).default(500)
    }, async ({ pattern, max_files, max_file_size, max_results }) => {
        const results = [];
        const regex = new RegExp(pattern, 'gi');
        let fileCount = 0;
        let resultCount = 0;
        async function searchDirectory(dir) {
            if (fileCount >= max_files || resultCount >= max_results)
                return;
            try {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (fileCount >= max_files || resultCount >= max_results)
                        break;
                    const fullPath = path.join(dir, entry.name);
                    const resolved = path.resolve(fullPath);
                    // Check if within allowed roots
                    if (!ROOTS_FINAL.some(root => resolved.startsWith(root)))
                        continue;
                    if (entry.isDirectory()) {
                        await searchDirectory(fullPath);
                    }
                    else if (entry.isFile()) {
                        try {
                            const stat = await fs.stat(fullPath);
                            if (stat.size > max_file_size)
                                return;
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
                        }
                        catch (error) {
                            // Skip files that can't be read
                            return;
                        }
                    }
                }
            }
            catch (error) {
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
    });
    // fs_read_content
    server.tool("fs_read_content", "Read content from URL or file", { url: z.string() }, async ({ url }) => {
        try {
            // For now, just treat as file path
            const content = await fs.readFile(url, 'utf-8');
            return okText({ url, content });
        }
        catch (error) {
            return errText(`Failed to read content: ${error.message}`);
        }
    });
    // fs_write_content  
    server.tool("fs_write_content", "Write content to file", {
        path: z.string(),
        content: z.string(),
        create_empty: z.boolean().optional().default(false)
    }, async ({ path: filePath, content, create_empty }) => {
        try {
            const resolved = assertInAllowedRoots(filePath);
            const dir = path.dirname(resolved);
            await fs.mkdir(dir, { recursive: true });
            if (create_empty) {
                await fs.writeFile(resolved, '', 'utf-8');
            }
            else {
                await fs.writeFile(resolved, content, 'utf-8');
            }
            return okText({ written: true, path: resolved });
        }
        catch (error) {
            return errText(`Failed to write content: ${error.message}`);
        }
    });
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
    function log(tag) {
        if (done)
            return;
        done = true;
        const ms = Date.now() - start;
        const extra = (ip ? ' ip=' + ip : '') +
            (ray ? ' ray=' + ray : '') +
            (ua ? ' ua=' + ua : '');
        console.log(tag + ' #' + rid + ' ' + req.method + ' ' + url + ' -> ' + res.statusCode + ' (' + ms + 'ms)' + extra);
    }
    res.on('finish', () => log('FINISH'));
    res.on('close', () => { if (!res.writableEnded)
        log('CLOSE'); });
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
    if (typeof res.flushHeaders === 'function')
        res.flushHeaders();
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
    req.on('aborted', () => { try {
        clearInterval(t);
    }
    catch { } });
    res.on('close', () => { try {
        clearInterval(t);
    }
    catch { } });
});
// ------------------------------------------------------
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use((req, res, next) => {
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
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
const transports = {};
const sseTransports = {};
// Unified /mcp handler for all methods (GET, POST, DELETE)
app.all("/mcp", async (req, res) => {
    try {
        const sessionId = req.headers["mcp-session-id"];
        console.log(`[${req.method}] /mcp Request received`, {
            sessionId,
            accept: req.headers["accept"],
            ua: req.headers["user-agent"],
        });
        // Check if this is an initialize request
        const isInitialize = req.method === "POST" &&
            req.body?.method === "initialize" &&
            req.body?.jsonrpc === "2.0";
        let transport = sessionId ? transports[sessionId] : undefined;
        if (!transport && isInitialize) {
            // Create new transport
            transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => {
                    transports[sid] = transport;
                },
            });
            transport.onclose = () => {
                if (transport?.sessionId)
                    delete transports[transport.sessionId];
            };
            const server = createMcpServer();
            await server.connect(transport);
        }
        if (!transport) {
            console.log(`[${req.method}] /mcp Invalid session`, { sessionId, hasSession: !!transports[sessionId] });
            res.status(400).json({
                jsonrpc: "2.0",
                error: { code: -32000, message: "Bad Request: No valid session ID provided" },
                id: null,
            });
            return;
        }
        // Convert Express request to Fetch request
        const fetchReq = toFetchRequest(req);
        const opts = req.method === "POST" ? { parsedBody: req.body } : undefined;
        // Disable timeouts for long-lived MCP requests (GET/POST)
        req.socket.setTimeout(0);
        res.setTimeout?.(0);
        const webRes = await transport.handleRequest(fetchReq, opts);
        await sendFetchResponseToExpress(webRes, res);
    }
    catch (e) {
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
            }
            catch (error) {
                console.log(`[GET /sse-simple] Heartbeat error for session ${sessionId}:`, error);
                clearInterval(heartbeat);
            }
        }, 25000);
        req.on("close", () => {
            console.log(`[GET /sse-simple] Request closed for session ${sessionId}`);
            clearInterval(heartbeat);
        });
    }
    catch (error) {
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
        transport.onclose = () => {
            delete sseTransports[sid];
        };
        // Add heartbeat every 25 seconds to prevent Cloudflare timeout
        const heartbeat = setInterval(() => {
            try {
                res.write(`: ping ${Date.now()}\n\n`);
            }
            catch (error) {
                clearInterval(heartbeat);
            }
        }, 25000);
        req.on("close", () => {
            clearInterval(heartbeat);
        });
        const server = createMcpServer();
        await server.connect(transport);
    }
    catch (error) {
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
    await active[0].handleRequest(req, res);
});
// Add JSON error handler
app.use((err, _req, res, next) => {
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
async function shutdownGracefully(signal) {
    if (shuttingDown)
        return;
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
    await new Promise((resolve) => {
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
