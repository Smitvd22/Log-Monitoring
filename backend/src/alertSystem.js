/**
 * Phase 3 — Alert System (Final)
 * Enhancements:
 *   • Anomaly-driven alerts (subscribes to /api/anomalies polling + WS push)
 *   • Per-service SLA tracking (error budget)
 *   • Alert escalation: WARNING → CRITICAL after repeated violations
 *   • Alert suppression / maintenance window
 *   • Full AWS SNS with structured MessageAttributes
 *   • Slack webhook support (set SLACK_WEBHOOK_URL)
 *   • Alert REST API on :3001
 */

const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const WebSocket = require('ws');

// ── SNS ───────────────────────────────────────────────────────────────────
let SNSClient, PublishCommand;
if (process.env.AWS_SNS_TOPIC_ARN) {
  try {
    ({SNSClient, PublishCommand} = require('@aws-sdk/client-sns'));
  } catch { console.warn('⚠️  Install @aws-sdk/client-sns for SNS support'); }
}
const sns = (SNSClient && process.env.AWS_SNS_TOPIC_ARN)
  ? new SNSClient({ region: process.env.AWS_DEFAULT_REGION || 'us-east-1' })
  : null;

// ── Config ────────────────────────────────────────────────────────────────
const CFG = {
  apiUrl      : process.env.API_URL      || 'http://localhost:3000',
  wsUrl       : process.env.WS_URL       || 'ws://localhost:3000/ws/logs',
  pollMs      : parseInt(process.env.POLL_INTERVAL_MS) || 10000,
  snsTopic    : process.env.AWS_SNS_TOPIC_ARN   || null,
  slackWebhook: process.env.SLACK_WEBHOOK_URL   || null,
  alertLogFile: path.join(__dirname, '../logs/alerts.log'),
  maintenance : false, // set true to suppress all alerts
  thresholds  : {
    errorCount  : parseInt(process.env.ERROR_THRESHOLD)       || 5,
    warnCount   : parseInt(process.env.WARN_THRESHOLD)        || 10,
    errorRate   : parseFloat(process.env.ERROR_RATE_THRESHOLD) || 0.20,
    avgRT       : parseInt(process.env.RESP_TIME_THRESHOLD)    || 500,
    p95RT       : parseInt(process.env.P95_THRESHOLD)         || 2000,
    p99RT       : parseInt(process.env.P99_THRESHOLD)         || 5000,
    errorVelocity: 3,
  },
  errorBudget: { window: 5 * 60 * 1000, maxRate: 0.01 }, // 1% error budget
};

// ── State ─────────────────────────────────────────────────────────────────
const alertHistory  = [];
const firedAt       = {};
const violationCount= {}; // for escalation
const COOLDOWN      = 5 * 60 * 1000;
const errVelocityH  = [];

// ── Delivery ──────────────────────────────────────────────────────────────
async function deliver(severity, ruleId, message, data={}) {
  if (CFG.maintenance) { console.log(`[MAINT] Suppressed: ${ruleId}`); return; }

  const now    = Date.now();
  const record = { id: Math.random().toString(36).slice(2), timestamp: new Date().toISOString(), severity, ruleId, message, data };

  // Escalation: repeated violations increase severity
  violationCount[ruleId] = (violationCount[ruleId]||0)+1;
  if (violationCount[ruleId] >= 3 && severity === 'WARNING') {
    severity = 'CRITICAL';
    record.severity = 'CRITICAL';
    record.escalated = true;
  }

  const icon = severity==='CRITICAL'?'🔴':severity==='WARNING'?'🟡':'🟢';
  console.log(`\n${icon} [${severity}] ${ruleId}`);
  console.log(`   ${message}`);
  if (Object.keys(data).length) console.log(`   ${JSON.stringify(data)}`);

  alertHistory.unshift(record);
  if (alertHistory.length > 100) alertHistory.pop();
  fs.appendFileSync(CFG.alertLogFile, JSON.stringify(record)+'\n');

  // AWS SNS
  if (sns && CFG.snsTopic) {
    try {
      await sns.send(new PublishCommand({
        TopicArn : CFG.snsTopic,
        Subject  : `[${severity}] ${ruleId}`,
        Message  : JSON.stringify({...record, source:'log-monitor-phase3'}, null, 2),
        MessageAttributes: {
          severity: { DataType:'String', StringValue:severity },
          ruleId  : { DataType:'String', StringValue:ruleId },
        },
      }));
      console.log('   📨 SNS published');
    } catch(e) { console.error('   ❌ SNS:', e.message); }
  }

  // Slack
  if (CFG.slackWebhook) {
    try {
      const body = JSON.stringify({ text:`${icon} *${severity}* — ${ruleId}\n${message}\n\`\`\`${JSON.stringify(data)}\`\`\`` });
      const url  = new URL(CFG.slackWebhook);
      const req  = https.request({ hostname:url.hostname, path:url.pathname, method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} });
      req.write(body); req.end();
    } catch {}
  }
}

function shouldFire(id) {
  const now=Date.now();
  if (!firedAt[id] || now-firedAt[id]>COOLDOWN) { firedAt[id]=now; return true; }
  return false;
}

// ── Rules ─────────────────────────────────────────────────────────────────
async function evaluate(stats) {
  const {ERROR=0,WARN=0,total=0,avgResponseTime=0,p95ResponseTime=0,p99ResponseTime=0}=stats;
  const rate = total>0 ? ERROR/total : 0;

  if (ERROR>=CFG.thresholds.errorCount    &&shouldFire('HIGH_ERROR_COUNT'))   await deliver('CRITICAL','HIGH_ERROR_COUNT',   `${ERROR} errors/5min (threshold ${CFG.thresholds.errorCount})`,{ERROR,total});
  if (rate >=CFG.thresholds.errorRate     &&shouldFire('HIGH_ERROR_RATE'))    await deliver('CRITICAL','HIGH_ERROR_RATE',    `Error rate ${(rate*100).toFixed(1)}% ≥ ${CFG.thresholds.errorRate*100}%`,{ERROR,total});
  if (WARN >=CFG.thresholds.warnCount     &&shouldFire('HIGH_WARN_COUNT'))    await deliver('WARNING', 'HIGH_WARN_COUNT',    `${WARN} warnings/5min (threshold ${CFG.thresholds.warnCount})`,{WARN});
  if (avgResponseTime>=CFG.thresholds.avgRT&&shouldFire('SLOW_AVG_RT'))       await deliver('WARNING', 'SLOW_AVG_RT',        `Avg RT ${avgResponseTime}ms ≥ ${CFG.thresholds.avgRT}ms`,{avgResponseTime});
  if (p95ResponseTime>=CFG.thresholds.p95RT&&shouldFire('SLOW_P95_RT'))       await deliver('CRITICAL','SLOW_P95_RT',        `P95 RT ${p95ResponseTime}ms ≥ ${CFG.thresholds.p95RT}ms`,{p95ResponseTime});
  if (p99ResponseTime>=CFG.thresholds.p99RT&&shouldFire('SLOW_P99_RT'))       await deliver('CRITICAL','SLOW_P99_RT',        `P99 RT ${p99ResponseTime}ms ≥ ${CFG.thresholds.p99RT}ms`,{p99ResponseTime});

  // Velocity
  errVelocityH.push({t:Date.now(),n:ERROR});
  if (errVelocityH.length>10) errVelocityH.shift();
  if (errVelocityH.length>=3) {
    const el=(errVelocityH.at(-1).t-errVelocityH[0].t)/60000||1;
    const vel=(errVelocityH.at(-1).n-errVelocityH[0].n)/el;
    if (vel>=CFG.thresholds.errorVelocity&&shouldFire('ERROR_VELOCITY')) await deliver('CRITICAL','ERROR_VELOCITY',`Error rate increasing at ${vel.toFixed(1)}/min`,{velocity:vel.toFixed(2)});
  }

  // Error budget
  if (rate>=CFG.errorBudget.maxRate&&shouldFire('ERROR_BUDGET_BURN')) await deliver('CRITICAL','ERROR_BUDGET_BURN',`Error budget burning: ${(rate*100).toFixed(2)}% > SLA target ${CFG.errorBudget.maxRate*100}%`,{rate:rate.toFixed(4)});
}

// ── Anomaly alert from API ────────────────────────────────────────────────
async function checkAnomalies() {
  try {
    const data = await getJSON(`${CFG.apiUrl}/api/anomalies?limit=5`);
    for (const a of (data.anomalies||[])) {
      const id=`ANOMALY_${a.id}`;
      if (!firedAt[id]) {
        firedAt[id] = Date.now();
        await deliver(a.severity, `ANOMALY_${a.type}`, a.description, {zScore:a.zScore||null,responseTime:a.responseTime||null,service:a.service});
      }
    }
  } catch {}
}

// ── WebSocket real-time anomaly listener ──────────────────────────────────
function connectWS() {
  try {
    const ws = new WebSocket(CFG.wsUrl);
    ws.on('open', ()=>{ console.log('[WS] Alert system connected to log stream'); ws.send(JSON.stringify({type:'subscribe',filter:{level:'ERROR'}})); });
    ws.on('message', async raw=>{
      try {
        const msg=JSON.parse(raw.toString());
        if (msg.type==='anomaly') {
          const a=msg.anomaly;
          const id=`RT_ANOMALY_${a.id}`;
          if (!firedAt[id]) { firedAt[id]=Date.now(); await deliver(a.severity,`RT_${a.type}`,`[Real-time] ${a.description}`,{}); }
        }
        if (msg.type==='log'&&msg.log.level==='ERROR'&&msg.log.message.includes('Payment')&&shouldFire('RT_PAYMENT_ERR')) {
          await deliver('CRITICAL','PAYMENT_ERROR_RT',`Real-time payment error: ${msg.log.message}`,{service:msg.log.service,traceId:msg.log.traceId});
        }
      } catch {}
    });
    ws.on('close', ()=>setTimeout(connectWS, 5000));
    ws.on('error', ()=>setTimeout(connectWS, 5000));
  } catch { setTimeout(connectWS, 5000); }
}

function getJSON(url) {
  return new Promise((res,rej)=>{
    http.get(url,r=>{ let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d));}catch(e){rej(e);}}); }).on('error',rej);
  });
}

// ── Poll loop ────────────────────────────────────────────────────────────
async function poll() {
  try {
    const stats=await getJSON(`${CFG.apiUrl}/api/stats`);
    const ts=new Date().toLocaleTimeString();
    process.stdout.write(`[${ts}] E:${stats.ERROR||0} W:${stats.WARN||0} total:${stats.total||0} avg:${stats.avgResponseTime||0}ms p95:${stats.p95ResponseTime||0}ms\n`);
    await evaluate(stats);
    await checkAnomalies();
  } catch(e) { console.error('⚠️  API unreachable:', e.message); }
}

// ── Alert HTTP API (for dashboard to read) ───────────────────────────────
const alertApi = http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Content-Type','application/json');
  if (req.url==='/alerts') { res.end(JSON.stringify({count:alertHistory.length,alerts:alertHistory})); }
  else if (req.url==='/maintenance' && req.method==='POST') { CFG.maintenance=!CFG.maintenance; res.end(JSON.stringify({maintenance:CFG.maintenance})); }
  else { res.writeHead(404); res.end(); }
});
alertApi.listen(3001, ()=>console.log('[Alert API] :3001/alerts'));

// ── Start ─────────────────────────────────────────────────────────────────
console.log('🔔 Phase 3 Alert System');
console.log(`   SNS     : ${CFG.snsTopic||'not configured'}`);
console.log(`   Slack   : ${CFG.slackWebhook?'configured':'not configured'}`);
console.log(`   Thresholds: E≥${CFG.thresholds.errorCount} W≥${CFG.thresholds.warnCount} p95≥${CFG.thresholds.p95RT}ms\n`);

connectWS();
poll();
setInterval(poll, CFG.pollMs);
