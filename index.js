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
const { fetch } = require("undici");
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

// ========== 1. 인증/메타데이터 (표준 준수) ==========

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
  
  // 만약 클라이언트가 audience를 안 보냈다면 강제로 추가 (선택사항)
  if (!params.has("audience") && process.env.AUTH0_AUDIENCE) {
    params.append("audience", process.env.AUTH0_AUDIENCE);
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

// ========== 2. 보안 미들웨어 (401 Challenge) ==========

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

// ========== 3. MCP 로직 (기존과 동일하지만 requireAuth 적용) ==========

// ... (N8nSession 클래스는 기존 코드 그대로 사용하세요. 너무 길어서 생략합니다) ...
// ... (기존 N8nSession 클래스 코드 붙여넣기) ...
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

// ========== 4. 핸들러 및 라우트 ==========

const handleMcpPost = async (req, res) => {
  const method = req.body?.method;

  // [보안] 이메일 주입 (수정됨)
  if (method === "tools/call" && req.body.params && req.body.params.arguments) {
    if (req.user_email) {
        console.log(`[Security] Injecting email to n8n: ${req.user_email}`);
        
        // [핵심 수정] n8n이 기다리는 'email' 변수에 강제로 덮어씌웁니다!
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
      try { await new Promise(r => setTimeout(r, 1000)); const response = await tempSession.sendToN8nAndWait(req.body); return res.json(response); } finally { tempSession.close(); }
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  res.status(200).send("OK");
};

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
});