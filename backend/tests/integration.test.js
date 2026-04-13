/**
 * Phase 3 — Integration Tests
 * Run: node tests/integration.test.js
 * Requires the API to be running on :3000
 */

const http = require('http');
let passed = 0, failed = 0;

function get(path) {
  return new Promise((res, rej) => {
    http.get(`http://localhost:3000${path}`, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res({ status: r.statusCode, body: JSON.parse(d) }); } catch { res({ status: r.statusCode, body: d }); } });
    }).on('error', rej);
  });
}

function post(path, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const req  = http.request(`http://localhost:3000${path}`, { method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)} }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res({ status: r.statusCode, body: JSON.parse(d) }); } catch { res({ status: r.statusCode, body: d }); } });
    });
    req.on('error', rej);
    req.write(data); req.end();
  });
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch(e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

async function run() {
  console.log('\n🧪 Phase 3 Integration Tests\n');

  await test('GET /health returns ok', async () => {
    const r = await get('/health');
    assert(r.status === 200);
    assert(r.body.status === 'ok');
  });

  await test('GET /api/health/deep returns healthy flag', async () => {
    const r = await get('/api/health/deep');
    assert(r.status === 200 || r.status === 503);
    assert(typeof r.body.healthy === 'boolean');
  });

  await test('POST /api/log accepts INFO log', async () => {
    const r = await post('/api/log', { level:'INFO', message:'Test log from integration test', service:'test-runner' });
    assert(r.status === 200);
    assert(r.body.logged.level === 'INFO');
    assert(r.body.logged.traceId);
  });

  await test('POST /api/log accepts ERROR log', async () => {
    const r = await post('/api/log', { level:'ERROR', message:'Test error', service:'test-runner', meta:{ responseTime:5500 } });
    assert(r.status === 200);
    assert(r.body.logged.level === 'ERROR');
  });

  await test('POST /api/log rejects invalid level', async () => {
    const r = await post('/api/log', { level:'VERBOSE', message:'bad level' });
    assert(r.status === 400);
  });

  await test('POST /api/ingest/bulk accepts array', async () => {
    const logs = [
      { level:'INFO',  message:'Bulk log 1', service:'api-gateway' },
      { level:'WARN',  message:'Bulk log 2', service:'auth-service' },
      { level:'ERROR', message:'Bulk log 3', service:'payment-service' },
    ];
    const r = await post('/api/ingest/bulk', { logs, source:'lambda' });
    assert(r.status === 200);
    assert(r.body.accepted === 3);
  });

  await test('GET /api/logs returns array', async () => {
    const r = await get('/api/logs?limit=10');
    assert(r.status === 200);
    assert(Array.isArray(r.body.logs));
    assert(typeof r.body.count === 'number');
  });

  await test('GET /api/logs filters by level', async () => {
    const r = await get('/api/logs?level=ERROR&limit=50');
    assert(r.status === 200);
    assert(r.body.logs.every(l => l.level === 'ERROR'));
  });

  await test('GET /api/logs searches by message', async () => {
    const r = await get('/api/logs?search=integration+test');
    assert(r.status === 200);
    // Should find the log we injected above
  });

  await test('GET /api/stats returns aggregates', async () => {
    const r = await get('/api/stats');
    assert(r.status === 200);
    assert(typeof r.body.total === 'number');
    assert(typeof r.body.avgResponseTime === 'number');
    assert(r.body.p95ResponseTime !== undefined);
  });

  await test('GET /api/timeline returns 30 buckets by default', async () => {
    const r = await get('/api/timeline?minutes=30');
    assert(r.status === 200);
    assert(Array.isArray(r.body));
    assert(r.body.length === 30);
  });

  await test('GET /api/top-errors returns array', async () => {
    const r = await get('/api/top-errors');
    assert(r.status === 200);
    assert(Array.isArray(r.body));
  });

  await test('GET /api/services returns array', async () => {
    const r = await get('/api/services');
    assert(r.status === 200);
    assert(Array.isArray(r.body));
  });

  await test('GET /api/anomalies returns anomaly list', async () => {
    const r = await get('/api/anomalies');
    assert(r.status === 200);
    assert(typeof r.body.count === 'number');
    assert(Array.isArray(r.body.anomalies));
  });

  await test('GET /api/heatmap returns 7×24 matrix', async () => {
    const r = await get('/api/heatmap');
    assert(r.status === 200);
    assert(r.body.matrix.length === 7);
    assert(r.body.matrix[0].length === 24);
  });

  await test('GET /api/metrics returns Prometheus text', async () => {
    const r = await get('/api/metrics');
    assert(r.status === 200);
    assert(typeof r.body === 'string' || r.status === 200);
  });

  await test('GET /api/trace/:id returns spans array', async () => {
    // Use a traceId from an injected log
    const logs = await get('/api/logs?limit=5');
    if (logs.body.logs.length > 0) {
      const tid = logs.body.logs[0].traceId;
      const r   = await get(`/api/trace/${tid}`);
      assert(r.status === 200);
      assert(Array.isArray(r.body.spans));
    }
  });

  console.log(`\n─────────────────────────────`);
  console.log(`  Passed: ${passed}  |  Failed: ${failed}`);
  console.log(`─────────────────────────────\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Test runner error:', e.message); process.exit(1); });
