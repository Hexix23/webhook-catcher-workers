export interface Env {
  WEBHOOKS: KVNamespace;
  ALLOWED_API_KEYS?: string; // Comma-separated list; if empty, any key is accepted
  RETENTION_DAYS?: string; // Defaults to 30
  PANEL_USER?: string;
  PANEL_PASS?: string;
  APP_NAME?: string;
}

type EventRecord = {
  id: string;
  apiKey: string;
  receivedAt: string; // ISO timestamp
  body: Record<string, unknown>;
};

const NO_KEY = "NO-KEY";

// Entry point
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS and preflight for webhook POST
    if (request.method === "OPTIONS") {
      return buildCorsResponse(new Response(null, { status: 204 }));
    }

    if (pathname === "/" || pathname === "/panel") {
      return handlePanel(request, env);
    }

    if (pathname === "/panel.js" && request.method === "GET") {
      return new Response(renderPanelJs(), {
        status: 200,
        headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    if (pathname === "/panel-ext.js" && request.method === "GET") {
      return new Response(renderPanelExtJs(), {
        status: 200,
        headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    if (pathname === "/api/events" && request.method === "GET") {
      try {
        return await handleListEvents(request, env);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Internal error";
        return new Response(
          JSON.stringify({ events: [], listComplete: true, error: message }),
          { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
        );
      }
    }
    if (pathname === "/api/events" && request.method === "DELETE") {
      try {
        return await handleDeleteEvents(request, env);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Internal error";
        return new Response(JSON.stringify({ error: message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    if (pathname === "/api/keys" && request.method === "GET") {
      try {
        return await handleListDistinctKeys(request, env);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Internal error";
        return new Response(JSON.stringify({ keys: [], error: message }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    }

    if ((pathname === "/webhook" || pathname === "/api/webhook") && request.method === "POST") {
      const response = await handleWebhook(request, env, ctx);
      return buildCorsResponse(response);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function buildCorsResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, key, Authorization");
  return new Response(response.body, { status: response.status, headers });
}

function getRetentionTtlSeconds(env: Env): number | undefined {
  const daysRaw = (env.RETENTION_DAYS ?? "30").trim();
  const days = Number(daysRaw);
  if (!Number.isFinite(days) || days <= 0) return undefined;
  return Math.floor(days * 24 * 60 * 60);
}

function requireBasicAuth(
  request: Request,
  env: Env,
  isHtml = false,
): { ok: true } | { error: Response } {
  const hdr = request.headers.get("authorization");
  const user = env.PANEL_USER ?? "";
  const pass = env.PANEL_PASS ?? "";
  const expected = `Basic ${btoa(`${user}:${pass}`)}`;
  if (!hdr || hdr !== expected) {
    const headers = new Headers();
    headers.set("WWW-Authenticate", 'Basic realm="panel"');
    headers.set("Cache-Control", "no-store");
    if (isHtml) headers.set("Content-Type", "text/html; charset=utf-8");
    return {
      error: new Response(isHtml ? "Unauthorized" : JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers,
      }),
    };
  }
  return { ok: true };
}

function readApiKey(request: Request): string | null {
  const url = new URL(request.url);
  // New header name: "key". Backward compatibility: support old query/header names.
  const fromKeyHeader = request.headers.get("key");
  if (fromKeyHeader) return fromKeyHeader;
  const fromQueryLegacy = url.searchParams.get("api_key");
  if (fromQueryLegacy) return fromQueryLegacy;
  const fromHeaderLegacy = request.headers.get("x-api-key");
  if (fromHeaderLegacy) return fromHeaderLegacy;
  return null;
}

function toEffectiveKey(maybe: string | null): string {
  const trimmed = (maybe ?? "").trim();
  return trimmed.length > 0 ? trimmed : NO_KEY;
}

function isApiKeyAllowed(apiKey: string, env: Env): boolean {
  const allowlistRaw = env.ALLOWED_API_KEYS ?? "";
  const allowlist = allowlistRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (allowlist.length === 0) return true; // Open if no allowlist configured
  return allowlist.includes(apiKey);
}

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const apiKey = toEffectiveKey(readApiKey(request));
  if (!isApiKeyAllowed(apiKey, env)) {
    return new Response(JSON.stringify({ error: "Forbidden api_key" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return new Response(JSON.stringify({ error: "Body must be a flat JSON object of key-value pairs" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!isFlatKeyValueObject(body as Record<string, unknown>)) {
    return new Response(
      JSON.stringify({ error: "Body must be flat (no nested objects/arrays); only key-value pairs" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const eventRecord: EventRecord = {
    id: generateEventId(),
    apiKey,
    receivedAt: new Date().toISOString(),
    body: body as Record<string, unknown>,
  };

  const ttlSeconds = getRetentionTtlSeconds(env);
  const storageKey = makeStorageKey(apiKey, eventRecord.id);

  await env.WEBHOOKS.put(storageKey, JSON.stringify(eventRecord), {
    expirationTtl: ttlSeconds,
    metadata: {
      apiKey,
      receivedAt: eventRecord.receivedAt,
    },
  });

  return new Response(JSON.stringify({ ok: true, id: eventRecord.id }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeStorageKey(apiKey: string, id: string): string {
  // Prefix by api key for efficient listing
  return `${apiKey}:${id}`;
}

function generateEventId(): string {
  // Use timestamp + random suffix for ordering and uniqueness
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 10);
  return `${now}_${rand}`;
}

function isFlatKeyValueObject(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  for (const key of keys) {
    const value = (obj as Record<string, unknown>)[key];
    const isObject = typeof value === "object" && value !== null;
    if (isObject) return false; // reject nested objects/arrays
  }
  return true;
}

async function handleListEvents(request: Request, env: Env): Promise<Response> {
  // No Basic auth required here; panel remains protected. Keep this API simple for same-origin fetch.
  const url = new URL(request.url);
  const selected = url.searchParams.get("key");
  const apiKey = toEffectiveKey(selected ?? readApiKey(request));
  if (!isApiKeyAllowed(apiKey, env)) {
    return new Response(JSON.stringify({ error: "Forbidden api_key" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const limitParam = url.searchParams.get("limit");
  const cursorParam = url.searchParams.get("cursor") || undefined;
  const limit = Math.min(Math.max(Number(limitParam) || 50, 1), 200);

  const { events, cursor, listComplete } = await listEventsForApiKey(env, apiKey, limit, cursorParam);

  return new Response(JSON.stringify({ events, cursor, listComplete }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function listEventsForApiKey(
  env: Env,
  apiKey: string,
  limit: number,
  cursor?: string,
): Promise<{ events: EventRecord[]; cursor?: string; listComplete: boolean }> {
  const prefix = `${apiKey}:`;
  const page: KVNamespaceListResult<unknown, string> = await env.WEBHOOKS.list({
    prefix,
    cursor,
    limit: Math.min(1000, limit),
  });

  const results = await Promise.all(
    page.keys.map(async (k) => {
      const data = await env.WEBHOOKS.get(k.name, "json");
      return data as EventRecord | null;
    })
  );
  const events = results.filter((r): r is EventRecord => r !== null);
  return {
    events,
    cursor: ("list_complete" in page && (page as any).list_complete === false) ? (page as any).cursor : undefined,
    listComplete: ("list_complete" in page) ? (page as any).list_complete : true,
  };
}

async function handleListDistinctKeys(request: Request, env: Env): Promise<Response> {
  // Enumerate up to N keys from KV, extract distinct prefixes (apiKey before ':')
  const maxScan = 2000;
  const distinct = new Set<string>();
  let cursor: string | undefined = undefined;
  let scanned = 0;
  while (scanned < maxScan) {
    const page: KVNamespaceListResult<unknown, string> = await env.WEBHOOKS.list({ cursor, limit: 1000 });
    for (const k of page.keys) {
      scanned++;
      const name = k.name;
      const idx = name.indexOf(":");
      const prefix = idx === -1 ? name : name.slice(0, idx);
      // Skip NO_KEY; the client renders a dedicated option for it
      if (prefix && prefix !== NO_KEY) distinct.add(prefix);
    }
    if (("list_complete" in page) && (page as any).list_complete === false) {
      cursor = (page as any).cursor;
    } else {
      break;
    }
  }
  const keys = Array.from(distinct.values()).sort((a, b) => a.localeCompare(b));
  return new Response(JSON.stringify({ keys }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function handleDeleteEvents(request: Request, env: Env): Promise<Response> {
  // Basic auth protects delete operations
  const auth = requireBasicAuth(request, env);
  if ("error" in auth) return auth.error;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (!payload || typeof payload !== "object") {
    return new Response(JSON.stringify({ error: "Body must be JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const { key, ids } = payload as { key?: string; ids?: string[] };
  const apiKey = toEffectiveKey(key ?? null);
  if (!isApiKeyAllowed(apiKey, env)) {
    return new Response(JSON.stringify({ error: "Forbidden api_key" }), { status: 403, headers: { "Content-Type": "application/json" } });
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return new Response(JSON.stringify({ error: "ids must be a non-empty array" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const limited = ids.slice(0, 500); // guardrail
  const keysToDelete = limited.map((id) => makeStorageKey(apiKey, id));

  await Promise.all(keysToDelete.map((k) => env.WEBHOOKS.delete(k)));
  return new Response(JSON.stringify({ ok: true, deleted: keysToDelete.length }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function handlePanel(request: Request, env: Env): Promise<Response> {
  const auth = requireBasicAuth(request, env, true);
  if ("error" in auth) {
    return auth.error;
  }
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const limit = Math.min(Math.max(Number(limitParam) || 50, 1), 200);

  // The panel now loads events client-side via fetch to /api/events with header `key`.
  const events: EventRecord[] = [];
  const errorText: string | null = null;
  const apiKey = "";

  const html = renderPanelHtml({ apiKey, limit, events, errorText, env, origin: url.origin });
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Hint the browser to keep Basic auth for the tab
      "Cache-Control": "no-store",
    },
  });
}

function renderPanelHtml(params: {
  apiKey: string;
  limit: number;
  events: EventRecord[];
  errorText: string | null;
  env: Env;
  origin?: string;
}): string {
  const { apiKey, limit, events, errorText, env, origin } = params;
  const escapedError = errorText ? `<div class="error">${escapeHtml(errorText)}</div>` : "";

  const items = events
    .map((e) => {
      const pretty = escapeHtml(JSON.stringify(e.body, null, 2));
      const ts = new Date(e.receivedAt).toLocaleString();
      return `
        <div class="event">
          <div class="event__meta">
            <span class="event__id">${escapeHtml(e.id)}</span>
            <span class="event__time">${escapeHtml(ts)}</span>
          </div>
          <pre class="event__json">${pretty}</pre>
        </div>
      `;
    })
    .join("\n");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${env.APP_NAME}</title>
    <style>
      :root { color-scheme: light dark; --bg:#0b1020; --card:#111834; --muted:#aab2d6; --text:#e8ecff; --acc:#6c8cff; --chip:#1b2448; --border:#2a376a; --code:#0a1025; --btnStart:#6c8cff; --btnEnd:#4e6af0; --shadow: rgba(0,0,0,0.18); }
      .theme-light { --bg:#f7f8fc; --card:#ffffff; --muted:#556; --text:#141824; --acc:#3b5bfd; --chip:#eef1fb; --border:#d3d9ef; --code:#f6f8ff; --btnStart:#5e79ff; --btnEnd:#3e5ff9; --shadow: rgba(0,0,0,0.06); }
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Arial, "Apple Color Emoji", "Segoe UI Emoji"; margin: 0; background: linear-gradient(180deg, var(--bg), var(--card)); color: var(--text); }
      .container { max-width: 1100px; margin: 0 auto; padding: 28px; }
      header { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; justify-content: space-between; margin-bottom: 16px; }
      .brand { display: flex; align-items: center; gap: 12px; }
      .logo { width: 24px; height: 24px; border-radius: 6px; background: radial-gradient(60% 80% at 60% 40%, #7aa2ff, #5e7dff 40%, #2c3d99 80%); box-shadow: 0 0 18px #5e7dff55; }
      h1 { font-size: 20px; margin: 0; letter-spacing: 0.3px; }
      .controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .control { display: inline-flex; gap: 8px; align-items: center; background: var(--card); border: 1px solid var(--border); padding: 8px 10px; border-radius: 10px; }
      input, select, button { font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--text); }
      input::placeholder { color: #aab2d6aa; }
      button { background: linear-gradient(180deg, var(--btnStart), var(--btnEnd)); border: none; color: white; cursor: pointer; transition: transform .12s ease, filter .2s ease; }
      button.secondary { background: var(--card); border: 1px solid var(--border); color: var(--text); }
      button:hover { filter: brightness(1.05); }
      button:active { transform: translateY(1px); }
      .hint { opacity: 0.8; font-size: 12px; }
      .error { margin-top: 12px; color: #ff6688; }
      .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 10px 0 18px; }
      .snippet { margin-top: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; background: var(--code); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 10px; overflow: auto; white-space: pre; }
      .chip { font-size: 12px; padding: 4px 8px; border-radius: 999px; background: var(--chip); border: 1px solid var(--border); color: var(--text); }
      .events { display: grid; gap: 12px; }
      .event { padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--card); box-shadow: 0 2px 8px var(--shadow); }
      .event__meta { display: flex; gap: 12px; font-size: 12px; opacity: 0.9; margin-bottom: 8px; align-items: center; }
      .event__id { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; background: var(--chip); padding: 2px 6px; border-radius: 8px; border: 1px solid var(--border); }
      .event__time { opacity: 0.9; }
      .event__json { margin: 0; overflow: auto; max-height: 360px; background: var(--code); color: var(--text); padding: 10px; border-radius: 8px; border: 1px solid var(--border); }
      .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
      .spacer { flex: 1 }
      code { background: var(--code); color: var(--text); padding: 2px 6px; border-radius: 6px; border: 1px solid var(--border); }
    </style>
  </head>
  <body>
    <div class="container">
      <header>
        <div class="brand"><div class="logo"></div><h1>${env.APP_NAME}</h1></div>
        <form method="GET" action="/panel" class="controls">
          <label class="control">
            <span>Limit</span>
            <select name="limit">
              ${[10, 25, 50, 100, 200]
                .map((n) => `<option value="${n}" ${n === limit ? "selected" : ""}>${n}</option>`)
                .join("")}
            </select>
          </label>
          <label class="control">
            <span>Key</span>
            <select id="keySelect"><option value="">Loading...</option></select>
          </label>
          <button type="submit" class="secondary" id="reloadBtn">Reload</button>
          <button type="button" id="exportJson">Export JSON</button>
          <button type="button" id="exportCsv" class="secondary">Export CSV</button>
          <button type="button" id="themeToggle" title="Toggle theme" class="secondary">Theme</button>
        </form>
      </header>
      <div class="hint">Send webhooks to <code>/webhook</code> using header <code>key: YOUR_KEY</code>.</div>
      <pre class="snippet" id="curlExample">curl -X POST "${origin ?? ""}/webhook" &#92;
&#10;  -H "Content-Type: application/json" &#92;
&#10;  -H "key: demo" &#92;
&#10;  -d '{"orderId":"123","status":"paid"}'</pre>
      <div class="toolbar">
        <div class="row">
          <input id="search" placeholder="Filter by key or value..."/>
          <span class="chip" id="countChip">0 events</span>
          <div class="spacer"></div>
          <button type="button" id="autoRefresh" class="secondary">Auto refresh: off</button>
          <button type="button" id="deleteSelected" class="secondary" title="Delete checked events">Delete selected</button>
        </div>
      </div>
      ${escapedError}
      <main class="events" id="events">${items || "<div class=\"hint\">No events</div>"}</main>
    </div>
    <script src="/panel.js" defer></script>
    <script src="/panel-ext.js" defer></script>
  </body>
  </html>`;
}

function renderPanelJs(): string {
  return `"use strict";\n(function(){\n  async function load(){\n    var limitSel = document.querySelector('select[name=\"limit\"]');\n    var limit = limitSel ? limitSel.value : '50';\n    var sel = document.getElementById('keySelect');\n    var selectedKey = sel ? sel.value : '';\n    var el = document.getElementById('events');\n    try {\n      var url = '/api/events?limit=' + encodeURIComponent(limit) + (selectedKey ? ('&key=' + encodeURIComponent(selectedKey)) : '');\n      var res = await fetch(url);\n      if (!res.ok) {\n        var text = await res.text();\n        el.innerHTML = '<div class=\"error\">Failed to load events: ' + (text || res.status) + '<\\/div>';\n        document.getElementById('countChip').textContent = '0 events';\n        window.__events = [];\n        return;\n      }\n      var data = await res.json();\n      window.__events = data.events || [];\n      render();\n    } catch (e) {\n      el.innerHTML = '<div class=\"error\">Network error loading events<\\/div>';\n      document.getElementById('countChip').textContent = '0 events';\n      window.__events = [];\n    }\n  }\n  function render(){\n    var events = window.__events || [];\n    var q = (document.getElementById('search').value || '').toLowerCase();\n    var el = document.getElementById('events');\n    var filtered = !q ? events : events.filter(function(e){\n      try {\n        var s = JSON.stringify(e.body).toLowerCase();\n        return s.includes(q) || (e.id || '').toLowerCase().includes(q);\n      } catch(_) { return true; }\n    });\n    document.getElementById('countChip').textContent = filtered.length + ' events';\n    el.innerHTML = filtered.map(function(e){\n      return '<div class=\"event\">'\n        + '<div class=\"event__meta\">'\n        + '<label><input type=\"checkbox\" class=\"chk\" data-id=\"' + e.id + '\\"> Select<\\/label>'\n        + '<span class=\"event__id\">' + e.id + '<\\/span>'\n        + '<span class=\"event__time\">' + new Date(e.receivedAt).toLocaleString() + '<\\/span>'\n        + '<\\/div>'\n        + '<pre class=\"event__json\">' + JSON.stringify(e.body, null, 2) + '<\\/pre>'\n        + '<\\/div>'\n    }).join('') || '<div class=\"hint\">No events<\\/div>';\n  }\n  async function populateKeys(){\n    try {\n      var res = await fetch('/api/keys');\n      var data = await res.json();\n      var keys = (data && data.keys) ? data.keys : [];\n      var sel = document.getElementById('keySelect');\n      if (!sel) return;\n      var current = localStorage.getItem('panel_key') || '';\n      var opts = keys.map(function(k){ return '<option value=\"' + k + '\\">' + k + '</option>'; }).join('');\n      sel.innerHTML = '<option value=\"\">NO-KEY</option>' + opts;\n      sel.value = current || '';\n      sel.addEventListener('change', function(){ localStorage.setItem('panel_key', this.value); load(); });\n    } catch (e) {}\n  }\n  document.getElementById('reloadBtn').addEventListener('click', function(ev){ ev.preventDefault(); setTimeout(load, 0); });\n  (function(){\n    var form = document.querySelector('form[action=\"/panel\"]');\n    if (form) form.addEventListener('submit', function(ev){ ev.preventDefault(); load(); });\n  })();\n  document.getElementById('search').addEventListener('input', render);\n  document.getElementById('deleteSelected').addEventListener('click', async function(ev){\n    ev.preventDefault();\n    var sel = document.getElementById('keySelect');\n    var selectedKey = sel ? sel.value : '';\n    var ids = Array.from(document.querySelectorAll('.chk:checked')).map(function(c){ return c.getAttribute('data-id'); }).filter(Boolean);\n    if (!ids.length) { alert('No events selected'); return; }\n    if (!confirm('Delete ' + ids.length + ' event(s)?')) return;\n    try {\n      var res = await fetch('/api/events', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: selectedKey, ids: ids }) });\n      if (!res.ok) { alert('Delete failed: ' + (await res.text())); return; }\n      load();\n    } catch (e) { alert('Network error'); }\n  });\n  var timer = null;\n  function setAutoRefresh(on){\n    if (timer) { clearInterval(timer); timer = null; }\n    if (on) { timer = setInterval(load, 5000); }\n    document.getElementById('autoRefresh').textContent = 'Auto refresh: ' + (on ? 'on' : 'off');\n    localStorage.setItem('auto_refresh', on ? '1' : '0');\n  }\n  document.getElementById('autoRefresh').addEventListener('click', function(){\n    var current = localStorage.getItem('auto_refresh') === '1';\n    var next = !current;\n    setAutoRefresh(next);\n    if (next) load();\n  });\n  // ensure default is off on first load\n  var saved = localStorage.getItem('auto_refresh');\n  if (saved !== '1') { localStorage.setItem('auto_refresh','0'); }\n  setAutoRefresh(saved === '1');\n  populateKeys();\n  load();\n})();\n`;
}
function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}



function renderPanelExtJs(): string {
  return `"use strict";\n(function(){\n  function getSelectedIds(){ return Array.from(document.querySelectorAll('.chk:checked')).map(function(c){ return c.getAttribute('data-id'); }).filter(Boolean); }\n  function getSelectedOrAll(){ var ids = getSelectedIds(); var ev = window.__events || []; if (!ids.length) return ev; var s = new Set(ids); return ev.filter(function(e){ return s.has(e.id); }); }\n  function download(fn, content, type){ var b = new Blob([content], {type: type}); var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = fn; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1500); }\n  var btnJson = document.getElementById('exportJson'); if (btnJson) btnJson.addEventListener('click', function(){ try { var list = getSelectedOrAll(); download('events.json', JSON.stringify(list, null, 2), 'application/json'); } catch(_) {} });\n  var btnCsv = document.getElementById('exportCsv'); if (btnCsv) btnCsv.addEventListener('click', function(){ try { var list = getSelectedOrAll(); var header = ['id','receivedAt','keyValues']; var rows = list.map(function(e){ var kv = Object.entries(e.body || {}).map(function(pair){ return pair[0] + '=' + String(pair[1]).replaceAll('\\n',' '); }).join('; '); return [e.id, e.receivedAt, '"' + kv.replaceAll('"','""') + '"']; }); var csv = [header.join(',')].concat(rows.map(function(r){ return r.join(','); })).join('\\n'); download('events.csv', csv, 'text/csv'); } catch(_) {} });\n  try { var saved = localStorage.getItem('theme') || 'dark'; if (saved === 'light') document.body.classList.add('theme-light'); } catch (_) {}\n  var tbtn = document.getElementById('themeToggle'); if (tbtn) tbtn.addEventListener('click', function(){ document.body.classList.toggle('theme-light'); try { localStorage.setItem('theme', document.body.classList.contains('theme-light') ? 'light' : 'dark'); } catch(_) {} });\n})();\n`;
}
