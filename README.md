# Remote MCP Server for Claude.ai

n8n MCP 서버를 Claude.ai 웹/모바일에서 사용할 수 있도록 하는 Remote MCP Proxy 서버입니다.

## 🏗️ 아키텍처

```
Claude.ai Web/Mobile
    ↓ (SSE)
Remote MCP Server (Railway)
    ↓ (SSE)
n8n MCP Server (https://n8n-auto.showk.ing/mcp/...)
    ↓
주식 분석 도구들
```

## 🚀 Railway 배포

### 1. Railway 프로젝트 생성
```bash
# Railway CLI 설치 (선택)
npm install -g @railway/cli

# Railway 로그인
railway login

# 새 프로젝트 생성
railway init

# 배포
railway up
```

### 2. 환경변수 설정
Railway 대시보드 → Variables 메뉴에서 다음 환경변수 추가:

```bash
# n8n MCP 서버 URL (필수)
N8N_MCP_URL=https://n8n-auto.showk.ing/mcp/a3711111-1111-1111-1aaa-a1111111111

# n8n API 키 (필요시)
N8N_API_KEY=your_api_key_here

# 포트 (Railway가 자동 설정하므로 선택)
PORT=3000
```

### 3. 배포 확인
```bash
# Health check
curl https://your-app.railway.app/

# 응답 예시:
# {
#   "status": "ok",
#   "service": "Remote MCP Server",
#   "version": "1.0.0",
#   "activeSessions": 0
# }
```

## 🔗 Claude.ai 연결

### Custom Connector 추가

1. **Claude.ai 웹 접속**
   - https://claude.ai 로그인

2. **Settings → Custom Connectors**
   - "Add Custom Connector" 클릭

3. **MCP Server URL 입력**
   ```
   https://your-app.railway.app/sse
   ```

4. **연결 확인**
   - 연결되면 도구 목록이 자동으로 로드됨
   - 채팅에서 "오늘 미국 시장 시황 알려줘" 같은 명령 테스트

## 📝 사용 예시

Claude.ai 웹에서 다음과 같이 사용 가능:

```
사용자: 오늘 미국 증시 시황 알려줘
Claude: [get_market_brief 도구 호출] ...

사용자: 엔비디아 분석해줘
Claude: [analyze_target_stock 도구 호출] ...

사용자: 내 포트폴리오 조회
Claude: [get_my_portfolio 도구 호출] ...
```

## 🛠️ 로컬 테스트

```bash
# 패키지 설치
npm install

# 환경변수 설정 (.env.local)
N8N_MCP_URL=https://example.com/mcp/...

# 서버 실행
npm start

# 테스트
curl http://localhost:3000/
```

## 📊 로그 확인

Railway 대시보드에서 실시간 로그 확인:
```
✅ Remote MCP Server running on port 3000
📡 SSE Endpoint: http://localhost:3000/sse
🔗 n8n Backend: https://n8n-auto.showk.ing/mcp/...
📦 Tools will be loaded from n8n on first connection

[SSE] New connection: abc-123-...
[n8n] Connecting to https://n8n-auto.showk.ing/mcp/...
[n8n] Session URL: https://n8n-auto.showk.ing/session/...
[n8n] Initialized successfully
[n8n] Loaded 15 tools
[SSE] Session abc-123 created with 15 tools
```

## 🔧 트러블슈팅

### 연결 안 됨
- Railway 로그에서 n8n 연결 상태 확인
- N8N_MCP_URL 환경변수가 올바른지 확인
- n8n 서버가 실행 중인지 확인

### 도구 실행 실패
- n8n 워크플로우가 활성화되어 있는지 확인
- n8n 로그에서 오류 메시지 확인

### 세션 끊김
- Railway 로그에서 SSE 연결 상태 확인
- Claude.ai에서 재연결 시도

## 📦 파일 구조

```
remote-mcp-proxy/
├── remote-mcp-server.js  # 메인 서버
├── package.json           # 의존성
└── README.md             # 이 문서
```

## 🔐 보안

- n8n API 키는 환경변수로 관리
- Railway 환경변수는 암호화되어 저장됨
- SSE 연결은 HTTPS로 암호화

## 📄 라이선스

MIT