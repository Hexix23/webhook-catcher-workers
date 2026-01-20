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
import panelCss from "./panel.css";
import panelJs from "./panel.client.js";
import panelExtJs from "./panel-ext.client.js";

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
      return new Response(panelJs, {
        status: 200,
        headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    if (pathname === "/panel-ext.js" && request.method === "GET") {
      return new Response(panelExtJs, {
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
    <style>${panelCss}</style>
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
          <button type="button" id="exportJson" class="secondary">JSON</button>
          <button type="button" id="exportCsv" class="secondary">CSV</button>
          <button type="button" id="themeToggle" title="Toggle theme" class="secondary">🌗</button>
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
          <button type="button" id="selectAll" class="secondary" title="Select all visible events">Select All</button>
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


function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
