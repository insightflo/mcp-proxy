// MCP Proxy: SSE Buffering Fix & Robust Logging
const isRailway = !!process.env.RAILWAY_ENVIRONMENT;
if (!isRailway) {
  try {
    require("dotenv").config({ path: ".env.local" });
  } catch (e) {}
}

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
// 대용량 응답 대비 제한 해제
app.use(express.json({ limit: "50mb" }));
app.use(cors());

// ---------- Config & Keys ----------
const config = JSON.parse(fs.readFileSync("./mcp.config.json", "utf8"));

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

// [디버깅용 로그 추가]
// 보안을 위해 값은 숨기고, 키(Key) 목록만 출력해서 USERKEY_... 가 있는지 확인
console.log("[DEBUG] Loaded Env Keys:", Object.keys(process.env).filter(k => k.startsWith("USERKEY_")));

console.log("[INIT] User keys loaded:", Object.keys(KEY_MAP));

// ---------- Global State ----------

// pendingRequests: ID -> { resolve, reject, timer }
const pendingRequests = new Map();

// serverSessions: serverName -> { initialized, sessionUrl, controller }
const serverSessions = {};

// ---------- Helpers ----------

function buildMcpHeaders(target, realKey) {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    ...(target.headers || {}),
    "Authorization": `Bearer ${realKey}`
  };
}

// 수신된 JSON 메시지 처리
function handleIncomingMessage(serverName, dataStr) {
  let json;
  try {
    json = JSON.parse(dataStr);
  } catch (e) {
    // JSON 파싱 실패는 무시 (완전하지 않은 데이터일 수 있음)
    return;
  }

  // [Debug] 들어온 메시지 ID 확인
  // console.log(`[MCP][${serverName}] Received Msg ID: ${json.id || 'Notification'}`);

  if (json.id && pendingRequests.has(json.id)) {
    const { resolve, reject, timer } = pendingRequests.get(json.id);
    clearTimeout(timer);
    pendingRequests.delete(json.id);

    if (json.error) {
      reject(new Error(`MCP Error: ${JSON.stringify(json.error)}`));
    } else {
      resolve(json);
    }
  }
}

/**
 * SSE 연결 및 유지 (Buffering 로직 추가됨)
 */
async function connectAndKeepAlive(serverName, targetUrl, headers) {
  console.log(`[MCP][${serverName}] Connecting to SSE: ${targetUrl}`);
  
  const controller = new AbortController();
  const response = await fetch(targetUrl, {
    method: "GET",
    headers: { ...headers, "Accept": "text/event-stream", "Cache-Control": "no-cache" },
    signal: controller.signal
  });

  if (!response.ok) {
    throw new Error(`SSE connection failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let sessionUrl = null;
  let buffer = ""; // [중요] 청크 조립용 버퍼

  // 1단계: Endpoint 찾기 (초기 Handshake)
  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error("Stream ended before finding endpoint");
    
    // 버퍼에 쌓기
    buffer += decoder.decode(value, { stream: true });
    
    // 줄바꿈 기준으로 나누기
    const lines = buffer.split("\n");
    
    // 마지막 조각은 아직 미완성일 수 있으므로 버퍼에 남겨둠
    buffer = lines.pop(); 

    for (const line of lines) {
      if (line.trim().startsWith("event: endpoint")) {
        // endpoint 이벤트 발견 시, 해당 라인 근처에서 data 찾기 로직이 필요하지만
        // SSE는 순서대로 오므로 다음 줄이나 같은 배치에 data가 있음.
        // 여기선 간단히 전체 lines 배열에서 검색
        const dataLine = lines.find(l => l.trim().startsWith("data: "));
        if (dataLine) {
          const relativePath = dataLine.replace("data: ", "").trim();
          sessionUrl = new URL(relativePath, targetUrl).toString();
          break;
        }
      }
    }
    if (sessionUrl) break;
  }

  console.log(`[MCP][${serverName}] Session URL acquired: ${sessionUrl}`);

  // 2단계: 백그라운드 리스닝 (완벽한 Buffering 지원)
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log(`[MCP][${serverName}] SSE connection closed by server.`);
          if (serverSessions[serverName]) {
             serverSessions[serverName].initialized = false;
             serverSessions[serverName].sessionUrl = null;
          }
          break;
        }
        
        // [핵심] 버퍼링: 이전 조각 + 새 조각
        buffer += decoder.decode(value, { stream: true });
        
        // 줄 단위 분리
        const lines = buffer.split("\n");
        
        // 마지막 요소는 "아직 끝나지 않은 줄"일 수 있으므로 다시 버퍼에 저장하고 처리에서 제외
        buffer = lines.pop(); 

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            const jsonStr = trimmed.replace("data: ", "").trim();
            if (jsonStr && jsonStr !== "[DONE]") {
               handleIncomingMessage(serverName, jsonStr);
            }
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn(`[MCP][${serverName}] Background SSE Error:`, err.message);
      }
    }
  })();

  return { sessionUrl, controller };
}

/**
 * MCP 요청 전송 및 응답 대기
 */
async function sendMcpRequestAndWait(sessionUrl, headers, method, params, explicitId = null) {
  const id = explicitId || crypto.randomUUID();
  
  // 1. 응답 대기 설정
  const responsePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`MCP Request Timeout (${method}, ID: ${id})`));
      }
    }, 30000); // 30초 타임아웃
    
    pendingRequests.set(id, { resolve, reject, timer });
  });

  // 2. 요청 전송
  const jsonRpcRequest = {
    jsonrpc: "2.0",
    id,
    method,
    params: params || {}
  };

  // console.log(`[Debug] Sending ID: ${id}`); // 디버깅용

  const res = await fetch(sessionUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(jsonRpcRequest)
  });

  if (!res.ok) {
    pendingRequests.delete(id);
    throw new Error(`MCP POST failed: ${res.status}`);
  }

  // 3. Notification은 대기하지 않음
  if (method === 'initialized' || method.startsWith('notifications/')) {
    pendingRequests.delete(id);
    return null;
  }

  // 4. SSE로 응답이 올 때까지 대기
  return await responsePromise;
}

// ---------- API Routes ----------

async function ensureInitialized(serverName, target, realKey) {
  if (!serverSessions[serverName]) {
    serverSessions[serverName] = { initialized: false, initializingPromise: null, sessionUrl: null, controller: null };
  }
  const session = serverSessions[serverName];

  if (session.initialized && session.sessionUrl) return session.sessionUrl;
  if (session.initializingPromise) return await session.initializingPromise;

  session.initializingPromise = (async () => {
    try {
      const headers = buildMcpHeaders(target, realKey);
      if (session.controller) session.controller.abort();

      const { sessionUrl, controller } = await connectAndKeepAlive(serverName, target.url, headers);
      session.sessionUrl = sessionUrl;
      session.controller = controller;

      console.log(`[MCP][${serverName}] Sending initialize...`);
      await sendMcpRequestAndWait(sessionUrl, headers, "initialize", {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "MCP-Proxy", version: "1.0.0" },
          capabilities: {}
      });
      console.log(`[MCP][${serverName}] initialize OK`);

      await sendMcpRequestAndWait(sessionUrl, headers, "initialized", {});
      console.log(`[MCP][${serverName}] initialized OK`);
      
      session.initialized = true;
      return sessionUrl;

    } catch (err) {
      console.error(`[MCP][${serverName}] Handshake Failed:`, err);
      session.initialized = false;
      session.sessionUrl = null;
      if (session.controller) session.controller.abort();
      throw err;
    } finally {
      session.initializingPromise = null;
    }
  })();

  return session.initializingPromise;
}

app.get("/", (req, res) => res.json({ status: "ok" }));

app.post("/mcp/call", async (req, res) => {
  try {
    const authHeader = req.headers["authorization"] || "";
    const userKey = authHeader.replace("Bearer", "").trim();

    if (!KEY_MAP || Object.keys(KEY_MAP).length === 0) KEY_MAP = loadKeyMapFromEnv();
    const REAL_KEY = KEY_MAP[userKey];
    if (!REAL_KEY) return res.status(403).json({ error: "Invalid user key" });

    const { server, method, params, id } = req.body || {};
    if (!server || !method) return res.status(400).json({ error: "Missing server/method" });

    const target = config.servers[server];
    if (!target) return res.status(400).json({ error: "Unknown server" });

    const sessionUrl = await ensureInitialized(server, target, REAL_KEY);

    // 로그에 ID를 명시하여 추적
    const requestId = id || crypto.randomUUID();
    console.log(`[MCP Proxy] Forwarding ${method} (ID: ${requestId})`);

    const result = await sendMcpRequestAndWait(
      sessionUrl,
      buildMcpHeaders(target, REAL_KEY),
      method,
      params,
      requestId // 여기서 ID를 고정하여 넘김
    );

    return res.status(200).json(result);

  } catch (err) {
    console.error("[MCP Proxy Error]", err);
    return res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`MCP Proxy running on port ${port}`);
});