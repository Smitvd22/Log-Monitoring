const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

async function run(){
  const base = process.env.UI_BASE || 'http://localhost:3000';
  const outDir = path.join(__dirname,'..','logs'); if(!fs.existsSync(outDir)) fs.mkdirSync(outDir,{recursive:true});
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage();
  await page.goto(base, {waitUntil:'networkidle'});

  // wait for UI
  await page.waitForSelector('.btn[onclick*="toggleFeed"]',{timeout:5000});
  const results = {};

  // before
  results.before = await page.evaluate(()=>({pauseText: document.querySelector('.btn[onclick*="toggleFeed"]').textContent.trim(), anomalies: document.getElementById('m-ano')?.textContent || null, alertBadge: document.getElementById('alert-badge')?.textContent || null}));
  await page.screenshot({path:path.join(outDir,'ui_before.png'),fullPage:true});

  // click pause
  await page.click('.btn[onclick*="toggleFeed"]');
  await page.waitForTimeout(600);
  results.afterPause = await page.evaluate(()=>({pauseText: document.querySelector('.btn[onclick*="toggleFeed"]').textContent.trim()}));
  await page.screenshot({path:path.join(outDir,'ui_paused.png'),fullPage:true});

  // click resume
  await page.click('.btn[onclick*="toggleFeed"]');
  await page.waitForTimeout(600);
  results.afterResume = await page.evaluate(()=>({pauseText: document.querySelector('.btn[onclick*="toggleFeed"]').textContent.trim()}));
  await page.screenshot({path:path.join(outDir,'ui_resumed.png'),fullPage:true});

  // inject anomaly
  if (await page.$('button[onclick*="injectAnomaly"]')){
    await page.click('button[onclick*="injectAnomaly"]');
    await page.waitForTimeout(900);
    await page.screenshot({path:path.join(outDir,'ui_injected.png'),fullPage:true});
  }

  // trigger cascade
  if (await page.$('button[onclick*="triggerCascade"]')){
    await page.click('button[onclick*="triggerCascade"]');
    await page.waitForTimeout(900);
    await page.screenshot({path:path.join(outDir,'ui_cascade.png'),fullPage:true});
  }

  // clear
  if (await page.$('button[onclick*="clearAll"]')){
    await page.click('button[onclick*="clearAll"]');
    await page.waitForTimeout(600);
    await page.screenshot({path:path.join(outDir,'ui_cleared.png'),fullPage:true});
  }

  // collect final UI state
  results.final = await page.evaluate(()=>({pauseText: document.querySelector('.btn[onclick*="toggleFeed"]').textContent.trim(), anomalies: document.getElementById('m-ano')?.textContent || null, alertBadge: document.getElementById('alert-badge')?.textContent || null, total: document.getElementById('m-total')?.textContent || null}));

  await browser.close();
  fs.writeFileSync(path.join(outDir,'ui_headless_result.json'), JSON.stringify(results,null,2));
  console.log('Screenshots and results written to', outDir);
}

run().catch(e=>{ console.error(e); process.exit(1); });
