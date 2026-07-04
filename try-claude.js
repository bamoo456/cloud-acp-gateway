// 本機快速試 Route A：透過 gateway 對真的 Claude agent 送一句 prompt。
// 用法：
//   ACPG_AUTH_TOKEN=<你的token> node try-claude.js "你想問的話"
// 前提：分頁 A 已用 `node dist/gateway.js` 啟動 gateway（一般 terminal，非 Claude Code session）。
const WebSocket = require(__dirname + '/node_modules/ws');

const TOKEN = process.env.ACPG_AUTH_TOKEN;
if (!TOKEN) { console.error('FATAL: 先 export ACPG_AUTH_TOKEN=<分頁A的token>'); process.exit(1); }
const HOST = process.env.HOST || '127.0.0.1:8080';
const AGENT = process.env.AGENT || 'claude';
const PROMPT = process.argv[2] || 'Reply with exactly: BRIDGE_OK_42';

// token/agent 必須 URL 編碼：base64 token 含 + / =，其中 + 會被伺服器解成空格而導致 401
const url = `ws://${HOST}/acp?token=${encodeURIComponent(TOKEN)}&agent=${encodeURIComponent(AGENT)}&cursor=0`;
const ws = new WebSocket(url);
const send = (o) => { ws.send(JSON.stringify(o)); };

ws.on('open', () => {
  console.log(`connected -> ${AGENT}`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } } });
});

ws.on('message', (data) => {
  let m; try { m = JSON.parse(data.toString()); } catch { return; }

  // agent -> client 的反向 request：自動回空 result，避免卡住
  if (m.id !== undefined && m.method) { send({ jsonrpc: '2.0', id: m.id, result: {} }); return; }

  // 串流通知：把 Claude 的文字 chunk 印出來
  if (m.method === 'session/update') {
    const u = m.params && m.params.update;
    if (u && u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') {
      process.stdout.write(u.content.text);
    }
    return;
  }

  if (m.id === 1) {  // initialize OK -> 開 session
    send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
  } else if (m.id === 2) {  // session/new OK -> 送 prompt
    if (m.error) { console.error('\nsession/new ERROR', m.error); process.exit(1); }
    send({ jsonrpc: '2.0', id: 3, method: 'session/prompt',
      params: { sessionId: m.result.sessionId, prompt: [{ type: 'text', text: PROMPT }] } });
  } else if (m.id === 3) {  // prompt 完成
    console.log(`\n\n[done: ${JSON.stringify(m.result || m.error)}]`);
    ws.close(); process.exit(0);
  }
});

ws.on('error', (e) => console.error('WS ERROR', e.message));
ws.on('unexpected-response', (_q, r) => { console.error('連線被拒 HTTP', r.statusCode, '(token 不對?)'); process.exit(1); });
setTimeout(() => { console.error('\nTIMEOUT'); process.exit(2); }, 120000);
