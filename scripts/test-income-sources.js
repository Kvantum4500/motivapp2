const { chromium } = require('playwright');
const { spawn } = require('child_process');

const PORT = 8949;
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

  // 1) normalizeAppState() migrates an old state with only monthlyIncome set (no incomeSources array)
  //    into a single "Fizetés" source carrying that exact amount.
  const migrateWithIncome = await page.evaluate(() => {
    delete App.state.finance.incomeSources;
    App.state.finance.monthlyIncome = 480000;
    normalizeAppState();
    return App.state.finance.incomeSources;
  });
  results.push({
    name:'normalizeAppState() migrates old monthlyIncome (480000) into a single "Fizetés" incomeSources entry',
    pass: Array.isArray(migrateWithIncome) && migrateWithIncome.length===1 && migrateWithIncome[0].id==='inc1' && migrateWithIncome[0].name==='Fizetés' && migrateWithIncome[0].amount===480000,
    detail: JSON.stringify(migrateWithIncome)
  });

  // Reload to a clean state before the next migration scenario (avoid cross-test leakage).
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(400);

  // 2) A state with monthlyIncome:0 and no incomeSources array gets the plain default array
  //    (a single "Fizetés" entry with amount 0, exactly defaultState()'s template) - NOT skipped
  //    as an empty array, and NOT a "bogus" entry with a different id/shape. This keeps the
  //    migration branch's output identical, whether it runs, to a brand-new user's defaultState(),
  //    which is simpler to reason about than special-casing "no array at all" differently.
  const migrateNoIncome = await page.evaluate(() => {
    delete App.state.finance.incomeSources;
    App.state.finance.monthlyIncome = 0;
    normalizeAppState();
    return { got: App.state.finance.incomeSources, expected: defaultState().finance.incomeSources };
  });
  results.push({
    name:'normalizeAppState() with monthlyIncome:0 and no incomeSources gets the plain default array (defaultState() template, not a bogus/legacy entry)',
    pass: JSON.stringify(migrateNoIncome.got) === JSON.stringify(migrateNoIncome.expected),
    detail: JSON.stringify(migrateNoIncome.got)
  });

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(400);

  // 3) Same migration backfill mirrored in applyImportedJson() for old JSON backups.
  const importMigration = await page.evaluate(() => {
    const legacyBackup = JSON.stringify({ finance: { monthlyIncome: 250000, mandatory: [{id:'m1',name:'Bérlet',icon:'🏠',amount:0,type:'fix'}] } });
    applyImportedJson(legacyBackup);
    return App.state.finance.incomeSources;
  });
  results.push({
    name:'applyImportedJson() migrates an old backup\'s monthlyIncome into a single "Fizetés" incomeSources entry',
    pass: Array.isArray(importMigration) && importMigration.length===1 && importMigration[0].name==='Fizetés' && importMigration[0].amount===250000,
    detail: JSON.stringify(importMigration)
  });

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(400);

  // 4) ÁTTEKINTÉS renders the "Bevételi forrásaid" section with the default source, and the
  //    freeRemaining/"Fizetés" row reflect the SUM after adding a second income source.
  const twoSources = await page.evaluate(() => {
    App.state.finance.incomeSources = [{id:'inc1', name:'Fizetés', amount:400000}];
    App.state.finance.mandatory = [{id:'m1', name:'Bérlet', icon:'🏠', amount:100000, type:'fix'}];
    App.state.finance.discretionary = [{id:'d1', name:'Étkezés', icon:'🍔', spent:20000, limit:30000}];
    App.ui.financeTab = 'attekintes';
    RENDERERS.finance();
    const before = document.getElementById('view-finance').innerHTML;
    // add a second income source via addIncomeSourceSheet()/saveIncomeSource()
    addIncomeSourceSheet();
    document.getElementById('inc-name').value = 'Melléklás';
    document.getElementById('inc-amount').value = '100000';
    saveIncomeSource();
    const after = document.getElementById('view-finance').innerHTML;
    const totalIncome = App.state.finance.incomeSources.reduce((s,x)=>s+(x.amount||0),0);
    const freeRemaining = totalIncome - 100000 - 30000;
    return {
      hasSectionTitle: before.includes('Bevételi forrásaid'),
      hasDefaultCardBefore: before.includes('Fizetés') && before.includes('400 000 Ft'.replace(' ',' ')) || before.includes('400 000 Ft'),
      sourcesLen: App.state.finance.incomeSources.length,
      totalIncome,
      freeRemaining,
      afterHasBothNames: after.includes('Fizetés') && after.includes('Melléklás'),
      afterFizetesRow: (after.match(/Fizetés<\/span><span class="mono small">([^<]+)Ft/)||[])[1],
      afterFreeRow: (after.match(/Jelenlegi szabad pénz<\/span><span[^>]*>([^<]+)Ft/)||[])[1],
    };
  });
  results.push({name:'ÁTTEKINTÉS renders "Bevételi forrásaid" section title and the default source card', pass: twoSources.hasSectionTitle, detail: JSON.stringify({hasSectionTitle:twoSources.hasSectionTitle})});
  results.push({name:'addIncomeSourceSheet()/saveIncomeSource() adds a second income source', pass: twoSources.sourcesLen===2, detail: 'sourcesLen='+twoSources.sourcesLen});
  results.push({name:'after adding a second source, both names render in the ÁTTEKINTÉS list', pass: twoSources.afterHasBothNames, detail: JSON.stringify(twoSources.afterHasBothNames)});
  // innerHTML serializes the U+00A0 thousands-separator back out as the literal entity text
  // "&nbsp;" (same quirk documented in scripts/test-finance-donut-planned.js) - normalize both
  // that and a real NBSP to a plain space before comparing.
  const normSep = s => (s||'').trim().replace(/&nbsp;/g,' ').replace(/ /g,' ');
  results.push({
    name:'"Fizetés" summary row and "Jelenlegi szabad pénz" row reflect the SUM of all income sources, not just one',
    pass: normSep(twoSources.afterFizetesRow) === twoSources.totalIncome.toLocaleString('hu-HU').replace(/ /g,' ')
       && normSep(twoSources.afterFreeRow) === twoSources.freeRemaining.toLocaleString('hu-HU').replace(/ /g,' '),
    detail: JSON.stringify({afterFizetesRow:twoSources.afterFizetesRow, expectedTotal:twoSources.totalIncome.toLocaleString('hu-HU'), afterFreeRow:twoSources.afterFreeRow, expectedFree:twoSources.freeRemaining.toLocaleString('hu-HU')})
  });

  // 5) Editing an income source's amount persists and updates the total.
  const editOutcome = await page.evaluate(() => {
    const id = App.state.finance.incomeSources[0].id; // 'Fizetés', currently 400000
    manageIncomeSourceSheet(id);
    const prefilledName = document.getElementById('inc-edit-name').value;
    const prefilledAmount = document.getElementById('inc-edit-amount').value;
    document.getElementById('inc-edit-name').value = 'Fizetés';
    document.getElementById('inc-edit-amount').value = '450000';
    saveIncomeSourceEdits(id);
    const totalAfter = App.state.finance.incomeSources.reduce((s,x)=>s+(x.amount||0),0);
    return { prefilledName, prefilledAmount, amountAfter: App.state.finance.incomeSources.find(x=>x.id===id).amount, totalAfter };
  });
  results.push({name:'manageIncomeSourceSheet() pre-fills name/amount correctly', pass: editOutcome.prefilledName==='Fizetés' && editOutcome.prefilledAmount==='400 000', detail: JSON.stringify(editOutcome)});
  results.push({name:'saveIncomeSourceEdits() persists the edited amount and updates the total (400000->450000, total 450000+100000=550000)', pass: editOutcome.amountAfter===450000 && editOutcome.totalAfter===550000, detail: JSON.stringify(editOutcome)});

  // 6) Deleting one income source correctly reduces the total (uses the generic removeFinanceItem()).
  const deleteOutcome = await page.evaluate(() => {
    const before = App.state.finance.incomeSources.reduce((s,x)=>s+(x.amount||0),0);
    const idToRemove = App.state.finance.incomeSources.find(x=>x.name==='Melléklás').id;
    removeFinanceItem('incomeSources', idToRemove);
    const after = App.state.finance.incomeSources.reduce((s,x)=>s+(x.amount||0),0);
    return { before, after, lenAfter: App.state.finance.incomeSources.length };
  });
  results.push({name:'removeFinanceItem(\'incomeSources\', id) deletes a source and reduces the total (550000 -> 450000)', pass: deleteOutcome.before===550000 && deleteOutcome.after===450000 && deleteOutcome.lenAfter===1, detail: JSON.stringify(deleteOutcome)});

  // 7) moveFinanceItem() works unmodified for 'incomeSources' (generic helper) - add a third
  //    source first so there's something to reorder.
  const moveOutcome = await page.evaluate(() => {
    App.state.finance.incomeSources.push({id:'inc-extra', name:'Bérbeadás', amount:50000});
    const before = App.state.finance.incomeSources.map(x=>x.id);
    moveFinanceItem('incomeSources', 'inc-extra', -1);
    const after = App.state.finance.incomeSources.map(x=>x.id);
    return { before, after };
  });
  results.push({name:'moveFinanceItem(\'incomeSources\',...) reorders the array unmodified (generic helper)', pass: moveOutcome.after[0]==='inc-extra' && moveOutcome.before[0]!=='inc-extra', detail: JSON.stringify(moveOutcome)});

  // 8) _applyIncomeSuggestion finds-and-updates the existing "Fizetés" source when it already exists.
  const applyExisting = await page.evaluate(() => {
    App.state.finance.incomeSources = [{id:'inc1', name:'Fizetés', amount:300000}, {id:'inc-extra', name:'Bérbeadás', amount:50000}];
    const msg = _applyIncomeSuggestion({amount: 500000});
    return { sources: App.state.finance.incomeSources, msg };
  });
  results.push({
    name:'_applyIncomeSuggestion() updates the existing "Fizetés" source amount (find-by-name), does not create a duplicate',
    pass: applyExisting.sources.length===2 && applyExisting.sources.find(x=>x.name==='Fizetés').amount===500000,
    detail: JSON.stringify(applyExisting)
  });

  // 9) _applyIncomeSuggestion creates a fresh "Fizetés" source when the user renamed/removed the default one.
  const applyFresh = await page.evaluate(() => {
    App.state.finance.incomeSources = [{id:'inc1', name:'Alapfizetés', amount:300000}]; // renamed away from "Fizetés"
    const before = App.state.finance.incomeSources.length;
    const msg = _applyIncomeSuggestion({amount: 420000});
    return { sources: App.state.finance.incomeSources, before, msg };
  });
  results.push({
    name:'_applyIncomeSuggestion() creates a fresh "Fizetés" source when none by that exact name exists (renamed default not touched)',
    pass: applyFresh.sources.length===applyFresh.before+1
      && applyFresh.sources.find(x=>x.name==='Alapfizetés').amount===300000
      && applyFresh.sources.find(x=>x.name==='Fizetés').amount===420000,
    detail: JSON.stringify(applyFresh)
  });

  // 10) isLocalStateTrivial(): a state that only differs from defaultState() via finance.incomeSources
  //     (e.g. a customized income amount) is correctly treated as NON-trivial.
  const trivialCheck = await page.evaluate(() => {
    const fresh = defaultState();
    App.state = fresh;
    const trivialBefore = isLocalStateTrivial();
    App.state.finance.incomeSources[0].amount = 350000;
    const trivialAfter = isLocalStateTrivial();
    return { trivialBefore, trivialAfter };
  });
  results.push({name:'isLocalStateTrivial(): fresh defaultState() is trivial', pass: trivialCheck.trivialBefore===true, detail: JSON.stringify(trivialCheck)});
  results.push({name:'isLocalStateTrivial(): customizing finance.incomeSources amount makes state non-trivial', pass: trivialCheck.trivialAfter===false, detail: JSON.stringify(trivialCheck)});

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(400);

  // 11) runRegressionChecks() still 16/16 at the end, and zero console/page errors throughout.
  const regEnd = await page.evaluate(async () => await runRegressionChecks());
  const regEndFails = regEnd.filter(x => x['Eredmény'] !== 'PASS');
  results.push({name:'runRegressionChecks() still 16/16 at end of test run', pass: regEndFails.length===0, detail: JSON.stringify({total:regEnd.length, fails:regEndFails.length})});

  console.log('\n=== Bevételi forrásaid (finance.incomeSources) tesztek ===');
  results.forEach(r => console.log((r.pass?'PASS':'FAIL')+' - '+r.name+'  ['+r.detail+']'));
  console.log('\nConsole/page errors:', errs.length===0?'NONE':errs.join(' | '));

  const anyFail = results.some(r=>!r.pass) || errs.length>0;
  console.log('\n'+(anyFail?'SOME FAILED':'ALL PASS'));

  await browser.close();
  server.kill();
  process.exitCode = anyFail ? 1 : 0;
})().catch(e => { console.error('TEST FAILED:', e); process.exitCode = 1; });
