const express = require('express');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors());

const config = JSON.parse(fs.readFileSync('./mcp.config.json', 'utf8'));

// 단순 헬스체크
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'MCP Proxy running' });
});

/**
 * POST /mcp/call
 *
 * body 예시:
 * {
 *   "server": "example",
 *   "method": "tools/call",
 *   "params": {
 *     "name": "search",
 *     "arguments": { "query": "삼성전자 실적" }
 *   }
 * }
 */
app.post('/mcp/call', async (req, res) => {
  try {
    const { server, method, params } = req.body || {};

    if (!server || !method) {
      return res.status(400).json({
        error: 'server, method 는 필수입니다.'
      });
    }

    const target = config.servers[server];
    if (!target) {
      return res.status(400).json({
        error: `알 수 없는 server: ${server}`
      });
    }

    const url = target.url;
    const headers = {
      'Content-Type': 'application/json',
      ...(target.headers || {})
    };

    const id = crypto.randomUUID();

    const jsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params: params || {}
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(jsonRpcRequest)
    });

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return res.status(502).json({
        error: 'MCP 서버 응답이 JSON 이 아닙니다.',
        raw: text
      });
    }

    // JSON-RPC 표준 응답 형태 그대로 전달
    return res.status(200).json(json);
  } catch (err) {
    console.error('MCP Proxy error:', err);
    return res.status(500).json({
      error: 'Internal MCP Proxy error',
      detail: err.message
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`MCP Proxy listening on port ${port}`);
});

