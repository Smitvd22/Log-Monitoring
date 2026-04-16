/**
 * Log Monitoring & Alert System — Phase 3 (FINAL)
 * ================================================
 * Phase 3 additions over Phase 2:
 *   • Anomaly detection: Z-score error spike + IQR response-time outlier
 *   • /api/anomalies   — real-time anomaly feed
 *   • /api/heatmap     — hour × day-of-week error density
 *   • /api/trace/:id   — distributed trace aggregation
 *   • /api/ingest/bulk — multi-source batch ingest endpoint
 *   • /api/metrics     — Prometheus text format (for Grafana/CloudWatch EMF)
 *   • /api/health/deep — auto-scaling readiness probe
 *   • Syslog UDP listener (port 5140)
 *   • Log rotation at 100 MB
 */

const express   = require('express');
const http      = require('http');
const dgram     = require('dgram');
const WebSocket = require('ws');
const fs        = require('fs');
const path      = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const cors      = require('cors');
const os        = require('os');
const crypto    = require('crypto');
const {
  resolveRegion,
  getAwsStatus,
  listLogGroups,
  listBuckets,
  listTopics,
  listFunctions,
} = require('./awsServices');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws/logs' });
const PORT        = process.env.PORT        || 3000;
const SYSLOG_PORT = parseInt(process.env.SYSLOG_PORT) || 5140;
const API_KEY     = process.env.API_KEY || null;

// Test mode: enable runtime debug helpers by default unless explicitly disabled
const TEST_MODE = (typeof process.env.TEST_MODE !== 'undefined') ? (process.env.TEST_MODE === '1' || process.env.TEST_MODE === 'true') : true;
let testMode = TEST_MODE;

const LOG_DIR      = path.join(__dirname, '../logs');
const LOG_FILE     = path.join(LOG_DIR, 'app.log');
const ANOMALY_FILE = path.join(LOG_DIR, 'anomalies.log');
const MAX_LOG_BYTES = 100 * 1024 * 1024;
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Ring buffers
const MAX_BUFFER = 5000;
let logBuffer    = [];
let anomalyBuf   = [];
const sourceCounts = { http:0, syslog:0, bulk:0, lambda:0 };

// ── Anomaly Detection ─────────────────────────────────────────────────────
const BASELINE_WINDOW = 20;
const Z_THRESH        = 2.5;
const errHistory      = new Array(BASELINE_WINDOW).fill(0);
let   errMinuteCur    = 0;
let   lastMinute      = Date.now();
const rtHistory       = [];

function tickBaseline(isError) {
  if (Date.now() - lastMinute >= 60000) {
    errHistory.shift(); errHistory.push(errMinuteCur);
    errMinuteCur = 0; lastMinute = Date.now();
  }
  if (isError) errMinuteCur++;
}

function zScoreAnomaly(entry) {
  const hist = errHistory.filter(v => v > 0);
  if (hist.length < 5) return null;
  const mean   = hist.reduce((a,b)=>a+b,0) / hist.length;
  const stdDev = Math.sqrt(hist.map(v=>(v-mean)**2).reduce((a,b)=>a+b,0)/hist.length);
  if (stdDev === 0) return null;
  const z = (errMinuteCur - mean) / stdDev;
  if (z < Z_THRESH) return null;
  return {
    id: crypto.randomBytes(6).toString('hex'),
    timestamp: new Date().toISOString(), type: 'ERROR_SPIKE',
    zScore: +z.toFixed(2), currentRate: errMinuteCur,
    baseline: +mean.toFixed(2), stdDev: +stdDev.toFixed(2),
    severity: z >= 4 ? 'CRITICAL' : 'WARNING', service: entry.service,
    description: `Error rate ${errMinuteCur}/min is ${z.toFixed(1)}σ above baseline (${mean.toFixed(1)}/min)`,
  };
}

function iqrAnomaly(rt, service) {
  if (!rt) return null;
  rtHistory.push(rt);
  if (rtHistory.length > 500) rtHistory.shift();
  if (rtHistory.length < 50) return null;
  const s  = rtHistory.slice().sort((a,b)=>a-b);
  const q1 = s[Math.floor(s.length*.25)];
  const q3 = s[Math.floor(s.length*.75)];
  const fence = q3 + 3*(q3-q1);
  if (rt <= fence || rt <= 2000) return null;
  return {
    id: crypto.randomBytes(6).toString('hex'),
    timestamp: new Date().toISOString(), type: 'SLOW_REQUEST',
    severity: rt > 10000 ? 'CRITICAL' : 'WARNING',
    responseTime: rt, fence: Math.round(fence), service,
    description: `Response ${rt}ms exceeds IQR fence (${Math.round(fence)}ms) for ${service}`,
  };
}

function recordAnomaly(a) {
  if (!a) return;
  anomalyBuf.unshift(a);
  if (anomalyBuf.length > 200) anomalyBuf.pop();
  fs.appendFileSync(ANOMALY_FILE, JSON.stringify(a)+'\n');
  broadcastWS({ type:'anomaly', anomaly:a });
  console.log(`🔬 ANOMALY [${a.severity}] ${a.type}: ${a.description}`);
}

// ── Logger ────────────────────────────────────────────────────────────────
const LEVELS = ['INFO','WARN','ERROR','DEBUG'];

function rotateLog() {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size >= MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE.replace('.log',`.${Date.now()}.log`));
    }
  } catch {}
}

function writeLog(level, message, meta={}) {
  const entry = {
    timestamp: new Date().toISOString(), level, message,
    service: meta.service || 'log-monitor-app',
    host: os.hostname(), pid: process.pid,
    traceId: meta.traceId || crypto.randomBytes(8).toString('hex'),
    requestId: meta.requestId || null,
    source: meta.source || 'http',
    environment: process.env.NODE_ENV || 'development',
    version: '3.0.0', ...meta,
  };
  rotateLog();
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry)+'\n');
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER) logBuffer.shift();
  sourceCounts[entry.source] = (sourceCounts[entry.source]||0)+1;
  broadcastWS({ type:'log', log:entry });
  tickBaseline(level==='ERROR');
  recordAnomaly(zScoreAnomaly(entry));
  recordAnomaly(iqrAnomaly(entry.responseTime, entry.service));
  return entry;
}

// ── WebSocket ─────────────────────────────────────────────────────────────
const wsClients = new Set();

wss.on('connection', ws => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ type:'history', logs: logBuffer.slice(-100) }));
  ws.send(JSON.stringify({ type:'anomalies', anomalies: anomalyBuf.slice(0,20) }));
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type==='subscribe') {
        ws.filterLevel   = msg.filter?.level   || null;
        ws.filterSearch  = (msg.filter?.search||'').toLowerCase()||null;
        ws.filterService = msg.filter?.service || null;
      }
    } catch {}
  });
  ws.on('close', ()=>wsClients.delete(ws));
  ws.on('error', ()=>wsClients.delete(ws));
});

function broadcastWS(payload) {
  const s = JSON.stringify(payload);
  for (const ws of wsClients) {
    if (ws.readyState !== WebSocket.OPEN) { wsClients.delete(ws); continue; }
    if (payload.type==='log') {
      const l=payload.log;
      if (ws.filterLevel   && l.level   !==ws.filterLevel)   continue;
      if (ws.filterService && l.service !==ws.filterService)  continue;
      if (ws.filterSearch  && !l.message.toLowerCase().includes(ws.filterSearch)) continue;
    }
    try { ws.send(s); } catch {}
  }
}

// ── Syslog UDP ────────────────────────────────────────────────────────────
const syslog = dgram.createSocket('udp4');
syslog.on('message', msg => {
  const raw=msg.toString().trim();
  const pri=parseInt((raw.match(/^<(\d+)>/)||[0,'14'])[1]);
  const sev=pri&7;
  const lvl={0:'ERROR',1:'ERROR',2:'ERROR',3:'ERROR',4:'WARN',5:'WARN',6:'INFO',7:'DEBUG'}[sev]||'INFO';
  writeLog(lvl, raw.replace(/^<\d+>/,'').trim(), { source:'syslog', service:'system' });
});
syslog.bind(SYSLOG_PORT, ()=>console.log(`📡 Syslog UDP :${SYSLOG_PORT}`));

// ── Middleware ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit:'10mb' }));

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const raw = req.headers['x-api-key'] || req.headers.authorization || '';
  const key = raw.replace(/^Bearer\s+/i, '').trim();
  if (key && key === API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/ui-config', (_req, res) => {
  const apiBase = process.env.UI_API_BASE || '';
  const region = resolveRegion(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION);
  res.json({ apiBase, awsRegion: region, apiKey: API_KEY || '' });
});

// Serve dashboard static files at server root when available
const STATIC_DIR = path.join(__dirname, '..', '..', 'dashboard');
if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.get('/', (_req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')));
}

app.use((req,_res,next)=>{ req.traceId=crypto.randomBytes(8).toString('hex'); next(); });
app.use((req,res,next)=>{
  const t=Date.now();
  res.on('finish',()=>{
    const d=Date.now()-t;
    const lv=res.statusCode>=500?'ERROR':res.statusCode>=400?'WARN':'INFO';
    writeLog(lv,`HTTP ${req.method} ${req.path}`,{
      method:req.method, path:req.path, statusCode:res.statusCode,
      responseTime:d, ip:req.ip, traceId:req.traceId,
      requestId:req.headers['x-request-id']||req.traceId,
    });
  });
  next();
});

// ── Query helper ──────────────────────────────────────────────────────────
function query({level,search,service,source,from,to,limit=200}) {
  let r=logBuffer.slice().reverse();
  if (level  &&level  !=='ALL') r=r.filter(l=>l.level  ===level.toUpperCase());
  if (service&&service!=='ALL') r=r.filter(l=>l.service===service);
  if (source &&source !=='ALL') r=r.filter(l=>l.source ===source);
  if (search){const q=search.toLowerCase();r=r.filter(l=>l.message.toLowerCase().includes(q)||(l.traceId||'').includes(q));}
  if (from){const ts=new Date(from).getTime();r=r.filter(l=>new Date(l.timestamp).getTime()>=ts);}
  if (to)  {const ts=new Date(to).getTime();  r=r.filter(l=>new Date(l.timestamp).getTime()<=ts);}
  return r.slice(0,Math.min(limit,1000));
}

// ── Routes ────────────────────────────────────────────────────────────────
app.get('/health', (_req,res)=>res.json({status:'ok',uptime:process.uptime(),wsClients:wsClients.size,bufferSize:logBuffer.length,anomalies:anomalyBuf.length,sourceCounts}));

app.get('/api/health/deep', (_req,res)=>{
  const since=Date.now()-60000;
  const rec=logBuffer.filter(l=>new Date(l.timestamp).getTime()>=since);
  const errRate=rec.length>0?rec.filter(l=>l.level==='ERROR').length/rec.length:0;
  const mem=process.memoryUsage().heapUsed/1024/1024;
  const ok=errRate<0.5&&mem<512&&logBuffer.length<MAX_BUFFER*.9;
  res.status(ok?200:503).json({healthy:ok,errRatePct:+(errRate*100).toFixed(1),memMB:Math.round(mem),bufferPct:Math.round(logBuffer.length/MAX_BUFFER*100)});
});

app.get('/api/metrics', (_req,res)=>{
  const since=Date.now()-60000;
  const cnt={INFO:0,WARN:0,ERROR:0,DEBUG:0};
  logBuffer.filter(l=>new Date(l.timestamp).getTime()>=since).forEach(l=>cnt[l.level]++);
  res.set('Content-Type','text/plain; version=0.0.4').send([
    '# HELP log_monitor_log_total Log entries per level (last 60s)',
    '# TYPE log_monitor_log_total counter',
    ...Object.entries(cnt).map(([l,v])=>`log_monitor_log_total{level="${l}"} ${v}`),
    `log_monitor_anomalies_total ${anomalyBuf.length}`,
    `log_monitor_ws_clients ${wsClients.size}`,
    `log_monitor_buffer_size ${logBuffer.length}`,
  ].join('\n'));
});

app.get('/api/logs',  (req,res)=>{ const {level,search,service,source,from,to,limit}=req.query; const r=query({level,search,service,source,from,to,limit:parseInt(limit)||200}); res.json({count:r.length,logs:r}); });
app.post('/api/log',  (req,res)=>{ const {level='INFO',message='',meta={},service}=req.body; if(!LEVELS.includes(level))return res.status(400).json({error:'Invalid level'}); res.json({logged:writeLog(level,message,{...meta,service:service||meta.service})}); });
app.delete('/api/logs',(_req,res)=>{ logBuffer.length=0; anomalyBuf.length=0; fs.writeFileSync(LOG_FILE,''); res.json({message:'Cleared'}); });

app.post('/api/ingest/bulk', (req,res)=>{
  const {logs:inc=[],source='bulk'}=req.body;
  if (!Array.isArray(inc)) return res.status(400).json({error:'logs must be array'});
  const written=[];
  for (const e of inc.slice(0,500)) {
    if (!LEVELS.includes(e.level)) continue;
    written.push(writeLog(e.level, e.message||'', {...e,source}));
  }
  res.json({accepted:written.length});
});

app.get('/api/timeline', (req,res)=>{
  const mins=parseInt(req.query.minutes)||30;
  const now=Date.now(); const b={};
  for (let i=mins-1;i>=0;i--){const k=new Date(now-i*60000).toISOString().slice(0,16);b[k]={INFO:0,WARN:0,ERROR:0,DEBUG:0,total:0};}
  for (const l of logBuffer){const k=l.timestamp.slice(0,16);if(b[k]){b[k][l.level]++;b[k].total++;}}
  res.json(Object.entries(b).map(([time,c])=>({time,...c})));
});

app.get('/api/stats', (_req,res)=>{
  const since=Date.now()-5*60*1000;
  const rec=logBuffer.filter(l=>new Date(l.timestamp).getTime()>=since);
  const cnt={INFO:0,WARN:0,ERROR:0,DEBUG:0}; const rts=[];
  rec.forEach(l=>{cnt[l.level]++;if(l.responseTime)rts.push(l.responseTime);});
  rts.sort((a,b)=>a-b);
  const avg=rts.length?Math.round(rts.reduce((a,b)=>a+b,0)/rts.length):0;
  res.json({total:rec.length,...cnt,avgResponseTime:avg,p95ResponseTime:rts[Math.floor(rts.length*.95)]||0,p99ResponseTime:rts[Math.floor(rts.length*.99)]||0,errorRate:rec.length>0?((cnt.ERROR/rec.length)*100).toFixed(1):'0.0',wsClients:wsClients.size,bufferSize:logBuffer.length,anomalies:anomalyBuf.length,sourceCounts});
});

app.get('/api/anomalies', (req,res)=>res.json({count:anomalyBuf.length,anomalies:anomalyBuf.slice(0,parseInt(req.query.limit)||50)}));

app.get('/api/heatmap', (_req,res)=>{
  const matrix=Array.from({length:7},()=>new Array(24).fill(0));
  logBuffer.filter(l=>l.level==='ERROR').forEach(l=>{const d=new Date(l.timestamp);matrix[d.getDay()][d.getHours()]++;});
  res.json({days:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],hours:Array.from({length:24},(_,i)=>i),matrix});
});

app.get('/api/trace/:id', (req,res)=>{
  const spans=logBuffer.filter(l=>l.traceId===req.params.id).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  res.json({traceId:req.params.id,spanCount:spans.length,spans});
});

// Simple alerts endpoint (wraps current anomaly buffer as alert feed).
app.get('/api/alerts', (_req,res)=>{
  res.json({count:anomalyBuf.length,alerts:anomalyBuf.slice(0,parseInt(_req.query?.limit)||50)});
});

// ── AWS connectivity endpoints (API key protected if configured) ─────────
app.use('/api/aws', requireApiKey);

app.get('/api/aws/status', async (req, res) => {
  try {
    const region = resolveRegion(req.query.region);
    const status = await getAwsStatus(region);
    return res.json(status);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'AWS status failed' });
  }
});

app.get('/api/aws/cloudwatch/log-groups', async (req, res) => {
  try {
    const region = resolveRegion(req.query.region);
    const limit = parseInt(req.query.limit) || 20;
    const data = await listLogGroups(region, Math.min(limit, 50));
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'CloudWatch query failed' });
  }
});

app.get('/api/aws/s3/buckets', async (req, res) => {
  try {
    const region = resolveRegion(req.query.region);
    const data = await listBuckets(region);
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'S3 query failed' });
  }
});

app.get('/api/aws/sns/topics', async (req, res) => {
  try {
    const region = resolveRegion(req.query.region);
    const limit = parseInt(req.query.limit) || 20;
    const data = await listTopics(region, Math.min(limit, 50));
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'SNS query failed' });
  }
});

app.get('/api/aws/lambda/functions', async (req, res) => {
  try {
    const region = resolveRegion(req.query.region);
    const limit = parseInt(req.query.limit) || 20;
    const data = await listFunctions(region, Math.min(limit, 50));
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Lambda query failed' });
  }
});

// DEBUG: seed error-history and current error-minute to help testing anomaly detector
app.post('/api/debug/seed_anomaly', (req,res)=>{
  try{
    const {history, current} = req.body || {};
    if (!Array.isArray(history) || history.length===0) return res.status(400).json({error:'history must be non-empty array'});
    // clamp to BASELINE_WINDOW
    const arr = history.slice(-BASELINE_WINDOW);
    while(arr.length < BASELINE_WINDOW) arr.unshift(0);
    for (let i=0;i<BASELINE_WINDOW;i++) errHistory[i]=arr[i];
    errMinuteCur = parseInt(current) || 0;
    lastMinute = Date.now();
    return res.json({ok:true,errHistory,errMinuteCur});
  }catch(e){ return res.status(500).json({error:e.message}); }
});

// Runtime test-mode toggle and helpers
app.get('/api/debug/testmode', (_req,res)=>res.json({testMode}));
app.post('/api/debug/testmode', (req,res)=>{
  const enable = req.body && typeof req.body.enabled !== 'undefined' ? !!req.body.enabled : true;
  testMode = enable;
  res.json({testMode});
});

app.post('/api/debug/force_anomaly', (req,res)=>{
  if (!testMode) return res.status(403).json({error:'testMode disabled'});
  try{
    const b = req.body || {};
    const a = {
      id: crypto.randomBytes(6).toString('hex'),
      timestamp: new Date().toISOString(),
      type: b.type || 'FORCED_ANOMALY',
      severity: b.severity || 'WARNING',
      service: b.service || 'test-service',
      description: b.description || 'Forced anomaly via testMode',
    };
    recordAnomaly(a);
    return res.json({ok:true,anomaly:a});
  }catch(e){return res.status(500).json({error:e.message});}
});

app.post('/api/debug/emit_logs', (req,res)=>{
  if (!testMode) return res.status(403).json({error:'testMode disabled'});
  try{
    const {count=50, level='ERROR', services=['api-gateway','auth-service','order-service','payment-service','log-monitor-app']} = req.body || {};
    const emitted=[];
    for(let i=0;i<count;i++){
      const svc = services[i%services.length];
      emitted.push(writeLog(level, `testmode log ${i+1}`, {service:svc, source:'testmode'}));
    }
    return res.json({emitted:emitted.length});
  }catch(e){return res.status(500).json({error:e.message});}
});

app.get('/api/top-errors', (req,res)=>{
  const f={};
  logBuffer.filter(l=>l.level==='ERROR').forEach(e=>{const k=e.message.slice(0,80);if(!f[k])f[k]={message:e.message,count:0,lastSeen:e.timestamp,service:e.service};f[k].count++;if(e.timestamp>f[k].lastSeen)f[k].lastSeen=e.timestamp;});
  res.json(Object.values(f).sort((a,b)=>b.count-a.count).slice(0,parseInt(req.query.limit)||10));
});

app.get('/api/services', (_req,res)=>res.json([...new Set(logBuffer.map(l=>l.service).filter(Boolean))]));
app.get('/simulate', (_req,res)=>{ const s=[{lv:'INFO',msg:'User login',meta:{service:'auth-service'}},{lv:'WARN',msg:'High memory',meta:{}},{lv:'ERROR',msg:'DB timeout',meta:{service:'order-service'}}][Math.floor(Math.random()*3)]; res.json({logged:writeLog(s.lv,s.msg,s.meta)}); });

server.listen(PORT, ()=>{
  writeLog('INFO','Phase 3 server started',{port:PORT,features:['anomaly-detection','heatmap','trace','bulk-ingest','prometheus','syslog','log-rotation']});
  console.log(`\n🚀 Phase 3 Log Monitor → http://localhost:${PORT}`);
  console.log(`   /api/anomalies  /api/heatmap  /api/trace/:id  /api/metrics\n`);
});

process.on('SIGTERM',()=>{writeLog('INFO','SIGTERM shutdown');server.close(()=>process.exit(0));});
module.exports={app,server};
