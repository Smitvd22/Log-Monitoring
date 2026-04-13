/**
 * Phase 3 — Multi-Source Log Generator
 * Generates realistic traffic from 5 services + syslog + Lambda sources.
 * Includes controlled anomaly injections every ~3 minutes for demo purposes.
 */

const http  = require('http');
const dgram = require('dgram');

const API_URL     = process.env.API_URL     || 'http://localhost:3000';
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS) || 1200;

function rnd(a,b){return Math.floor(Math.random()*(b-a)+a)}

// ── HTTP log injection ────────────────────────────────────────────────────
const SCENARIOS = {
  'api-gateway'    :[{w:35,lv:'INFO',msg:'GET /api/products 200',rt:()=>rnd(15,50)},{w:20,lv:'INFO',msg:'POST /api/orders 201',rt:()=>rnd(40,120)},{w:12,lv:'WARN',msg:'Upstream latency elevated',rt:()=>rnd(700,2200)},{w:6,lv:'ERROR',msg:'Circuit breaker OPEN — order-service',rt:()=>rnd(1,5)},{w:4,lv:'ERROR',msg:'TLS handshake timeout',rt:()=>rnd(3000,6000)}],
  'auth-service'   :[{w:40,lv:'INFO',msg:'JWT issued',rt:()=>rnd(18,70)},{w:22,lv:'INFO',msg:'Token validated',rt:()=>rnd(4,25)},{w:14,lv:'WARN',msg:'Failed login attempt',rt:()=>rnd(40,120)},{w:7,lv:'WARN',msg:'Token refresh storm',rt:()=>rnd(25,80)},{w:4,lv:'ERROR',msg:'OAuth provider unreachable',rt:()=>rnd(3000,5500)}],
  'order-service'  :[{w:28,lv:'INFO',msg:'Order created',rt:()=>rnd(90,280),extra:()=>({orderId:`ORD-${rnd(1000,9999)}`})},{w:20,lv:'INFO',msg:'Order shipped',rt:()=>rnd(45,90)},{w:14,lv:'WARN',msg:'Inventory threshold low',rt:()=>rnd(180,380)},{w:10,lv:'WARN',msg:'Slow query on orders table',rt:()=>rnd(500,2400)},{w:7,lv:'ERROR',msg:'Payment gateway timeout',rt:()=>rnd(5000,6500)},{w:3,lv:'ERROR',msg:'Order rollback — idempotency key conflict',rt:()=>rnd(60,160)}],
  'payment-service':[{w:34,lv:'INFO',msg:'Payment processed',rt:()=>rnd(180,550),extra:()=>({amount:`$${(rnd(10,5000)/10).toFixed(2)}`})},{w:16,lv:'INFO',msg:'Refund initiated',rt:()=>rnd(130,350)},{w:14,lv:'WARN',msg:'Retry attempt 1/3',rt:()=>rnd(450,1400)},{w:9,lv:'ERROR',msg:'Stripe webhook failed',rt:()=>rnd(1,12)},{w:5,lv:'ERROR',msg:'Fraud detection blocked transaction',rt:()=>rnd(45,180)}],
  'log-monitor-app':[{w:38,lv:'INFO',msg:'Health check OK',rt:()=>rnd(1,12)},{w:22,lv:'INFO',msg:'Log rotation completed',rt:()=>rnd(40,280)},{w:14,lv:'DEBUG',msg:'Ring buffer flush',rt:()=>rnd(3,18)},{w:10,lv:'WARN',msg:'Disk usage 76%',rt:()=>rnd(0,4)},{w:5,lv:'ERROR',msg:'CloudWatch agent reconnecting',rt:()=>rnd(0,6)}],
};

const SERVICES = Object.keys(SCENARIOS);

function pick(svc){const b=SCENARIOS[svc],t=b.reduce((s,sc)=>s+sc.w,0);let x=Math.random()*t;for(const sc of b){x-=sc.w;if(x<=0)return sc;}return b[0];}

function post(url, body) {
  const data = JSON.stringify(body);
  const req  = http.request(url,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}});
  req.on('error',()=>{});
  req.write(data); req.end();
}

function injectLog(payload) { post(`${API_URL}/api/log`, payload); }

function injectBulk(logs) { post(`${API_URL}/api/ingest/bulk`, { logs, source:'lambda' }); }

// ── Syslog UDP (simulates Linux syslog shipping) ──────────────────────────
const syslogClient = dgram.createSocket('udp4');
const SYSLOG_MSGS  = [
  '<14>kernel: EXT4-fs (xvda1): re-mounted',
  '<11>kernel: Out of memory: Kill process',
  '<6>systemd: Started PM2 process manager',
  '<14>sshd: Accepted publickey for ubuntu',
  '<12>kernel: TCP: request_sock_TCP: Possible SYN flooding',
];

function sendSyslog() {
  const msg = SYSLOG_MSGS[rnd(0, SYSLOG_MSGS.length)];
  const buf = Buffer.from(msg);
  syslogClient.send(buf, 5140, '127.0.0.1', ()=>{});
}

// ── Lambda-style bulk ingest simulation ───────────────────────────────────
function injectLambdaBatch() {
  const batch = Array.from({length:rnd(5,15)}, ()=>{
    const svc = SERVICES[rnd(0,SERVICES.length)];
    const sc  = pick(svc);
    return { level:sc.lv, message:sc.msg, service:svc, responseTime:sc.rt(), source:'lambda', ...(sc.extra?sc.extra():{}) };
  });
  injectBulk(batch);
}

// ── Controlled anomaly injection ─────────────────────────────────────────
// Every ~3 min: flood with errors to trigger Z-score anomaly
let anomalyTimer = rnd(150, 210) * 1000;
let anomalyCountdown = anomalyTimer;

// Every ~2 min: inject a very slow request to trigger IQR anomaly
function injectSlowRequest() {
  injectLog({ level:'ERROR', message:'Database query exceeded timeout', service:'order-service',
    responseTime: rnd(12000, 20000), source:'http',
    meta:{ query:'SELECT * FROM orders WHERE...', timeoutMs:10000 } });
}

// ── Main loop ─────────────────────────────────────────────────────────────
let tick = 0;
let lastLambda = Date.now();
let lastSyslog = Date.now();
let lastSlow   = Date.now();

function loop() {
  const svc   = SERVICES[tick % SERVICES.length];
  const count = rnd(1, 4);

  for (let i = 0; i < count; i++) {
    const sc = pick(svc);
    const extra = sc.extra ? sc.extra() : {};
    injectLog({ level:sc.lv, message:sc.msg, service:svc, responseTime:sc.rt(), source:'http', ...extra });
  }

  // Syslog every ~8s
  if (Date.now()-lastSyslog > 8000) { sendSyslog(); lastSyslog=Date.now(); }

  // Lambda batch every ~30s
  if (Date.now()-lastLambda > 30000) { injectLambdaBatch(); lastLambda=Date.now(); }

  // Slow request every ~120s
  if (Date.now()-lastSlow > 120000) { injectSlowRequest(); lastSlow=Date.now(); }

  // Anomaly burst
  anomalyCountdown -= INTERVAL_MS;
  if (anomalyCountdown <= 0) {
    console.log('\n⚡ Injecting error burst for anomaly detection demo...');
    const burst = Array.from({length:20},()=>({
      level:'ERROR', message:['Payment gateway timeout','Circuit breaker OPEN','DB connection pool exhausted','OAuth provider unreachable','Order rollback'][rnd(0,5)],
      service: SERVICES[rnd(0,SERVICES.length)], responseTime:rnd(3000,9000), source:'http',
    }));
    let i=0;
    const iv=setInterval(()=>{if(i>=burst.length){clearInterval(iv);return;}injectLog(burst[i++]);},200);
    anomalyCountdown = rnd(150,250)*1000; // reset
  }

  tick++;
  setTimeout(loop, INTERVAL_MS);
}

console.log(`📡 Phase 3 Multi-Source Generator → ${API_URL}`);
console.log(`   Sources: HTTP (5 services), Lambda bulk, Syslog UDP`);
console.log(`   Anomaly burst scheduled every ~3 min\n`);
setTimeout(loop, 1500);
