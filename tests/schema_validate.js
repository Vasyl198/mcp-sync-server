// Validate MCP tool schemas: no { type: "array" } without "items"
// Run:
//   node .\tests\schema_validate.js
// Env:
//   MCP_BASE_URL=https://mcp.pioneer-mcp.online

const base = (process.env.MCP_BASE_URL || "https://mcp.pioneer-mcp.online").replace(/\/$/, "");
const endpoint = `${base}/mcp`;
const UA = "node-mcp-schema-validate/0.1.0";

function pathJoin(prefix, segment) {
  if (!prefix) return segment;
  return `${prefix}.${segment}`;
}

function findArraysWithoutItems(node, path = "") {
  const bad = [];
  if (!node || typeof node !== "object") return bad;

  if (node.type === "array" && node.items === undefined) {
    bad.push(path || "<root>");
  }

  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v)) {
      v.forEach((it, i) => bad.push(...findArraysWithoutItems(it, `${pathJoin(path, k)}[${i}]`)));
    } else if (v && typeof v === "object") {
      bad.push(...findArraysWithoutItems(v, pathJoin(path, k)));
    }
  }

  return bad;
}

function headersObj(res) {
  const o = {};
  for (const [k, v] of res.headers.entries()) o[k] = v;
  return o;
}

async function readSseFirstJson(res, { timeoutMs = 15000, maxBytes = 512 * 1024 } = {}) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const text = await res.text();
    return { json: null, raw: text.slice(0, 1200) };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";
  let bytes = 0;
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) break;
      buf += dec.decode(value, { stream: true });

      const idx = buf.indexOf("\n\n");
      if (idx === -1) continue;
      const event = buf.slice(0, idx);
      const dataLines = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      for (const dl of dataLines) {
        if (!dl || dl === "[DONE]") continue;
        try {
          return { json: JSON.parse(dl), raw: dl };
        } catch {
          // continue
        }
      }
      return { json: null, raw: event.slice(0, 1200) };
    }
    return { json: null, raw: buf.slice(0, 1200) };
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

async function postRpc({ sessionId, id, method, params, timeoutMs = 20000 }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const headers = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
    "user-agent": UA,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: controller.signal,
    });
    const ct = String(res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("text/event-stream")) {
      const sse = await readSseFirstJson(res);
      return { res, json: sse.json, raw: sse.raw };
    }
    const text = await res.text();
    try {
      return { res, json: JSON.parse(text), raw: text };
    } catch {
      return { res, json: null, raw: text };
    }
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  console.log("BASE:", base);

  const init = await postRpc({
    sessionId: null,
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "schema-validator", version: "0.1.0" },
    },
  });

  const sessionId = headersObj(init.res)["mcp-session-id"];
  if (!sessionId) {
    console.error("initialize failed: missing mcp-session-id");
    console.error("status:", init.res.status);
    console.error("body:", init.raw?.slice?.(0, 1200) ?? init.raw);
    process.exit(2);
  }

  const tl = await postRpc({
    sessionId,
    id: 1,
    method: "tools/list",
    params: {},
  });

  const tools = tl.json?.result?.tools || tl.json?.tools || [];
  if (!Array.isArray(tools)) {
    console.error("tools/list malformed response");
    console.error("status:", tl.res.status);
    console.error("body:", tl.raw?.slice?.(0, 1200) ?? tl.raw);
    process.exit(3);
  }

  const violations = [];
  for (const tool of tools) {
    const name = String(tool?.name ?? "<unknown>");
    const schema = tool?.inputSchema;
    const bad = findArraysWithoutItems(schema, "inputSchema");
    if (bad.length > 0) {
      violations.push({ tool: name, paths: bad });
    }
  }

  const del = await fetch(endpoint, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId, "user-agent": UA },
  });
  console.log("DELETE /mcp:", del.status);

  if (violations.length > 0) {
    console.error("Schema violations found (array without items):");
    for (const v of violations) {
      console.error(`- ${v.tool}`);
      for (const p of v.paths) {
        console.error(`  ${p}`);
      }
    }
    process.exit(1);
  }

  console.log(`OK: validated ${tools.length} tool schemas, no array-without-items issues.`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
