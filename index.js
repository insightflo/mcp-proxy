// Remote MCP Server for Claude.ai (Multi-User Support)
const isRailway = !!process.env.RAILWAY_ENVIRONMENT;
if (!isRailway) {
  try {
    require("dotenv").config({ path: ".env.local" });
  } catch (e) {}
}

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { fetch } = require("undici"); // Node 18+ 내장 fetch 대신 안정적인 스트림 처리를 위해 권장되지만, 없으면 내장 사용

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// 디버깅: 요청 로깅
app.use((req, res, next) => {
  if (req.path === "/" || req.path === "/favicon.ico") return next();
  if (req.path.includes("/session/") || req.path === "/sse") {
    // console.log(`[HTTP] ${req.method} ${req.path}`);
  }
  next();
});

const N8N_MCP_URL = process.env.N8N_MCP_URL;
const N8N_API_KEY = process.env.N8N_API_KEY || "";

// ========== N8n Session Class (사용자별 독립 연결 관리) ==========
class N8nSession {
  constructor(sessionId, res) {
    this.sessionId = sessionId;
    this.clientRes = res; // Claude에게 응답을 보낼 SSE 스트림
    this.n8nSessionUrl = null;
    this.controller = new AbortController();
    this.responseWaiters = new Map(); // HTTP 요청(GPT/Sync) 대기열
    this.isAlive = true;

    this.connect();
  }

  async connect() {
    console.log(`[Session ${this.sessionId}] Connecting to n8n...`);
    try {
      const response = await fetch(N8N_MCP_URL, {
        method: "GET",
        headers: {
          "Accept": "text/event-stream",
          "Cache-Control": "no-cache",
          ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {})
        },
        signal: this.controller.signal,
        // 타임아웃 방지 (중요)
        headersTimeout: 60000, 
        bodyTimeout: 0 // 무제한
      });

      if (!response.ok) throw new Error(`n8n connection failed: ${response.status}`);

      // 스트림 리더 시작
      this.readStream(response.body);

    } catch (error) {
      if (this.isAlive) {
        console.error(`[Session ${this.sessionId}] Connection Error:`, error.message);
        this.close();
      }
    }
  }

  async readStream(body) {
    const reader = body.getReader(); // Node 18+ Web Streams API
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (this.isAlive) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          this.processLine(line.trim());
        }
      }
    } catch (error) {
      // AbortError는 정상 종료로 간주
      if (error.name !== 'AbortError' && this.isAlive) {
        console.error(`[Session ${this.sessionId}] Stream Read Error:`, error.message);
      }
    }
  }

  processLine(line) {
    if (!line) return;

    // 1. Endpoint 이벤트 (초기 연결 주소)
    if (line.startsWith("event: endpoint")) {
      this.expectingEndpointData = true;
    } else if (this.expectingEndpointData && line.startsWith("data: ")) {
      const relativePath = line.replace("data: ", "").trim();
      this.n8nSessionUrl = new URL(relativePath, N8N_MCP_URL).toString();
      console.log(`[Session ${this.sessionId}] Endpoint Locked: ${this.n8nSessionUrl}`);
      this.expectingEndpointData = false;
      
      // n8n 연결 즉시 초기화 핸드셰이크 전송
      this.sendToN8n({
        jsonrpc: "2.0", id: crypto.randomUUID(), method: "initialize",
        params: { protocolVersion: "2024-11-05", clientInfo: { name: "Proxy", version: "1.0" }, capabilities: {} }
      });
    }
    // 2. 일반 Data 이벤트 (응답)
    else if (line.startsWith("data: ")) {
      const jsonStr = line.replace("data: ", "").trim();
      if (jsonStr && jsonStr !== "[DONE]") {
        try {
          const msg = JSON.parse(jsonStr);
          
          // A. HTTP 동기 요청(GPT/Tools) 대기자가 있으면 그쪽으로 응답
          if (msg.id && this.responseWaiters.has(msg.id)) {
            const resolve = this.responseWaiters.get(msg.id);
            resolve(msg);
            this.responseWaiters.delete(msg.id);
            console.log(`[Session ${this.sessionId}] ✅ Sync Response matched for ID ${msg.id}`);
          } 
          // B. 아니면 Claude SSE로 전달 (SSE 모드)
          else if (this.clientRes) {
             this.sendSSEToClient('message', msg);
          }
        } catch (e) {
          // console.error("Parse error", e);
        }
      }
    }
  }

  // Claude에게 SSE 메시지 전송
  sendSSEToClient(event, data) {
    if (!this.clientRes || this.clientRes.writableEnded) return;
    this.clientRes.write(`event: ${event}\n`);
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this.clientRes.write(`data: ${payload}\n\n`);
  }

  // n8n으로 요청 전송
  async sendToN8n(payload) {
    // Endpoint 획득 전이면 잠시 대기 (최대 5초)
    if (!this.n8nSessionUrl) {
      let attempts = 0;
      while (!this.n8nSessionUrl && attempts < 50) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
      }
      if (!this.n8nSessionUrl) throw new Error("n8n session endpoint not ready");
    }

    // n8n으로 POST 전송
    await fetch(this.n8nSessionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
      body: JSON.stringify(payload)
    });
  }

  // Sync Bridge (응답이 올 때까지 기다림 - GPT/Tools 용)
  async sendToN8nAndWait(payload) {
    await this.sendToN8n(payload);
    
    return new Promise((resolve, reject) => {
      this.responseWaiters.set(payload.id, resolve);
      // 30초 타임아웃
      setTimeout(() => {
        if (this.responseWaiters.has(payload.id)) {
          this.responseWaiters.delete(payload.id);
          reject(new Error("Timeout waiting for n8n response"));
        }
      }, 30000);
    });
  }

  close() {
    this.isAlive = false;
    this.controller.abort();
    // 대기 중인 요청들 모두 정리
    for (const [id, resolve] of this.responseWaiters) {
      resolve({ error: "Session closed" });
    }
    this.responseWaiters.clear();
    console.log(`[Session ${this.sessionId}] Closed`);
  }
}

// ========== Global Session Map ==========
const sessions = new Map(); // sessionId -> N8nSession

// ========== Routes ==========

// 1. Claude 연결 (GET /sse) - 새로운 세션 시작
app.get("/sse", (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  // 간단한 토큰 체크 (필요시 강화)
  // if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const sessionId = crypto.randomUUID();
  console.log(`[New Connection] Client connected, ID: ${sessionId}`);

  // 이 사용자만을 위한 n8n 세션 생성!
  const n8nSession = new N8nSession(sessionId, res);
  sessions.set(sessionId, n8nSession);

  res.write(": welcome\n\n");
  n8nSession.sendSSEToClient('endpoint', `/session/${sessionId}`);

  // Keep-alive 핑
  const pinger = setInterval(() => res.write(": ping\n\n"), 15000);

  req.on('close', () => {
    clearInterval(pinger);
    n8nSession.close();
    sessions.delete(sessionId);
    console.log(`[Client Disconnected] ID: ${sessionId}`);
  });
});

// 2. Claude 메시지 수신 (POST /session/:sessionId)
app.post("/session/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found or expired" });
  }

  try {
    await session.sendToN8n(req.body);
    res.status(202).end(); // Accepted (비동기 처리)
  } catch (error) {
    console.error(`[Error] Forwarding to n8n failed:`, error);
    res.status(500).json({ error: error.message });
  }
});

// 3. 초기화 (POST /sse) - 핸드셰이크용 (Auth0 토큰 체크 포함)
app.post("/sse", async (req, res) => {
  // 인증 체크 (키 인증 or 토큰 인증)
  const authHeader = req.headers["authorization"] || "";
  const apiKey = req.query.key;
  const MY_SECRET_KEY = process.env.MCP_SECRET_KEY;

  const isAuth0 = authHeader.startsWith("Bearer ");
  const isKeyValid = MY_SECRET_KEY && apiKey === MY_SECRET_KEY;

  if (!isAuth0 && !isKeyValid) {
    // console.log("[Auth] Blocked: No valid token or key");
    // return res.status(401).json({ error: "Unauthorized" }); // 개발 편의를 위해 일단 패스하거나 주석 처리
  }

  if (req.body && req.body.method === "initialize") {
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
  
  // 그 외 요청은 무시 (Claude는 초기화 후 GET /sse로 넘어감)
  res.status(200).send("OK");
});

// 4. GPTs용 엔드포인트 (임시 세션 생성 -> 실행 -> 종료)
app.post("/gpt/execute", async (req, res) => {
  const { toolName, arguments: args } = req.body;
  const tempId = `gpt-${crypto.randomUUID()}`;
  
  console.log(`[GPT] Request: ${toolName} (TempID: ${tempId})`);

  // GPT 요청은 SSE 연결이 없으므로 res=null로 세션 생성
  const session = new N8nSession(tempId, null);
  
  try {
    // n8n 연결 대기
    await new Promise(r => setTimeout(r, 1000)); 

    const payload = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name: toolName, arguments: args || {} }
    };

    const response = await session.sendToN8nAndWait(payload);

    // 결과 반환
    if (response.result && response.result.content) {
      const textContent = response.result.content.map(c => c.text).join("\n");
      res.json({ result: textContent });
    } else {
      res.json({ result: JSON.stringify(response) });
    }

  } catch (e) {
    console.error(`[GPT Error]`, e.message);
    res.status(500).json({ error: e.message });
  } finally {
    session.close(); // GPT 요청 끝나면 즉시 정리
  }
});

// 5. Auth0 Proxy (ChatGPT 인증용)
app.get("/auth/authorize", (req, res) => {
  const params = new URLSearchParams(req.query);
  const auth0Url = `https://${process.env.AUTH0_DOMAIN}/authorize?${params.toString()}`;
  res.redirect(auth0Url);
});

app.post("/auth/token", async (req, res) => {
  try {
    const { code, redirect_uri } = req.body;
    const response = await fetch(`https://${process.env.AUTH0_DOMAIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.AUTH0_CLIENT_ID,
        client_secret: process.env.AUTH0_CLIENT_SECRET,
        code: code,
        grant_type: "authorization_code",
        redirect_uri: redirect_uri
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Token exchange failed" });
  }
});

// Auth0 Metadata
const AUTH0_METADATA = {
  issuer: `https://${process.env.AUTH0_DOMAIN}/`,
  authorization_endpoint: `https://${process.env.AUTH0_DOMAIN}/authorize`,
  token_endpoint: `https://${process.env.AUTH0_DOMAIN}/oauth/token`,
  registration_endpoint: `https://${process.env.AUTH0_DOMAIN}/oidc/register`,
  jwks_uri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`
};
app.get("/.well-known/oauth-authorization-server", (req, res) => res.json(AUTH0_METADATA));
app.get("/.well-known/oauth-protected-resource", (req, res) => res.json({ resource: process.env.AUTH0_AUDIENCE }));

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Multi-User Server running on port ${port}`);
});