// Remote MCP Server for Claude.ai (Stable Connection Fix)
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
  // 헬스체크 등은 로그 제외
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
const sessions = new Map();
const pendingRequests = new Map();
const N8N_MCP_URL = process.env.N8N_MCP_URL;
const N8N_API_KEY = process.env.N8N_API_KEY || "";

// ========== n8n 연결 관리 (Promise Singleton Pattern) ==========
let n8nGlobalSession = null;
let n8nConnectionPromise = null; // 연결 작업 자체를 저장

async function ensureN8nGlobalConnection() {
  // 1. 이미 연결되어 있으면 즉시 반환
  if (n8nGlobalSession) return n8nGlobalSession;

  // 2. 현재 연결을 시도 중이라면, 그 작업이 끝날 때까지 기다림 (중복 연결 방지)
  if (n8nConnectionPromise) {
    // console.log("[n8n] Waiting for existing connection attempt...");
    return n8nConnectionPromise;
  }

  // 3. 연결 시작 및 Promise 저장
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
                    const sessionId = pendingRequests.get(msg.id);
                    if (sessionId) {
                      const session = sessions.get(sessionId);
                      if (session && session.type === 'sse' && session.res) {
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
          n8nConnectionPromise = null;
        }
      })();

      // 세션 객체 생성 및 반환
      n8nGlobalSession = { sessionUrl, controller };
      return n8nGlobalSession;

    } catch (error) {
      console.error("[n8n] Connection Fatal Error:", error);
      n8nGlobalSession = null;
      throw error;
    } finally {
      // 연결 시도가 끝나면 Promise 초기화 (성공했으면 n8nGlobalSession이 있으므로 괜찮음)
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

// POST /sse 핸들러 (Claude의 요청 처리)
app.post("/sse", async (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  
  if (!authHeader.startsWith("Bearer ")) {
    console.log("[POST/sse] No Token provided (Ignoring)");
  }

  // 1. Initialize 요청 처리 (n8n 연결 없이 즉시 응답)
  if (req.body && req.body.method === "initialize") {
    console.log("[POST/sse] Handling Initialization Request");
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

  // 2. 그 외 요청 (n8n으로 전달)
  if (req.body && req.body.method) {
    try {
      const n8n = await ensureN8nGlobalConnection();
      
      // [중요] 연결 실패 시 방어 코드
      if (!n8n || !n8n.sessionUrl) {
        throw new Error("n8n connection unavailable");
      }

      console.log(`[POST/sse] Relaying ${req.body.method} to n8n`);
      
      await fetch(n8n.sessionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
        body: JSON.stringify(req.body)
      });
      
      // 알림(notification)은 응답이 없으므로 빈값, 요청은 나중에 SSE로 옴
      return res.json({ jsonrpc: "2.0", id: req.body.id, result: {} }); 
    } catch(e) {
      console.error(`[POST/sse Error] ${e.message}`);
      // Claude에게 에러라고 알려줌
      return res.status(500).json({ 
        jsonrpc: "2.0", 
        id: req.body.id, 
        error: { code: -32603, message: "Internal Proxy Error" } 
      });
    }
  }

  return res.status(200).send("OK");
});

// SSE Connection (GET)
app.get("/sse", (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Bearer ")) {
    console.log("[SSE] Failed: No Token");
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log("[SSE] Connection Started");

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.write(": welcome\n\n");

  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { type: 'sse', connectedAt: Date.now(), res: res });
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

  const { id, method } = req.body;
  // console.log(`[RPC] ${method} (${sessionId})`);

  try {
    const n8n = await ensureN8nGlobalConnection();
    pendingRequests.set(id, sessionId);

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