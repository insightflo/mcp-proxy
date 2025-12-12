// Remote MCP Server for Claude.ai (OAuth Only)
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
// sessionId -> { userId, tools, lastActivity, res (SSE 응답 객체) }
const sessions = new Map();

// ========== n8n 설정 ==========
const N8N_MCP_URL = process.env.N8N_MCP_URL;
const N8N_API_KEY = process.env.N8N_API_KEY || "";

// n8n 연결/도구 관리는 요청 시점에 처리 (Stateless)
// 대기중인 요청 매핑 (id -> sessionId)
const pendingRequests = new Map();

// ========== n8n 세션 관리 (SSE Listener) ==========
// 하나의 n8n SSE 연결을 유지하며 모든 세션의 응답을 중계
let n8nGlobalSession = null;
let n8nConnecting = false;

async function ensureN8nGlobalConnection() {
  if (n8nGlobalSession) return n8nGlobalSession;
  if (n8nConnecting) {
    // 연결 중이면 잠시 대기
    await new Promise(resolve => setTimeout(resolve, 500));
    return n8nGlobalSession;
  }

  n8nConnecting = true;
  console.log(`[n8n] Connecting to Backend: ${N8N_MCP_URL}`);

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

    // 1. Endpoint 찾기
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

    console.log(`[n8n] Endpoint found: ${sessionUrl}`);

    // 2. Initialize handshake
    await fetch(sessionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
      body: JSON.stringify({
        jsonrpc: "2.0", id: crypto.randomUUID(), method: "initialize",
        params: { protocolVersion: "2024-11-05", clientInfo: { name: "Proxy", version: "1.0" }, capabilities: {} }
      })
    });

    // 3. Background Listener
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
                  // ID로 요청한 세션 찾기
                  const sessionId = pendingRequests.get(msg.id);
                  if (sessionId) {
                    const session = sessions.get(sessionId);
                    if (session && session.res) {
                      sendSSE(session.res, 'message', msg);
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
        n8nGlobalSession = null; // 재연결을 위해 초기화
      }
    })();

    n8nGlobalSession = { sessionUrl, controller };
    return n8nGlobalSession;

  } catch (error) {
    console.error("[n8n] Connection Fatal Error:", error);
    n8nConnecting = false;
    throw error;
  } finally {
    n8nConnecting = false;
  }
}

// ========== SSE Helper ==========
function sendSSE(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  // 버퍼링 방지를 위한 즉시 플러시 (Node.js 기본 동작이지만 명시적으로 처리됨)
}

// ========== Routes ==========

app.get("/", (req, res) => res.send("Auth0 MCP Proxy Active"));

// Auth0 Configuration
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

// SSE Connection (Claude connects here)
app.get("/sse", (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  
  // 1. OAuth 토큰 확인 (간이 검증: 있음/없음만 체크)
  // 실제 검증은 나중에 DB 연동 시 추가 (jwt-decode 등으로 subject 확인 가능)
  if (!authHeader.startsWith("Bearer ")) {
    console.log("[Auth] No token provided");
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log("[Auth] OAuth token accepted");

  // 2. SSE 헤더 설정 (중요: 버퍼링 끄기)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // Nginx 버퍼링 해제
  });

  // 3. 연결 즉시 데이터 전송 (연결 끊김 방지용)
  res.write(": welcome\n\n"); 

  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    connectedAt: Date.now(),
    res: res
  });

  console.log(`[SSE] New Session: ${sessionId}`);

  // 4. Endpoint 알려주기
  sendSSE(res, 'endpoint', `/session/${sessionId}`);

  // 5. Keep-Alive Ping (30초 -> 15초로 단축)
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

  if (!session) return res.status(404).json({ error: "Session not found" });

  const { id, method, params } = req.body;
  console.log(`[RPC] ${method} (Session: ${sessionId})`);

  try {
    // n8n 연결 확인
    const n8n = await ensureN8nGlobalConnection();
    
    // 이 요청 ID가 어떤 세션에서 왔는지 기록 (응답 라우팅용)
    pendingRequests.set(id, sessionId);

    // n8n으로 요청 전달
    const response = await fetch(n8n.sessionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) throw new Error("n8n relay failed");
    
    // HTTP 응답은 202 Accepted (결과는 SSE로 감)
    res.status(202).end();

  } catch (error) {
    console.error(`[RPC Error]`, error);
    res.status(500).json({ error: error.message });
    // 에러 발생 시 SSE로도 에러 전달
    if(session.res) {
      sendSSE(session.res, 'message', {
        jsonrpc: "2.0", id, error: { code: -32603, message: "Internal Error" }
      });
    }
  }
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Auth0 MCP Proxy running on port ${port}`);
});