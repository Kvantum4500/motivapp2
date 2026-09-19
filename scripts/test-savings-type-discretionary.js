const { chromium } = require('playwright');
const { spawn } = require('child_process');

const PORT = 8954;
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const APP_DIR = __dirname + '/..';

// User bug report: an expense conceptually tied to savings (e.g. "car repair", paid out of
// money already set aside) was being recorded as a normal discretionary category, which never
// touches any account balance and instead drags down the Folyószámla card's "Jelenlegi szabad
// pénz" - the user's point: "ha arra félre van téve akkor ahhoz nem lehet hozzányúlni" (if it's
// set aside for that, you shouldn't be able to touch it from checking). Feature: a discretionary
// category can be marked isSavingsType, linked to a specific savings-type account
// (savingsAccountId) - recording spend against it then decrements that REAL account balance via
// applyDiscretionarySpendDelta(), and is excluded from the Folyószámla card's
// discSpent/discLimitTotal/freeRemaining entirely.
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

    // Set up a known state: checking 150000, savings 520000, one "Autó" discretionary category.
    const setup = await page.evaluate(() => {
      App.state.finance.accounts = [
        { id: 'acc-checking', name: 'Folyószámla', icon: '💳', type: 'checking', balance: 150000 },
        { id: 'acc-savings', name: 'Megtakarítási számla', icon: '🏦', type: 'savings', balance: 520000 },
      ];
      App.state.finance.mandatory = [];
      App.state.finance.discretionary = [{ id: 'd-auto', name: 'Autó', icon: '🚙', spent: 0, limit: 25000 }];
      App.state.finance.incomeSources = [{ id: 'inc1', name: 'Fizetés', amount: 520000 }];
      saveState();
      return true;
    });
    results.push({ name: 'setup applied', pass: setup, detail: '' });

    // 1) BEFORE marking it savings-type: recording a spend behaves exactly as before - only
    // affects discretionary.spent, drags the Folyószámla card's freeRemaining down, never
    // touches any account balance.
    const before = await page.evaluate(() => {
      const x = App.state.finance.discretionary.find(c => c.id === 'd-auto');
      document.getElementById && null;
      logSpendSheet('d-auto');
      document.getElementById('sp-amount').value = '5000';
      saveSpend('d-auto');
      App.ui.financeTab = 'attekintes';
      RENDERERS.finance();
      const checkingAcc = App.state.finance.accounts.find(a => a.id === 'acc-checking');
      const savingsAcc = App.state.finance.accounts.find(a => a.id === 'acc-savings');
      return { spent: x.spent, checkingBalance: checkingAcc.balance, savingsBalance: savingsAcc.balance };
    });
    results.push({ name: 'BEFORE savings-type toggle: saveSpend() only changes discretionary.spent, no account touched', pass: before.spent === 5000 && before.checkingBalance === 150000 && before.savingsBalance === 520000, detail: JSON.stringify(before) });

    // 2) Mark "Autó" as savings-type via the actual edit sheet UI, linked to the savings account.
    const marked = await page.evaluate(() => {
      manageDiscretionarySheet('d-auto');
      document.querySelector('#dc-edit-savingstype .chip[data-v="savings"]').click();
      const acctChip = document.querySelector('#dc-edit-savingsacct .chip[data-id="acc-savings"]');
      const hasAcctChip = !!acctChip;
      if (acctChip) acctChip.click();
      saveDiscretionaryEdits('d-auto');
      const x = App.state.finance.discretionary.find(c => c.id === 'd-auto');
      return { hasAcctChip, isSavingsType: x.isSavingsType, savingsAccountId: x.savingsAccountId };
    });
    results.push({ name: 'manageDiscretionarySheet(): savings-account chip appears and can be selected via the real UI', pass: marked.hasAcctChip, detail: JSON.stringify(marked) });
    results.push({ name: 'saveDiscretionaryEdits(): persists isSavingsType=true + savingsAccountId via the toggle chips', pass: marked.isSavingsType === true && marked.savingsAccountId === 'acc-savings', detail: JSON.stringify(marked) });

    // 3) AFTER marking savings-type: recording a NEW spend must decrement the Megtakarítási
    // számla balance directly, and must NOT count toward the Folyószámla card's kiadás totals.
    const after = await page.evaluate(() => {
      logSpendSheet('d-auto');
      document.getElementById('sp-amount').value = '8000';
      saveSpend('d-auto');
      App.ui.financeTab = 'attekintes';
      RENDERERS.finance();
      const x = App.state.finance.discretionary.find(c => c.id === 'd-auto');
      const checkingAcc = App.state.finance.accounts.find(a => a.id === 'acc-checking');
      const savingsAcc = App.state.finance.accounts.find(a => a.id === 'acc-savings');
      const rows = Array.from(document.querySelectorAll('#view-finance .card .flex.between')).map(el => el.textContent.trim());
      return {
        spent: x.spent,
        checkingBalance: checkingAcc.balance,
        savingsBalance: savingsAcc.balance,
        freeRemainingRow: rows.find(t => t.includes('Jelenlegi szabad pénz')),
      };
    });
    {
      // Total spent on "Autó" is now 5000 (before toggle) + 8000 (after toggle) = 13000, but only
      // the 8000 recorded AFTER the toggle should have touched the savings account: 520000-8000=512000.
      // Checking balance must be completely untouched (150000), and freeRemaining must reflect
      // ONLY mandatory (0) subtracted from checking (150000) - the now-excluded "Autó" limit
      // (25000) must NOT drag it down anymore.
      const ok = after.spent === 13000 && after.checkingBalance === 150000 && after.savingsBalance === 512000
        && after.freeRemainingRow && after.freeRemainingRow.includes('150') && !after.freeRemainingRow.includes('-');
      results.push({ name: 'AFTER savings-type toggle: saveSpend() decrements Megtakarítási számla, leaves Folyószámla untouched, excluded from freeRemaining', pass: ok, detail: JSON.stringify(after) });
    }

    // 4) The AI-suggestion applier path (_applyDiscretionarySpendSuggestion / discretionary_spend)
    // must go through the same shared helper, so it also correctly draws from savings.
    const aiPath = await page.evaluate(() => {
      const savingsBefore = App.state.finance.accounts.find(a => a.id === 'acc-savings').balance;
      const msg = _applyDiscretionarySpendSuggestion({ type: 'discretionary_spend', name: 'Autó', amount: 2000 });
      const x = App.state.finance.discretionary.find(c => c.id === 'd-auto');
      const savingsAfter = App.state.finance.accounts.find(a => a.id === 'acc-savings').balance;
      return { msg, spent: x.spent, savingsBefore, savingsAfter };
    });
    results.push({ name: '_applyDiscretionarySpendSuggestion() (AI chat path) also draws from the linked savings account', pass: aiPath.savingsAfter === aiPath.savingsBefore - 2000 && aiPath.spent === 15000, detail: JSON.stringify(aiPath) });

    // 5) The bank-notification recording path (saveBankNotification) must also go through the
    // shared helper.
    const bankPath = await page.evaluate(() => {
      const savingsBefore = App.state.finance.accounts.find(a => a.id === 'acc-savings').balance;
      openBankNotificationSheet(3000, 'Teszt terhelés');
      document.querySelector('#bn-cat .chip[data-id="d-auto"]').click();
      document.getElementById('bn-amount').value = '3000';
      saveBankNotification();
      const x = App.state.finance.discretionary.find(c => c.id === 'd-auto');
      const savingsAfter = App.state.finance.accounts.find(a => a.id === 'acc-savings').balance;
      return { spent: x.spent, savingsBefore, savingsAfter };
    });
    results.push({ name: 'saveBankNotification() (bank-notification path) also draws from the linked savings account', pass: bankPath.savingsAfter === bankPath.savingsBefore - 3000 && bankPath.spent === 18000, detail: JSON.stringify(bankPath) });

    // 6) Toggling a category BACK to "normal" (isSavingsType=false) must stop it from touching
    // any account balance again, and it must count toward the Folyószámla totals again.
    const untoggled = await page.evaluate(() => {
      manageDiscretionarySheet('d-auto');
      document.querySelector('#dc-edit-savingstype .chip[data-v="normal"]').click();
      saveDiscretionaryEdits('d-auto');
      const x = App.state.finance.discretionary.find(c => c.id === 'd-auto');
      const savingsBefore = App.state.finance.accounts.find(a => a.id === 'acc-savings').balance;
      logSpendSheet('d-auto');
      document.getElementById('sp-amount').value = '1000';
      saveSpend('d-auto');
      const savingsAfter = App.state.finance.accounts.find(a => a.id === 'acc-savings').balance;
      App.ui.financeTab = 'attekintes';
      RENDERERS.finance();
      const rows = Array.from(document.querySelectorAll('#view-finance .card .flex.between')).map(el => el.textContent.trim());
      return { isSavingsType: x.isSavingsType, savingsBefore, savingsAfter, freeRemainingRow: rows.find(t => t.includes('Jelenlegi szabad pénz')) };
    });
    // freeRemaining = checkingBalance(150000) - mandTotal(0) - discLimitTotal(25000, the "Autó"
    // limit counts again now that it's back to normal) = 125000.
    results.push({ name: 'toggling back to "Szokásos kiadás" stops touching the savings account and re-enters the Folyószámla calculation', pass: untoggled.isSavingsType === false && untoggled.savingsAfter === untoggled.savingsBefore && untoggled.freeRemainingRow.includes('125') && !untoggled.freeRemainingRow.includes('-'), detail: JSON.stringify(untoggled) });

    // 7) A savings-type category can never push the linked account negative - a spend larger
    // than the account's balance clamps the account to 0 rather than going negative.
    const overdraw = await page.evaluate(() => {
      App.state.finance.accounts.find(a => a.id === 'acc-savings').balance = 500;
      manageDiscretionarySheet('d-auto');
      document.querySelector('#dc-edit-savingstype .chip[data-v="savings"]').click();
      document.querySelector('#dc-edit-savingsacct .chip[data-id="acc-savings"]').click();
      saveDiscretionaryEdits('d-auto');
      logSpendSheet('d-auto');
      document.getElementById('sp-amount').value = '9000';
      saveSpend('d-auto');
      return App.state.finance.accounts.find(a => a.id === 'acc-savings').balance;
    });
    results.push({ name: 'overdrawing a savings-type category clamps the linked account balance to 0, never negative', pass: overdraw === 0, detail: 'balance=' + overdraw });

    // 8) New-category creation (addDiscretionarySheet/saveDiscretionary) supports the same
    // toggle from the start.
    const created = await page.evaluate(() => {
      addDiscretionarySheet();
      document.getElementById('dc-name').value = 'Nyaralás keret';
      document.getElementById('dc-limit').value = '10000';
      document.querySelector('#dc-savingstype .chip[data-v="savings"]').click();
      const acctChip = document.querySelector('#dc-savingsacct .chip[data-id="acc-savings"]');
      const hasChip = !!acctChip;
      if (acctChip) acctChip.click();
      saveDiscretionary();
      const created = App.state.finance.discretionary.find(c => c.name === 'Nyaralás keret');
      return { hasChip, created };
    });
    results.push({ name: 'addDiscretionarySheet()/saveDiscretionary(): new categories can be created as savings-type from the start', pass: created.hasChip && created.created && created.created.isSavingsType === true && created.created.savingsAccountId === 'acc-savings', detail: JSON.stringify(created) });

    // 9) If the user selects "Megtakarítás jellegű" but has NO savings-type account at all,
    // isSavingsType must NOT silently become true with a dangling/missing account reference.
    const noSavingsAcct = await page.evaluate(() => {
      App.state.finance.accounts = [{ id: 'acc-checking', name: 'Folyószámla', icon: '💳', type: 'checking', balance: 100000 }];
      addDiscretionarySheet();
      document.getElementById('dc-name').value = 'Teszt kategória';
      document.getElementById('dc-limit').value = '5000';
      document.querySelector('#dc-savingstype .chip[data-v="savings"]').click();
      const sectionText = document.getElementById('dc-savingsacct-section').innerHTML;
      saveDiscretionary();
      const created = App.state.finance.discretionary.find(c => c.name === 'Teszt kategória');
      return { sectionMentionsMissingAccount: sectionText.includes('Nincs megtakarítási számlád'), created };
    });
    results.push({ name: 'no savings-type account exists: warning shown, category saved as normal (isSavingsType stays false)', pass: noSavingsAcct.sectionMentionsMissingAccount && noSavingsAcct.created && noSavingsAcct.created.isSavingsType === false, detail: JSON.stringify(noSavingsAcct) });

    console.log('\n=== "Megtakarítás jellegű" kiadás-kategória tesztek ===');
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
