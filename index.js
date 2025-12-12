// Remote MCP Server for Claude.ai (Universal Handler)
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
  if (req.path === "/sse" && req.method === "POST") {
    // POST /sse 요청의 Body를 로그에 찍어서 확인
    const bodySnippet = JSON.stringify(req.body).substring(0, 100);
    console.log(`[HTTP] POST /sse Payload: ${bodySnippet}...`);
  } else if (req.path !== "/" && req.path !== "/favicon.ico") {
    console.log(`[HTTP] ${req.method} ${req.path}`);
  }
  next();
});

// ========== 세션 및 설정 ==========
const sessions = new Map();
const pendingRequests = new Map();
const N8N_MCP_URL = process.env.N8N_MCP_URL;
const N8N_API_KEY = process.env.N8N_API_KEY || "";

// ========== n8n 연결 관리 ==========
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
    console.log(`[n8n] Endpoint: ${sessionUrl}`);

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
                    // SSE 세션이면 SSE로 전송
                    if (session && session.type === 'sse' && session.res) {
                      sendSSE(session.res, 'message', JSON.stringify(msg));
                    }
                    // HTTP POST 대기중이면 여기서 처리 불가 (비동기라 구조상 복잡)
                    // 현재 구조는 SSE 중심이므로 HTTP Polling은 지원 안함, 
                    // 단 Initialize는 즉시 응답 가능
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

function sendSSE(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.write(`data: ${payload}\n\n`);
}

// ========== Routes ==========

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

// [핵심 수정] POST /sse 핸들러를 똑똑하게 변경
app.post("/sse", async (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  
  // 1. 토큰 체크 (로그만 남기고 통과시킴, 차단하지 않음)
  if (!authHeader.startsWith("Bearer ")) {
    console.log("[POST/sse] No Token provided");
  }

  // 2. 만약 Claude가 "initialize"를 POST로 보냈다면? (이게 문제의 핵심)
  if (req.body && req.body.method === "initialize") {
    console.log("[POST/sse] Handling Initialization Request");
    return res.json({
      jsonrpc: "2.0",
      id: req.body.id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: {
          name: "Stock Analysis MCP",
          version: "1.0.0"
        },
        capabilities: {
          tools: {} // 여기서는 빈 값, 나중에 tools/list로 가져감
        }
      }
    });
  }

  // 3. 그 외의 요청(tools/list 등)이면 n8n으로 전달 시도
  if (req.body && req.body.method) {
    try {
      const n8n = await ensureN8nGlobalConnection();
      // 임시 ID로 요청
      const tempId = crypto.randomUUID();
      // 여기서는 응답을 기다리기 힘드므로 200 OK만 주고 끝냄 (MCP HTTP 스펙의 한계)
      // 하지만 initialize만 통과하면 연결됨으로 뜰 확률이 높음
      console.log(`[POST/sse] Relaying ${req.body.method} to n8n (Blind)`);
      
      await fetch(n8n.sessionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
        body: JSON.stringify(req.body)
      });
      
      return res.json({ jsonrpc: "2.0", id: req.body.id, result: {} }); // Dummy success
    } catch(e) {
      console.error(e);
    }
  }

  // 4. 아무것도 해당 안되면 그냥 OK
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
  console.log(`[RPC] ${method} (${sessionId})`);

  try {
    const n8n = await ensureN8nGlobalConnection();
    pendingRequests.set(id, sessionId);

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

app.get("/", (req, res) => res.send("Auth0 MCP Proxy Active"));

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${port}`);
});