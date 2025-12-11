// MCP Proxy - Multi User Version (Final)
// - Authorization: Bearer userKey  → KEY_MAP[userKey] → REAL MCP KEY
// - JSON-RPC proxy forwarding
// - Fully compatible with GPT Actions + Railway

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors());

// Load public config
const config = JSON.parse(fs.readFileSync('./mcp.config.json', 'utf8'));


// Load KEY_MAP from Railway env variable
function loadKeyMapFromEnv() {
  const map = {};
  for (const [envKey, value] of Object.entries(process.env)) {
    if (envKey.startsWith("USERKEY_")) {
      const user = envKey.replace("USERKEY_", "");
      map[user] = value;
    }
  }
  return map;
}

const KEY_MAP = loadKeyMapFromEnv();

console.log("[INIT] User keys loaded:", Object.keys(KEY_MAP));

// Health check
app.get('/', (req, res) => {
  res.json({ status: "ok", message: "MCP Proxy running" });
});

app.post('/mcp/call', async (req, res) => {
  try {
    //
    // 1) Read userKey from Authorization header
    //
    const auth = req.headers["authorization"] || "";
    const userKey = auth.replace("Bearer", "").trim();

    if (!userKey) {
      return res.status(401).json({
        error: "Missing Authorization header. Expected 'Authorization: Bearer <userKey>'"
      });
    }

    //
    // 2) UserKey → REAL MCP KEY
    //
    const REAL_KEY = KEY_MAP[userKey];

    if (!REAL_KEY) {
      return res.status(403).json({
        error: "Invalid user key",
        userKey
      });
    }

    //
    // 3) Parse body
    //
    const { server, method, params } = req.body || {};
    if (!server || !method) {
      return res.status(400).json({
        error: "Missing required fields: server, method"
      });
    }

    //
    // 4) Load target server config
    //
    const target = config.servers[server];
    if (!target) {
      return res.status(400).json({
        error: `Unknown server: ${server}`,
        availableServers: Object.keys(config.servers)
      });
    }

    //
    // 5) Build JSON-RPC call
    //
    const jsonRpcRequest = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params: params || {}
    };

    //
    // 6) Forward request to actual MCP server
    //
    const url = target.url;

    const headers = {
      "Content-Type": "application/json",
      ...(target.headers || {}),
      "Authorization": `Bearer ${REAL_KEY}`     // ★ 핵심: 실제 MCP Key 삽입
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(jsonRpcRequest)
    });

    const text = await response.text();

    //
    // 7) Parse response JSON
    //
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({
        error: "Invalid JSON returned by MCP server",
        raw: text
      });
    }

    //
    // 8) Return JSON-RPC response
    //
    return res.status(200).json(data);

  } catch (err) {
    console.error("[Proxy Error]", err);
    return res.status(500).json({
      error: "Internal MCP Proxy error",
      detail: err.message
    });
  }
});

// Run server
const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`MCP Proxy running on port ${port}`);
});
