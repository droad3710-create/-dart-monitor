// Stateless MCP server (Streamable HTTP transport, JSON responses) for OpenDART.
// Endpoint: POST /mcp/<MCP_TOKEN>

import { TOOLS, callTool } from "./tools.js";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "dart-mcp", title: "DART 전자공시", version: "1.0.0" };
const INSTRUCTIONS =
  "금융감독원 DART(OpenDART) 전자공시 조회 도구. 회사명만 알면 search_disclosures·get_company_info·get_financials에 company로 넘기면 된다. " +
  "공시 내용을 말할 때는 get_disclosure_text로 원문을 확인하고 접수번호와 DART 링크를 근거로 밝힌다. 날짜는 한국 시간 YYYYMMDD.";

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleMessage(env, msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return msg && "id" in msg ? rpcError(msg.id, -32600, "Invalid Request") : null;
  }
  const isNotification = !("id" in msg);
  if (isNotification) return null;
  const { id, method, params = {} } = msg;
  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      if (!TOOLS.some((t) => t.name === params.name)) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      return { jsonrpc: "2.0", id, result: await callTool(env, params.name, params.arguments) };
    }
    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return new Response("ok");

    const match = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
    if (!match) return new Response("Not found", { status: 404 });
    if (!env.MCP_TOKEN || !env.DART_API_KEY) return new Response("Server not configured", { status: 500 });
    if (!safeEqual(match[1], env.MCP_TOKEN)) return new Response("Not found", { status: 404 });

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }

    if (Array.isArray(body)) {
      const replies = (await Promise.all(body.map((m) => handleMessage(env, m)))).filter(Boolean);
      return replies.length ? json(replies) : new Response(null, { status: 202 });
    }
    const reply = await handleMessage(env, body);
    return reply ? json(reply) : new Response(null, { status: 202 });
  },
};
