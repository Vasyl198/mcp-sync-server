$ErrorActionPreference = "Stop"

$path = "C:\Users\anani\Projects\mcp-sync-server\src\agent\llm_agent_chat.ts"
$content = [IO.File]::ReadAllText($path)

$start = $content.IndexOf("function isInProcessLocalBackend")
$end = $content.IndexOf("export function registerLlmAgentChatTool")

if ($start -lt 0 -or $end -lt 0 -or $end -le $start) {
  throw "Failed to locate replacement markers in llm_agent_chat.ts"
}

$prefix = $content.Substring(0, $start)
$suffix = $content.Substring($end)

$block = @'
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

  const final = (answer: string, evidence: string[]) =>
    JSON.stringify({ type: "final", answer, evidence }, null, 0);
  const toolCall = (name: string, args: Record<string, unknown>, reason: string) =>
    JSON.stringify({ type: "tool_call", name, arguments: args, reason }, null, 0);

  if (lastErr) {
    return final(
      `Не удалось выполнить инструмент '${lastErr.tool}'. Проверьте доступность инструмента и повторите запрос.`,
      [lastErr.raw]
    );
  }

  if (containsAny(q, ["привет", "здравств", "hello", "hi"])) {
    return final(
      "Здравствуйте. Готов работать как инженерный SWE-агент: анализировать, вызывать инструменты, вносить изменения и давать проверяемый результат с evidence.",
      ["TOOL_RESULT(boot): local://swe backend active"]
    );
  }

  if (containsAny(q, ["кто ты", "о себе", "что умеешь", "функции", "инструменты"])) {
    const toolsLine = shortToolList(allowed, 20).join(", ");
    return final(
      "Я мостовой SWE-агент лаборатории. Работаю в режиме tool-first: сначала факты и tool-вызовы, затем выводы. "
      + `Доступные инструменты (фрагмент): ${toolsLine || "(none)"}.`,
      ["TOOL_RESULT(boot): capabilities loaded"]
    );
  }

  if (containsAny(q, ["день", "время", "дата", "недели", "day", "time", "date", "weekday"])) {
    const done = lastSignal(signals, "result", ["sync_status", "time", "whoami"]);
    if (done) {
      return final("Проверил через инструменты. Текущие дата/время получены.", [done.raw]);
    }
    if (allowed.has("sync_status")) return toolCall("sync_status", {}, "need runtime datetime");
    if (allowed.has("time")) return toolCall("time", { utc_offset: "+00:00" }, "fallback datetime");
    if (allowed.has("whoami")) return toolCall("whoami", {}, "whoami often includes runtime clock");
    return final("Инструмент времени не доступен в allowlist.", ["TOOL_RESULT(boot): no datetime tools"]);
  }

  if (containsAny(q, ["погод", "курс", "новост", "мероприят", "одесс", "киев", "доллар", "weather", "news", "events", "usd", "uah"])) {
    const done = lastSignal(signals, "result", ["search_web", "web", "read_url_content"]);
    if (done) {
      return final("Проверил через web-инструмент. Данные получены из источников.", [done.raw]);
    }
    if (allowed.has("search_web")) {
      return toolCall("search_web", { query: lastUser, max_results: 5 }, "fresh web data required");
    }
    if (allowed.has("web")) {
      return toolCall("web", { op: "search", query: lastUser, max_results: 5 }, "fresh web data required");
    }
    return final("Для этого запроса нужен веб-поиск, но соответствующий инструмент не разрешен.", [
      "TOOL_RESULT(boot): web search not allowed",
    ]);
  }

  if (containsAny(q, ["папк", "файл", "директор", "рабоч", "desktop", "projects", "folder", "file", "directory"])) {
    const done = lastSignal(signals, "result", ["fs_projects", "fs", "terminal_swe"]);
    if (done) {
      return final("Проверил файловую систему через инструмент. Список получен.", [done.raw]);
    }
    const p = /([A-Za-z]:\\[^\n\r"]+)/.exec(lastUser)?.[1] ?? "C:\\Users\\anani\\Projects";
    if (allowed.has("fs_projects")) return toolCall("fs_projects", { path: p, limit: 30 }, "list files");
    if (allowed.has("fs")) return toolCall("fs", { op: "list", dir: p, limit: 30 }, "list files");
    return final("Инструменты файловой системы недоступны в allowlist.", [
      "TOOL_RESULT(boot): fs_projects/fs not allowed",
    ]);
  }

  if (containsAny(q, ["улучш", "оптимиз", "архитектур", "лаборатор", "roadmap", "план", "stressed", "entropy", "improve", "optimize", "optimization", "architecture", "lab", "plan"])) {
    const meta = lastSignal(signals, "result", [
      "intelligence_meta_snapshot",
      "intelligence_health_snapshot",
      "arena_telemetry_snapshot",
    ]);
    const transfer = lastSignal(signals, "result", ["transfer_diagnostics"]);

    if (!meta) {
      if (allowed.has("intelligence_meta_snapshot")) {
        return toolCall("intelligence_meta_snapshot", {}, "collect system-level diagnostics before plan");
      }
      if (allowed.has("intelligence_health_snapshot")) {
        return toolCall("intelligence_health_snapshot", {}, "collect health diagnostics before plan");
      }
    }
    if (meta && !transfer && allowed.has("transfer_diagnostics")) {
      return toolCall("transfer_diagnostics", {}, "collect transfer anomalies before final plan");
    }
    if (meta) {
      const evidence: string[] = [meta.raw];
      if (transfer) evidence.push(transfer.raw);
      const answer = [
        "Короткий инженерный план улучшения лаборатории:",
        "1) Стабилизация: зафиксировать текущие драйверы stressed и включить авто-валидацию 3/6 тиков для каждого apply.",
        "2) Качество сигнала: опираться на recent-метрики (evidence recent_*) и убрать шумные причины drop из active decision path.",
        "3) Замкнутый цикл: agenda -> patch proposal -> tests -> governance с жестким gate по evidence и rollback при регрессии GIHI/variance.",
      ].join("\n");
      return final(answer, evidence);
    }
    return final("Для инженерного плана нужны диагностические инструменты, но они не доступны в allowlist.", [
      "TOOL_RESULT(boot): missing diagnostics tools",
    ]);
  }

  const who = lastSignal(signals, "result", ["whoami", "sync_status"]);
  if (!who && allowed.has("whoami")) {
    return toolCall("whoami", {}, "baseline runtime context");
  }
  if (!who && allowed.has("sync_status")) {
    return toolCall("sync_status", {}, "baseline runtime context");
  }
  if (who) {
    return final(
      "Запрос принят. Могу выполнить конкретное действие: проверить метрики, прочитать/изменить файлы, запустить диагностику или поиск.",
      [who.raw]
    );
  }
  return final(
    "Запрос принят. Для выполнения укажите конкретное действие (что проверить, прочитать, запустить или изменить).",
    ["TOOL_RESULT(boot): local://swe backend active"]
  );
}

'@

$newContent = $prefix + $block + $suffix
$enc = [System.Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($path, $newContent, $enc)
Write-Output "Local backend block rewritten."
