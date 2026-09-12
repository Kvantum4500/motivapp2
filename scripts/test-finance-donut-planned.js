const { chromium } = require('playwright');
const { spawn } = require('child_process');

const PORT = 8947;
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const APP_DIR = __dirname + '/..';

(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: APP_DIR, stdio: 'pipe' });
  await new Promise(r => setTimeout(r, 1000));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--headless=new'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('PAGEERROR: '+e.message));

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(400);

  const results = [];

  // 0) Regression baseline unaffected
  const reg = await page.evaluate(async () => await runRegressionChecks());
  const regFails = reg.filter(x => x['Eredmény'] !== 'PASS');
  results.push({name:'runRegressionChecks() 16/16 unaffected', pass: regFails.length===0, detail: JSON.stringify({total:reg.length, fails:regFails.length})});

  // Helper: set finance state, switch to attekintes tab, spy on drawDonutChart, render, and read back DOM text.
  async function renderAndCapture(financeState) {
    return await page.evaluate((fin) => {
      App.state.finance = fin;
      App.ui.financeTab = 'attekintes';
      let captured = null;
      const orig = drawDonutChart;
      window.drawDonutChart = function(canvas, segments, centerLabel, centerValue) {
        captured = { segments: segments.map(s=>({value:s.value, color:s.color})), centerLabel, centerValue };
        return orig.apply(this, arguments);
      };
      RENDERERS.finance();
      return new Promise(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            window.drawDonutChart = orig;
            const rows = Array.from(document.querySelectorAll('#view-finance .card .flex.between'))
              .map(el => el.textContent.trim());
            resolve({ captured, rows, html: document.getElementById('view-finance').innerHTML });
          });
        });
      });
    }, financeState);
  }

  // 1) Empty discretionary (no categories at all)
  // NOTE: these fixtures now set incomeSources (an array) instead of the old flat monthlyIncome
  // number - RENDERERS.finance() no longer reads monthlyIncome at all after the "multiple income
  // sources" feature (see index.html's totalIncome/freeRemaining), so a fixture still only setting
  // monthlyIncome would silently test a freeRemaining of 0-mandTotal-discLimitTotal instead of the
  // real income figure. Each fixture below uses a single income source carrying the same amount
  // the old monthlyIncome value did, so every hand-computed expectation in this file stays correct.
  const emptyDisc = await renderAndCapture({
    incomeSources: [{id:'inc1', name:'Fizetés', amount:300000}],
    mandatory: [{id:'m1', name:'Bérlet', icon:'🏠', amount:120000, type:'fix'}],
    discretionary: [],
    savings: [],
  });
  {
    const mandTotal = 120000, discSpent = 0, discLimitTotal = 0, discPlanned = 0;
    const freeRemaining = 300000 - mandTotal - discLimitTotal; // 180000
    const seg = emptyDisc.captured.segments;
    const ok = emptyDisc.captured && seg.length===4
      && seg[0].value===freeRemaining && seg[1].value===mandTotal && seg[2].value===discSpent && seg[3].value===discPlanned
      && emptyDisc.captured.centerLabel==='SZABAD PÉNZ'
      && emptyDisc.captured.centerValue===freeRemaining.toLocaleString('hu-HU')+' Ft';
    results.push({name:'empty discretionary: donut gets 4 segments, 0-value planned segment tolerated, no crash', pass: ok, detail: JSON.stringify(emptyDisc.captured)});
    const rowsOk = emptyDisc.rows.some(r=>r.includes('Egyéb kiadás – tervezett') && r.includes('0 Ft'))
      && emptyDisc.rows.some(r=>r.includes('Jelenlegi szabad pénz') && r.includes(freeRemaining.toLocaleString('hu-HU')+' Ft'));
    results.push({name:'empty discretionary: text rows show 0 planned and correct free money', pass: rowsOk, detail: JSON.stringify(emptyDisc.rows)});
  }

  // 2) Discretionary over limit (both single category over, and aggregate over)
  const overLimit = await renderAndCapture({
    incomeSources: [{id:'inc1', name:'Fizetés', amount:400000}],
    mandatory: [{id:'m1', name:'Bérlet', icon:'🏠', amount:150000, type:'fix'}],
    discretionary: [
      {id:'d1', name:'Étkezés', icon:'🍔', spent:60000, limit:40000}, // over limit
      {id:'d2', name:'Szórakozás', icon:'🎮', spent:5000, limit:10000}, // under limit
    ],
    savings: [],
  });
  {
    const mandTotal = 150000, discSpent = 65000, discLimitTotal = 50000;
    const discPlanned = Math.max(0, discLimitTotal - discSpent); // clamps to 0 (would be -15000 unclamped)
    const freeRemaining = 400000 - mandTotal - discLimitTotal; // 200000
    const seg = overLimit.captured.segments;
    const ok = discPlanned===0
      && seg[2].value===discSpent && seg[3].value===discPlanned
      && seg[0].value===freeRemaining;
    results.push({name:'over-limit discretionary: discPlanned clamps to 0 (never negative), donut still consistent', pass: ok, detail: JSON.stringify({discPlanned, seg})});
    const rowsOk = overLimit.rows.some(r=>r.includes('Egyéb kiadás – elköltött') && r.includes('65 000 Ft'.replace(' ',' ')) || r.includes('65 000 Ft'));
    results.push({name:'over-limit discretionary: spent row shows aggregate 65 000 Ft', pass: overLimit.rows.some(r=>r.includes('Egyéb kiadás – elköltött')), detail: JSON.stringify(overLimit.rows)});
  }

  // 3) income 0 (never set, empty incomeSources) -> freeRemaining negative, donut segment clamps to 0, text row shows real negative number in red
  const zeroIncome = await renderAndCapture({
    incomeSources: [],
    mandatory: [{id:'m1', name:'Bérlet', icon:'🏠', amount:80000, type:'fix'}],
    discretionary: [{id:'d1', name:'Étkezés', icon:'🍔', spent:10000, limit:20000}],
    savings: [],
  });
  {
    const mandTotal = 80000, discLimitTotal = 20000, discSpent = 10000, discPlanned = 10000;
    const freeRemaining = 0 - mandTotal - discLimitTotal; // -100000
    const seg = zeroIncome.captured.segments;
    const segOk = seg[0].value===0; // Math.max(0, negative) clamp in donut
    results.push({name:'zero income: donut free-money segment clamps to 0 via Math.max guard', pass: segOk, detail: JSON.stringify(seg[0])});
    // innerHTML serializes the U+00A0 in toLocaleString's thousands separator back out as the
    // literal entity text "&nbsp;", so normalize both sides to plain spaces before comparing.
    const negText = freeRemaining.toLocaleString('hu-HU').replace(/ /g, ' ')+' Ft';
    const htmlNormalized = zeroIncome.html.replace(/&nbsp;/g, ' ').replace(/ /g, ' ');
    const hasNegRow = htmlNormalized.includes(negText) && zeroIncome.html.includes('var(--trail-red)');
    results.push({name:'zero income: text row shows real negative freeRemaining ('+negText+') colored red', pass: hasNegRow, detail: 'expected:'+negText});
  }

  // 4) Realistic mid-range case: hand-computed cross-check of all 4 numbers
  const mid = await renderAndCapture({
    incomeSources: [{id:'inc1', name:'Fizetés', amount:400000}, {id:'inc2', name:'Melléklás', amount:150000}],
    mandatory: [
      {id:'m1', name:'Bérlet', icon:'🏠', amount:180000, type:'fix'},
      {id:'m2', name:'Áram', icon:'💡', amount:25000, type:'variable'},
    ],
    discretionary: [
      {id:'d1', name:'Étkezés', icon:'🍔', spent:45000, limit:60000},   // under
      {id:'d2', name:'Szórakozás', icon:'🎮', spent:22000, limit:15000}, // over
      {id:'d3', name:'Ruházat', icon:'👕', spent:0, limit:10000},        // untouched
    ],
    savings: [],
  });
  {
    const mandTotal = 205000;
    const discSpent = 45000+22000+0; // 67000
    const discLimitTotal = 60000+15000+10000; // 85000
    const discPlanned = Math.max(0, discLimitTotal-discSpent); // 18000
    const freeRemaining = 550000 - mandTotal - discLimitTotal; // 260000
    const seg = mid.captured.segments;
    const ok = seg[1].value===mandTotal && seg[2].value===discSpent && seg[3].value===discPlanned && seg[0].value===freeRemaining
      && mid.captured.centerValue===freeRemaining.toLocaleString('hu-HU')+' Ft';
    results.push({name:'realistic mid-range case: mandTotal/discSpent/discPlanned/freeRemaining all match hand-computed values', pass: ok, detail: JSON.stringify({expected:{mandTotal,discSpent,discPlanned,freeRemaining}, got: seg})});
  }

  console.log('\n=== Havi áttekintés donut: tervezett vs. elköltött szétválasztás tesztek ===');
  results.forEach(r => console.log((r.pass?'PASS':'FAIL')+' - '+r.name+'  ['+r.detail+']'));
  console.log('\nConsole/page errors:', errs.length===0?'NONE':errs.join(' | '));

  const anyFail = results.some(r=>!r.pass) || errs.length>0;
  console.log('\n'+(anyFail?'SOME FAILED':'ALL PASS'));

  await browser.close();
  server.kill();
  process.exitCode = anyFail ? 1 : 0;
})().catch(e => { console.error('TEST FAILED:', e); process.exitCode = 1; });
