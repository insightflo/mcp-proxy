// Remote MCP Server for Claude.ai (Multi-User + Legacy Route Support)
const isRailway = !!process.env.RAILWAY_ENVIRONMENT;
if (!isRailway) {
  try {
    require("dotenv").config({ path: ".env.local" });
  } catch (e) {}
}

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
// undici가 설치되어 있어야 합니다 (package.json 확인)
const { fetch } = require("undici"); 

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// 디버깅: 요청 로깅
app.use((req, res, next) => {
  if (req.path === "/favicon.ico") return next();
  next();
});

const N8N_MCP_URL = process.env.N8N_MCP_URL;
const N8N_API_KEY = process.env.N8N_API_KEY || "";

// ========== N8n Session Class (사용자별 독립 연결) ==========
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
        headersTimeout: 60000, 
        bodyTimeout: 0 
      });

      if (!response.ok) throw new Error(`n8n connection failed: ${response.status}`);
      this.readStream(response.body);

    } catch (error) {
      if (this.isAlive) {
        console.error(`[Session ${this.sessionId}] Connection Error:`, error.message);
        this.close();
      }
    }
  }

  async readStream(body) {
    const reader = body.getReader(); 
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
      if (error.name !== 'AbortError' && this.isAlive) {
        console.error(`[Session ${this.sessionId}] Stream Read Error:`, error.message);
      }
    }
  }

  processLine(line) {
    if (!line) return;

    if (line.startsWith("event: endpoint")) {
      this.expectingEndpointData = true;
    } else if (this.expectingEndpointData && line.startsWith("data: ")) {
      const relativePath = line.replace("data: ", "").trim();
      this.n8nSessionUrl = new URL(relativePath, N8N_MCP_URL).toString();
      console.log(`[Session ${this.sessionId}] Endpoint Locked: ${this.n8nSessionUrl}`);
      this.expectingEndpointData = false;
      
      this.sendToN8n({
        jsonrpc: "2.0", id: crypto.randomUUID(), method: "initialize",
        params: { protocolVersion: "2024-11-05", clientInfo: { name: "Proxy", version: "1.0" }, capabilities: {} }
      });
    }
    else if (line.startsWith("data: ")) {
      const jsonStr = line.replace("data: ", "").trim();
      if (jsonStr && jsonStr !== "[DONE]") {
        try {
          const msg = JSON.parse(jsonStr);
          if (msg.id && this.responseWaiters.has(msg.id)) {
            const resolve = this.responseWaiters.get(msg.id);
            resolve(msg);
            this.responseWaiters.delete(msg.id);
          } 
          else if (this.clientRes) {
             this.sendSSEToClient('message', msg);
          }
        } catch (e) {}
      }
    }
  }

  sendSSEToClient(event, data) {
    if (!this.clientRes || this.clientRes.writableEnded) return;
    this.clientRes.write(`event: ${event}\n`);
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this.clientRes.write(`data: ${payload}\n\n`);
  }

  async sendToN8n(payload) {
    if (!this.n8nSessionUrl) {
      let attempts = 0;
      while (!this.n8nSessionUrl && attempts < 50) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
      }
      if (!this.n8nSessionUrl) throw new Error("n8n session endpoint not ready");
    }

    await fetch(this.n8nSessionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {}) },
      body: JSON.stringify(payload)
    });
  }

  async sendToN8nAndWait(payload) {
    await this.sendToN8n(payload);
    return new Promise((resolve, reject) => {
      this.responseWaiters.set(payload.id, resolve);
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
    for (const [id, resolve] of this.responseWaiters) {
      resolve({ error: "Session closed" });
    }
    this.responseWaiters.clear();
  }
}

const sessions = new Map();

// ========== Routes ==========

// Root Health Check
app.get("/", (req, res) => {
  res.send("MCP Server is Running! Please use /sse endpoint.");
});

// 1. Claude 연결 (GET /sse)
app.get("/sse", (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const sessionId = crypto.randomUUID();
  console.log(`[New Connection] Client connected, ID: ${sessionId}`);

  const n8nSession = new N8nSession(sessionId, res);
  sessions.set(sessionId, n8nSession);

  res.write(": welcome\n\n");
  n8nSession.sendSSEToClient('endpoint', `/session/${sessionId}`);

  const pinger = setInterval(() => res.write(": ping\n\n"), 15000);

  req.on('close', () => {
    clearInterval(pinger);
    n8nSession.close();
    sessions.delete(sessionId);
    console.log(`[Client Disconnected] ID: ${sessionId}`);
  });
});

// 2. Claude 메시지 수신 (POST /session/:sessionId) - 표준 방식
app.post("/session/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  try {
    await session.sendToN8n(req.body);
    res.status(202).end(); 
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. [핵심 수정] 초기화 및 레거시 라우팅 (POST /sse)
// Claude가 '/session/ID' 대신 그냥 '/sse'로 요청을 보낼 때 처리하는 로직
app.post("/sse", async (req, res) => {
  
  // A. 초기화 요청인 경우 (항상 즉시 응답)
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

  // B. 그 외 요청 (tools/list 등)인데 주소가 /sse인 경우
  // -> 가장 최근에 접속한 세션을 찾아서 거기로 보냄 (Fallback)
  if (req.body && req.body.method) {
    try {
      // 가장 마지막에 추가된 세션 ID 찾기
      const lastSessionId = Array.from(sessions.keys()).pop();
      
      if (lastSessionId) {
        const session = sessions.get(lastSessionId);
        // console.log(`[Fallback] Relaying ${req.body.method} to session ${lastSessionId}`);
        await session.sendToN8n(req.body);
        return res.status(202).end();
      } else {
        console.warn("[Fallback] No active session found for POST /sse request");
        // 세션이 없으면 어쩔 수 없이 에러
        return res.status(400).json({ error: "No active session" });
      }
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(200).send("OK");
});

// 4. GPTs용 엔드포인트
app.post("/gpt/execute", async (req, res) => {
  const { toolName, arguments: args } = req.body;
  const tempId = `gpt-${crypto.randomUUID()}`;
  console.log(`[GPT] Request: ${toolName}`);

  const session = new N8nSession(tempId, null);
  
  try {
    await new Promise(r => setTimeout(r, 1000)); 
    const payload = {
      jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call",
      params: { name: toolName, arguments: args || {} }
    };
    const response = await session.sendToN8nAndWait(payload);

    if (response.result && response.result.content) {
      const textContent = response.result.content.map(c => c.text).join("\n");
      res.json({ result: textContent });
    } else {
      res.json({ result: JSON.stringify(response) });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    session.close();
  }
});

// 5. Auth0 Proxy
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