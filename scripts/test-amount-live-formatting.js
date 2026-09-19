const { chromium } = require('playwright');
const { spawn } = require('child_process');

const PORT = 8948;
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const APP_DIR = __dirname + '/..';

// NOTE on the separator character: fmtFtInput() (index.html) uses U+00A0 (NO-BREAK SPACE)
// as the thousands separator, matching the rest of the app's `.toLocaleString('hu-HU')`
// calls (e.g. "150 000 Ft" on cards elsewhere). It groups from 4 digits up (via
// `new Intl.NumberFormat('hu-HU',{useGrouping:true})`, deliberately NOT bare
// `Number.prototype.toLocaleString('hu-HU')`, which in this Chromium/ICU build only groups
// once a number reaches 5 digits - e.g. `(1234).toLocaleString('hu-HU')` -> "1234", no
// separator - failing the very "5000 -> 5.000 while typing" case this feature exists for.
const NBSP = ' ';

(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: APP_DIR, stdio: 'pipe' });
  let browser;
  try {
  await new Promise(r => setTimeout(r, 1000));
  browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--headless=new'] });
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

  // 1) Income source (inc-amount, addIncomeSourceSheet/saveIncomeSource): type "12345" char by
  //    char, assert live-formatted display at each keystroke, then save and confirm the plain
  //    numeric value lands in the new finance.incomeSources array (replaced the old flat
  //    monthlyIncome field/editIncomeSheet()/saveIncome() - see PR #66).
  await page.evaluate(() => { addIncomeSourceSheet(); document.getElementById('inc-name').value = 'Teszt forrás'; });
  const incEl = await page.$('#inc-amount');
  await incEl.click();
  const incStages = [];
  for (const ch of '12345') {
    await page.keyboard.type(ch);
    incStages.push(await incEl.inputValue());
  }
  await page.evaluate(() => saveIncomeSource());
  const incSaved = await page.evaluate(() => App.state.finance.incomeSources.find(x=>x.name==='Teszt forrás').amount);
  const incExpected = ['1','12','123','1'+NBSP+'234','12'+NBSP+'345'];
  results.push({name:'inc-amount live-formats while typing "12345" -> grouped as "12 345" (NBSP) once it reaches 5 digits', pass: JSON.stringify(incStages)===JSON.stringify(incExpected), detail: 'got '+JSON.stringify(incStages)+' expected '+JSON.stringify(incExpected)});
  results.push({name:'inc-amount: saved App.state value is plain number 12345 (not corrupted by the separator)', pass: incSaved===12345, detail: 'amount='+incSaved});

  // 2) Editing an EXISTING income source: pre-filled sheet shows it already formatted, not raw digits.
  const prefillCheck = await page.evaluate(() => {
    App.state.finance.incomeSources.push({id:'fmt-test-inc', name:'Fizetés teszt', amount:150000});
    manageIncomeSourceSheet('fmt-test-inc');
    return document.getElementById('inc-edit-amount').value;
  });
  const prefillExpected = '150'+NBSP+'000';
  results.push({name:'manageIncomeSourceSheet() pre-fills existing 150000 as "150 000" (already formatted on open)', pass: prefillCheck===prefillExpected, detail: 'value='+JSON.stringify(prefillCheck)});
  await page.evaluate(() => closeSheet());

  // 3) Discretionary edit (dc-edit-limit / dc-edit-spent): confirm pre-fill formatting for a
  //    second, independent sheet/save pair, then type into dc-edit-limit and save.
  const dcPrefill = await page.evaluate(() => {
    App.state.finance.discretionary.push({id:'fmt-test-cat', name:'Teszt kategória', icon:'🛍️', spent:12500, limit:75000});
    manageDiscretionarySheet('fmt-test-cat');
    return { limit: document.getElementById('dc-edit-limit').value, spent: document.getElementById('dc-edit-spent').value };
  });
  const dcPrefillExpected = { limit: '75'+NBSP+'000', spent: '12'+NBSP+'500' };
  results.push({name:'manageDiscretionarySheet() pre-fills limit 75000 and spent 12500 already formatted', pass: dcPrefill.limit===dcPrefillExpected.limit && dcPrefill.spent===dcPrefillExpected.spent, detail: 'got '+JSON.stringify(dcPrefill)+' expected '+JSON.stringify(dcPrefillExpected)});

  const dcLimitEl = await page.$('#dc-edit-limit');
  await dcLimitEl.click({clickCount:3}); // select-all the pre-filled "75 000" before retyping
  await page.keyboard.press('Backspace');
  const dcStages = [];
  for (const ch of '123456') {
    await page.keyboard.type(ch);
    dcStages.push(await dcLimitEl.inputValue());
  }
  await page.evaluate(() => saveDiscretionaryEdits('fmt-test-cat'));
  const dcSaved = await page.evaluate(() => App.state.finance.discretionary.find(x=>x.id==='fmt-test-cat').limit);
  const dcExpectedLast = '123'+NBSP+'456';
  results.push({name:'dc-edit-limit live-formats while typing "123456" -> ends "123 456"', pass: dcStages[dcStages.length-1]===dcExpectedLast, detail: 'stages='+JSON.stringify(dcStages)});
  results.push({name:'dc-edit-limit: saved App.state value is plain number 123456', pass: dcSaved===123456, detail: 'limit='+dcSaved});

  // 4) Savings add (sv-add): another sheet/save pair, typing digits (5-digit amount so real
  //    grouping actually kicks in, per the NBSP/5-digit note above).
  const svId = await page.evaluate(() => {
    App.state.finance.savings.push({id:'fmt-test-sv', name:'Teszt cél', icon:'🏦', saved:0, target:500000});
    addToSavingsSheet('fmt-test-sv');
    return 'fmt-test-sv';
  });
  const svEl = await page.$('#sv-add');
  await svEl.click();
  for (const ch of '95000') await page.keyboard.type(ch);
  const svDisplay = await svEl.inputValue();
  await page.evaluate((id) => saveSavingsAdd(id), svId);
  const svSaved = await page.evaluate(() => App.state.finance.savings.find(x=>x.id==='fmt-test-sv').saved);
  const svExpected = '95'+NBSP+'000';
  results.push({name:'sv-add live-formats "95000" -> "95 000"', pass: svDisplay===svExpected, detail: 'display='+JSON.stringify(svDisplay)});
  results.push({name:'sv-add: saved App.state saved amount is plain number 95000', pass: svSaved===95000, detail: 'saved='+svSaved});

  // 5) Dynamic MotivAI suggestion field (ai-sugg-amount-${i}-${si}): render a chat message
  //    with an 'income' suggestion, confirm formatAmountInputLive is attached to the
  //    dynamically-IDed field after renderAiChat(), type digits, accept, confirm applied value.
  const aiPrefill = await page.evaluate(() => {
    openSub('ai'); // #ai-log only exists in the DOM once the MotivAI sub-view is active
    App.state.aiChat = [{role:'assistant', content:'Beállítsam a bevételt?', suggestions:[{type:'income', amount:300000}]}];
    renderAiChat();
    return document.getElementById('ai-sugg-amount-0-0').value;
  });
  const aiPrefillExpected = '300'+NBSP+'000';
  results.push({name:'ai-sugg-amount-0-0 pre-fills suggested amount 300000 as "300 000"', pass: aiPrefill===aiPrefillExpected, detail: 'value='+JSON.stringify(aiPrefill)});

  const aiEl = await page.$('#ai-sugg-amount-0-0');
  await aiEl.click({clickCount:3});
  await page.keyboard.press('Backspace');
  const aiStages = [];
  for (const ch of '48000') {
    await page.keyboard.type(ch);
    aiStages.push(await aiEl.inputValue());
  }
  const aiExpectedLast = '48'+NBSP+'000';
  results.push({name:'ai-sugg-amount-0-0 live-formats "48000" -> "48 000" (helper attached via [id^="ai-sugg-amount-"] after re-render)', pass: aiStages[aiStages.length-1]===aiExpectedLast, detail: 'stages='+JSON.stringify(aiStages)});

  await page.evaluate(() => { App.state.rpg = App.state.rpg||{}; acceptAiSuggestion(0,0); });
  const aiApplied = await page.evaluate(() => {
    const item = App.state.finance.incomeSources.find(x=>x.name==='Fizetés');
    return item && item.amount;
  });
  results.push({name:'accepting AI income suggestion applies plain number 48000 to the canonical "Fizetés" incomeSources entry (not corrupted by the separator)', pass: aiApplied===48000, detail: 'amount='+aiApplied});

  // 6) Cursor-position sanity: type "150000", move cursor into the middle with ArrowLeft,
  //    type an extra digit, and confirm it lands where the human positioned the cursor
  //    (not appended to the end).
  await page.evaluate(() => { addMandatorySheet(); });
  const mnAmountEl = await page.$('#mn-amount');
  await mnAmountEl.click();
  for (const ch of '150000') await page.keyboard.type(ch);
  const beforeCursor = await mnAmountEl.inputValue(); // "150 000"
  // "150 000" is 7 characters: '1','5','0',NBSP,'0','0','0'. Cursor starts at the end (index 7).
  // 5x ArrowLeft lands it at index 2 - right after the digits "15", before the third digit "0"
  // of "150" - i.e. squarely in the middle of the number, not at either end.
  for (let i=0;i<5;i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('9');
  const afterMidInsert = await mnAmountEl.inputValue();
  // Inserting "9" between the 2nd and 3rd digit of "150000" (digits: 1,5,0,0,0,0) gives
  // "15" + "9" + "0000" = "1590000" -> formatted "1 590 000". A naive "cursor always jumps to
  // the end" implementation would instead produce "150 0009" (appended) or similar breakage.
  const midInsertExpected = '1'+NBSP+'590'+NBSP+'000';
  results.push({name:'cursor sanity: "150 000" with cursor repositioned mid-number + typed "9" inserts at cursor, not appended at end', pass: afterMidInsert===midInsertExpected, detail: 'before='+JSON.stringify(beforeCursor)+' after='+JSON.stringify(afterMidInsert)+' expected='+JSON.stringify(midInsertExpected)});

  console.log('\n=== Élő ezres-tagolás (amount live formatting) tesztek ===');
  results.forEach(r => console.log((r.pass?'PASS':'FAIL')+' - '+r.name+'  ['+r.detail+']'));
  console.log('\nConsole/page errors:', errs.length===0?'NONE':errs.join(' | '));

  const anyFail = results.some(r=>!r.pass) || errs.length>0;
  console.log('\n'+(anyFail?'SOME FAILED':'ALL PASS'));
  process.exitCode = anyFail ? 1 : 0;
  } catch (e) {
    console.error('TEST FAILED:', e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
})();
