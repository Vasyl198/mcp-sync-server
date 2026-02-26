import { z } from "zod";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ReqLog = {
  ts: string;
  id: string;
  httpMethod: string;
  path: string;
  status?: number;
  durationMs?: number;

  // useful headers
  accept?: string;
  ua?: string;
  sessionId?: string;
  cfRay?: string;

  // MCP details (best-effort)
  mcpMethod?: string;
  toolName?: string;
};

const REQ_RING: ReqLog[] = [];
const REQ_RING_MAX = 400;

function pushReq(e: ReqLog) {
  REQ_RING.push(e);
  while (REQ_RING.length > REQ_RING_MAX) REQ_RING.shift();
}

function getEnvLogPath() {
  return (
    process.env.CLOUDFLARED_LOG_PATH ||
    `${process.env.USERPROFILE}\\.cloudflared\\logs\\cloudflared.log` 
  );
}

async function tryFetch(url: string, timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(t);
  }
}

async function autoMetricsUrl(): Promise<string | null> {
  // if user pinned it explicitly
  if (process.env.CLOUDFLARED_METRICS_URL) return process.env.CLOUDFLARED_METRICS_URL;

  // default range 20241..20245 per cloudflared docs
  for (const port of [20241, 20242, 20243, 20244, 20245]) {
    const url = `http://127.0.0.1:${port}/metrics`;
    try {
      const r = await tryFetch(url, 300);
      if (r.ok && r.text.includes("# HELP")) return url;
    } catch {}
  }
  return null;
}

export function diagRequestMiddleware() {
  return (req: any, res: any, next: any) => {
    const id = randomUUID();
    const start = Date.now();

    const sessionId = req.headers["mcp-session-id"];
    const accept = req.headers["accept"];
    const ua = req.headers["user-agent"];
    const cfRay = req.headers["cf-ray"];

    // parse MCP info best-effort (only for POST /mcp)
    let mcpMethod: string | undefined;
    let toolName: string | undefined;
    if (req.path === "/mcp" && req.method === "POST" && req.body) {
      mcpMethod = req.body?.method;
      if (mcpMethod === "tools/call") {
        toolName = req.body?.params?.name;
      }
    }

    res.on("finish", () => {
      pushReq({
        ts: new Date().toISOString(),
        id,
        httpMethod: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - start,
        accept,
        ua,
        sessionId,
        cfRay,
        mcpMethod,
        toolName,
      });
    });

    // close может быть до finish (SSE/aborts)
    res.on("close", () => {
      if (!res.headersSent) return;
      // если finish уже был — второй раз не пишем
      // (простая защита: ищем id)
      if (REQ_RING.length && REQ_RING[REQ_RING.length - 1]?.id === id) return;

      pushReq({
        ts: new Date().toISOString(),
        id,
        httpMethod: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - start,
        accept,
        ua,
        sessionId,
        cfRay,
        mcpMethod,
        toolName,
      });
    });

    next();
  };
}

async function tailFileLines(filePath: string, lines: number, maxBytes: number) {
  const st = await fs.stat(filePath);
  const size = st.size;
  const readSize = Math.min(size, maxBytes);

  const fh = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, size - readSize);
    const text = buf.toString("utf8");
    const arr = text.split(/\r?\n/).filter((x) => x.length > 0);
    return { size, lines: arr.slice(-lines) };
  } finally {
    await fh.close();
  }
}

function parseMetricsSample(metricsText: string) {
  // вернём маленькую "выжимку" — остальное можно смотреть raw
  const interesting = [
    "cloudflared_tunnel",
    "cloudflared_connections",
    "cloudflared_ha_connections",
    "cloudflared_request",
    "cloudflared_retries",
  ];

  const out: string[] = [];
  for (const line of metricsText.split("\n")) {
    if (line.startsWith("#")) continue;
    if (interesting.some((p) => line.startsWith(p))) out.push(line);
    if (out.length >= 80) break;
  }
  return out;
}

export function createDiagTools(server: McpServer) {
  const handlers: Record<string, Function> = {};
  const diagRecentRequestsHandler = async ({ limit }: any) => {
    const items = REQ_RING.slice(-limit);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ items }, null, 2) }],
    };
  };

  server.tool(
    "diag_recent_requests",
    "Recent /mcp request log (correlate tool calls with tunnel logs).",
    {
      limit: z.number().int().min(1).max(400).optional().default(50),
    },
    diagRecentRequestsHandler
  );

  handlers["diag_recent_requests"] = diagRecentRequestsHandler;

  const tunnelLogTailHandler = async ({ path, lines, max_bytes, match }: any) => {
      const logPath = path || getEnvLogPath();
      const t = await tailFileLines(logPath, lines, max_bytes);
      let out = t.lines;
      if (match) {
        const re = new RegExp(match, "i");
        out = out.filter((l) => re.test(l));
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ logPath, fileSize: t.size, lines: out }, null, 2),
          },
        ],
      };
    };

  server.tool(
    "tunnel_log_tail",
    "Tail cloudflared logfile (last N lines).",
    {
      path: z.string().optional(),
      lines: z.number().int().min(10).max(2000).optional().default(200),
      max_bytes: z.number().int().min(4096).max(2_000_000).optional().default(200_000),
      match: z.string().optional(), // regex string
    },
    tunnelLogTailHandler
  );

  handlers["tunnel_log_tail"] = tunnelLogTailHandler;

  server.tool(
    "tunnel_metrics",
    "Fetch cloudflared Prometheus metrics and return a filtered sample.",
    {
      url: z.string().optional(),
    },
    async ({ url }: any) => {
      const metricsUrl = url || (await autoMetricsUrl());
      if (!metricsUrl) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error:
                    "metrics endpoint not found on 127.0.0.1:20241-20245. Start tunnel with: --metrics 127.0.0.1:20241",
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      const r = await tryFetch(metricsUrl, 1500);
      const sample = parseMetricsSample(r.text);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: r.ok, status: r.status, url: metricsUrl, sampleLines: sample },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  const diagSnapshotHandler = async ({ req_limit, log_lines }: any) => {
      const reqs = REQ_RING.slice(-req_limit);

      let log: any = null;
      try {
        const logPath = getEnvLogPath();
        const t = await tailFileLines(logPath, log_lines, 300_000);
        // покажем только ошибки/контекст
        const filtered = t.lines.filter(
          (l) => l.includes(" ERR ") || l.toLowerCase().includes("context canceled")
        );
        log = { logPath, fileSize: t.size, lines: filtered.slice(-200) };
      } catch (e: any) {
        log = { error: e?.message || String(e) };
      }

      let metrics: any = null;
      try {
        const metricsUrl = await autoMetricsUrl();
        if (metricsUrl) {
          const r = await tryFetch(metricsUrl, 1500);
          metrics = { url: metricsUrl, ok: r.ok, status: r.status, sampleLines: parseMetricsSample(r.text) };
        } else {
          metrics = { ok: false, error: "metrics URL not found" };
        }
      } catch (e: any) {
        metrics = { ok: false, error: e?.message || String(e) };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { now: new Date().toISOString(), recentRequests: reqs, tunnelLog: log, metrics },
              null,
              2
            ),
          },
        ],
      };
    };

  server.tool(
    "diag_snapshot",
    "One-call snapshot: last MCP requests + last cloudflared ERRs + metrics sample.",
    {
      req_limit: z.number().int().min(1).max(200).optional().default(30),
      log_lines: z.number().int().min(50).max(2000).optional().default(300),
    },
    diagSnapshotHandler
  );

  handlers["diag_snapshot"] = diagSnapshotHandler;

  return handlers;
}
