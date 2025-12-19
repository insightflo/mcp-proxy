// Remote MCP Server (Strict OAuth Standard)
const isRailway = !!process.env.RAILWAY_ENVIRONMENT;
if (!isRailway) {
  try {
    require("dotenv").config({ path: ".env.local" });
  } catch (e) {}
}

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
// const { fetch } = require("undici"); 
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// 로그 미들웨어
app.use((req, res, next) => {
  if (req.path === "/favicon.ico") return next();
  // console.log(`[HTTP] ${req.method} ${req.path}`);
  next();
});

// 환경변수 체크
const N8N_MCP_URL = process.env.N8N_MCP_URL;
const N8N_API_KEY = process.env.N8N_API_KEY || "";
// [중요] Railway 변수에 BASE_URL을 꼭 설정하세요! (예: https://...railway.app)
const BASE_URL = process.env.BASE_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`; 

// =================================================================
// 1. 인증/메타데이터
// =================================================================
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_ISSUER = `https://${AUTH0_DOMAIN}/`;

// (1) Protected Resource Metadata (MCP 클라이언트가 이걸 보고 인증 서버를 찾음)
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [AUTH0_ISSUER], // Auth0가 인증 담당자라고 명시
    scopes_supported: ["openid", "profile", "email", "offline_access"],
  });
});

// (2) Authorization Server Metadata (Auth0 정보 전달)
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer: AUTH0_ISSUER,
    authorization_endpoint: `${AUTH0_ISSUER}authorize`, // 쿼리 파라미터 제거 (표준)
    token_endpoint: `${AUTH0_ISSUER}oauth/token`,
    jwks_uri: `${AUTH0_ISSUER}.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    scopes_supported: ["openid", "profile", "email", "offline_access"]
  });
});

// (3) Auth0 Proxy (Redirect URI 처리용)
app.get("/auth/authorize", (req, res) => {
  // 클라이언트가 보내준 쿼리를 그대로 Auth0로 토스
  const params = new URLSearchParams(req.query);
  
  // 만약 클라이언트가 audience를 안 보냈다면 강제로 추가
  if (!params.has("audience") && process.env.AUTH0_AUDIENCE) {
    let audience = process.env.AUTH0_AUDIENCE;
    
    // [핵심] Railway가 슬래시를 지웠다면, 코드에서 강제로 다시 붙입니다! (auth0의 api 주소가 https://mcp-proxy-production-48c3.up.railway.app/ 으로 되어 있음. )
    if (!audience.endsWith("/")) {
      audience = audience + "/";
    }
    
    params.append("audience", audience);
  }
  
  res.redirect(`https://${AUTH0_DOMAIN}/authorize?${params.toString()}`);
});

app.post("/auth/token", async (req, res) => {
  try {
    const response = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.AUTH0_CLIENT_ID,
        client_secret: process.env.AUTH0_CLIENT_SECRET,
        ...req.body // 클라이언트가 보낸 code, redirect_uri 등 사용
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Token exchange failed" });
  }
});

// =================================================================
// 2. 보안 미들웨어 (401 Challenge)
// =================================================================
// 토큰에서 이메일 추출
function extractUserEmail(req) {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      const decoded = jwt.decode(token);
      return decoded["https://mcp-proxy/email"] || decoded.email || decoded.sub;
    }
    // 백도어 (URL Key 방식) - 최후의 수단
    if (req.query.key === process.env.MCP_SECRET_KEY && req.query.user_email) {
      return req.query.user_email;
    }
    return null;
  } catch (e) { return null; }
}

// [핵심] 인증 강제 미들웨어

const requireAuth = (req, res, next) => {
  // 1. [예외] 브라우저 접속(GET /)이나 설정 파일(.well-known)은 봐줍니다.
  if (req.method === "GET" && req.path === "/") return next(); // GET만 봐줌!
  if (req.path.startsWith("/.well-known/") || req.path.startsWith("/auth/")) return next();
  if (req.path === "/favicon.ico") return next();

  // 2. 토큰이 있어서 이메일 확인이 되면 통과!
  const email = extractUserEmail(req);
  if (email) {
    req.user_email = email;
    return next();
  }

  // 3. [핵심] 토큰 없는 POST 요청(initialize 등)은 가차 없이 401 에러!
  // 그래야 Claude가 "아! 로그인해야 하는구나!" 하고 깨닫습니다.
  console.log(`[Auth] Blocking unauthenticated request: ${req.method} ${req.path}`);
  
  const metaUrl = `${BASE_URL}/.well-known/oauth-protected-resource`;
  
  res.status(401)
     .set("WWW-Authenticate", `Bearer resource_metadata="${metaUrl}", scope="openid profile email"`)
     .json({ error: "Authentication required" });
};

// =================================================================
// 3. MCP 로직 (requireAuth 적용)
// Claude용 지속 연결 클래스 (건드리지 않음)
// =================================================================.
class N8nSession {
  constructor(sessionId, res) {
    this.sessionId = sessionId;
    this.clientRes = res; 
    this.n8nSessionUrl = null;
    this.controller = new AbortController();
    this.responseWaiters = new Map(); 
    this.isAlive = true;
    this.connect();
  }
  async connect() {
    try {
      const response = await fetch(N8N_MCP_URL, {
        method: "GET",
        headers: { "Accept": "text/event-stream", "Cache-Control": "no-cache", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
        signal: this.controller.signal, headersTimeout: 60000, bodyTimeout: 0 
      });
      if (!response.ok) throw new Error(`n8n connection failed: ${response.status}`);
      this.readStream(response.body);
    } catch (error) { if (this.isAlive) this.close(); }
  }
  async readStream(body) {
    const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    try {
      while (this.isAlive) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop();
        for (const line of lines) this.processLine(line.trim());
      }
    } catch (error) {}
  }
  processLine(line) {
    if (!line) return;
    if (line.startsWith("event: endpoint")) {
      this.expectingEndpointData = true;
    } else if (this.expectingEndpointData && line.startsWith("data: ")) {
      const relativePath = line.replace("data: ", "").trim();
      this.n8nSessionUrl = new URL(relativePath, N8N_MCP_URL).toString();
      this.expectingEndpointData = false;
      this.sendToN8n({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "Proxy", version: "1.0" }, capabilities: {} } });
    } else if (line.startsWith("data: ")) {
      const jsonStr = line.replace("data: ", "").trim();
      if (jsonStr && jsonStr !== "[DONE]") {
        try { const msg = JSON.parse(jsonStr); if (msg.id && this.responseWaiters.has(msg.id)) { const resolve = this.responseWaiters.get(msg.id); resolve(msg); this.responseWaiters.delete(msg.id); } else if (this.clientRes) { this.sendSSEToClient('message', msg); } } catch (e) {}
      }
    }
  }
  sendSSEToClient(event, data) { if (!this.clientRes || this.clientRes.writableEnded) return; this.clientRes.write(`event: ${event}\n`); const payload = typeof data === 'string' ? data : JSON.stringify(data); this.clientRes.write(`data: ${payload}\n\n`); }
  async sendToN8n(payload) {
    if (!this.n8nSessionUrl) { let attempts = 0; while (!this.n8nSessionUrl && attempts < 50) { await new Promise(r => setTimeout(r, 100)); attempts++; } if (!this.n8nSessionUrl) throw new Error("n8n session endpoint not ready"); }
    await fetch(this.n8nSessionUrl, { method: "POST", headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) }, body: JSON.stringify(payload) });
  }
  async sendToN8nAndWait(payload) { await this.sendToN8n(payload); return new Promise((resolve, reject) => { this.responseWaiters.set(payload.id, resolve); setTimeout(() => { if (this.responseWaiters.has(payload.id)) { this.responseWaiters.delete(payload.id); reject(new Error("Timeout waiting for n8n response")); } }, 30000); }); }
  close() { this.isAlive = false; this.controller.abort(); this.responseWaiters.clear(); }
}
const sessions = new Map();

// =================================================================
// 4. [신규] GPT 전용 Quick Client (분리됨)
// =================================================================
class QuickMcpClient {
  constructor() {
    this.controller = new AbortController();
    this.sessionUrl = null;
    this.responseWaiters = new Map();
    this.endpointResolved = null; // 엔드포인트 수신 대기용 Promise
  }

  // 연결 및 초기화 (반드시 완료될 때까지 대기)
  async connectAndInit() {
    console.log("[QuickMcp] Connecting to n8n...");
    
    // 1. 엔드포인트를 기다리는 Promise 생성
    this.endpointPromise = new Promise((resolve, reject) => {
        this.endpointResolver = resolve;
        // 10초 내에 엔드포인트 못 받으면 타임아웃
        setTimeout(() => reject(new Error("Timeout: Failed to receive session URL from n8n")), 10000);
    });

    // 2. SSE 연결 시작
    const response = await fetch(N8N_MCP_URL, {
        method: "GET",
        headers: { 
            "Accept": "text/event-stream", 
            "Cache-Control": "no-cache", 
            ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) 
        },
        signal: this.controller.signal,
    });

    if (!response.ok) throw new Error(`n8n connection failed: ${response.status}`);

    // 3. 스트림 읽기 시작 (백그라운드)
    this.readStream(response.body).catch(console.error);

    // 4. 엔드포인트가 잡힐 때까지 여기서 멈춰서 기다림! (핵심)
    await this.endpointPromise;
    console.log("[QuickMcp] Connection Ready:", this.sessionUrl);
  }

  async readStream(body) {
    const decoder = new TextDecoder();
    let expectingEndpoint = false;

    try { // [수정] try-catch 블록 추가
        // Node.js Stream Iterator
        for await (const chunk of body) {
            const text = decoder.decode(chunk, { stream: true });
            const lines = text.split("\n");
            
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                if (trimmed.startsWith("event: endpoint")) {
                    expectingEndpoint = true;
                } else if (expectingEndpoint && trimmed.startsWith("data: ")) {
                    const relativePath = trimmed.replace("data: ", "").trim();
                    this.sessionUrl = new URL(relativePath, N8N_MCP_URL).toString();
                    expectingEndpoint = false;
                    
                    if (this.endpointResolver) this.endpointResolver(this.sessionUrl);
                    
                    this.sendInternal({ 
                        jsonrpc: "2.0", id: crypto.randomUUID(), method: "initialize", 
                        params: { protocolVersion: "2024-11-05", clientInfo: { name: "GPT-Quick", version: "1.0" }, capabilities: {} } 
                    });

                } else if (trimmed.startsWith("data: ")) {
                    const jsonStr = trimmed.replace("data: ", "").trim();
                    if (jsonStr && jsonStr !== "[DONE]") {
                        try {
                            const msg = JSON.parse(jsonStr);
                            if (msg.id && this.responseWaiters.has(msg.id)) {
                                const resolve = this.responseWaiters.get(msg.id);
                                resolve(msg);
                                this.responseWaiters.delete(msg.id);
                            }
                        } catch (e) {}
                    }
                }
            }
        }
    } catch (error) {
        // [수정] 의도된 종료(Abort)는 에러 로그를 찍지 않음
        if (error.name !== 'AbortError') {
            console.error("[QuickMcp] Stream Error:", error);
        }
    }
  }

  async sendInternal(payload) {
      if (!this.sessionUrl) return;
      await fetch(this.sessionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
          body: JSON.stringify(payload)
      });
  }

  async executeTool(toolName, args) {
      const requestId = crypto.randomUUID();
      const payload = {
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: toolName, arguments: args },
          id: requestId
      };

      // 응답 대기 Promise 등록
      const responsePromise = new Promise((resolve, reject) => {
          this.responseWaiters.set(requestId, resolve);
          setTimeout(() => {
              if (this.responseWaiters.has(requestId)) {
                  this.responseWaiters.delete(requestId);
                  reject(new Error("Timeout waiting for n8n tool execution"));
              }
          }, 60000); // 툴 실행은 오래 걸릴 수 있으니 60초
      });

      console.log(`[QuickMcp] Sending tool call: ${toolName}`);
      await this.sendInternal(payload);
      
      return responsePromise;
  }

  close() {
      this.controller.abort();
      this.responseWaiters.clear();
  }
}


// =================================================================
// 5. 핸들러 및 라우트
// =================================================================
// Claude용 핸들러 (N8nSession 사용)
const handleMcpPost = async (req, res) => {
  const method = req.body?.method;

  // [보안] 이메일 주입 (수정됨)
  if (method === "tools/call" && req.body.params && req.body.params.arguments) {
    if (req.user_email) {
        console.log(`[Security] Injecting email to n8n: ${req.user_email}`);
        
        // n8n이 기다리는 'email' 변수에 강제로 덮어씌웁니다!
        req.body.params.arguments.email = req.user_email;
        
        // (혹시 모르니 기존 user_email도 같이 보내둡니다)
        req.body.params.arguments.user_email = req.user_email;
    } else {
        console.warn("[Security] No email found in request");
    }
  }

  // 1. 초기화
  if (method === "initialize") {
    return res.json({ jsonrpc: "2.0", id: req.body.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "Stock Analysis MCP", version: "1.0.0" }, capabilities: { tools: {} } } });
  }
  // 2. 알림 (즉시 응답)
  if (method && (method.startsWith("notifications/") || !req.body.id)) {
    (async () => { try { const lastSessionId = Array.from(sessions.keys()).pop(); if (lastSessionId) await sessions.get(lastSessionId).sendToN8n(req.body); } catch (e) {} })();
    return res.status(200).send("OK");
  }
  // 3. 일반 요청
  if (method) {
    try {
      const lastSessionId = Array.from(sessions.keys()).pop();
      if (lastSessionId) { const session = sessions.get(lastSessionId); await session.sendToN8n(req.body); return res.status(202).end(); }
      
      const tempId = `temp-${crypto.randomUUID()}`; const tempSession = new N8nSession(tempId, null);
      try { await new Promise(r => setTimeout(r, 5000)); const response = await tempSession.sendToN8nAndWait(req.body); return res.json(response); } finally { tempSession.close(); }
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  res.status(200).send("OK");
};

// Claude용 SSE 핸들러
const handleSseConnection = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  const sessionId = crypto.randomUUID();
  const n8nSession = new N8nSession(sessionId, res);
  sessions.set(sessionId, n8nSession);
  res.write(": welcome\n\n");
  n8nSession.sendSSEToClient('endpoint', `/session/${sessionId}`);
  const pinger = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on('close', () => { clearInterval(pinger); n8nSession.close(); sessions.delete(sessionId); });
};

// 라우트 등록
app.get("/", (req, res) => res.send("MCP Server Running")); // 루트는 401 안 걸리게 단순 메시지

// ---------------------------------------------------------------------
// [수정] GPT 라우트 (QuickMcpClient 사용)
// ---------------------------------------------------------------------
app.post('/gpt/execute', async (req, res) => {
  let client = null;
  try {
    console.log("👉 [GPT] Start Request");
    const { toolName, arguments: nestedArgs, ...restBody } = req.body;
    if (!toolName) return res.status(400).json({ error: "toolName is required" });

    let finalArguments = {};
    if (nestedArgs && typeof nestedArgs === 'object' && Object.keys(nestedArgs).length > 0) {
      finalArguments = nestedArgs;
    } else {
      finalArguments = restBody;
    }

    // 1. 새 클라이언트 생성 및 연결 대기 (여기서 멈춰서 확실히 붙을 때까지 기다림)
    client = new QuickMcpClient();
    await client.connectAndInit(); 

    // 2. 툴 실행 및 결과 대기
    console.log(`👉 [GPT] Executing Tool: ${toolName}`);
    const result = await client.executeTool(toolName, finalArguments);
    
    // 3. 결과 반환
    console.log("👉 [GPT] Success");
    res.json(result);

  } catch (error) {
    console.error("❌ GPT Error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    if (client) client.close(); // 연결 종료
  }
});
// ---------------------------------------------------------------------


// [GPT] 개인정보 처리방침 (Privacy Policy) 페이지
app.get("/privacy", (req, res) => {
  const html = `
    <html>
      <head>
        <title>Privacy Policy - Stock Analysis GPT</title>
        <style>
          body { font-family: sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; line-height: 1.6; }
          h1, h2 { color: #333; }
          .section { margin-bottom: 20px; }
        </style>
      </head>
      <body>
        <h1>Privacy Policy</h1>
        <p><strong>Last Updated:</strong> December 2025</p>
        
        <div class="section">
          <h2>1. Introduction</h2>
          <p>This Privacy Policy explains how "Stock Analysis MCP" (the "Service") handles your data. The Service is designed to provide stock market analysis using OpenAI's ChatGPT.</p>
        </div>

        <div class="section">
          <h2>2. Data Collection</h2>
          <p>We collect the minimum amount of data required to operate the Service:</p>
          <ul>
            <li><strong>Email Address:</strong> Collected via Auth0 for authentication purposes only.</li>
            <li><strong>Query Data:</strong> The stock tickers or questions you ask are processed to generate answers.</li>
          </ul>
        </div>

        <div class="section">
          <h2>3. Data Usage</h2>
          <p>Your data is used solely for:</p>
          <ul>
            <li>Verifying your identity to prevent abuse.</li>
            <li>Sending requests to our internal tools (n8n) to fetch financial data.</li>
          </ul>
          <p>We do <strong>not</strong> sell or share your personal data with advertisers.</p>
        </div>

        <div class="section">
          <h2>4. Third-Party Services</h2>
          <p>We use the following trusted third-party services:</p>
          <ul>
            <li><strong>Auth0:</strong> For secure user authentication.</li>
            <li><strong>Railway:</strong> For hosting the server infrastructure.</li>
            <li><strong>OpenAI:</strong> As the interface for the conversation.</li>
          </ul>
        </div>

        <div class="section">
          <h2>5. Contact</h2>
          <p>If you have questions about this policy, please contact: <br>
          <a href="mailto:teo@insightflo.co">teo@insightflo.co</a></p>
        </div>
      </body>
    </html>
  `;
  res.send(html);
});

// [중요] SSE 연결은 브라우저 스펙상 헤더를 못 넣을 수 있으므로 requireAuth 제외 고려
// 하지만 Claude가 GET /sse 시에도 401을 받고 재시도할 수 있으므로 일단 적용해봄.
// 만약 무한 401이 뜬다면 SSE만 requireAuth 뺄 것.
app.get("/sse", handleSseConnection); 

// [중요] POST 요청은 무조건 인증 필수!
app.post("/", requireAuth, handleMcpPost);
app.post("/sse", requireAuth, handleMcpPost);
app.post("/session/:sessionId", requireAuth, async (req, res) => {
  const { sessionId } = req.params; const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  try { await session.sendToN8n(req.body); res.status(202).end(); } catch (error) { res.status(500).json({ error: error.message }); }
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Strict Auth Server running on port ${port}`);
  if(!N8N_MCP_URL) console.warn("⚠️ N8N_MCP_URL MISSING");
});