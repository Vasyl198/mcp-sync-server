// MCP protocol + HTTP diagnostics (Node.js, SSE-safe)
// Repo uses ESM (package.json: "type": "module")
// Run:
//   node .\\tests\\mcp_protocol_tests.js
// Env overrides:
//   set MCP_BASE_URL=https://mcp.pioneer-mcp.online
//   set MCP_ABORT_MS=85000
//   set MCP_LONG_MS=120000
//   set MCP_STREAM_MS=15000

const base = (process.env.MCP_BASE_URL || 'https://mcp.pioneer-mcp.online').replace(/\/$/, '');
const endpoint = `${base}/mcp`;
const abortMs = Number(process.env.MCP_ABORT_MS || '85000');
const longMs = Number(process.env.MCP_LONG_MS || '120000');
const streamMs = Number(process.env.MCP_STREAM_MS || '15000');

const UA = 'node-mcp-protocol-test/0.2.0';

function now() {
  return new Date().toISOString();
}

function short(s, n = 900) {
  if (s == null) return '';
  const t = String(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

async function getText(url, timeoutMs = 60000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: controller.signal });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(t);
  }
}

async function readSseFirstJson(res, { timeoutMs = 15000, maxBytes = 512 * 1024 } = {}) {
  // Reads from res.body until it can parse a JSON from the first SSE data event.
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    return { json: null, raw: short(text, 1200) };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let bytes = 0;
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        bytes += value.byteLength;
        if (bytes > maxBytes) break;
        buf += dec.decode(value, { stream: true });

        // SSE events are separated by blank line.
        const idx = buf.indexOf('\n\n');
        if (idx !== -1) {
          const event = buf.slice(0, idx);
          // Parse first JSON in data: lines
          const dataLines = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
          for (const dl of dataLines) {
            if (!dl || dl === '[DONE]') continue;
            try {
              return { json: JSON.parse(dl), raw: dl };
            } catch {
              // continue
            }
          }
          return { json: null, raw: short(event, 1200) };
        }
      }
    }
    return { json: null, raw: short(buf, 1200) };
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

async function postRpc({ sessionId, id, method, params, timeoutMs = 0 }) {
  const controller = new AbortController();
  let timer = null;
  if (timeoutMs > 0) timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'user-agent': UA,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

  try {
    const res = await fetch(endpoint, { method: 'POST', headers, body, signal: controller.signal });
    const ct = res.headers.get('content-type') || '';

    if (ct.toLowerCase().includes('text/event-stream')) {
      const sse = await readSseFirstJson(res, { timeoutMs: 15000 });
      return { res, parsed: { kind: 'sse', json: sse.json, raw: sse.raw } };
    }

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(String(text || '').trim()); } catch {}
    return { res, parsed: json ? { kind: 'json', json, raw: short(text, 1200) } : { kind: 'text', json: null, raw: short(text, 1200) } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function headersObj(res) {
  const o = {};
  for (const [k, v] of res.headers.entries()) o[k] = v;
  return o;
}

async function main() {
  console.log('TIME:', now());
  console.log('BASE:', base);
  console.log('ENDPOINT:', endpoint);

  // HTTP sanity
  console.log(`\n[1] GET /health @ ${now()}`);
  {
    const { res, text } = await getText(`${base}/health`, 15000);
    console.log('[health]', res.status, text.trim());
  }

  console.log(`\n[2] GET /debug/stream ${streamMs}ms @ ${now()}`);
  {
    const { res, text } = await getText(`${base}/debug/stream?ms=${streamMs}&interval=5000`, streamMs + 15000);
    console.log('[debug/stream]', res.status);
    console.log(short(text, 300));
  }

  // MCP initialize
  console.log(`\n[3] POST /mcp initialize @ ${now()}`);
  const initParams = {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'node-mcp-test', version: '0.2.0' },
  };

  const init = await postRpc({ sessionId: null, id: 0, method: 'initialize', params: initParams, timeoutMs: 20000 });
  console.log('init status:', init.res.status);
  const h = headersObj(init.res);
  const sessionId = h['mcp-session-id'];
  console.log('mcp-session-id:', sessionId || '(missing)');
  if (!sessionId) {
    console.log('headers:', h);
    console.log('body:', init.parsed.json ? JSON.stringify(init.parsed.json) : init.parsed.raw);
    process.exitCode = 2;
    return;
  }

  // tools/list
  console.log(`\n[4] tools/list @ ${now()}`);
  const tl = await postRpc({ sessionId, id: 1, method: 'tools/list', params: {}, timeoutMs: 20000 });
  console.log('tools/list status:', tl.res.status);
  const tlJson = tl.parsed.json;
  if (!tlJson) {
    console.log('tools/list raw:', tl.parsed.raw);
    process.exitCode = 3;
    return;
  }

  const tools = tlJson?.result?.tools || tlJson?.tools || [];
  const names = Array.isArray(tools) ? tools.map(t => t?.name).filter(Boolean) : [];
  console.log('tools count:', names.length);
  console.log('first tools:', names.slice(0, 25));

  const hasSleep = names.includes('debug_sleep_sync');
  console.log('has debug_sleep_sync:', hasSleep);

  if (hasSleep) {
    console.log(`\n[5] tools/call debug_sleep_sync 1s @ ${now()}`);
    const c1 = await postRpc({ sessionId, id: 2, method: 'tools/call', params: { name: 'debug_sleep_sync', arguments: { ms: 1000 } }, timeoutMs: 20000 });
    console.log('status:', c1.res.status);
    console.log('resp:', c1.parsed.json ? JSON.stringify(c1.parsed.json).slice(0, 700) : c1.parsed.raw);

    console.log(`\n[6] tools/call debug_sleep_sync ${longMs}ms with client abort at ${abortMs}ms @ ${now()}`);
    console.log(`Expected: client abort + server log ABORT ... ua=${UA} around ~${abortMs}ms`);
    try {
      await postRpc({ sessionId, id: 3, method: 'tools/call', params: { name: 'debug_sleep_sync', arguments: { ms: longMs } }, timeoutMs: abortMs });
      console.log('WARNING: long call completed without abort.');
    } catch (e) {
      console.log('client aborted as expected:', e?.name || e?.message || String(e));
    }
  } else {
    console.log('\n[5-6] Skipping sleep calls (tool not registered).');
  }

  // close
  console.log(`\n[7] DELETE /mcp (close) @ ${now()}`);
  const del = await fetch(endpoint, { method: 'DELETE', headers: { 'mcp-session-id': sessionId, 'user-agent': UA } });
  console.log('delete status:', del.status);

  console.log('\nDone.');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
