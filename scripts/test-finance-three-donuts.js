const { chromium } = require('playwright');
const { spawn } = require('child_process');

const PORT = 8949;
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const APP_DIR = __dirname + '/..';

const DONUT_PALETTE = ['#4A85AC', '#D9A441', '#5C8F62', '#C1432B', '#EDE9DD'];
const donutColor = i => DONUT_PALETTE[i % DONUT_PALETTE.length];
// GOAL_PALETTE mirrors index.html's own definition (DONUT_PALETTE minus white) - Card 2's
// goal segments use THIS, not donutColor, specifically so a goal segment can never collide
// with the white "Nem konkrét célra félretett" segment. Only Card 3 (Teljes kép) uses
// donutColor directly. Keep this in sync with index.html's GOAL_PALETTE if that ever changes.
const GOAL_PALETTE = DONUT_PALETTE.filter(c => c !== '#EDE9DD');
const goalColor = i => GOAL_PALETTE[i % GOAL_PALETTE.length];

(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: APP_DIR, stdio: 'pipe' });
  await new Promise(r => setTimeout(r, 1000));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--headless=new'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(400);

  const results = [];

  // 0) Regression baseline unaffected
  const reg = await page.evaluate(async () => await runRegressionChecks());
  const regFails = reg.filter(x => x['Eredmény'] !== 'PASS');
  results.push({ name: 'runRegressionChecks() 16/16 unaffected', pass: regFails.length === 0, detail: JSON.stringify({ total: reg.length, fails: regFails.length }) });

  // Helper: set finance state, switch to attekintes tab, spy on ALL drawDonutChart() calls
  // (now three per render: checking/savings/total), render, and read back DOM text/HTML.
  async function renderAndCapture(financeState) {
    return await page.evaluate((fin) => {
      App.state.finance = fin;
      App.ui.financeTab = 'attekintes';
      const allCalls = [];
      const orig = drawDonutChart;
      window.drawDonutChart = function (canvas, segments, centerLabel, centerValue) {
        allCalls.push({ canvasId: canvas && canvas.id, segments: segments.map(s => ({ value: s.value, color: s.color })), centerLabel, centerValue });
        return orig.apply(this, arguments);
      };
      RENDERERS.finance();
      return new Promise(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            window.drawDonutChart = orig;
            const byLabel = {};
            allCalls.forEach(c => { byLabel[c.centerLabel] = c; });
            const rows = Array.from(document.querySelectorAll('#view-finance .card .flex.between')).map(el => el.textContent.trim());
            resolve({ allCalls, checking: byLabel['SZABAD PÉNZ'], savings: byLabel['MEGTAKARÍTÁS'], total: byLabel['ÖSSZESEN'], rows, html: document.getElementById('view-finance').innerHTML });
          });
        });
      });
    }, financeState);
  }

  // 1) Card 1 (Folyószámla / checking donut) regression: identical segment values/colors/canvas
  // id/label shape to before THIS (three-donuts) feature, for a known state.
  // NOTE (checking-account-balance fix, separate later change): Card 1's freeRemaining is now
  // driven by the REAL checking-account balance (finance.accounts, type==='checking'), not by
  // incomeSources - see index.html's checkingBalance/freeRemaining and
  // scripts/test-finance-donut-planned.js for the dedicated tests of that fix. This fixture is
  // updated in place (rather than left "unmodified") to add a checking account, since the old
  // accounts:[] + incomeSources-only shape now exercises the checkingBalance===0 fallback path
  // instead of the intended balance-driven one - the donut mechanics being tested here (4 fixed
  // segments/colors/canvas id/center label) are otherwise untouched by that fix.
  const r1 = await renderAndCapture({
    incomeSources: [{ id: 'inc1', name: 'Fizetés', amount: 999999 }], // deliberately different from the checking balance below - informational only, no longer drives freeRemaining
    mandatory: [{ id: 'm1', name: 'Bérlet', icon: '🏠', amount: 150000, type: 'fix' }],
    discretionary: [{ id: 'd1', name: 'Étkezés', icon: '🍔', spent: 30000, limit: 50000 }],
    savings: [],
    accounts: [{ id: 'a1', name: 'Folyószámla', icon: '💳', type: 'checking', balance: 400000 }],
  });
  {
    const mandTotal = 150000, discSpent = 30000, discLimitTotal = 50000;
    const discPlanned = Math.max(0, discLimitTotal - discSpent); // 20000
    const checkingBalance = 400000;
    const freeRemaining = checkingBalance - mandTotal - discLimitTotal; // 200000
    const seg = r1.checking && r1.checking.segments;
    const ok = r1.checking && r1.checking.canvasId === 'chart-donut-checking' && seg.length === 4
      && seg[0].value === freeRemaining && seg[0].color === '#5C8F62'
      && seg[1].value === mandTotal && seg[1].color === '#4A85AC'
      && seg[2].value === discSpent && seg[2].color === '#D9A441'
      && seg[3].value === discPlanned && seg[3].color === '#EDE9DD'
      && r1.checking.centerValue === freeRemaining.toLocaleString('hu-HU') + ' Ft';
    results.push({ name: 'Card 1 (Folyószámla): checking donut segments/colors/canvas id unchanged from pre-feature behavior', pass: ok, detail: JSON.stringify(r1.checking) });
  }

  // 2) Card 2 (Megtakarítási számla): 3 goals, savings-account balance LARGER than sum of goals'
  // saved -> unallocated segment appears with the correct (positive) value.
  const r2 = await renderAndCapture({
    incomeSources: [{ id: 'inc1', name: 'Fizetés', amount: 500000 }],
    mandatory: [], discretionary: [],
    savings: [
      { id: 's1', name: 'Lakáscél', icon: '🏠', saved: 200000, target: 5000000 },
      { id: 's2', name: 'Vésztartalék', icon: '🛟', saved: 100000, target: 500000 },
      { id: 's3', name: 'Nyaralás', icon: '🏖️', saved: 50000, target: 300000 },
    ],
    accounts: [
      { id: 'acc-checking', name: 'Folyószámla', icon: '💳', type: 'checking', balance: 300000 },
      { id: 'acc-savings', name: 'Megtakarítási számla', icon: '🏦', type: 'savings', balance: 600000 },
    ],
  });
  {
    const totalGoalsSaved = 200000 + 100000 + 50000; // 350000
    const totalSavingsBalance = 600000;
    const unallocated = totalSavingsBalance - totalGoalsSaved; // 250000
    const seg = r2.savings && r2.savings.segments;
    const ok = r2.savings && seg.length === 4
      && seg[0].value === 200000 && seg[0].color === goalColor(0)
      && seg[1].value === 100000 && seg[1].color === goalColor(1)
      && seg[2].value === 50000 && seg[2].color === goalColor(2)
      && seg[3].value === unallocated && seg[3].color === '#EDE9DD'
      && r2.savings.centerValue === totalSavingsBalance.toLocaleString('hu-HU') + ' Ft';
    results.push({ name: 'Card 2: 3 goals + savings balance > sum(saved) -> correct unallocated segment', pass: ok, detail: JSON.stringify({ expectedUnallocated: unallocated, got: r2.savings }) });
    // innerHTML serializes the U+00A0 thousands-separator from toLocaleString('hu-HU') back
    // out as the literal entity text "&nbsp;" - normalize both sides before comparing (same
    // fix as test-finance-donut-planned.js's zero-income case).
    const htmlNormalized = r2.html.replace(/&nbsp;/g, ' ').replace(/ /g, ' ');
    const expectedText = unallocated.toLocaleString('hu-HU').replace(/ /g, ' ');
    const rowsOk = htmlNormalized.includes('Nem konkrét célra félretett') && htmlNormalized.includes(expectedText);
    results.push({ name: 'Card 2: "Nem konkrét célra félretett" row shows correct unallocated amount', pass: rowsOk, detail: 'expected amount ' + unallocated.toLocaleString('hu-HU') });
  }

  // 3) Card 2: goals' saved SUM EXCEEDS the savings-account balance -> unallocated clamps to 0,
  // no crash, no negative segment value, and the row itself is omitted (unallocated===0).
  const r3 = await renderAndCapture({
    incomeSources: [{ id: 'inc1', name: 'Fizetés', amount: 500000 }],
    mandatory: [], discretionary: [],
    savings: [
      { id: 's1', name: 'Lakáscél', icon: '🏠', saved: 400000, target: 5000000 },
      { id: 's2', name: 'Vésztartalék', icon: '🛟', saved: 300000, target: 500000 },
    ],
    accounts: [
      { id: 'acc-savings', name: 'Megtakarítási számla', icon: '🏦', type: 'savings', balance: 500000 },
    ],
  });
  {
    const seg = r3.savings && r3.savings.segments;
    const ok = r3.savings && seg.length === 2 // no trailing unallocated segment (it's 0)
      && seg[0].value === 400000 && seg[1].value === 300000
      && seg.every(s => s.value >= 0)
      && r3.savings.centerValue === (500000).toLocaleString('hu-HU') + ' Ft';
    results.push({ name: 'Card 2: goals sum > savings balance -> unallocated clamps to 0 (no negative segment, no trailing 0-segment)', pass: ok, detail: JSON.stringify(r3.savings) });
    const noUnallocatedRow = !r3.html.includes('Nem konkrét célra félretett');
    results.push({ name: 'Card 2: unallocated===0 -> "Nem konkrét célra félretett" row is omitted', pass: noUnallocatedRow, detail: 'html should not mention it' });
  }

  // 3b) Card 2: 5 goals (no unallocated remainder) -> goalColor's 4-color GOAL_PALETTE wraps at
  // index 4 back to its own 1st color, WITHOUT ever landing on white ('#EDE9DD') - the exact
  // collision GOAL_PALETTE exists to prevent (5th goal would land on white if Card 2 used the
  // plain 5-color donutColor instead). This is the one behavior the doc comments describe but
  // that, before this test, nothing actually exercised.
  const r3b = await renderAndCapture({
    incomeSources: [{ id: 'inc1', name: 'Fizetés', amount: 500000 }],
    mandatory: [], discretionary: [],
    savings: [
      { id: 's1', name: 'Cél 1', icon: '🏠', saved: 100000, target: 1000000 },
      { id: 's2', name: 'Cél 2', icon: '🚗', saved: 100000, target: 1000000 },
      { id: 's3', name: 'Cél 3', icon: '🎓', saved: 100000, target: 1000000 },
      { id: 's4', name: 'Cél 4', icon: '🏖️', saved: 100000, target: 1000000 },
      { id: 's5', name: 'Cél 5', icon: '💍', saved: 100000, target: 1000000 },
    ],
    accounts: [
      { id: 'acc-savings', name: 'Megtakarítási számla', icon: '🏦', type: 'savings', balance: 500000 },
    ],
  });
  {
    const seg = r3b.savings && r3b.savings.segments;
    const ok = r3b.savings && seg.length === 5 // no unallocated row (balance === sum(saved))
      && seg.every((s, i) => s.color === goalColor(i))
      && seg[4].color === seg[0].color // wraps back to GOAL_PALETTE's own 1st color...
      && seg.every(s => s.color !== '#EDE9DD') // ...and NEVER white, unlike plain donutColor(4)
      && donutColor(4) === '#EDE9DD'; // sanity check: this really would be white under the plain 5-color palette
    results.push({ name: 'Card 2: 5 goals -> goalColor wraps at index 4 without ever reusing white (the bug GOAL_PALETTE was built to prevent)', pass: ok, detail: JSON.stringify(seg && seg.map(s => s.color)) });
  }

  // 4) Card 2: zero savings-type accounts -> graceful fallback text, no crash.
  const r4 = await renderAndCapture({
    incomeSources: [{ id: 'inc1', name: 'Fizetés', amount: 300000 }],
    mandatory: [], discretionary: [],
    savings: [{ id: 's1', name: 'Cél', icon: '🏠', saved: 10000, target: 100000 }],
    accounts: [
      { id: 'acc-checking', name: 'Folyószámla', icon: '💳', type: 'checking', balance: 100000 },
    ],
  });
  {
    const fallbackOk = r4.html.includes('Nincs megtakarítási számlád');
    const noCrash = errs.length === 0;
    results.push({ name: 'Card 2: zero savings-type accounts -> graceful fallback message, no crash', pass: fallbackOk && noCrash, detail: 'fallbackOk=' + fallbackOk + ' errsSoFar=' + errs.length });
  }

  // 5) Card 3 (Teljes kép): 2+ accounts of different types -> one segment per account, correct
  // grand total, color cycling applied (index 0/1 of the fixed 5-color palette).
  const r5 = await renderAndCapture({
    incomeSources: [{ id: 'inc1', name: 'Fizetés', amount: 500000 }],
    mandatory: [], discretionary: [], savings: [],
    accounts: [
      { id: 'acc-checking', name: 'Folyószámla', icon: '💳', type: 'checking', balance: 500000 },
      { id: 'acc-savings', name: 'Megtakarítási számla', icon: '🏦', type: 'savings', balance: 600000 },
    ],
  });
  {
    const grandTotal = 500000 + 600000;
    const seg = r5.total && r5.total.segments;
    const ok = r5.total && seg.length === 2
      && seg[0].value === 500000 && seg[0].color === donutColor(0)
      && seg[1].value === 600000 && seg[1].color === donutColor(1)
      && r5.total.centerValue === grandTotal.toLocaleString('hu-HU') + ' Ft';
    results.push({ name: 'Card 3: 2 accounts of different types -> one segment each, correct grand total, palette colors', pass: ok, detail: JSON.stringify(r5.total) });
  }

  // 6) Card 3: hypothetical 6th account -> color cycling wraps around (index 5 % 5 === 0, i.e.
  // same color as the 1st account) instead of erroring or running out of colors.
  const r6 = await renderAndCapture({
    incomeSources: [{ id: 'inc1', name: 'Fizetés', amount: 500000 }],
    mandatory: [], discretionary: [], savings: [],
    accounts: [
      { id: 'a1', name: 'Számla 1', icon: '💳', type: 'checking', balance: 10000 },
      { id: 'a2', name: 'Számla 2', icon: '💳', type: 'checking', balance: 20000 },
      { id: 'a3', name: 'Számla 3', icon: '💳', type: 'savings', balance: 30000 },
      { id: 'a4', name: 'Számla 4', icon: '💳', type: 'savings', balance: 40000 },
      { id: 'a5', name: 'Számla 5', icon: '💳', type: 'checking', balance: 50000 },
      { id: 'a6', name: 'Számla 6', icon: '💳', type: 'savings', balance: 60000 },
    ],
  });
  {
    const seg = r6.total && r6.total.segments;
    const grandTotal = 10000 + 20000 + 30000 + 40000 + 50000 + 60000;
    const ok = r6.total && seg.length === 6
      && seg.every((s, i) => s.color === donutColor(i))
      && seg[5].color === seg[0].color // wraps back to the 1st palette color (index 5 % 5 === 0)
      && r6.total.centerValue === grandTotal.toLocaleString('hu-HU') + ' Ft';
    results.push({ name: 'Card 3: 6 accounts -> color cycling wraps around correctly (no error, no color reuse gap)', pass: ok, detail: JSON.stringify(seg && seg.map(s => s.color)) });
  }

  // 7) Card 3: zero accounts -> graceful fallback, no crash (defensive-only, defaultState()
  // always seeds 2, but verify correctness anyway).
  const r7 = await renderAndCapture({
    incomeSources: [{ id: 'inc1', name: 'Fizetés', amount: 100000 }],
    mandatory: [], discretionary: [], savings: [], accounts: [],
  });
  {
    const fallbackOk = r7.html.includes('Még nincs felvett számlád');
    const seg = r7.total && r7.total.segments;
    const noCrashOk = seg && seg.length === 0 && r7.total.centerValue === (0).toLocaleString('hu-HU') + ' Ft';
    results.push({ name: 'Card 3: zero accounts -> graceful fallback message + empty/zero donut, no crash', pass: fallbackOk && noCrashOk, detail: JSON.stringify({ fallbackOk, total: r7.total }) });
  }

  console.log('\n=== Három donut (Folyószámla / Megtakarítási számla / Teljes kép) tesztek ===');
  results.forEach(r => console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.name + '  [' + r.detail + ']'));
  console.log('\nConsole/page errors:', errs.length === 0 ? 'NONE' : errs.join(' | '));

  const anyFail = results.some(r => !r.pass) || errs.length > 0;
  console.log('\n' + (anyFail ? 'SOME FAILED' : 'ALL PASS'));

  await browser.close();
  server.kill();
  process.exitCode = anyFail ? 1 : 0;
})().catch(e => { console.error('TEST FAILED:', e); process.exitCode = 1; });
