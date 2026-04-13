async function main(){
  const base = process.env.API_BASE || 'http://localhost:3000';
  const fetch = globalThis.fetch;
  if (!fetch) { console.error('global fetch not available in this Node runtime'); process.exit(1); }
  console.log('=== INJECT SPIKE (8 posts) ===');
  for(let i=0;i<8;i++){ const r=await fetch(base+'/api/log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({level:'ERROR',message:'Injected spike '+(i+1),meta:{source:'dashboard-test'}})}); console.log('POST',i+1,'->',r.status); }
  const s = await (await fetch(base+'/api/stats')).json();
  console.log('STATS AFTER INJECT:',s);
  const logs = await (await fetch(base+'/api/logs?limit=10')).json(); console.log('LATEST LOGS COUNT:', logs.logs.length); console.log(logs.logs.slice(0,6));

  console.log('\n=== TRIGGER CASCADE (5 posts) ===');
  const burst=['api-gateway','order-service','payment-service','auth-service','log-monitor-app'];
  for(const b of burst){ const r=await fetch(base+'/api/log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({level:'ERROR',message:'Cascade event',meta:{service:b,source:'dashboard-test'}})}); console.log('POST cascade',b,'->',r.status); }
  const s2 = await (await fetch(base+'/api/stats')).json(); console.log('STATS AFTER CASCADE:',s2);
  const logs2 = await (await fetch(base+'/api/logs?limit=20')).json(); console.log('LATEST LOGS COUNT:', logs2.logs.length);

  console.log('\n=== FETCH ANOMALIES / HEATMAP / ALERTS ===');
  const [anos,heat,alertsRes] = await Promise.all([fetch(base+'/api/anomalies?limit=20'), fetch(base+'/api/heatmap'), fetch(base+'/api/alerts?limit=20')]);
  console.log('/api/anomalies ->',anos.status); if(anos.ok) console.log(await anos.json());
  console.log('/api/heatmap ->',heat.status); if(heat.ok){ const h=await heat.json(); console.log('heat matrix sample row 0:',h.matrix[0].slice(0,8)); }
  console.log('/api/alerts ->',alertsRes.status); if(alertsRes.ok) console.log(await alertsRes.json());

  console.log('\n=== FETCH TRACES (from recent logs) ===');
  const recent = await (await fetch(base+'/api/logs?limit=30')).json();
  const tids = [...new Set((recent.logs||[]).map(l=>l.traceId).filter(Boolean))].slice(0,5);
  if (!tids.length) console.log('No traceIds found in recent logs');
  for(const tid of tids){ const r=await fetch(base+`/api/trace/${tid}`); console.log(`/api/trace/${tid} ->`,r.status); if (r.ok) console.log(await r.json()); }

  console.log('\n=== CLEAR LOGS (DELETE /api/logs) ===');
  const clr = await fetch(base+'/api/logs',{method:'DELETE'}); console.log('DELETE /api/logs ->',clr.status);
  const final = await (await fetch(base+'/api/stats')).json(); console.log('STATS AFTER CLEAR:', final);
}

main().catch(e=>{console.error(e);process.exit(1)});
