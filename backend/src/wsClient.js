/**
 * Phase 2 — WebSocket Log Stream Client
 * Use this as a test client or import in your React dashboard.
 *
 * Usage:
 *   node wsClient.js [level] [search]
 *   node wsClient.js ERROR timeout
 *   node wsClient.js ALL
 */

const WebSocket = require('ws');

const WS_URL = process.env.WS_URL || 'ws://localhost:3000/ws/logs';
const LEVEL  = process.argv[2] || null;
const SEARCH = process.argv[3] || null;

const BADGE = { INFO: '\x1b[34mINFO \x1b[0m', WARN: '\x1b[33mWARN \x1b[0m', ERROR: '\x1b[31mERROR\x1b[0m', DEBUG: '\x1b[90mDEBUG\x1b[0m' };

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log(`✅ Connected to ${WS_URL}`);
  if (LEVEL || SEARCH) {
    const filter = {};
    if (LEVEL  && LEVEL !== 'ALL') filter.level  = LEVEL;
    if (SEARCH)                    filter.search = SEARCH;
    ws.send(JSON.stringify({ type: 'subscribe', filter }));
    console.log(`📌 Subscribed with filter: ${JSON.stringify(filter)}\n`);
  } else {
    console.log('📌 Receiving all log levels\n');
  }
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'history') {
    console.log(`📜 [history] Received ${msg.logs.length} recent logs:`);
    msg.logs.slice(0, 10).forEach(printLog);
    if (msg.logs.length > 10) console.log(`   ... and ${msg.logs.length - 10} more\n`);
  } else if (msg.type === 'log') {
    printLog(msg.log);
  }
});

function printLog(l) {
  const ts  = l.timestamp.slice(11, 19);
  const svc = (l.service || 'unknown').padEnd(20);
  const rt  = l.responseTime ? `${l.responseTime}ms`.padStart(8) : '       ';
  console.log(`${ts} ${BADGE[l.level] || l.level} [${svc}] ${rt}  ${l.message}`);
}

ws.on('error', (e) => console.error('WebSocket error:', e.message));
ws.on('close', ()  => { console.log('\nConnection closed.'); process.exit(0); });

process.on('SIGINT', () => { ws.close(); });
