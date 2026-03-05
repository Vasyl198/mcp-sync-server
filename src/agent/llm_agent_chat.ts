import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_MODEL,
  OPENAI_TIMEOUT_MS,
  SYNC_DIR,
} from "../config.js";

type ChatMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
};

type ToolExec = (args: Record<string, unknown>) => Promise<unknown>;

type RegisterOpts = {
  server: any;
  okText: (obj: unknown) => any;
  errText: (message: string) => any;
  tools: Record<string, ToolExec>;
};

const TOOL_ALIASES: Record<string, string> = {
  internet_search: "search_web",
  web_search: "search_web",
  search: "search_web",
  list_directory: "fs_projects",
  fs_list: "fs_projects",
  list_files: "fs_projects",
  // NOTE: keep legacy alias for older prompts, but we prefer real tool names when present.
  whoami: "whoami",
};

function normalizeToolName(name: string): string {
  const n = String(name ?? "").trim();
  if (!n) return n;
  return TOOL_ALIASES[n] ?? n;
}

function extractJsonCandidate(raw: string): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    JSON.parse(text);
    return text;
  } catch {
    // continue
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) {
    try {
      JSON.parse(fenced);
      return fenced;
    } catch {
      // continue
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = text.slice(start, end + 1);
    try {
      JSON.parse(sliced);
      return sliced;
    } catch {
      return null;
    }
  }
  return null;
}

function summarizeResult(result: unknown, limit = 1800): string {
  let text = "";
  try {
    text = JSON.stringify(result);
  } catch {
    text = String(result);
  }
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...[TRUNCATED ${text.length - limit} chars]`;
}

async function safeReadCapabilities(maxChars = 6000): Promise<string> {
  // Always read from sync dir source-of-truth.
  const p = path.join(SYNC_DIR, "CAPABILITIES.md");
  try {
    const raw = await readFile(p, "utf-8");
    if (raw.length <= maxChars) return raw;
    return `${raw.slice(0, maxChars)}\n...[TRUNCATED ${raw.length - maxChars} chars]`;
  } catch (e: any) {
    return `FAILED_TO_READ_CAPABILITIES: ${p}: ${String(e?.message ?? e)}`;
  }
}

async function callChatCompletions(opts: {
  model?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  allowedTools?: string[];
}): Promise<string> {
  const baseUrl = OPENAI_BASE_URL.replace(/\/+$/, "");
  if (isInProcessLocalBackend(baseUrl)) {
    return callLocalSWEBackend({
      model: opts.model ?? OPENAI_MODEL,
      messages: opts.messages,
      allowedTools: opts.allowedTools ?? [],
    });
  }

  const controller = new AbortController();
  const timeoutMs = OPENAI_TIMEOUT_MS > 0 ? Math.max(2_000, OPENAI_TIMEOUT_MS) : 0;
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY || "local-anything"}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        model: (opts.model ?? OPENAI_MODEL) || "swe",
        temperature: 0.2,
        max_tokens: 900,
        messages: opts.messages,
      }),
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`LLM HTTP ${res.status}: ${raw}`);
    }
    const json = raw ? JSON.parse(raw) : {};
    const content = json?.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isInProcessLocalBackend(baseUrl: string): boolean {
  const u = (baseUrl ?? "").trim().toLowerCase();
  return (
    u === "local://swe" ||
    u === "lab://swe" ||
    u === "internal://swe" ||
    u === "inproc://swe"
  );
}

type LocalToolSignal = {
  kind: "result" | "error";
  tool: string;
  body: string;
  raw: string;
};

function containsAny(text: string, needles: string[]): boolean {
  return needles.some((n) => text.includes(n));
}

function parseLocalToolSignals(userMessages: string[]): LocalToolSignal[] {
  const out: LocalToolSignal[] = [];
  for (const msg of userMessages) {
    const m = /^TOOL_(RESULT|ERROR)\(([^)]+)\):\s*([\s\S]*)$/i.exec(msg);
    if (!m) continue;
    out.push({
      kind: m[1].toLowerCase() === "result" ? "result" : "error",
      tool: String(m[2] ?? "").trim(),
      body: String(m[3] ?? "").trim(),
      raw: msg,
    });
  }
  return out;
}

function lastSignal(
  signals: LocalToolSignal[],
  kind: "result" | "error",
  tools?: string[]
): LocalToolSignal | null {
  const set = new Set((tools ?? []).map((t) => String(t)));
  for (let i = signals.length - 1; i >= 0; i -= 1) {
    const s = signals[i];
    if (s.kind !== kind) continue;
    if (set.size > 0 && !set.has(s.tool)) continue;
    return s;
  }
  return null;
}

function shortToolList(allowed: Set<string>, max = 18): string[] {
  return [...allowed].sort().slice(0, max);
}

function callLocalSWEBackend(opts: {
  model?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  allowedTools: string[];
}): string {
  const allowed = new Set((opts.allowedTools ?? []).map((x) => String(x).trim()).filter(Boolean));
  const users = opts.messages
    .filter((m) => m.role === "user")
    .map((m) => String(m.content ?? "").trim())
    .filter(Boolean);
  const signals = parseLocalToolSignals(users);
  const lastErr = lastSignal(signals, "error");
  const lastUser = [...users].reverse().find(
    (c) => !c.startsWith("TOOL_RESULT(") && !c.startsWith("TOOL_ERROR(") && !c.startsWith("MISSING_EVIDENCE:")
  ) ?? "";
  const q = lastUser.toLowerCase();

  const isRu = /[\u0400-\u04FF]/.test(lastUser);
  const final = (answer: string, evidence: string[]) =>
    JSON.stringify({ type: "final", answer, evidence }, null, 0);
  const toolCall = (name: string, args: Record<string, unknown>, reason: string) =>
    JSON.stringify({ type: "tool_call", name, arguments: args, reason }, null, 0);

  const has = (...patterns: RegExp[]) => patterns.some((p) => p.test(q));

  if (lastErr) {
    return final(
      isRu
        ? `Не удалось выполнить инструмент '${lastErr.tool}'. Проверьте доступность и повторите запрос.`
        : `Failed to execute tool '${lastErr.tool}'. Check availability and retry.`,
      [lastErr.raw]
    );
  }

  const isGreeting = has(/\b(hello|hi|hey)\b/i, /\bпривет\b/u, /\bздравств/i, /\bкак дела\b/u);
  if (isGreeting) {
    return final(
      isRu
        ? "Здравствуйте. Готов помочь: могу проверять метрики, читать/менять файлы, запускать команды и давать план с evidence."
        : "Hello. Ready to help: I can check metrics, edit/read files, run commands, and provide evidence-based plans.",
      ["TOOL_RESULT(boot): local://swe backend active"]
    );
  }

  const isAboutSelf = has(
    /\bwho are you\b/i,
    /\bwhat can you do\b/i,
    /\bwho you are\b/i,
    /\bкто ты\b/u,
    /\bо себе\b/u,
    /\bчто умеешь\b/u,
    /\bинструмент/i,
    /\bфункци/i
  );
  if (isAboutSelf) {
    const toolsLine = shortToolList(allowed, 24).join(", ");
    return final(
      isRu
        ? `Я мостовой SWE-агент лаборатории в режиме tool-first. Доступные инструменты: ${toolsLine || "(нет)"}`
        : `I am the bridge SWE lab agent in tool-first mode. Available tools: ${toolsLine || "(none)"}`,
      ["TOOL_RESULT(boot): capabilities loaded"]
    );
  }

  const isDateTime = has(/\b(day|time|date|weekday|clock)\b/i, /\bдень\b/u, /\bвремя\b/u, /\bдата\b/u, /\bнедел/i);
  if (isDateTime) {
    const done = lastSignal(signals, "result", ["sync_status", "time", "whoami"]);
    if (done) {
      return final(
        isRu ? "Проверил через инструмент. Дата и время получены." : "Checked via tool. Date and time were retrieved.",
        [done.raw]
      );
    }
    if (allowed.has("sync_status")) return toolCall("sync_status", {}, "need runtime datetime");
    if (allowed.has("time")) return toolCall("time", { utc_offset: "+00:00" }, "fallback datetime");
    if (allowed.has("whoami")) return toolCall("whoami", {}, "whoami may include runtime clock");
    return final(
      isRu ? "Инструмент времени недоступен в allowlist." : "Datetime tool is not available in allowlist.",
      ["TOOL_RESULT(boot): no datetime tools"]
    );
  }

  const isWeb = has(
    /\b(weather|news|events|usd|uah|rate|currency)\b/i,
    /\bпогод/i,
    /\bкурс\b/u,
    /\bновост/i,
    /\bмероприят/i,
    /\bодесс/i,
    /\bкиев/i,
    /\bдоллар/i
  );
  if (isWeb) {
    const done = lastSignal(signals, "result", ["search_web", "web", "read_url_content"]);
    if (done) {
      return final(
        isRu ? "Проверил через веб-инструмент. Данные получены." : "Checked via web tool. Data retrieved.",
        [done.raw]
      );
    }
    if (allowed.has("search_web")) return toolCall("search_web", { query: lastUser, max_results: 5 }, "need fresh web data");
    if (allowed.has("web")) return toolCall("web", { op: "search", query: lastUser, max_results: 5 }, "need fresh web data");
    return final(
      isRu ? "Для этого запроса нужен web-search, но он не разрешен." : "This request requires web search, but it is not allowed.",
      ["TOOL_RESULT(boot): web search not allowed"]
    );
  }

  const isFs = has(
    /\b(file|folder|directory|desktop|projects)\b/i,
    /\bпапк/i,
    /\bфайл/i,
    /\bдиректор/i,
    /\bрабоч/i
  );
  if (isFs) {
    const done = lastSignal(signals, "result", ["fs_projects", "fs", "terminal_swe"]);
    if (done) {
      return final(
        isRu ? "Проверил файловую систему через инструмент. Результат получен." : "Checked filesystem via tool. Result retrieved.",
        [done.raw]
      );
    }
    const p = /([A-Za-z]:\\[^\n\r"]+)/.exec(lastUser)?.[1] ?? "C:\\Users\\anani\\Projects";
    if (allowed.has("fs_projects")) return toolCall("fs_projects", { path: p, limit: 30 }, "list files");
    if (allowed.has("fs")) return toolCall("fs", { op: "list", dir: p, limit: 30 }, "list files");
    return final(
      isRu ? "Файловые инструменты недоступны в allowlist." : "Filesystem tools are not available in allowlist.",
      ["TOOL_RESULT(boot): fs tools not allowed"]
    );
  }

  const isLabImprove = has(
    /\b(improve|optimi[sz]e|architecture|lab|roadmap|plan|stressed|entropy)\b/i,
    /\bулучш/i,
    /\bоптим/i,
    /\bархитектур/i,
    /\bлаборатор/i,
    /\bплан\b/u,
    /\broadmap\b/i
  );
  if (isLabImprove) {
    const meta = lastSignal(signals, "result", [
      "intelligence_meta_snapshot",
      "intelligence_health_snapshot",
      "arena_telemetry_snapshot",
    ]);
    const transfer = lastSignal(signals, "result", ["transfer_diagnostics"]);

    if (!meta) {
      if (allowed.has("intelligence_meta_snapshot")) return toolCall("intelligence_meta_snapshot", {}, "collect diagnostics before plan");
      if (allowed.has("intelligence_health_snapshot")) return toolCall("intelligence_health_snapshot", {}, "collect diagnostics before plan");
    }
    if (meta && !transfer && allowed.has("transfer_diagnostics")) {
      return toolCall("transfer_diagnostics", {}, "collect transfer diagnostics before final plan");
    }
    if (meta) {
      const evidence: string[] = [meta.raw];
      if (transfer) evidence.push(transfer.raw);
      const answer = isRu
        ? [
            "Короткий инженерный план улучшения лаборатории:",
            "1. Зафиксировать текущие драйверы stressed и включить авто-валидацию 3/6 после apply.",
            "2. Использовать recent evidence-сигналы, убрать decision path по stale причинам.",
            "3. Замкнуть контур proposal -> test -> governance с rollback при регрессии GIHI/variance.",
          ].join("\n")
        : [
            "Short engineering lab-improvement plan:",
            "1. Lock current stressed drivers and keep post-apply 3/6 auto-validation.",
            "2. Rely on recent evidence signals and remove stale-drop reasons from active decisions.",
            "3. Close proposal -> test -> governance loop with rollback on GIHI/variance regression.",
          ].join("\n");
      return final(answer, evidence);
    }
    return final(
      isRu
        ? "Для инженерного плана нужны диагностические инструменты, но они недоступны в allowlist."
        : "Engineering plan requires diagnostics tools, but they are unavailable in allowlist.",
      ["TOOL_RESULT(boot): missing diagnostics tools"]
    );
  }

  const who = lastSignal(signals, "result", ["whoami", "sync_status"]);
  if (!who && allowed.has("whoami")) return toolCall("whoami", {}, "baseline runtime context");
  if (!who && allowed.has("sync_status")) return toolCall("sync_status", {}, "baseline runtime context");
  if (who) {
    return final(
      isRu
        ? "Запрос принят. Сформулируйте конкретное действие: что проверить, прочитать, запустить или изменить."
        : "Request accepted. Specify a concrete action: what to check, read, run, or modify.",
      [who.raw]
    );
  }
  return final(
    isRu
      ? "Запрос принят. Укажите конкретное действие (проверить/прочитать/запустить/изменить)."
      : "Request accepted. Specify a concrete action (check/read/run/modify).",
    ["TOOL_RESULT(boot): local://swe backend active"]
  );
}
export function registerLlmAgentChatTool(opts: RegisterOpts) {
  const MessageSchema = z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string().min(1),
    name: z.string().optional(),
  });

  opts.server.tool(
    "llm_agent_chat",
    "LLM agent wrapper with tool-loop: model emits JSON tool calls, server executes allowlisted tools, returns final answer + trace.",
    {
      messages: z.array(MessageSchema).min(1),
      model: z.string().optional(),
      max_steps: z.number().int().min(1).max(12).optional(),
      allowed_tools: z.array(z.string()).optional(),
      tool_choice: z.enum(["auto", "none"]).optional(),
      trace: z.boolean().optional(),
      stop_on_final: z.boolean().optional(),
      // Hardening flags:
      enforce_boot: z.boolean().optional(),
      require_evidence: z.boolean().optional(),
    },
    async (args: {
      messages: ChatMsg[];
      model?: string;
      max_steps?: number;
      allowed_tools?: string[];
      tool_choice?: "auto" | "none";
      trace?: boolean;
      stop_on_final?: boolean;
      enforce_boot?: boolean;
      require_evidence?: boolean;
    }) => {
      try {
        const toolMap = opts.tools;
        const allToolNames = Object.keys(toolMap).sort();
        const requested = Array.isArray(args.allowed_tools) && args.allowed_tools.length > 0
          ? args.allowed_tools
          : allToolNames;
        const allowedTools = requested.filter((n) => Boolean(toolMap[n]));

        const maxSteps = Math.max(1, Math.min(12, args.max_steps ?? 8));
        const traceOn = args.trace !== false;
        const stopOnFinal = args.stop_on_final !== false;
        const toolChoice = args.tool_choice ?? "auto";

        const enforceBoot = args.enforce_boot !== false; // default true
        const requireEvidence = args.require_evidence !== false; // default true

        const sessionId = `llm_agent_chat:${randomUUID()}`;

        // === Boot context: ALWAYS injected server-side (model cannot skip). ===
        const now = new Date();
        const capabilitiesText = enforceBoot ? await safeReadCapabilities() : "(boot skipped)";

        // Try to obtain whoami from tools, but do not depend on LLM to call it.
        let whoamiSummary = "(whoami unavailable)";
        try {
          if (typeof toolMap.whoami === "function" && allowedTools.includes("whoami")) {
            whoamiSummary = summarizeResult(await toolMap.whoami({}));
          } else if (typeof (toolMap as any).sync_status === "function" && allowedTools.includes("sync_status")) {
            whoamiSummary = summarizeResult(await (toolMap as any).sync_status({}));
          }
        } catch (e: any) {
          whoamiSummary = `FAILED_TO_RUN_WHOAMI: ${String(e?.message ?? e)}`;
        }

        const systemFacts =
          `Current datetime (ISO): ${now.toISOString()}\n` +
          `Today: ${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}\n` +
          `Runtime mode: tool-wrapped agent, no hidden tools.\n` +
          `Available tools: ${allowedTools.join(", ") || "(none)"}`;

        const state: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

        // Strict protocol:
        state.push({
          role: "system",
          content:
            "You are an LLM agent in a tool-loop.\n" +
            "Never claim tool access unless the tool call succeeded in THIS loop.\n" +
            "You will always receive BOOT_CONTEXT (CAPABILITIES + WHOAMI). Treat it as the only source of truth about lab capabilities.\n" +
            "If you need to check something, you MUST call tools; do not guess.\n" +
            "If tool is required, respond ONLY JSON:\n" +
            "{\"type\":\"tool_call\",\"name\":\"<tool>\",\"arguments\":{...},\"reason\":\"...\"}\n" +
            "If final answer is ready, respond ONLY JSON:\n" +
            "{\"type\":\"final\",\"answer\":\"...\",\"evidence\":[\"TOOL_RESULT(<tool>): ...\", ...]}\n" +
            "No prose outside JSON.\n" +
            "Use ONLY exact tool names from Available tools list.\n" +
            "RULE: If you claim something is done/created/fixed/active/cleaned, you MUST include evidence lines produced by tools in this loop."
        });

        // Boot context injected as system message (cannot be skipped by SWE).
        state.push({
          role: "system",
          content:
            "BOOT_CONTEXT\n" +
            `WHOAMI: ${whoamiSummary}\n\n` +
            "CAPABILITIES_MD (source of truth):\n" +
            capabilitiesText,
        });

        state.push({ role: "system", content: systemFacts });

        for (const m of args.messages) {
          if (m.role === "tool") {
            state.push({ role: "user", content: `TOOL_RESULT(${m.name ?? "tool"}): ${m.content}` });
          } else {
            state.push({ role: m.role, content: m.content });
          }
        }

        const steps: Array<Record<string, unknown>> = [];
        let finalText = "";

        for (let step = 1; step <= maxSteps; step += 1) {
          const modelOut = await callChatCompletions({
            model: args.model,
            messages: state,
            allowedTools,
          });
          const parsedJson = extractJsonCandidate(modelOut);
          const parsed = parsedJson ? JSON.parse(parsedJson) : null;

          if (!parsed || typeof parsed !== "object") {
            finalText = modelOut || "No model output.";
            if (traceOn) steps.push({ step, kind: "final_fallback", llm_output: modelOut });
            break;
          }

          const kind = String((parsed as any).type ?? "").trim();

          if (kind === "final") {
            const answer = String((parsed as any).answer ?? "").trim() || modelOut;
            const evidence = Array.isArray((parsed as any).evidence) ? (parsed as any).evidence : [];

            // Hard gate: require evidence for any final output when enabled.
            if (requireEvidence && evidence.length === 0) {
              const msg =
                "MISSING_EVIDENCE: Final answers must include an 'evidence' array with TOOL_RESULT lines from this loop. " +
                "Call tools to verify, then answer again.";
              state.push({ role: "user", content: msg });
              if (traceOn) steps.push({ step, kind: "final_rejected_no_evidence", llm_output: modelOut, error: msg });
              continue;
            }

            finalText = answer;
            if (traceOn) steps.push({ step, kind: "final", answer: finalText, evidence_count: evidence.length });
            if (stopOnFinal) break;
            continue;
          }

          if (kind !== "tool_call" || toolChoice === "none") {
            finalText = modelOut;
            if (traceOn) steps.push({ step, kind: "final_non_tool", llm_output: modelOut });
            break;
          }

          const toolNameRaw = String((parsed as any).name ?? "").trim();
          const toolName = normalizeToolName(toolNameRaw);
          const toolArgs = ((parsed as any).arguments && typeof (parsed as any).arguments === "object")
            ? (parsed as any).arguments
            : {};

          if (!allowedTools.includes(toolName)) {
            const msg = `Tool not allowed: ${toolNameRaw || "(empty)"}`;
            state.push({ role: "user", content: `TOOL_ERROR(${toolName}): ${msg}` });
            if (traceOn) steps.push({ step, kind: "tool_error", tool: toolNameRaw, normalized_tool: toolName, error: msg });
            continue;
          }

          try {
            const result = await toolMap[toolName](toolArgs);
            const short = summarizeResult(result);
            state.push({ role: "user", content: `TOOL_RESULT(${toolName}): ${short}` });
            if (traceOn) steps.push({ step, kind: "tool_call", tool: toolName, arguments: toolArgs, result_summary: short });
          } catch (error: any) {
            const msg = String(error?.message ?? error);
            state.push({ role: "user", content: `TOOL_ERROR(${toolName}): ${msg}` });
            if (traceOn) steps.push({ step, kind: "tool_error", tool: toolName, arguments: toolArgs, error: msg });
          }
        }

        if (!finalText) {
          finalText = "ÐÐµ ÑƒÐ´Ð°Ð»Ð¾ÑÑŒ ÑÑ„Ð¾Ñ€Ð¼Ð¸Ñ€Ð¾Ð²Ð°Ñ‚ÑŒ Ñ„Ð¸Ð½Ð°Ð»ÑŒÐ½Ñ‹Ð¹ Ð¾Ñ‚Ð²ÐµÑ‚ Ð² Ð¿Ñ€ÐµÐ´ÐµÐ»Ð°Ñ… max_steps.";
        }

        return opts.okText({
          session_id: sessionId,
          final: finalText,
          used_tools: traceOn ? steps.filter((s) => s.kind === "tool_call").map((s) => s.tool) : undefined,
          steps: traceOn ? steps : undefined,
        });
      } catch (error: any) {
        return opts.errText(`llm_agent_chat failed: ${String(error?.message ?? error)}`);
      }
    }
  );
}
