const { chromium } = require('playwright');
const { spawn } = require('child_process');

const PORT = 8946;
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

  // 1) Seed a discretionary category directly in state, open manage sheet, edit all fields, save, verify persisted
  const outcome = await page.evaluate(() => {
    App.state.finance.discretionary.push({id:'test-cat-1', name:'Régi név', icon:'🛒', spent:1000, limit:5000});
    manageDiscretionarySheet('test-cat-1');
    const nameEl = document.getElementById('dc-edit-name');
    const iconEl = document.getElementById('dc-edit-icon');
    const limitEl = document.getElementById('dc-edit-limit');
    const spentEl = document.getElementById('dc-edit-spent');
    const prefilled = {
      name: nameEl && nameEl.value,
      icon: iconEl && iconEl.value,
      limit: limitEl && limitEl.value,
      spent: spentEl && spentEl.value,
    };
    nameEl.value = 'Ruházat';
    iconEl.value = '👕';
    limitEl.value = '15000';
    spentEl.value = '2500';
    saveDiscretionaryEdits('test-cat-1');
    const saved = App.state.finance.discretionary.find(x=>x.id==='test-cat-1');
    return { prefilled, saved };
  });
  results.push({name:'sheet pre-fills existing values correctly (already thousand-separated, live-format helper applied on open)', pass: outcome.prefilled.name==='Régi név' && outcome.prefilled.icon==='🛒' && outcome.prefilled.limit==='5 000' && outcome.prefilled.spent==='1 000', detail: JSON.stringify(outcome.prefilled)});
  results.push({name:'edited name/icon/limit/spent all persisted to state', pass: outcome.saved.name==='Ruházat' && outcome.saved.icon==='👕' && outcome.saved.limit===15000 && outcome.saved.spent===2500, detail: JSON.stringify(outcome.saved)});

  // 2) Empty name rejected (validation)
  const rejectName = await page.evaluate(() => {
    manageDiscretionarySheet('test-cat-1');
    document.getElementById('dc-edit-name').value = '   ';
    saveDiscretionaryEdits('test-cat-1');
    const x = App.state.finance.discretionary.find(i=>i.id==='test-cat-1');
    return { nameStillRuhazat: x.name==='Ruházat', sheetStillOpen: document.getElementById('sheetbg').classList.contains('open') };
  });
  results.push({name:'empty name rejected, previous name untouched', pass: rejectName.nameStillRuhazat, detail: JSON.stringify(rejectName)});

  // 3) The live-formatting input only allows digits, so a minus sign can never be
  //    typed through the real UI. A directly-injected one (bypassing real typing,
  //    e.g. simulating a paste) is normalized to its non-negative absolute value by
  //    parseAmountInput() rather than producing a negative stored amount - this
  //    replaces the old browser-level min="0" validation, which no longer applies
  //    now that the field is type="text".
  const negativeInputNormalized = await page.evaluate(() => {
    manageDiscretionarySheet('test-cat-1');
    document.getElementById('dc-edit-limit').value = '-500';
    saveDiscretionaryEdits('test-cat-1');
    const x = App.state.finance.discretionary.find(i=>i.id==='test-cat-1');
    return x.limit;
  });
  results.push({name:'a directly-injected minus sign is normalized to a non-negative amount, never stored as negative', pass: negativeInputNormalized===500, detail: 'limit='+negativeInputNormalized});

  // 4) Empty icon falls back to default emoji rather than storing blank
  const iconFallback = await page.evaluate(() => {
    manageDiscretionarySheet('test-cat-1');
    document.getElementById('dc-edit-icon').value = '';
    saveDiscretionaryEdits('test-cat-1');
    const x = App.state.finance.discretionary.find(i=>i.id==='test-cat-1');
    return x.icon;
  });
  results.push({name:'blank icon falls back to default (not stored empty)', pass: !!iconFallback && iconFallback.length>0, detail: 'icon='+iconFallback});

  console.log('\n=== Egyéb kategória (discretionary) név/ikon/keret szerkesztés tesztek ===');
  results.forEach(r => console.log((r.pass?'PASS':'FAIL')+' - '+r.name+'  ['+r.detail+']'));
  console.log('\nConsole/page errors:', errs.length===0?'NONE':errs.join(' | '));

  const anyFail = results.some(r=>!r.pass) || errs.length>0;
  console.log('\n'+(anyFail?'SOME FAILED':'ALL PASS'));

  await browser.close();
  server.kill();
  process.exitCode = anyFail ? 1 : 0;
})().catch(e => { console.error('TEST FAILED:', e); process.exitCode = 1; });
