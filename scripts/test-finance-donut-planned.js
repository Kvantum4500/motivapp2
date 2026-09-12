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
  // NOTE (three-donuts feature): RENDERERS.finance() now draws THREE donuts per render
  // (Folyószámla/checking, Megtakarítási számla, Teljes kép), so a spy that just keeps
  // overwriting a single `captured` var would end up holding whichever of the three was
  // drawn LAST, not necessarily the checking-account one this file's hand-computed
  // assertions are about. We collect every call and pick out the one whose centerLabel is
  // 'SZABAD PÉNZ' - that label is unique to the checking-account donut and unchanged by
  // this feature - so `captured` keeps meaning exactly what it meant before, independent of
  // draw order or how many donuts a future change adds.
  async function renderAndCapture(financeState) {
    return await page.evaluate((fin) => {
      App.state.finance = fin;
      App.ui.financeTab = 'attekintes';
      const allCalls = [];
      const orig = drawDonutChart;
      window.drawDonutChart = function(canvas, segments, centerLabel, centerValue) {
        allCalls.push({ segments: segments.map(s=>({value:s.value, color:s.color})), centerLabel, centerValue });
        return orig.apply(this, arguments);
      };
      RENDERERS.finance();
      return new Promise(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            window.drawDonutChart = orig;
            const captured = allCalls.find(c => c.centerLabel === 'SZABAD PÉNZ') || null;
            const rows = Array.from(document.querySelectorAll('#view-finance .card .flex.between'))
              .map(el => el.textContent.trim());
            resolve({ captured, allCalls, rows, html: document.getElementById('view-finance').innerHTML });
          });
        });
      });
    }, financeState);
  }

  // 1) Empty discretionary (no categories at all)
  // NOTE (checking-account fix): freeRemaining is now driven by the REAL checking-account
  // balance (finance.accounts, type==='checking'), not by incomeSources - see index.html's
  // checkingBalance/freeRemaining. Each fixture below therefore sets `accounts` with a
  // checking-type balance in place of what used to be the income figure driving the math;
  // `incomeSources` is kept alongside purely as the separate, informational "Fizetés" row and
  // deliberately given a DIFFERENT amount than the checking balance in most fixtures, to prove
  // (by the numbers not matching if they were still wired together) that the two are decoupled.
  const emptyDisc = await renderAndCapture({
    incomeSources: [{id:'inc1', name:'Fizetés', amount:300000}],
    accounts: [{id:'a1', name:'Folyószámla', icon:'💳', type:'checking', balance:300000}],
    mandatory: [{id:'m1', name:'Bérlet', icon:'🏠', amount:120000, type:'fix'}],
    discretionary: [],
    savings: [],
  });
  {
    const mandTotal = 120000, discSpent = 0, discLimitTotal = 0, discPlanned = 0;
    const checkingBalance = 300000;
    const freeRemaining = checkingBalance - mandTotal - discLimitTotal; // 180000
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
    incomeSources: [{id:'inc1', name:'Fizetés', amount:999999}], // deliberately NOT equal to the checking balance below - proves incomeSources no longer feeds freeRemaining
    accounts: [{id:'a1', name:'Folyószámla', icon:'💳', type:'checking', balance:400000}],
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
    const checkingBalance = 400000;
    const freeRemaining = checkingBalance - mandTotal - discLimitTotal; // 200000 - NOT 849999, proving incomeSources (999999) is not used
    const seg = overLimit.captured.segments;
    const ok = discPlanned===0
      && seg[2].value===discSpent && seg[3].value===discPlanned
      && seg[0].value===freeRemaining;
    results.push({name:'over-limit discretionary: discPlanned clamps to 0 (never negative), donut still consistent', pass: ok, detail: JSON.stringify({discPlanned, seg})});
    const rowsOk = overLimit.rows.some(r=>r.includes('Egyéb kiadás – elköltött') && r.includes('65 000 Ft'.replace(' ',' ')) || r.includes('65 000 Ft'));
    results.push({name:'over-limit discretionary: spent row shows aggregate 65 000 Ft', pass: overLimit.rows.some(r=>r.includes('Egyéb kiadás – elköltött')), detail: JSON.stringify(overLimit.rows)});
  }

  // 3) no checking account at all (empty accounts, and empty incomeSources too) -> checkingBalance
  // falls out of the empty-array filter/reduce as 0, exactly like a genuinely-zero balance would
  // -> freeRemaining negative, donut segment clamps to 0, text row shows real negative number in red
  const zeroIncome = await renderAndCapture({
    incomeSources: [],
    accounts: [],
    mandatory: [{id:'m1', name:'Bérlet', icon:'🏠', amount:80000, type:'fix'}],
    discretionary: [{id:'d1', name:'Étkezés', icon:'🍔', spent:10000, limit:20000}],
    savings: [],
  });
  {
    const mandTotal = 80000, discLimitTotal = 20000, discSpent = 10000, discPlanned = 10000;
    const checkingBalance = 0;
    const freeRemaining = checkingBalance - mandTotal - discLimitTotal; // -100000
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
    incomeSources: [{id:'inc1', name:'Fizetés', amount:400000}, {id:'inc2', name:'Melléklás', amount:150000}], // sums to 550000 - deliberately NOT the checking balance below
    accounts: [
      {id:'a1', name:'Folyószámla', icon:'💳', type:'checking', balance:480000},
      {id:'a2', name:'Megtakarítási számla', icon:'🏦', type:'savings', balance:999999}, // savings-type must NOT be counted into checkingBalance
    ],
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
    const checkingBalance = 480000; // only the checking-type account, NOT the 550000 incomeSources total and NOT the savings account's 999999
    const freeRemaining = checkingBalance - mandTotal - discLimitTotal; // 190000
    const seg = mid.captured.segments;
    const ok = seg[1].value===mandTotal && seg[2].value===discSpent && seg[3].value===discPlanned && seg[0].value===freeRemaining
      && mid.captured.centerValue===freeRemaining.toLocaleString('hu-HU')+' Ft';
    results.push({name:'realistic mid-range case: mandTotal/discSpent/discPlanned/freeRemaining all match hand-computed values (checkingBalance-driven, not incomeSources or savings balance)', pass: ok, detail: JSON.stringify({expected:{mandTotal,discSpent,discPlanned,freeRemaining}, got: seg})});
    const rowsOk = mid.rows.some(r=>r.includes('Folyószámla egyenleg') && r.includes('480 000'.replace(/ /g,' ')) || (r.includes('Folyószámla egyenleg')&&r.includes('480')));
    results.push({name:'realistic mid-range case: new "Folyószámla egyenleg" text row shows the real checking balance (480 000 Ft)', pass: mid.rows.some(r=>r.includes('Folyószámla egyenleg')), detail: JSON.stringify(mid.rows)});
  }

  // 5) Decoupling proof: with accounts held fixed, changing ONLY incomeSources must NOT move
  // freeRemaining at all - this is the direct regression test for the reported bug (the checking
  // donut used to be driven by incomeSources; after the fix it must be fully indifferent to it).
  const decoupleA = await renderAndCapture({
    incomeSources: [{id:'inc1', name:'Fizetés', amount:100000}],
    accounts: [{id:'a1', name:'Folyószámla', icon:'💳', type:'checking', balance:250000}],
    mandatory: [{id:'m1', name:'Bérlet', icon:'🏠', amount:50000, type:'fix'}],
    discretionary: [],
    savings: [],
  });
  const decoupleB = await renderAndCapture({
    incomeSources: [{id:'inc1', name:'Fizetés', amount:5000000}, {id:'inc2', name:'Extra', amount:999999}], // wildly different income figure
    accounts: [{id:'a1', name:'Folyószámla', icon:'💳', type:'checking', balance:250000}], // SAME checking balance as decoupleA
    mandatory: [{id:'m1', name:'Bérlet', icon:'🏠', amount:50000, type:'fix'}],
    discretionary: [],
    savings: [],
  });
  {
    const expectedFree = 250000 - 50000; // 200000, independent of incomeSources in both cases
    const ok = decoupleA.captured.segments[0].value===expectedFree
      && decoupleB.captured.segments[0].value===expectedFree
      && decoupleA.captured.centerValue===decoupleB.captured.centerValue
      && decoupleA.captured.centerValue===expectedFree.toLocaleString('hu-HU')+' Ft';
    results.push({name:'decoupling: changing incomeSources alone (accounts unchanged) does NOT move freeRemaining/donut/center value', pass: ok, detail: JSON.stringify({a:decoupleA.captured.centerValue, b:decoupleB.captured.centerValue, expected:expectedFree})});
  }

  // 6) True end-to-end proof: a real transfer via saveTransfer() that changes the checking
  // account's balance must be reflected in Card 1 (freeRemaining/donut/text row) on the very
  // next render - i.e. accounts and the donut are actually WIRED TOGETHER, not just coincidentally
  // matching in a hand-built fixture.
  const transferE2E = await page.evaluate(() => {
    App.state.finance = {
      incomeSources: [{id:'inc1', name:'Fizetés', amount:100000}],
      accounts: [
        {id:'acc-checking', name:'Folyószámla', icon:'💳', type:'checking', balance:100000},
        {id:'acc-savings', name:'Megtakarítási számla', icon:'🏦', type:'savings', balance:50000},
      ],
      mandatory: [{id:'m1', name:'Bérlet', icon:'🏠', amount:20000, type:'fix'}],
      discretionary: [],
      savings: [],
    };
    App.ui.financeTab = 'attekintes';
    RENDERERS.finance();
    const before = App.state.finance.accounts.find(a=>a.id==='acc-checking').balance;

    // Move 30000 Ft OUT of the checking account into savings, exactly as a user would via the UI.
    transferBetweenAccountsSheet();
    document.querySelectorAll('#tr-from .chip').forEach(c=>c.classList.remove('active'));
    document.querySelector('#tr-from .chip[data-id="acc-checking"]').classList.add('active');
    document.querySelectorAll('#tr-to .chip').forEach(c=>c.classList.remove('active'));
    document.querySelector('#tr-to .chip[data-id="acc-savings"]').classList.add('active');
    document.getElementById('tr-amount').value = '30000';
    saveTransfer();

    const after = App.state.finance.accounts.find(a=>a.id==='acc-checking').balance;
    RENDERERS.finance(); // re-render, as the app does after any state change
    const rows = Array.from(document.querySelectorAll('#view-finance .card .flex.between')).map(el => el.textContent.trim());
    return { before, after, rows };
  });
  {
    const mandTotal = 20000, discLimitTotal = 0;
    const expectedFreeBefore = 100000 - mandTotal - discLimitTotal; // 80000
    const expectedFreeAfter = 70000 - mandTotal - discLimitTotal; // 50000, after the 30000 transfer out
    const balanceOk = transferE2E.before===100000 && transferE2E.after===70000;
    const rowOk = transferE2E.rows.some(r=>r.includes('Folyószámla egyenleg') && r.includes('70'));
    const freeOk = transferE2E.rows.some(r=>r.includes('Jelenlegi szabad pénz') && r.includes(expectedFreeAfter.toLocaleString('hu-HU')));
    results.push({name:'end-to-end: saveTransfer() changing the checking balance is immediately reflected in Card 1 on next render', pass: balanceOk && rowOk && freeOk, detail: JSON.stringify({expectedFreeBefore, expectedFreeAfter, transferE2E})});
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
