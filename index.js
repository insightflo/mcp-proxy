// Remote MCP Server for Claude.ai (Tools Fix)
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

// 디버깅: 요청 내용 자세히 보기
app.use((req, res, next) => {
  if (req.path === "/" || req.path === "/favicon.ico") return next();
  if (req.path === "/sse" && req.method === "POST") {
    const bodySnippet = JSON.stringify(req.body).substring(0, 150);
    console.log(`[HTTP] POST /sse Payload: ${bodySnippet}...`);
  } else {
    console.log(`[HTTP] ${req.method} ${req.path}`);
  }
  next();
});

// ========== 세션 및 설정 ==========
// sessions: Map<sessionId, { res, connectedAt }>
const sessions = new Map();
// pendingRequests: Map<requestId, sessionId>
const pendingRequests = new Map();

const N8N_MCP_URL = process.env.N8N_MCP_URL;
const N8N_API_KEY = process.env.N8N_API_KEY || "";

// ========== n8n 연결 관리 (Promise Singleton Pattern) ==========
let n8nGlobalSession = null;
let n8nConnectionPromise = null;

async function ensureN8nGlobalConnection() {
  if (n8nGlobalSession) return n8nGlobalSession;
  if (n8nConnectionPromise) return n8nConnectionPromise;

  n8nConnectionPromise = (async () => {
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

      // Endpoint 찾기
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
      console.log(`[n8n] Endpoint Found: ${sessionUrl}`);

      // Initialize N8N Session
      await fetch(sessionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
        body: JSON.stringify({
          jsonrpc: "2.0", id: crypto.randomUUID(), method: "initialize",
          params: { protocolVersion: "2024-11-05", clientInfo: { name: "Proxy", version: "1.0" }, capabilities: {} }
        })
      });

      // Background Listener
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
                    // 결과가 오면 누가 요청했는지 찾아서 SSE로 전송
                    const sessionId = pendingRequests.get(msg.id);
                    if (sessionId) {
                      const session = sessions.get(sessionId);
                      if (session && session.res) {
                        sendSSE(session.res, 'message', JSON.stringify(msg));
                        console.log(`[Relay] Response for ID ${msg.id} sent to session ${sessionId}`);
                      }
                      pendingRequests.delete(msg.id);
                    } else {
                      // ID를 못 찾으면 브로드캐스트 (fallback)
                      // console.log(`[Relay] No session for ID ${msg.id}, broadcasting...`);
                      // broadcastToAll(msg);
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
          n8nConnectionPromise = null;
        }
      })();

      n8nGlobalSession = { sessionUrl, controller };
      return n8nGlobalSession;

    } catch (error) {
      console.error("[n8n] Connection Fatal Error:", error);
      n8nGlobalSession = null;
      throw error;
    } finally {
      n8nConnectionPromise = null; 
    }
  })();

  return n8nConnectionPromise;
}

function sendSSE(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.write(`data: ${payload}\n\n`);
}

// ========== Auth0 Metadata ==========
const AUTH0_METADATA = {
  issuer: `https://${process.env.AUTH0_DOMAIN}/`,
  authorization_endpoint: `https://${process.env.AUTH0_DOMAIN}/authorize`,
  token_endpoint: `https://${process.env.AUTH0_DOMAIN}/oauth/token`,
  registration_endpoint: `https://${process.env.AUTH0_DOMAIN}/oidc/register`,
  jwks_uri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`
};
const RESOURCE_METADATA = {
  resource: process.env.AUTH0_AUDIENCE,
  authorization_servers: [`https://${process.env.AUTH0_DOMAIN}/`]
};

app.get("/.well-known/oauth-authorization-server", (req, res) => res.json(AUTH0_METADATA));
app.get("/.well-known/oauth-protected-resource", (req, res) => res.json(RESOURCE_METADATA));
app.get("/.well-known/oauth-authorization-server/sse", (req, res) => res.json(AUTH0_METADATA));
app.get("/.well-known/oauth-protected-resource/sse", (req, res) => res.json(RESOURCE_METADATA));

// ========== Routes ==========

// [핵심 수정] POST /sse 핸들러
app.post("/sse", async (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Bearer ")) console.log("[POST/sse] No Token provided (Ignoring)");

  // 1. Initialize 요청: 즉시 응답 (Handshake)
  if (req.body && req.body.method === "initialize") {
    console.log("[POST/sse] Handling Initialization");
    return res.json({
      jsonrpc: "2.0",
      id: req.body.id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "Stock Analysis MCP", version: "1.0.0" },
        capabilities: { tools: {} }
      }
    });
  }

  // 2. 그 외 요청 (tools/list 등): n8n으로 전달하고 "기다려(202)" 응답
  if (req.body && req.body.method) {
    try {
      const n8n = await ensureN8nGlobalConnection();
      if (!n8n || !n8n.sessionUrl) throw new Error("n8n connection unavailable");

      // [중요] 이 요청의 응답을 받을 SSE 세션을 찾아야 함
      // POST /sse는 Stateless라서 세션 ID가 없음. 
      // 해결책: 가장 최근에 생성된(가장 마지막) SSE 세션을 주인으로 가정 (단일 사용자 환경에서 유효)
      const lastSessionId = Array.from(sessions.keys()).pop();
      
      if (lastSessionId) {
        pendingRequests.set(req.body.id, lastSessionId);
        console.log(`[POST/sse] Relaying ${req.body.method} (linked to session ${lastSessionId})`);
      } else {
        console.warn(`[POST/sse] Warning: No active SSE session found to return result`);
      }
      
      await fetch(n8n.sessionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
        body: JSON.stringify(req.body)
      });
      
      // [수정] 빈 JSON 객체를 주는 대신 202 Accepted를 주어 SSE로 답이 올 때까지 기다리게 함
      return res.status(202).end();

    } catch(e) {
      console.error(`[POST/sse Error] ${e.message}`);
      return res.status(500).json({ error: { code: -32603, message: "Internal Proxy Error" } });
    }
  }

  return res.status(200).send("OK");
});

// SSE Connection (GET)
app.get("/sse", (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.write(": welcome\n\n");

  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { connectedAt: Date.now(), res: res });
  console.log(`[SSE] Session Created: ${sessionId}`);

  sendSSE(res, 'endpoint', `/session/${sessionId}`);

  const pinger = setInterval(() => res.write(": ping\n\n"), 15000);

  req.on('close', () => {
    console.log(`[SSE] Closed: ${sessionId}`);
    clearInterval(pinger);
    sessions.delete(sessionId);
  });
});

// JSON-RPC via Session URL
app.post("/session/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  try {
    const n8n = await ensureN8nGlobalConnection();
    pendingRequests.set(req.body.id, sessionId);

    if (!n8n || !n8n.sessionUrl) throw new Error("Backend unavailable");

    const response = await fetch(n8n.sessionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) throw new Error("Backend error");
    res.status(202).end();

  } catch (error) {
    console.error(`[RPC Error]`, error);
    res.status(500).json({ error: error.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${port}`);
});