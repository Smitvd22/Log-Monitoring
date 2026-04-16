const MINS = 30;
const timeline = Array.from({ length: MINS }, () => ({ INFO: 0, WARN: 0, ERROR: 0, DEBUG: 0 }));
const DEFAULT_BASE = (location.origin && location.origin !== 'null') ? location.origin : 'http://localhost:3000';

let tlChart = null;
let API_BASE = DEFAULT_BASE;
let AWS_REGION = 'us-east-1';
let API_KEY = '';

let running = true;
let logs = [];
let anomalies = [];
let filterLevel = 'ALL';
let ws = null;
let wsReconnectTimer = null;
let testMode = false;

function initChart() {
  try {
    if (window.Chart) {
      const tlCtx = document.getElementById('tl-chart').getContext('2d');
      tlChart = new Chart(tlCtx, {
        type: 'bar',
        data: {
          labels: Array.from({ length: MINS }, () => ''),
          datasets: [
            { label: 'ERR', data: timeline.map(i => i.ERROR), backgroundColor: '#ff5d5d', stack: 's' },
            { label: 'WARN', data: timeline.map(i => i.WARN), backgroundColor: '#ffb74a', stack: 's' },
            { label: 'INFO', data: timeline.map(i => i.INFO), backgroundColor: '#52a7ff', stack: 's' },
            { label: 'DBG', data: timeline.map(i => i.DEBUG), backgroundColor: '#9e9e9e', stack: 's' },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { x: { display: false }, y: { stacked: true } },
        },
      });
    }
  } catch (e) {
    tlChart = null;
  }
}

function setConnectionPill(id, ok) {
  const dot = document.getElementById(id + '-dot');
  if (!dot) return;
  dot.style.background = ok ? 'var(--ok)' : 'var(--error)';
}

function apiHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['x-api-key'] = API_KEY;
  return headers;
}

function renderStream() {
  const container = document.querySelector('.scroll');
  const tb = document.getElementById('log-tbody');
  const em = document.getElementById('log-empty');
  const prevScroll = container ? container.scrollTop : 0;
  const prevHeight = container ? container.scrollHeight : 0;
  const vis = logs.filter(l => filterLevel === 'ALL' || l.level === filterLevel).slice(0, 80);
  if (!vis.length) {
    tb.innerHTML = '';
    if (em) em.style.display = 'block';
    return;
  }
  if (em) em.style.display = 'none';
  tb.innerHTML = vis.map(l => `
    <tr>
      <td style="width:72px">${l.ts}</td>
      <td style="width:72px"><span class="tag ${l.level}">${l.level}</span></td>
      <td>${l.service}</td>
      <td style="text-align:right">${l.rt || 0}ms</td>
    </tr>`).join('');
  if (container) {
    const newHeight = container.scrollHeight;
    container.scrollTop = Math.max(0, prevScroll + (newHeight - prevHeight));
  }
}

function setFilter(level) {
  filterLevel = level;
  renderStream();
}

function updateToggleLabel() {
  const btn = document.getElementById('toggle-feed');
  if (!btn) return;
  btn.textContent = running ? 'Pause' : 'Resume';
}

function toggleFeed() {
  running = !running;
  updateToggleLabel();
  if (running) {
    fetchServerState();
    fetchOverview();
    fetchAwsStatus();
    fetchAwsLists();
  }
}

function updateModeLabel() {
  const btn = document.getElementById('toggle-mode');
  if (!btn) return;
  btn.textContent = testMode ? 'Mode: Test' : 'Mode: AWS';
}

async function toggleMode() {
  testMode = !testMode;
  updateModeLabel();
  try {
    await fetch(`${API_BASE}/api/debug/testmode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: testMode }),
    });
  } catch (e) {
    // ignore
  }
  if (!testMode) {
    fetchAwsStatus();
    fetchAwsLists();
  } else {
    setConnectionPill('aws', false);
    resetAwsPanels();
  }
}

function updateMetrics(stats) {
  const avg = stats.avgResponseTime || 0;
  const p95 = stats.p95ResponseTime || 0;
  const p99 = stats.p99ResponseTime || 0;
  document.getElementById('m-total').textContent = stats.total || 0;
  document.getElementById('m-err').textContent = stats.ERROR || 0;
  document.getElementById('m-avg').textContent = `${avg}ms / ${p95}ms`;
  document.getElementById('m-p99').textContent = `${p99}ms`;
  document.getElementById('m-ano').textContent = stats.anomalies || 0;
  document.getElementById('m-ws').textContent = stats.wsClients || 0;
}

function scheduleWsReconnect() {
  if (wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWS();
  }, 3000);
}

function connectWS() {
  try {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const wsUrl = API_BASE.replace(/^http/, 'ws') + '/ws/logs';
    ws = new WebSocket(wsUrl);
    ws.onopen = () => setConnectionPill('ws', true);
    ws.onmessage = (ev) => {
      try {
        if (!running) return;
        const p = JSON.parse(ev.data);
        if (p.type === 'log' && p.log) {
          logs.unshift({
            ts: new Date(p.log.timestamp).toLocaleTimeString(),
            level: p.log.level,
            message: p.log.message,
            service: p.log.service,
            rt: p.log.responseTime,
            traceId: p.log.traceId,
            src: p.log.source,
          });
          if (logs.length > 800) logs.pop();
          if (running) renderStream();
        }
        if (p.type === 'history' && p.logs) {
          logs = p.logs.map(l => ({
            ts: new Date(l.timestamp).toLocaleTimeString(),
            level: l.level,
            message: l.message,
            service: l.service,
            rt: l.responseTime,
            traceId: l.traceId,
            src: l.source,
          }));
          if (running) renderStream();
        }
        if (p.type === 'anomalies' && p.anomalies) {
          anomalies = p.anomalies.slice();
          renderAnomalies();
        }
        if (p.type === 'anomaly' && p.anomaly) {
          anomalies.unshift(p.anomaly);
          document.getElementById('m-ano').textContent = anomalies.length;
          renderAnomalies();
        }
      } catch (e) {
        console.error('WS parse error', e);
      }
    };
    ws.onclose = () => {
      setConnectionPill('ws', false);
      scheduleWsReconnect();
    };
    ws.onerror = () => {
      setConnectionPill('ws', false);
      scheduleWsReconnect();
    };
  } catch (e) {
    console.error('connectWS error', e);
  }
}

async function injectAnomaly() {
  try {
    if (!running) return;
    await fetch(`${API_BASE}/api/debug/testmode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    await fetch(`${API_BASE}/api/debug/emit_logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 12, level: 'ERROR' }),
    });
    await fetch(`${API_BASE}/api/debug/force_anomaly`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'dashboard', severity: 'WARNING', description: 'Injected anomaly via UI' }),
    });
    await fetchServerState();
  } catch (e) {
    console.error('injectAnomaly error', e);
  }
}

async function triggerCascade() {
  try {
    if (!running) return;
    await fetch(`${API_BASE}/api/debug/testmode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const tasks = [];
    for (let i = 0; i < 6; i += 1) {
      tasks.push(fetch(`${API_BASE}/api/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: 'ERROR', message: `Injected spike ${i + 1}`, meta: { source: 'dashboard' } }),
      }));
    }
    await Promise.all(tasks);
    await fetchServerState();
  } catch (e) {
    console.error('triggerCascade error', e);
  }
}

function resetAwsPanels() {
  updateAwsStatusBadge('aws-cw-status', false, 'Unknown');
  updateAwsStatusBadge('aws-s3-status', false, 'Unknown');
  updateAwsStatusBadge('aws-sns-status', false, 'Unknown');
  updateAwsStatusBadge('aws-lambda-status', false, 'Unknown');
  document.getElementById('aws-cw-list').innerHTML = '<div class="empty">No data</div>';
  document.getElementById('aws-s3-list').innerHTML = '<div class="empty">No data</div>';
  document.getElementById('aws-sns-list').innerHTML = '<div class="empty">No data</div>';
  document.getElementById('aws-lambda-list').innerHTML = '<div class="empty">No data</div>';
}

async function clearAll() {
  try {
    await fetch(`${API_BASE}/api/logs`, { method: 'DELETE' });
  } catch (e) {
    // ignore
  }
  logs = [];
  anomalies = [];
  renderStream();
  renderAnomalies();
  renderTopErrors();
  renderSources();
  document.getElementById('m-total').textContent = '0';
  document.getElementById('m-err').textContent = '0';
  document.getElementById('m-avg').textContent = '0ms / 0ms';
  document.getElementById('m-p99').textContent = '0ms';
  document.getElementById('m-ano').textContent = '0';
  document.getElementById('m-ws').textContent = '0';
  document.getElementById('donut-legend').textContent = 'No data';
  document.getElementById('heatmap-wrap').innerHTML = '<div class="empty">No heatmap data</div>';
  document.getElementById('trace-list').innerHTML = '<div class="empty">Traces appear as logs arrive</div>';
  document.getElementById('alert-feed').innerHTML = '<div class="empty">No alerts fired</div>';
  resetAwsPanels();
}

async function fetchOverview() {
  try {
    if (!running) return;
    const s = await (await fetch(`${API_BASE}/api/stats`)).json();
    updateMetrics(s);
    window.__lastStats = s;
    renderSources();
    renderLevelDistribution();
    try {
      const te = await (await fetch(`${API_BASE}/api/top-errors?limit=10`)).json();
      window.__lastTopErrors = Array.isArray(te) ? te : (te || []);
      renderTopErrors();
    } catch (e) {}
    const tl = await (await fetch(`${API_BASE}/api/timeline?minutes=${MINS}`)).json();
    if (tl && Array.isArray(tl) && tlChart) {
      tlChart.data.datasets[0].data = tl.map(x => x.ERROR);
      tlChart.data.datasets[1].data = tl.map(x => x.WARN);
      tlChart.data.datasets[2].data = tl.map(x => x.INFO);
      tlChart.data.datasets[3].data = tl.map(x => x.DEBUG);
      tlChart.update();
    }
  } catch (e) {}
}

async function fetchStream() {
  try {
    if (!running) return;
    const lj = await (await fetch(`${API_BASE}/api/logs?limit=200`)).json();
    logs = (lj.logs || []).map(l => ({
      ts: new Date(l.timestamp).toLocaleTimeString(),
      level: l.level,
      message: l.message,
      service: l.service,
      rt: l.responseTime || l.rt,
      traceId: l.traceId,
    }));
    renderStream();
  } catch (e) {}
}

function renderAnomalies() {
  const el = document.getElementById('ano-list');
  if (anomalies.length) {
    el.innerHTML = anomalies.map(a => `
      <div class="list-row">
        <div><strong>${a.type}</strong> ${a.severity}</div>
        <div>${a.description || ''}</div>
      </div>`).join('');
  } else {
    el.innerHTML = '<div class="empty">No anomalies detected</div>';
  }
}

async function fetchAnomalies() {
  try {
    if (!running) return;
    const a = await (await fetch(`${API_BASE}/api/anomalies?limit=50`)).json();
    anomalies = a.anomalies || [];
    renderAnomalies();
  } catch (e) {}
}

async function fetchHeatmap() {
  try {
    if (!running) return;
    const h = await (await fetch(`${API_BASE}/api/heatmap`)).json();
    const heatWrap = document.getElementById('heatmap-wrap');
    if (h && h.matrix) {
      heatWrap.innerHTML = h.matrix.map((r, ri) => `
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <div style="width:36px;color:var(--muted)">${h.days[ri]}</div>
          <div style="display:flex;gap:4px;flex:1">
            ${r.map(v => `<div style="flex:1;height:14px;background:rgba(255,93,93,${Math.min(0.9, v / 5)})"></div>`).join('')}
          </div>
        </div>`).join('');
    } else {
      heatWrap.innerHTML = '<div class="empty">No heatmap data</div>';
    }
  } catch (e) {}
}

async function fetchTraces() {
  try {
    if (!running) return;
    const lj = await (await fetch(`${API_BASE}/api/logs?limit=200`)).json();
    const tids = [...new Set((lj.logs || []).map(l => l.traceId).filter(Boolean))].slice(0, 6);
    const traceList = document.getElementById('trace-list');
    if (!tids.length) {
      traceList.innerHTML = '<div class="empty">Traces appear as logs arrive</div>';
      return;
    }
    const spanPromises = tids.map(t => fetch(`${API_BASE}/api/trace/${t}`).then(r => r.ok ? r.json() : null));
    const spans = (await Promise.all(spanPromises)).filter(Boolean);
    traceList.innerHTML = spans.map(s => `
      <div class="list-row">
        <div><strong>${s.traceId}</strong> ${s.spanCount} spans</div>
        <div>${s.spans.slice(0, 4).map(sp => sp.service + '(' + sp.level + ')').join(', ')}</div>
      </div>`).join('');
  } catch (e) {}
}

async function fetchAlerts() {
  try {
    if (!running) return;
    const a = await (await fetch(`${API_BASE}/api/alerts?limit=50`)).json();
    const af = document.getElementById('alert-feed');
    if (a.alerts && a.alerts.length) {
      af.innerHTML = a.alerts.map(x => `
        <div class="list-row">
          <div><strong>${x.type}</strong> ${x.severity}</div>
          <div>${x.description || ''}</div>
        </div>`).join('');
    } else {
      af.innerHTML = '<div class="empty">No alerts fired</div>';
    }
  } catch (e) {}
}

function renderTopErrors() {
  const el = document.getElementById('top-errors-ov');
  const top = window.__lastTopErrors || [];
  if (top && top.length) {
    el.innerHTML = top.map(e => `
      <div class="list-row">
        <div>${e.message.slice(0, 80)}</div>
        <div>${e.count} x ${e.service}</div>
      </div>`).join('');
  } else {
    el.innerHTML = '<div class="empty">No errors yet</div>';
  }
}

function renderSources() {
  const el = document.getElementById('sources-chart');
  const s = (window.__lastStats && window.__lastStats.sourceCounts) || {};
  const keys = Object.keys(s).filter(k => s[k] > 0);
  if (!keys.length) {
    el.innerHTML = '<div class="empty">No data</div>';
    return;
  }
  el.innerHTML = keys.map(k => `
    <div class="list-row">
      <div>${k}</div>
      <div>${s[k]}</div>
    </div>`).join('');
}

function renderLevelDistribution() {
  const el = document.getElementById('donut-legend');
  const s = window.__lastStats || {};
  const items = [
    { label: 'INFO', value: s.INFO || 0, color: '#52a7ff' },
    { label: 'WARN', value: s.WARN || 0, color: '#ffb74a' },
    { label: 'ERROR', value: s.ERROR || 0, color: '#ff5d5d' },
    { label: 'DEBUG', value: s.DEBUG || 0, color: '#a3a3a3' },
  ];
  const total = items.reduce((a, b) => a + b.value, 0);
  if (!total) {
    el.innerHTML = 'No data';
    return;
  }
  el.innerHTML = items.map(i => `
    <div class="list-row">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="width:10px;height:10px;border-radius:3px;background:${i.color};display:inline-block"></span>
        ${i.label}
      </div>
      <div>${i.value}</div>
    </div>`).join('');
}

function updateAwsStatusBadge(id, ok, error) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'status-badge ' + (ok ? 'status-ok' : 'status-bad');
  el.textContent = ok ? 'Connected' : (error || 'Error');
}

async function fetchAwsStatus() {
  try {
    if (!running || testMode) return;
    const url = `${API_BASE}/api/aws/status?region=${encodeURIComponent(AWS_REGION)}`;
    const res = await fetch(url, { headers: apiHeaders() });
    if (!res.ok) throw new Error('AWS status failed');
    const data = await res.json();
    setConnectionPill('aws', true);
    updateAwsStatusBadge('aws-cw-status', data.services.cloudwatch.ok, data.services.cloudwatch.error);
    updateAwsStatusBadge('aws-s3-status', data.services.s3.ok, data.services.s3.error);
    updateAwsStatusBadge('aws-sns-status', data.services.sns.ok, data.services.sns.error);
    updateAwsStatusBadge('aws-lambda-status', data.services.lambda.ok, data.services.lambda.error);
  } catch (e) {
    setConnectionPill('aws', false);
    updateAwsStatusBadge('aws-cw-status', false, 'Error');
    updateAwsStatusBadge('aws-s3-status', false, 'Error');
    updateAwsStatusBadge('aws-sns-status', false, 'Error');
    updateAwsStatusBadge('aws-lambda-status', false, 'Error');
  }
}

async function fetchAwsLists() {
  try {
    if (!running || testMode) return;
    const headers = apiHeaders();
    const [cwRes, s3Res, snsRes, lambdaRes] = await Promise.all([
      fetch(`${API_BASE}/api/aws/cloudwatch/log-groups?region=${encodeURIComponent(AWS_REGION)}&limit=8`, { headers }),
      fetch(`${API_BASE}/api/aws/s3/buckets?region=${encodeURIComponent(AWS_REGION)}`, { headers }),
      fetch(`${API_BASE}/api/aws/sns/topics?region=${encodeURIComponent(AWS_REGION)}&limit=8`, { headers }),
      fetch(`${API_BASE}/api/aws/lambda/functions?region=${encodeURIComponent(AWS_REGION)}&limit=8`, { headers }),
    ]);
    const cw = cwRes.ok ? await cwRes.json() : { groups: [] };
    const s3 = s3Res.ok ? await s3Res.json() : { buckets: [] };
    const sns = snsRes.ok ? await snsRes.json() : { topics: [] };
    const lambda = lambdaRes.ok ? await lambdaRes.json() : { functions: [] };

    document.getElementById('aws-cw-list').innerHTML = (cw.groups || []).length
      ? cw.groups.map(g => `<div class="list-row"><div>${g.name}</div><div>${g.retentionInDays || '-'}d</div></div>`).join('')
      : '<div class="empty">No log groups</div>';
    document.getElementById('aws-s3-list').innerHTML = (s3.buckets || []).length
      ? s3.buckets.slice(0, 8).map(b => `<div class="list-row"><div>${b.name}</div><div>${b.createdAt ? b.createdAt.slice(0, 10) : '-'}</div></div>`).join('')
      : '<div class="empty">No buckets</div>';
    document.getElementById('aws-sns-list').innerHTML = (sns.topics || []).length
      ? sns.topics.map(t => `<div class="list-row"><div>${t.arn}</div></div>`).join('')
      : '<div class="empty">No topics</div>';
    document.getElementById('aws-lambda-list').innerHTML = (lambda.functions || []).length
      ? lambda.functions.map(f => `<div class="list-row"><div>${f.name}</div><div>${f.runtime || '-'}</div></div>`).join('')
      : '<div class="empty">No functions</div>';
  } catch (e) {
    document.getElementById('aws-cw-list').innerHTML = '<div class="empty">No data</div>';
    document.getElementById('aws-s3-list').innerHTML = '<div class="empty">No data</div>';
    document.getElementById('aws-sns-list').innerHTML = '<div class="empty">No data</div>';
    document.getElementById('aws-lambda-list').innerHTML = '<div class="empty">No data</div>';
  }
}

async function fetchServerState() {
  try {
    if (!running) return;
    const [statsRes, logsRes, anoRes, heatRes, alertsRes] = await Promise.all([
      fetch(`${API_BASE}/api/stats`),
      fetch(`${API_BASE}/api/logs?limit=200`),
      fetch(`${API_BASE}/api/anomalies?limit=50`),
      fetch(`${API_BASE}/api/heatmap`),
      fetch(`${API_BASE}/api/alerts?limit=50`),
    ]);
    if (!statsRes.ok || !logsRes.ok) throw new Error('api error');
    const stats = await statsRes.json();
    const logsJson = await logsRes.json();
    const anomaliesJson = anoRes.ok ? await anoRes.json() : { count: 0, anomalies: [] };
    const heatJson = heatRes.ok ? await heatRes.json() : null;
    const alertsJson = alertsRes.ok ? await alertsRes.json() : { count: 0, alerts: [] };

    updateMetrics({ ...stats, anomalies: stats.anomalies || anomaliesJson.count || 0 });
    window.__lastStats = stats;
    logs = (logsJson.logs || []).map(l => ({
      ts: new Date(l.timestamp).toLocaleTimeString(),
      level: l.level,
      message: l.message,
      service: l.service,
      rt: l.responseTime || l.rt,
      src: l.source,
      traceId: l.traceId,
    }));
    renderStream();
    renderTopErrors();
    renderSources();
    renderLevelDistribution();

    if (anomaliesJson.anomalies && anomaliesJson.anomalies.length) {
      anomalies = anomaliesJson.anomalies.slice();
    } else {
      anomalies = [];
    }
    renderAnomalies();

    const heatWrap = document.getElementById('heatmap-wrap');
    if (heatJson && heatJson.matrix) {
      heatWrap.innerHTML = heatJson.matrix.map((r, ri) => `
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <div style="width:36px;color:var(--muted)">${heatJson.days[ri]}</div>
          <div style="display:flex;gap:4px;flex:1">
            ${r.map(v => `<div style="flex:1;height:14px;background:rgba(255,93,93,${Math.min(0.9, v / 5)})"></div>`).join('')}
          </div>
        </div>`).join('');
    } else {
      heatWrap.innerHTML = '<div class="empty">No heatmap data</div>';
    }

    const af = document.getElementById('alert-feed');
    if (alertsJson && alertsJson.alerts && alertsJson.alerts.length) {
      af.innerHTML = alertsJson.alerts.map(a => `
        <div class="list-row">
          <div><strong>${a.type}</strong> ${a.severity}</div>
          <div>${a.description}</div>
        </div>`).join('');
    } else {
      af.innerHTML = '<div class="empty">No alerts fired</div>';
    }

    const traceList = document.getElementById('trace-list');
    const tids = [...new Set(logs.map(l => l.traceId).filter(Boolean))].slice(0, 5);
    if (tids.length) {
      const spanPromises = tids.map(tid => fetch(`${API_BASE}/api/trace/${tid}`).then(r => r.ok ? r.json() : null));
      const spans = (await Promise.all(spanPromises)).filter(Boolean);
      traceList.innerHTML = spans.map(s => `
        <div class="list-row">
          <div><strong>${s.traceId}</strong> ${s.spanCount} spans</div>
          <div>${s.spans.slice(0, 4).map(sp => sp.service + '(' + sp.level + ')').join(', ')}</div>
        </div>`).join('');
    } else {
      traceList.innerHTML = '<div class="empty">Traces appear as logs arrive</div>';
    }
  } catch (err) {}
}

function startSimulation() {
  for (let i = 0; i < 20; i += 1) {
    logs.unshift({
      ts: new Date().toISOString().slice(11, 19),
      level: ['INFO', 'INFO', 'WARN', 'ERROR', 'DEBUG'][Math.floor(Math.random() * 5)],
      message: 'sim',
      service: ['api-gateway', 'auth-service', 'order-service', 'payment-service', 'log-monitor-app'][Math.floor(Math.random() * 5)],
      rt: Math.floor(Math.random() * 1000),
    });
  }
  renderStream();
  setInterval(() => {
    if (!running) return;
    logs.unshift({
      ts: new Date().toISOString().slice(11, 19),
      level: Math.random() > 0.9 ? 'ERROR' : 'INFO',
      message: 'live',
      service: ['api-gateway', 'auth-service', 'order-service', 'payment-service', 'log-monitor-app'][Math.floor(Math.random() * 5)],
      rt: Math.floor(Math.random() * 1200),
    });
    if (logs.length > 800) logs.pop();
    renderStream();
  }, 4000);
}

async function loadConfigFromEnv() {
  try {
    const res = await fetch(`${DEFAULT_BASE}/api/ui-config`);
    if (!res.ok) throw new Error('ui-config unavailable');
    const cfg = await res.json();
    API_BASE = cfg.apiBase || DEFAULT_BASE;
    AWS_REGION = cfg.awsRegion || 'us-east-1';
    API_KEY = cfg.apiKey || '';
  } catch (e) {
    API_BASE = DEFAULT_BASE;
  }
}

async function testApi() {
  try {
    const r = await fetch(`${API_BASE}/health`);
    setConnectionPill('api', r.ok);
    return r.ok;
  } catch (e) {
    setConnectionPill('api', false);
    return false;
  }
}

async function boot() {
  initChart();
  updateToggleLabel();
  updateModeLabel();
  await loadConfigFromEnv();
  const apiOk = await testApi();
  if (!apiOk) {
    startSimulation();
    return;
  }
  connectWS();
  await fetchServerState();
  await fetchOverview();
  await fetchAwsStatus();
  await fetchAwsLists();
  setInterval(fetchOverview, 8000);
  setInterval(fetchAwsStatus, 30000);
}

boot();
