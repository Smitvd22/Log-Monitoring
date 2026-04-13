(async ()=>{
  const base='http://localhost:3000';
  console.log('=== INJECT SPIKE (8 posts) ===');
  for(let i=0;i<8;i++){
    const r=await fetch(base+'/api/log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({level:'ERROR',message:'Injected spike '+(i+1),meta:{source:'dashboard-test'}})});
    console.log('POST',i+1,'->',r.status);
  }
  await new Promise(r=>setTimeout(r,500));
  let s=await (await fetch(base+'/api/stats')).json();
  console.log('STATS AFTER INJECT:',s);
  let logs=await (await fetch(base+'/api/logs?limit=10')).json();
  console.log('LATEST LOGS COUNT:',logs.count);
  console.log(logs.logs.slice(0,5));

  console.log('\n=== TRIGGER CASCADE (5 posts) ===');
  const services=['api-gateway','order-service','payment-service','auth-service','log-monitor-app'];
  for(let i=0;i<services.length;i++){
    const r=await fetch(base+'/api/log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({level:'ERROR',message:'Cascade event',meta:{service:services[i],source:'dashboard-test'}})});
    console.log('POST cascade',services[i],'->',r.status);
  }
  await new Promise(r=>setTimeout(r,500));
  s=await (await fetch(base+'/api/stats')).json();
  console.log('STATS AFTER CASCADE:',s);
  logs=await (await fetch(base+'/api/logs?limit=10')).json();
  console.log('LATEST LOGS COUNT:',logs.count);
  console.log(logs.logs.slice(0,8));

  console.log('\n=== CLEAR LOGS (DELETE /api/logs) ===');
  const clr=await fetch(base+'/api/logs',{method:'DELETE'});
  console.log('DELETE /api/logs ->',clr.status);
  await new Promise(r=>setTimeout(r,300));
  s=await (await fetch(base+'/api/stats')).json();
  console.log('STATS AFTER CLEAR:',s);
  logs=await (await fetch(base+'/api/logs?limit=10')).json();
  console.log('LATEST LOGS COUNT:',logs.count);
})();
