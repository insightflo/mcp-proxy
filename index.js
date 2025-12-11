const express = require('express');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors());

const config = JSON.parse(fs.readFileSync('./mcp.config.json', 'utf8'));
const KEY_MAP = process.env.KEY_MAP ? JSON.parse(process.env.KEY_MAP) : {};


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

    // 1) 유저 키 읽기 (헤더에서)
    const userKey = req.headers['x-user-key'];
    if (!userKey) {
      return res.status(401).json({
        error: 'X-User-Key 헤더가 필요합니다.'
      });
    }

    // 2) 유저 키 → 실제 백엔드 키 매핑
    const realKey = KEY_MAP[userKey];
    if (!realKey) {
      return res.status(403).json({
        error: '유효하지 않은 X-User-Key 입니다.'
      });
    }

    const url = target.url;

    // 3) MCP 서버로 보낼 헤더 구성
    const headers = {
      'Content-Type': 'application/json',
      ...(target.headers || {}),        // 필요하면 추가 header
      'Authorization': `Bearer ${realKey}`  // 여기서 실제 키 주입
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

