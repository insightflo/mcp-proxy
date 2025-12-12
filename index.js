// Remote MCP Server for Claude.ai (Sync Bridge Mode)
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

// 디버깅: 요청 내용 로깅
app.use((req, res, next) => {
  if (req.path === "/" || req.path === "/favicon.ico") return next();
  if (req.path === "/sse" && req.method === "POST") {
    // 본문 내용은 너무 길면 자름
    const bodySnippet = JSON.stringify(req.body).substring(0, 100);
    console.log(`[HTTP] POST /sse Payload: ${bodySnippet}...`);
  } else {
    console.log(`[HTTP] ${req.method} ${req.path}`);
  }
  next();
});

// ========== 설정 ==========
const N8N_MCP_URL = process.env.N8N_MCP_URL;
const N8N_API_KEY = process.env.N8N_API_KEY || "";

// ========== 동기화 브릿지 (Sync Bridge) ==========
// 요청 ID -> Promise Resolver 맵핑
// n8n에서 응답이 오면 이 맵에서 찾아서 HTTP 응답을 즉시 보냄
const responseWaiters = new Map();

// ========== n8n 연결 관리 (Promise Singleton) ==========
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

      // Background Listener (브릿지 핵심)
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
                    
                    // [핵심] 기다리고 있는 HTTP 요청이 있는지 확인
                    if (msg.id && responseWaiters.has(msg.id)) {
                      const resolve = responseWaiters.get(msg.id);
                      resolve(msg); // 약속 이행! (HTTP 응답 발송)
                      responseWaiters.delete(msg.id);
                      console.log(`[Bridge] Matched response for ID ${msg.id}`);
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

// [최종 수정] HTTP POST 핸들러 (동기식 대기 모드)
app.post("/sse", async (req, res) => {
  // 토큰 로그만 찍고 넘어감 (Claude가 안 보내는 경우가 많아서 강제하면 안됨)
  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Bearer ")) {
    // console.log("[POST/sse] No Token provided (Proceeding anyway)");
  }

  // 1. Initialize 요청: 즉시 응답
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

  // 2. 알림(Notifications): 응답 기다릴 필요 없음
  if (req.body && req.body.method && req.body.method.startsWith("notifications/")) {
     // n8n으로 쏘고 잊어버림
     ensureN8nGlobalConnection().then(n8n => {
        if(n8n && n8n.sessionUrl) {
            fetch(n8n.sessionUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
                body: JSON.stringify(req.body)
            }).catch(e => console.error(e));
        }
     });
     return res.status(200).send("OK");
  }

  // 3. 도구 실행/목록 (tools/list, tools/call) -> 응답을 기다려야 함!
  if (req.body && req.body.id) {
    try {
      const n8n = await ensureN8nGlobalConnection();
      if (!n8n || !n8n.sessionUrl) throw new Error("n8n connection unavailable");

      console.log(`[Bridge] Relaying ${req.body.method} (ID: ${req.body.id}) - Waiting for response...`);

      // n8n에 요청 전송
      await fetch(n8n.sessionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
        body: JSON.stringify(req.body)
      });

      // [핵심] n8n이 답을 줄 때까지 Promise로 기다림 (최대 25초 타임아웃)
      const n8nResponse = await new Promise((resolve, reject) => {
        // 대기열에 등록
        responseWaiters.set(req.body.id, resolve);
        
        // 타임아웃 설정 (Railway/Claude 타임아웃 방지)
        setTimeout(() => {
          if (responseWaiters.has(req.body.id)) {
            responseWaiters.delete(req.body.id);
            reject(new Error("Timeout waiting for n8n response"));
          }
        }, 25000); // 25초
      });

      // 답이 오면 바로 JSON으로 반환! (이게 Claude가 원하는 것)
      return res.json(n8nResponse);

    } catch(e) {
      console.error(`[Bridge Error] ${e.message}`);
      return res.status(500).json({ 
        jsonrpc: "2.0", 
        id: req.body.id, 
        error: { code: -32603, message: e.message || "Internal Proxy Error" } 
      });
    }
  }

  return res.status(200).send("OK");
});

// SSE Connection (GET) - 혹시 모르니 살려두지만, 필수는 아님
app.get("/sse", (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(": welcome\n\n");
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on('close', () => clearInterval(keepAlive));
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${port}`);
});