const { chromium } = require('playwright');
const { spawn } = require('child_process');

const PORT = 8952;
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const APP_DIR = __dirname + '/..';

// Round-3 data-handling audit found that applyImportedJson()'s `Object.assign(d, parsed)`
// (d = defaultState()) mutates and returns d itself, so `next === d` - every subsequent
// `next.X = d.X` fallback-to-default line became a no-op self-assignment, silently defeating
// the whole "restore missing/malformed fields" safety net for JSON-backup imports. Also found:
// sanitizeImportedIdsAndIcons() was missing finance.incomeSources from its sanitized-array
// list (an id-based XSS path via manageIncomeSourceSheet('${x.id}')'s onclick attribute), and
// normalizeAppState() lacked explicit discretionary/savings Array.isArray guards (inconsistent
// with applyImportedJson()'s parallel section). Also found via a live user bug report: neither
// function (nor applyCloudData(), which reuses normalizeAppState()) ever validated that an
// imported/loaded/synced finance.accounts[].balance is non-negative - unlike the UI forms
// (saveAccountEdits()/saveAccount()/saveTransfer()), which all guard against it. This file
// exercises all of the above fixes.
(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: APP_DIR, stdio: 'pipe' });
  let browser;
  try {
  await new Promise(r => setTimeout(r, 1000));
  browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--headless=new'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(400);

  const results = [];

  // 0) Regression baseline unaffected
  const reg = await page.evaluate(async () => await runRegressionChecks());
  const regFails = reg.filter(x => x['Eredmény'] !== 'PASS');
  results.push({ name: 'runRegressionChecks() 16/16 unaffected', pass: regFails.length === 0, detail: JSON.stringify({ total: reg.length, fails: regFails.length }) });

  // 1) Importing a realistic pre-accounts-feature backup (mandatory/discretionary/savings
  // populated, no finance.accounts, no finance.incomeSources, monthlyIncome:0) must backfill
  // BOTH new arrays to their real defaultState() shape, not leave them undefined.
  const r1 = await page.evaluate(() => {
    const backup = {
      finance: {
        monthlyIncome: 0,
        mandatory: [{ id: 'm1', name: 'Bérlet', amount: 20000 }],
        discretionary: [{ id: 'd1', name: 'Kaja', icon: '🍔', spent: 5000, limit: 40000 }],
        savings: [{ id: 's1', name: 'Auto', icon: '🚗', saved: 10000, target: 2000000 }],
      },
      tasks: [], events: [],
    };
    applyImportedJson(JSON.stringify(backup));
    return {
      accounts: App.state.finance.accounts,
      incomeSources: App.state.finance.incomeSources,
      mandatory: App.state.finance.mandatory,
      discretionary: App.state.finance.discretionary,
      savings: App.state.finance.savings,
    };
  });
  {
    // Ids come out hyphen-stripped by sanitizeImportedIdsAndIcons() (sanitizeImportedId() only
    // keeps [a-z0-9], pre-existing/correct behavior, not part of this fix) - assert shape/type/
    // balance instead of the exact default id string.
    const ok = Array.isArray(r1.accounts) && r1.accounts.length === 2
      && r1.accounts[0].type === 'checking' && r1.accounts[0].balance === 0
      && r1.accounts[1].type === 'savings' && r1.accounts[1].balance === 0
      && Array.isArray(r1.incomeSources) && r1.incomeSources.length === 1 && r1.incomeSources[0].name === 'Fizetés'
      && Array.isArray(r1.mandatory) && r1.mandatory.length === 1 && r1.mandatory[0].name === 'Bérlet'
      && Array.isArray(r1.discretionary) && r1.discretionary.length === 1
      && Array.isArray(r1.savings) && r1.savings.length === 1;
    results.push({ name: 'applyImportedJson(): pre-accounts-feature backup backfills finance.accounts/incomeSources to real defaults (not undefined), keeps imported fields intact', pass: ok, detail: JSON.stringify(r1) });
  }

  // 2) The two crash sites the audit cited must no longer throw after that same import.
  const c1 = await page.evaluate(() => {
    try { addAccountSheet(); closeSheet(); return 'ok'; } catch (e) { return 'THREW: ' + e.message; }
  });
  results.push({ name: 'addAccountSheet() no longer throws after importing a pre-accounts backup', pass: c1 === 'ok', detail: c1 });

  const c2 = await page.evaluate(() => {
    try {
      addIncomeSourceSheet();
      document.getElementById('inc-name').value = 'Teszt';
      document.getElementById('inc-amount').value = '1000';
      saveIncomeSource();
      return 'ok';
    } catch (e) { return 'THREW: ' + e.message; }
  });
  results.push({ name: 'saveIncomeSource() no longer throws after importing a pre-accounts backup', pass: c2 === 'ok', detail: c2 });

  // 3) A backup whose finance.incomeSources contains a malicious id must come out sanitized -
  // sanitizeImportedIdsAndIcons() now includes finance.incomeSources in its swept arrays.
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(400);
  const r3 = await page.evaluate(() => {
    const backup = {
      finance: {
        mandatory: [], discretionary: [], savings: [],
        accounts: [],
        incomeSources: [{ id: "x');alert(1)//", name: 'Fizetés', amount: 500000 }],
      },
    };
    applyImportedJson(JSON.stringify(backup));
    return App.state.finance.incomeSources[0].id;
  });
  {
    const ok = !/[<>&"']/.test(r3) && r3.length > 0;
    results.push({ name: 'sanitizeImportedIdsAndIcons() sanitizes finance.incomeSources ids on import (XSS-hardening gap fix)', pass: ok, detail: 'sanitized id: ' + JSON.stringify(r3) });
  }

  // 4) normalizeAppState(): a state with a VALID finance.mandatory array but a malformed
  // (non-array) discretionary/savings must have those two fields explicitly backfilled - not
  // just implicitly covered as a side effect of the outer mandatory-missing branch.
  const r4 = await page.evaluate(() => {
    App.state.finance.mandatory = [{ id: 'm1', name: 'Bérlet', amount: 1000 }];
    App.state.finance.discretionary = null;
    App.state.finance.savings = 'not-an-array';
    normalizeAppState();
    return { discretionary: App.state.finance.discretionary, savings: App.state.finance.savings };
  });
  {
    const ok = Array.isArray(r4.discretionary) && Array.isArray(r4.savings);
    results.push({ name: 'normalizeAppState(): malformed finance.discretionary/savings backfilled even when finance.mandatory is valid', pass: ok, detail: JSON.stringify(r4) });
  }

  // 5) Negative-balance protection gap (found via a real user bug report: importing an old/
  // manually-edited JSON backup with a negative finance.accounts[].balance rendered a genuine,
  // alarming negative "Folyószámla egyenleg" - the only guards against negative balances lived
  // in the UI forms (saveAccountEdits()/saveAccount()/saveTransfer()), never in the load/import/
  // cloud-sync paths). applyImportedJson() must clamp a negative imported balance to 0.
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(400);
  const r5 = await page.evaluate(() => {
    const backup = {
      finance: {
        monthlyIncome: 0, mandatory: [], discretionary: [], savings: [],
        accounts: [
          { id: 'acc-checking', name: 'Folyószámla', icon: '💳', type: 'checking', balance: -50000 },
          { id: 'acc-savings', name: 'Megtakarítási számla', icon: '🏦', type: 'savings', balance: -1 },
        ],
      },
    };
    applyImportedJson(JSON.stringify(backup));
    App.ui.financeTab = 'attekintes';
    RENDERERS.finance();
    const rows = Array.from(document.querySelectorAll('#view-finance .card .flex.between')).map(el => el.textContent.trim());
    return {
      balances: App.state.finance.accounts.map(a => a.balance),
      balanceRow: rows.find(t => t.includes('Folyószámla egyenleg')),
      freeRemainingRow: rows.find(t => t.includes('Jelenlegi szabad pénz')),
    };
  });
  {
    const ok = r5.balances.every(b => b === 0) && r5.balanceRow.includes('0 Ft') && !r5.balanceRow.includes('-') && r5.freeRemainingRow.includes('0 Ft') && !r5.freeRemainingRow.includes('-');
    results.push({ name: 'applyImportedJson(): negative imported account balances clamp to 0, no negative "Folyószámla egyenleg"/"Jelenlegi szabad pénz"', pass: ok, detail: JSON.stringify(r5) });
  }

  // 6) Same protection via normalizeAppState() directly - covers BOTH loadState() (corrupted/
  // pre-guard localStorage) and applyCloudData() (a stale/corrupted cloud snapshot from another
  // device), since both call normalizeAppState() to backfill/validate finance.accounts.
  const r6 = await page.evaluate(() => {
    App.state.finance.accounts = [
      { id: 'acc-checking', name: 'Folyószámla', icon: '💳', type: 'checking', balance: -75000 },
      { id: 'acc-savings', name: 'Megtakarítási számla', icon: '🏦', type: 'savings', balance: 20000 },
    ];
    normalizeAppState();
    return App.state.finance.accounts.map(a => ({ id: a.id, balance: a.balance }));
  });
  {
    const ok = r6[0].balance === 0 && r6[1].balance === 20000; // only the negative one clamps; the valid positive one is untouched
    results.push({ name: 'normalizeAppState(): negative account balance clamps to 0 (covers loadState() + applyCloudData()), positive balances untouched', pass: ok, detail: JSON.stringify(r6) });
  }

  // 7) Malformed (non-numeric) balance also normalizes to 0 rather than propagating NaN/garbage.
  const r7 = await page.evaluate(() => {
    App.state.finance.accounts = [
      { id: 'acc-checking', name: 'Folyószámla', icon: '💳', type: 'checking', balance: 'not-a-number' },
    ];
    normalizeAppState();
    return App.state.finance.accounts[0].balance;
  });
  results.push({ name: 'normalizeAppState(): non-numeric balance normalizes to 0, not NaN', pass: r7 === 0, detail: 'balance=' + JSON.stringify(r7) });

  console.log('\n=== Import/migráció biztonsági hálójának tesztjei (round-3 data-handling audit fixes) ===');
  results.forEach(r => console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.name + '  [' + r.detail + ']'));
  console.log('\nConsole/page errors:', errs.length === 0 ? 'NONE' : errs.join(' | '));

  const anyFail = results.some(r => !r.pass) || errs.length > 0;
  console.log('\n' + (anyFail ? 'SOME FAILED' : 'ALL PASS'));
  process.exitCode = anyFail ? 1 : 0;
  } catch (e) {
    console.error('TEST FAILED:', e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
})();
