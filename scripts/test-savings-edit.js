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

  const reg = await page.evaluate(async () => await runRegressionChecks());
  const regFails = reg.filter(x => x['Eredmény'] !== 'PASS');
  results.push({name:'runRegressionChecks() 16/16 unaffected', pass: regFails.length===0, detail: JSON.stringify({total:reg.length, fails:regFails.length})});

  const outcome = await page.evaluate(() => {
    App.state.finance.savings.push({id:'test-sv-1', name:'Régi cél', icon:'🏦', saved:1000, target:20000});
    manageSavingsSheet('test-sv-1');
    const prefilled = {
      name: document.getElementById('sv-edit-name').value,
      icon: document.getElementById('sv-edit-icon').value,
      target: document.getElementById('sv-edit-target').value,
      saved: document.getElementById('sv-edit-saved').value,
    };
    document.getElementById('sv-edit-name').value = 'Utazás';
    document.getElementById('sv-edit-icon').value = '✈️';
    document.getElementById('sv-edit-target').value = '300000';
    document.getElementById('sv-edit-saved').value = '50000';
    saveSavingsEdits('test-sv-1');
    const saved = App.state.finance.savings.find(x=>x.id==='test-sv-1');
    return { prefilled, saved };
  });
  results.push({name:'sheet pre-fills existing values correctly', pass: outcome.prefilled.name==='Régi cél' && outcome.prefilled.icon==='🏦' && outcome.prefilled.target==='20000' && outcome.prefilled.saved==='1000', detail: JSON.stringify(outcome.prefilled)});
  results.push({name:'edited name/icon/target/saved all persisted', pass: outcome.saved.name==='Utazás' && outcome.saved.icon==='✈️' && outcome.saved.target===300000 && outcome.saved.saved===50000, detail: JSON.stringify(outcome.saved)});

  const rejectName = await page.evaluate(() => {
    manageSavingsSheet('test-sv-1');
    document.getElementById('sv-edit-name').value = '   ';
    saveSavingsEdits('test-sv-1');
    return App.state.finance.savings.find(i=>i.id==='test-sv-1').name;
  });
  results.push({name:'empty name rejected, previous name untouched', pass: rejectName==='Utazás', detail: 'name='+rejectName});

  const rejectTarget = await page.evaluate(() => {
    manageSavingsSheet('test-sv-1');
    document.getElementById('sv-edit-target').value = '-100';
    saveSavingsEdits('test-sv-1');
    return App.state.finance.savings.find(i=>i.id==='test-sv-1').target;
  });
  results.push({name:'negative target rejected, previous target (300000) untouched', pass: rejectTarget===300000, detail: 'target='+rejectTarget});

  const iconFallback = await page.evaluate(() => {
    manageSavingsSheet('test-sv-1');
    document.getElementById('sv-edit-icon').value = '';
    saveSavingsEdits('test-sv-1');
    return App.state.finance.savings.find(i=>i.id==='test-sv-1').icon;
  });
  results.push({name:'blank icon falls back to default (not stored empty)', pass: !!iconFallback && iconFallback.length>0, detail: 'icon='+iconFallback});

  // Milestone check: editing saved to meet/exceed target should trigger checkSavingsGoalMilestone
  const milestone = await page.evaluate(() => {
    App.state.rpg = App.state.rpg || {}; App.state.rpg.onboarded = true;
    App.state.finance.savings.push({id:'test-sv-2', name:'Cél2', icon:'🎯', saved:0, target:1000, _questSuggested100:false});
    App.state.aiChat = App.state.aiChat || [];
    const before = App.state.aiChat.length;
    manageSavingsSheet('test-sv-2');
    document.getElementById('sv-edit-saved').value = '1000';
    saveSavingsEdits('test-sv-2');
    return { after: App.state.aiChat.length, before, flagged: App.state.finance.savings.find(i=>i.id==='test-sv-2')._questSuggested100 };
  });
  results.push({name:'direct edit reaching target triggers milestone suggestion (parity with Befizetés path)', pass: milestone.after > milestone.before && milestone.flagged===true, detail: JSON.stringify(milestone)});

  console.log('\n=== Megtakarítási cél név/ikon/célösszeg szerkesztés tesztek ===');
  results.forEach(r => console.log((r.pass?'PASS':'FAIL')+' - '+r.name+'  ['+r.detail+']'));
  console.log('\nConsole/page errors:', errs.length===0?'NONE':errs.join(' | '));

  const anyFail = results.some(r=>!r.pass) || errs.length>0;
  console.log('\n'+(anyFail?'SOME FAILED':'ALL PASS'));

  await browser.close();
  server.kill();
  process.exitCode = anyFail ? 1 : 0;
})().catch(e => { console.error('TEST FAILED:', e); process.exitCode = 1; });
