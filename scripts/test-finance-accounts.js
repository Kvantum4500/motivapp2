const { chromium } = require('playwright');
const { spawn } = require('child_process');

const PORT = 8948;
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

  // 1) normalizeAppState() backfills finance.accounts for a state object missing it entirely
  //    (simulating an existing user's pre-this-feature saved state).
  const backfill = await page.evaluate(() => {
    delete App.state.finance.accounts;
    normalizeAppState();
    return App.state.finance.accounts;
  });
  results.push({name:'normalizeAppState() backfills finance.accounts with the two default accounts when missing', pass: Array.isArray(backfill) && backfill.length===2 && backfill[0].id==='acc-checking' && backfill[0].type==='checking' && backfill[0].balance===0 && backfill[1].id==='acc-savings' && backfill[1].type==='savings' && backfill[1].balance===0, detail: JSON.stringify(backfill)});

  // Reload to a clean state for the rest of the tests (backfill test mutated App.state.finance.accounts
  // in a way that is already covered above; a fresh reload avoids any cross-test leakage).
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(400);

  // 2) SZÁMLÁK tab renders both default accounts
  const tabRender = await page.evaluate(() => {
    App.ui.tab = 'schedule'; // irrelevant - finance view is rendered into #view-finance regardless of active top tab
    setFinanceTab('szamlak');
    const html = document.getElementById('view-finance').innerHTML;
    return {
      hasChecking: html.includes('Folyószámla') && html.includes('💳'),
      hasSavings: html.includes('Megtakarítási számla'),
      hasTransferBtn: html.includes('Utalás számlák között'),
      hasAddBtn: html.includes('Új számla hozzáadása'),
    };
  });
  results.push({name:'SZÁMLÁK tab renders both default accounts + transfer/add buttons', pass: tabRender.hasChecking && tabRender.hasSavings && tabRender.hasTransferBtn && tabRender.hasAddBtn, detail: JSON.stringify(tabRender)});

  // 3) manageAccountSheet()/saveAccountEdits(): name/icon/balance editable, persisted
  const editOutcome = await page.evaluate(() => {
    manageAccountSheet('acc-checking');
    const prefilled = {
      name: document.getElementById('acc-edit-name').value,
      icon: document.getElementById('acc-edit-icon').value,
      balance: document.getElementById('acc-edit-balance').value,
      typeActive: document.querySelector('#acc-edit-type .chip.active').dataset.v,
    };
    document.getElementById('acc-edit-name').value = 'Napi számla';
    document.getElementById('acc-edit-icon').value = '💰';
    document.getElementById('acc-edit-balance').value = '500000';
    saveAccountEdits('acc-checking');
    const acc = App.state.finance.accounts.find(a=>a.id==='acc-checking');
    return { prefilled, acc };
  });
  results.push({name:'manageAccountSheet() pre-fills name/icon/type/balance correctly', pass: editOutcome.prefilled.name==='Folyószámla' && editOutcome.prefilled.icon==='💳' && editOutcome.prefilled.typeActive==='checking' && editOutcome.prefilled.balance==='0', detail: JSON.stringify(editOutcome.prefilled)});
  results.push({name:'saveAccountEdits() persists edited name/icon/balance (direct set)', pass: editOutcome.acc.name==='Napi számla' && editOutcome.acc.icon==='💰' && editOutcome.acc.balance===500000 && editOutcome.acc.type==='checking', detail: JSON.stringify(editOutcome.acc)});

  // 4) addAccountSheet()/saveAccount() adds a new account
  const addOutcome = await page.evaluate(() => {
    const before = App.state.finance.accounts.length;
    addAccountSheet();
    const defaultTypeActive = document.querySelector('#acc-type .chip.active').dataset.v;
    document.getElementById('acc-name').value = 'Befektetési számla';
    document.getElementById('acc-balance').value = '120000';
    document.querySelector('#acc-type .chip[data-v="savings"]').click();
    saveAccount();
    const after = App.state.finance.accounts.length;
    const added = App.state.finance.accounts[App.state.finance.accounts.length-1];
    return { before, after, added, defaultTypeActive };
  });
  results.push({name:'addAccountSheet() defaults to a sensible type chip (checking already present -> defaults to savings)', pass: addOutcome.defaultTypeActive==='savings', detail: 'defaultTypeActive='+addOutcome.defaultTypeActive});
  results.push({name:'saveAccount() adds a new account with chosen name/type/balance', pass: addOutcome.after===addOutcome.before+1 && addOutcome.added.name==='Befektetési számla' && addOutcome.added.type==='savings' && addOutcome.added.balance===120000, detail: JSON.stringify(addOutcome.added)});

  // 5) Full transfer between the two default accounts correctly decrements source and increments destination
  const transfer1 = await page.evaluate(() => {
    const from = App.state.finance.accounts.find(a=>a.id==='acc-checking');
    const to = App.state.finance.accounts.find(a=>a.id==='acc-savings');
    from.balance = 500000; to.balance = 600000;
    transferBetweenAccountsSheet();
    const fromChipActive = document.querySelector('#tr-from .chip.active').dataset.id;
    const toChipActive = document.querySelector('#tr-to .chip.active').dataset.id;
    document.getElementById('tr-amount').value = '50000';
    saveTransfer();
    return {
      fromChipActive, toChipActive,
      fromBalance: App.state.finance.accounts.find(a=>a.id==='acc-checking').balance,
      toBalance: App.state.finance.accounts.find(a=>a.id==='acc-savings').balance,
    };
  });
  results.push({name:'transferBetweenAccountsSheet() defaults Honnan/Hova to checking->savings when both exist', pass: transfer1.fromChipActive==='acc-checking' && transfer1.toChipActive==='acc-savings', detail: JSON.stringify({fromChipActive:transfer1.fromChipActive, toChipActive:transfer1.toChipActive})});
  results.push({name:'saveTransfer() decrements source and increments destination by the exact amount', pass: transfer1.fromBalance===450000 && transfer1.toBalance===650000, detail: JSON.stringify(transfer1)});

  // 6) Transfer into the savings account WITH a goal selected also increments that goal's saved,
  //    and triggers the milestone suggestion when it reaches target.
  const transferWithGoal = await page.evaluate(() => {
    App.state.rpg = App.state.rpg || {}; App.state.rpg.onboarded = true;
    App.state.finance.savings.push({id:'test-goal-1', name:'Autó', icon:'🚗', saved:9000, target:10000, _questSuggested100:false});
    App.state.aiChat = App.state.aiChat || [];
    const chatBefore = App.state.aiChat.length;
    const from = App.state.finance.accounts.find(a=>a.id==='acc-checking');
    const to = App.state.finance.accounts.find(a=>a.id==='acc-savings');
    const fromBalBefore = from.balance, toBalBefore = to.balance;
    transferBetweenAccountsSheet();
    const goalSectionHasGoal = document.getElementById('tr-goal-section').innerHTML.includes('Autó');
    document.getElementById('tr-amount').value = '1000';
    document.querySelector('#tr-goal .chip[data-id="test-goal-1"]').click();
    saveTransfer();
    const goal = App.state.finance.savings.find(g=>g.id==='test-goal-1');
    return {
      goalSectionHasGoal,
      fromBalAfter: from.balance, fromBalBefore,
      toBalAfter: to.balance, toBalBefore,
      goalSaved: goal.saved, goalFlagged: goal._questSuggested100,
      chatAfter: App.state.aiChat.length, chatBefore,
    };
  });
  results.push({name:'"Mire teszed félre?" goal chips appear for a savings-type destination and include the goal', pass: transferWithGoal.goalSectionHasGoal, detail: 'goalSectionHasGoal='+transferWithGoal.goalSectionHasGoal});
  results.push({name:'transfer into savings account moves balances correctly', pass: transferWithGoal.fromBalAfter===transferWithGoal.fromBalBefore-1000 && transferWithGoal.toBalAfter===transferWithGoal.toBalBefore+1000, detail: JSON.stringify(transferWithGoal)});
  results.push({name:'transfer WITH a goal selected increments that goal\'s saved by the transferred amount', pass: transferWithGoal.goalSaved===10000, detail: 'goalSaved='+transferWithGoal.goalSaved});
  results.push({name:'reaching target via a tagged transfer triggers checkSavingsGoalMilestone (milestone suggestion posted)', pass: transferWithGoal.goalFlagged===true && transferWithGoal.chatAfter>transferWithGoal.chatBefore, detail: JSON.stringify({flagged:transferWithGoal.goalFlagged, chatBefore:transferWithGoal.chatBefore, chatAfter:transferWithGoal.chatAfter})});

  // 7) Transfer into the savings account WITHOUT a goal selected does NOT touch any goal's saved.
  const transferNoGoal = await page.evaluate(() => {
    const goalBefore = App.state.finance.savings.find(g=>g.id==='test-goal-1').saved;
    const otherGoalsBefore = App.state.finance.savings.map(g=>({id:g.id, saved:g.saved}));
    transferBetweenAccountsSheet();
    // "Nincs konkrét cél / Egyéb" is the default-selected chip - leave it as-is.
    const noGoalChipActive = document.querySelector('#tr-goal .chip.active').dataset.id;
    document.getElementById('tr-amount').value = '2000';
    saveTransfer();
    const otherGoalsAfter = App.state.finance.savings.map(g=>({id:g.id, saved:g.saved}));
    return { noGoalChipActive, goalBefore, otherGoalsBefore, otherGoalsAfter };
  });
  results.push({name:'"Nincs konkrét cél / Egyéb" is the default-selected chip', pass: transferNoGoal.noGoalChipActive==='', detail: 'noGoalChipActive='+JSON.stringify(transferNoGoal.noGoalChipActive)});
  results.push({name:'transfer WITHOUT a goal selected does not change any goal\'s saved amount', pass: JSON.stringify(transferNoGoal.otherGoalsBefore)===JSON.stringify(transferNoGoal.otherGoalsAfter), detail: JSON.stringify(transferNoGoal)});

  // 8) A transfer attempt exceeding the source balance is rejected with balances unchanged on both accounts.
  const overdraw = await page.evaluate(() => {
    const from = App.state.finance.accounts.find(a=>a.id==='acc-checking');
    const to = App.state.finance.accounts.find(a=>a.id==='acc-savings');
    const fromBefore = from.balance, toBefore = to.balance;
    transferBetweenAccountsSheet();
    document.getElementById('tr-amount').value = String(fromBefore + 1000000);
    saveTransfer();
    const sheetStillOpen = document.getElementById('sheetbg').classList.contains('open');
    return { fromAfter: from.balance, fromBefore, toAfter: to.balance, toBefore, sheetStillOpen };
  });
  results.push({name:'a transfer exceeding the source balance is rejected, balances unchanged on both accounts', pass: overdraw.fromAfter===overdraw.fromBefore && overdraw.toAfter===overdraw.toBefore && overdraw.sheetStillOpen, detail: JSON.stringify(overdraw)});

  // 9) A same-account transfer attempt is rejected.
  const sameAccount = await page.evaluate(() => {
    transferBetweenAccountsSheet();
    document.querySelectorAll('#tr-to .chip').forEach(c=>c.classList.remove('active'));
    document.querySelector('#tr-to .chip[data-id="acc-checking"]').classList.add('active');
    // from is already defaulted to acc-checking - both sides now point at the same account.
    const from = App.state.finance.accounts.find(a=>a.id==='acc-checking');
    const balBefore = from.balance;
    document.getElementById('tr-amount').value = '1000';
    saveTransfer();
    return { balAfter: from.balance, balBefore, sheetStillOpen: document.getElementById('sheetbg').classList.contains('open') };
  });
  results.push({name:'a same-account transfer attempt is rejected, balance unchanged', pass: sameAccount.balAfter===sameAccount.balBefore && sameAccount.sheetStillOpen, detail: JSON.stringify(sameAccount)});

  // 10) removeFinanceItem/moveFinanceItem work unmodified for 'accounts' (generic helpers).
  const genericHelpers = await page.evaluate(() => {
    const before = App.state.finance.accounts.map(a=>a.id);
    moveFinanceItem('accounts','acc-savings',-1);
    const afterMove = App.state.finance.accounts.map(a=>a.id);
    removeFinanceItem('accounts','acc-savings');
    const afterRemove = App.state.finance.accounts.map(a=>a.id);
    return { before, afterMove, afterRemove };
  });
  results.push({name:'moveFinanceItem() reorders the accounts array', pass: genericHelpers.afterMove[0]==='acc-savings' && genericHelpers.before[0]!=='acc-savings', detail: JSON.stringify(genericHelpers)});
  results.push({name:'removeFinanceItem() removes an account', pass: !genericHelpers.afterRemove.includes('acc-savings'), detail: JSON.stringify(genericHelpers.afterRemove)});

  // 11) runRegressionChecks() still 16/16 at the end, and zero console/page errors throughout.
  const regEnd = await page.evaluate(async () => await runRegressionChecks());
  const regEndFails = regEnd.filter(x => x['Eredmény'] !== 'PASS');
  results.push({name:'runRegressionChecks() still 16/16 at end of test run', pass: regEndFails.length===0, detail: JSON.stringify({total:regEnd.length, fails:regEndFails.length})});

  console.log('\n=== Számlák (finance.accounts) + Utalás számlák között tesztek ===');
  results.forEach(r => console.log((r.pass?'PASS':'FAIL')+' - '+r.name+'  ['+r.detail+']'));
  console.log('\nConsole/page errors:', errs.length===0?'NONE':errs.join(' | '));

  const anyFail = results.some(r=>!r.pass) || errs.length>0;
  console.log('\n'+(anyFail?'SOME FAILED':'ALL PASS'));

  await browser.close();
  server.kill();
  process.exitCode = anyFail ? 1 : 0;
})().catch(e => { console.error('TEST FAILED:', e); process.exitCode = 1; });
