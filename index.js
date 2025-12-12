// Remote MCP Server for Claude.ai (Final Fix)
const isRailway = !!process.env.RAILWAY_ENVIRONMENT;
if (!isRailway) {
  try {
    require("dotenv").config({ path: ".env.local" });
  } catch (e) {}
}

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(cors());

// ========== 세션 저장소 ==========
const sessions = new Map();
const pendingRequests = new Map();

// ========== n8n 설정 ==========
const N8N_MCP_URL = process.env.N8N_MCP_URL;
const N8N_API_KEY = process.env.N8N_API_KEY || "";

// ========== n8n Global Connection (Stateless) ==========
let n8nGlobalSession = null;
let n8nConnecting = false;

async function ensureN8nGlobalConnection() {
  if (n8nGlobalSession) return n8nGlobalSession;
  if (n8nConnecting) {
    await new Promise(resolve => setTimeout(resolve, 500));
    return n8nGlobalSession;
  }

  n8nConnecting = true;
  console.log(`[n8n] Connecting to Backend...`);

  try {
    const controller = new AbortController();
    const response = await fetch(N8N_MCP_URL, {
      method: "GET",
      headers: {
        "Accept": "text/event-stream",
        "Cache-Control": "no-cache",
        ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {})
      },
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`n8n connection failed: ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sessionUrl = null;

    // 1. Find Endpoint
    while (!sessionUrl) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.trim().startsWith("event: endpoint")) {
          const dataLine = lines.find(l => l.trim().startsWith("data: "));
          if (dataLine) {
            const relativePath = dataLine.replace("data: ", "").trim();
            sessionUrl = new URL(relativePath, N8N_MCP_URL).toString();
          }
        }
      }
    }

    if (!sessionUrl) throw new Error("Could not find n8n endpoint");
    console.log(`[n8n] Endpoint: ${sessionUrl}`);

    // 2. Initialize
    await fetch(sessionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
      body: JSON.stringify({
        jsonrpc: "2.0", id: crypto.randomUUID(), method: "initialize",
        params: { protocolVersion: "2024-11-05", clientInfo: { name: "Proxy", version: "1.0" }, capabilities: {} }
      })
    });

    // 3. Listener
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");
          
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ")) {
              const jsonStr = trimmed.replace("data: ", "").trim();
              if (jsonStr && jsonStr !== "[DONE]") {
                try {
                  const msg = JSON.parse(jsonStr);
                  const sessionId = pendingRequests.get(msg.id);
                  if (sessionId) {
                    const session = sessions.get(sessionId);
                    if (session && session.res) {
                      // 메시지는 객체이므로 stringify 해서 보냄
                      sendSSE(session.res, 'message', JSON.stringify(msg));
                    }
                    pendingRequests.delete(msg.id);
                  }
                } catch (e) {}
              }
            }
          }
        }
      } catch (e) {
        console.error("[n8n] Stream error:", e);
      } finally {
        n8nGlobalSession = null;
      }
    })();

    n8nGlobalSession = { sessionUrl, controller };
    return n8nGlobalSession;

  } catch (error) {
    console.error("[n8n] Error:", error);
    n8nConnecting = false;
    throw error;
  } finally {
    n8nConnecting = false;
  }
}

// ========== SSE Helper (수정됨) ==========
function sendSSE(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  // 데이터가 이미 문자열이면 그대로, 객체면 stringify
  // endpoint 이벤트일 때 따옴표가 중복되는 것을 방지
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.write(`data: ${payload}\n\n`);
}

// ========== Routes ==========
app.get("/", (req, res) => res.send("Auth0 MCP Proxy"));

// Auth0 Endpoints
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer: `https://${process.env.AUTH0_DOMAIN}/`,
    authorization_endpoint: `https://${process.env.AUTH0_DOMAIN}/authorize`,
    token_endpoint: `https://${process.env.AUTH0_DOMAIN}/oauth/token`,
    registration_endpoint: `https://${process.env.AUTH0_DOMAIN}/oidc/register`,
    jwks_uri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`
  });
});

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    resource: process.env.AUTH0_AUDIENCE,
    authorization_servers: [`https://${process.env.AUTH0_DOMAIN}/`]
  });
});

// SSE Connection
// GET과 POST 모두 처리 (POST /sse 404 방지)
app.all("/sse", (req, res) => {
  if (req.method !== 'GET') {
    // Claude가 간혹 POST로 찔러볼 때가 있음. 200 OK 주고 끝냄.
    return res.status(200).send("OK");
  }

  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Bearer ")) {
    console.log("[Auth] Missing Token");
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log("[Auth] Token Accepted");

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.write(": welcome\n\n");

  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { connectedAt: Date.now(), res: res });
  console.log(`[SSE] Session: ${sessionId}`);

  // [중요 수정] JSON.stringify 없이 생 문자열로 보냄
  // 결과: data: /session/uuid
  sendSSE(res, 'endpoint', `/session/${sessionId}`);

  const pinger = setInterval(() => res.write(": ping\n\n"), 15000);

  req.on('close', () => {
    console.log(`[SSE] Closed: ${sessionId}`);
    clearInterval(pinger);
    sessions.delete(sessionId);
  });
});

// JSON-RPC Handling
app.post("/session/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    console.log(`[RPC] Session Not Found: ${sessionId}`);
    return res.status(404).json({ error: "Session not found" });
  }

  const { id, method } = req.body;
  console.log(`[RPC] ${method} (${sessionId})`);

  try {
    const n8n = await ensureN8nGlobalConnection();
    pendingRequests.set(id, sessionId);

    const response = await fetch(n8n.sessionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) throw new Error("n8n relay failed");
    res.status(202).end();

  } catch (error) {
    console.error(`[RPC Error]`, error);
    res.status(500).json({ error: error.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Proxy running on port ${port}`);
});