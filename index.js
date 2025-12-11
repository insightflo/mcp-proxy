// Remote MCP Server for Claude.ai Web/Mobile (With User Authentication)
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

// ========== 사용자 인증 시스템 ==========
function loadKeyMapFromEnv() {
  const map = {};
  for (const [envKey, value] of Object.entries(process.env)) {
    if (envKey.startsWith("USERKEY_")) {
      const userId = envKey.replace("USERKEY_", "");
      map[userId] = value;
    }
  }
  return map;
}

let KEY_MAP = loadKeyMapFromEnv();

// 주기적으로 환경변수 다시 로드 (Railway에서 변경 시 반영)
setInterval(() => {
  const newKeyMap = loadKeyMapFromEnv();
  if (Object.keys(newKeyMap).length > 0) {
    KEY_MAP = newKeyMap;
  }
}, 60000); // 1분마다

console.log(`[Auth] Loaded ${Object.keys(KEY_MAP).length} user keys:`, Object.keys(KEY_MAP));

// 인증 검증 함수
function authenticateUser(userKey) {
  if (!KEY_MAP || Object.keys(KEY_MAP).length === 0) {
    KEY_MAP = loadKeyMapFromEnv();
  }
  return KEY_MAP.hasOwnProperty(userKey);
}

// 사용자 키로 실제 인증 값 가져오기
function getRealKeyForUser(userKey) {
  return KEY_MAP[userKey];
}

// ========== 세션 저장소 ==========
// sessionId -> { userId, userRealKey, tools, lastActivity, res (SSE 응답 객체) }
const sessions = new Map();

// ========== n8n에서 도구 목록 가져오기 ==========
async function getToolsFromN8n() {
  try {
    const session = await ensureN8nSession();
    
    const response = await fetch(session.sessionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {})
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/list",
        params: {}
      })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to get tools: ${response.status}`);
    }
    
    const result = await response.json();
    console.log(`[n8n] Loaded ${result.result?.tools?.length || 0} tools`);
    return result.result?.tools || [];
    
  } catch (error) {
    console.error(`[n8n] Failed to load tools:`, error);
    return [];
  }
}

// ========== n8n MCP 서버 연결 설정 ==========
const N8N_MCP_URL = process.env.N8N_MCP_URL || "https://n8n-auto.showk.ing/mcp/a37e9a48-8d70-4830-9dea-a244691fea27";
const N8N_API_KEY = process.env.N8N_API_KEY || "";

// n8n MCP 서버 세션 관리
let n8nSession = null;
let n8nSessionInitializing = false;

// 대기중인 요청 매핑 (id -> sessionId)
const pendingRequests = new Map();

async function ensureN8nSession() {
  if (n8nSession && n8nSession.valid) {
    return n8nSession;
  }
  
  if (n8nSessionInitializing) {
    // 초기화 중이면 대기
    await new Promise(resolve => setTimeout(resolve, 100));
    return ensureN8nSession();
  }
  
  n8nSessionInitializing = true;
  
  try {
    console.log(`[n8n] Connecting to ${N8N_MCP_URL}...`);
    
    // SSE 연결
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
    
    if (!response.ok) {
      throw new Error(`n8n SSE connection failed: ${response.status}`);
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sessionUrl = null;
    
    // Endpoint 찾기
    while (!sessionUrl) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Stream ended before finding endpoint");
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      
      for (const line of lines) {
        if (line.trim().startsWith("event: endpoint")) {
          const dataLine = lines.find(l => l.trim().startsWith("data: "));
          if (dataLine) {
            const relativePath = dataLine.replace("data: ", "").trim();
            sessionUrl = new URL(relativePath, N8N_MCP_URL).toString();
            break;
          }
        }
      }
    }
    
    console.log(`[n8n] Session URL: ${sessionUrl}`);
    
    // Initialize
    const initResponse = await fetch(sessionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {})
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "Remote-MCP-Proxy", version: "1.0.0" },
          capabilities: {}
        }
      })
    });
    
    if (!initResponse.ok) {
      throw new Error(`n8n initialize failed: ${initResponse.status}`);
    }
    
    console.log(`[n8n] Initialized successfully`);
    
    // 백그라운드 SSE 리스너
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            console.log(`[n8n] SSE closed`);
            if (n8nSession) n8nSession.valid = false;
            break;
          }
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();
          
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ")) {
              const jsonStr = trimmed.replace("data: ", "").trim();
              if (jsonStr && jsonStr !== "[DONE]") {
                try {
                  const msg = JSON.parse(jsonStr);
                  console.log(`[n8n] Received message with ID: ${msg.id}`);
                  
                  // ID로 세션 찾기
                  const sessionId = pendingRequests.get(msg.id);
                  if (sessionId) {
                    const session = sessions.get(sessionId);
                    if (session && session.res && !session.res.writableEnded) {
                      // 클라이언트 SSE로 전달
                      sendSSE(session.res, 'message', msg);
                      console.log(`[Relay] Forwarded to session ${sessionId}`);
                    }
                    pendingRequests.delete(msg.id);
                  }
                } catch (e) {
                  console.error(`[n8n] JSON parse error:`, e.message);
                }
              }
            }
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.warn(`[n8n] SSE Error:`, err.message);
        }
      }
    })();
    
    n8nSession = {
      sessionUrl,
      controller,
      valid: true,
      lastActivity: Date.now()
    };
    
    return n8nSession;
    
  } catch (error) {
    console.error(`[n8n] Connection failed:`, error);
    n8nSession = null;
    throw error;
  } finally {
    n8nSessionInitializing = false;
  }
}

// ========== 실제 도구 실행 함수 (n8n 호출) ==========
async function executeTool(toolName, args) {
  console.log(`[Tool] ${toolName}`, args);
  
  try {
    const session = await ensureN8nSession();
    
    const response = await fetch(session.sessionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {})
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args
        }
      })
    });
    
    if (!response.ok) {
      throw new Error(`n8n tool call failed: ${response.status}`);
    }
    
    const result = await response.json();
    
    // n8n에서 받은 응답 처리
    if (result.result && result.result.content) {
      return result.result.content;
    } else if (result.result) {
      return [{ type: "text", text: JSON.stringify(result.result) }];
    } else {
      throw new Error("Invalid response from n8n");
    }
    
  } catch (error) {
    console.error(`[Tool Error] ${toolName}:`, error);
    return [{
      type: "text",
      text: `도구 실행 중 오류 발생: ${error.message}`
    }];
  }
}

// ========== SSE Helper ==========
function sendSSE(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ========== 세션 정리 (10분 비활성) ==========
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastActivity > 10 * 60 * 1000) {
      console.log(`[Session] Cleanup: ${sessionId} (user: ${session.userId})`);
      if (session.res && !session.res.writableEnded) {
        session.res.end();
      }
      sessions.delete(sessionId);
    }
  }
}, 60 * 1000); // 1분마다 체크

// ========== Routes ==========

// Health check
app.get("/", (req, res) => {
  res.json({ 
    status: "ok",
    service: "Remote MCP Server (Authenticated)",
    version: "1.0.0",
    activeSessions: sessions.size,
    registeredUsers: Object.keys(KEY_MAP).length
  });
});

// SSE 초기 연결 (Claude가 여기로 연결) - 인증 필요
app.get("/sse", async (req, res) => {
  // 1. 인증 확인 (Query parameter 또는 Authorization header)
  const authHeader = req.headers["authorization"] || "";
  const queryKey = req.query.key || "";
  
  // Bearer 토큰에서 키 추출
  const headerKey = authHeader.replace("Bearer", "").trim();
  const userKey = headerKey || queryKey;
  
  if (!userKey) {
    res.status(401).json({ 
      error: "Authentication required",
      message: "Provide key via ?key=YOUR_KEY or Authorization: Bearer YOUR_KEY"
    });
    return;
  }
  
  if (!authenticateUser(userKey)) {
    console.log(`[Auth] Failed authentication attempt: ${userKey}`);
    res.status(403).json({ 
      error: "Invalid authentication key",
      message: "The provided key is not authorized"
    });
    return;
  }
  
  console.log(`[Auth] User authenticated: ${userKey}`);
  
  // 2. 세션 생성
  const sessionId = crypto.randomUUID();
  
  console.log(`[SSE] New connection: ${sessionId} (user: ${userKey})`);
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx buffering 방지
  
  // Endpoint 이벤트 전송
  sendSSE(res, 'endpoint', `/session/${sessionId}`);
  
  // 세션 생성 (사용자 정보 포함)
  // tools는 빈 배열로 시작, tools/list 호출 시 n8n에서 받아옴
  sessions.set(sessionId, {
    userId: userKey,
    tools: [],
    lastActivity: Date.now(),
    res: res
  });
  
  console.log(`[SSE] Session ${sessionId} created for user ${userKey}`);
  
  // 연결 종료 처리
  req.on('close', () => {
    console.log(`[SSE] Connection closed: ${sessionId} (user: ${userKey})`);
    sessions.delete(sessionId);
  });
  
  // Keep-alive (30초마다 핑)
  const keepAlive = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(keepAlive);
      return;
    }
    res.write(': ping\n\n');
  }, 30000);
  
  req.on('close', () => clearInterval(keepAlive));
});

// 세션별 JSON-RPC 처리
app.post("/session/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({
      jsonrpc: "2.0",
      id: req.body.id,
      error: { code: -32001, message: "Session not found or expired" }
    });
  }
  
  session.lastActivity = Date.now();
  
  const { jsonrpc, id, method, params } = req.body;
  
  console.log(`[RPC][${sessionId}][${session.userId}] ${method}`);
  
  try {
    let result;
    
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          serverInfo: {
            name: "Stock Analysis MCP",
            version: "1.0.0"
          },
          capabilities: {
            tools: {}
          }
        };
        break;
        
      case "initialized":
        // notification이므로 응답 불필요
        return res.status(200).end();
        
      case "tools/list":
        // n8n에 tools/list 요청 전달
        const n8nSession_list = await ensureN8nSession();
        
        // 대기 목록에 등록
        pendingRequests.set(id, sessionId);
        
        const listResponse = await fetch(n8nSession_list.sessionUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {})
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: id,
            method: "tools/list",
            params: params || {}
          })
        });
        
        if (!listResponse.ok) {
          pendingRequests.delete(id);
          throw new Error(`tools/list failed: ${listResponse.status}`);
        }
        
        // POST 응답은 무시하고 SSE로 받을 때까지 대기
        // n8n이 SSE로 보낸 응답은 자동으로 클라이언트에게 전달됨
        return res.status(200).end();
        
      case "tools/call":
        const { name, arguments: args } = params;
        const n8nSession_call = await ensureN8nSession();
        
        // 대기 목록에 등록
        pendingRequests.set(id, sessionId);
        
        const callResponse = await fetch(n8nSession_call.sessionUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(N8N_API_KEY ? { "Authorization": `Bearer ${N8N_API_KEY}` } : {})
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: id,
            method: "tools/call",
            params: {
              name: name,
              arguments: args
            }
          })
        });
        
        if (!callResponse.ok) {
          pendingRequests.delete(id);
          throw new Error(`tools/call failed: ${callResponse.status}`);
        }
        
        // POST 응답은 무시하고 SSE로 받을 때까지 대기
        return res.status(200).end();
        
      default:
        throw { code: -32601, message: "Method not found" };
    }
    
    // SSE로 응답 전송 (비동기)
    if (session.res && !session.res.writableEnded) {
      sendSSE(session.res, 'message', {
        jsonrpc: "2.0",
        id: id,
        result: result
      });
    }
    
    // HTTP 응답은 즉시 200 OK (SSE가 실제 데이터 전송)
    res.status(200).end();
    
  } catch (error) {
    console.error(`[RPC Error][${sessionId}]`, error);
    
    const errorResponse = {
      jsonrpc: "2.0",
      id: id,
      error: {
        code: error.code || -32603,
        message: error.message || "Internal error"
      }
    };
    
    if (session.res && !session.res.writableEnded) {
      sendSSE(session.res, 'message', errorResponse);
    }
    
    res.status(200).end();
  }
});


// OAuth 더미 엔드포인트 (Claude.ai 호환성)
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.status(404).json({ error: "OAuth not supported" });
});

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.status(404).json({ error: "OAuth not supported" });
});

// ========== Server Start ==========
const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Remote MCP Server (Authenticated) running on port ${port}`);
  console.log(`📡 SSE Endpoint: http://localhost:${port}/sse`);
  console.log(`🔗 n8n Backend: ${N8N_MCP_URL}`);
  console.log(`🔐 Registered users: ${Object.keys(KEY_MAP).length}`);
  console.log(`📦 Tools will be loaded from n8n on first connection`);
});