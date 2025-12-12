// Remote MCP Server for Claude.ai (Robust Parser)
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

// 디버깅: 요청 로깅
app.use((req, res, next) => {
  if (req.path === "/" || req.path === "/favicon.ico") return next();
  if (req.path === "/sse" && req.method === "POST") {
    const bodySnippet = JSON.stringify(req.body).substring(0, 100);
    console.log(`[HTTP] POST /sse Payload: ${bodySnippet}...`);
  } else {
    console.log(`[HTTP] ${req.method} ${req.path}`);
  }
  next();
});

const N8N_MCP_URL = process.env.N8N_MCP_URL;
const N8N_API_KEY = process.env.N8N_API_KEY || "";
const responseWaiters = new Map();

// ========== n8n 연결 관리 ==========
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

      // 1. Endpoint 찾기 (초기 핸드셰이크)
      while (!sessionUrl) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop(); // 마지막 불완전한 라인 보관

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

      // Initialize Call (내부적으로 세션 활성화)
      await fetch(sessionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
        body: JSON.stringify({
          jsonrpc: "2.0", id: crypto.randomUUID(), method: "initialize",
          params: { protocolVersion: "2024-11-05", clientInfo: { name: "Proxy", version: "1.0" }, capabilities: {} }
        })
      });

      // 2. 강력해진 스트림 리스너 (백그라운드)
      (async () => {
        let currentEventData = ""; // 여러 줄의 data를 합칠 변수
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            
            // [디버깅] 들어오는 데이터가 뭔지 살짝 보기 (너무 길면 자름)
            // console.log(`[Stream Chunk] ${chunk.length} bytes received`);

            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop(); // 다음 청크를 위해 마지막 조각 보관

            for (const line of lines) {
              const trimmed = line.trim();

              // SSE 이벤트 처리 로직 개선
              if (trimmed.startsWith("data: ")) {
                // 'data: ' 접두사 제거하고 내용만 누적
                currentEventData += line.substring(6); 
              } else if (trimmed === "") {
                // 빈 줄(\n\n)은 이벤트의 끝을 의미 -> 파싱 시도
                if (currentEventData) {
                  if (currentEventData !== "[DONE]") {
                    try {
                      const msg = JSON.parse(currentEventData);
                      
                      // 기다리던 요청인지 확인
                      if (msg.id && responseWaiters.has(msg.id)) {
                        console.log(`[Bridge] ✅ Matched response for ID ${msg.id}`);
                        const resolve = responseWaiters.get(msg.id);
                        resolve(msg);
                        responseWaiters.delete(msg.id);
                      } else {
                        // console.log(`[Stream] Ignored message ID: ${msg.id}`);
                      }
                    } catch (e) {
                      console.error(`[Parse Error] Failed to parse JSON: ${e.message}`);
                      // console.error(`Bad Data: ${currentEventData.substring(0, 100)}...`);
                    }
                  }
                  currentEventData = ""; // 초기화
                }
              }
              // event: ... 라인은 무시해도 됨 (data만 중요)
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
// [수정] POST 요청 처리 (Auth0 토큰 OR 간단한 키 인증)
app.post("/sse", async (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  // Token check logging only

  // // Gemini 용 비번 
  // const apiKey = req.query.key; // URL 뒤에 ?key=... 로 들어오는 값 확인
  // const MY_SECRET_KEY = process.env.MCP_SECRET_KEY; // Railway 변수에 설정할 비번

  // // 1. 보안 검사: 토큰도 없고, 비밀키도 틀리면 차단
  // const isAuth0 = authHeader.startsWith("Bearer ");
  // const isKeyValid = MY_SECRET_KEY && apiKey === MY_SECRET_KEY;

  // if (!isAuth0 && !isKeyValid) {
  //   console.log("[Auth] Blocked: No valid token or key");
  //   return res.status(401).json({ error: "Unauthorized" });
  // }

  // 2. Initialize 요청: 즉시 응답
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

  // 2. 알림(Notifications): 비동기 처리
  if (req.body && req.body.method && req.body.method.startsWith("notifications/")) {
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

  // 3. 도구 실행/목록: 응답 대기 (Sync Bridge)
  if (req.body && req.body.id) {
    try {
      const n8n = await ensureN8nGlobalConnection();
      if (!n8n || !n8n.sessionUrl) throw new Error("n8n connection unavailable");

      console.log(`[Bridge] Relaying ${req.body.method} (ID: ${req.body.id}) - Waiting...`);

      // n8n 전송
      await fetch(n8n.sessionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
        body: JSON.stringify(req.body)
      });

      // 응답 대기 (30초 타임아웃)
      const n8nResponse = await new Promise((resolve, reject) => {
        responseWaiters.set(req.body.id, resolve);
        setTimeout(() => {
          if (responseWaiters.has(req.body.id)) {
            responseWaiters.delete(req.body.id);
            reject(new Error("Timeout waiting for n8n response"));
          }
        }, 30000);
      });

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


// [NEW] ChatGPT GPTs용 전용 엔드포인트 (REST API)
app.post("/gpt/execute", async (req, res) => {
  // 1. ChatGPT는 toolName과 arguments를 JSON으로 보냄
  const { toolName, arguments: args } = req.body;
  
  // 인증 체크 (Auth0 토큰이 헤더로 들어옴)
  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log(`[GPT] Request: ${toolName}`);

  try {
    // 2. n8n 연결 확인
    const n8n = await ensureN8nGlobalConnection();
    if (!n8n || !n8n.sessionUrl) throw new Error("n8n connection unavailable");

    // 3. MCP JSON-RPC 포맷으로 변환 ("통역")
    const rpcId = crypto.randomUUID();
    const payload = {
      jsonrpc: "2.0",
      id: rpcId,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args || {}
      }
    };

    // 4. n8n에 전송
    await fetch(n8n.sessionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
      body: JSON.stringify(payload)
    });

    // 5. 답이 올 때까지 기다림 (Sync Bridge 재사용)
    const n8nResponse = await new Promise((resolve, reject) => {
      responseWaiters.set(rpcId, resolve);
      setTimeout(() => {
        if (responseWaiters.has(rpcId)) {
          responseWaiters.delete(rpcId);
          reject(new Error("Timeout"));
        }
      }, 30000);
    });

    // 6. 결과 반환 (ChatGPT가 이해하기 쉽게 content만 추출)
    if (n8nResponse.result && n8nResponse.result.content) {
        // 텍스트 결과만 깔끔하게 보냄
        const textContent = n8nResponse.result.content.map(c => c.text).join("\n");
        return res.json({ result: textContent });
    } else {
        return res.json({ result: JSON.stringify(n8nResponse) });
    }

  } catch (e) {
    console.error(`[GPT Error] ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

// ... app.listen ...

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${port}`);
});