const { chromium } = require('playwright');
const { spawn } = require('child_process');

const PORT = 8953;
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const APP_DIR = __dirname + '/..';

// Havi pénzügyi történet feature: finance.discretionary[].spent és a "Változó" mandatory
// tételek (Áram/Víz/Fűtés) amount-ja korábban sosem nullázódott/archiválódott hónapváltáskor,
// ezért a felhasználó nem tudta visszanézni, egy hónappal ezelőtt mire mennyit költött. Ez a
// teszt a checkFinanceMonthRollover() + finance.history[] + "Korábbi hónapok" UI + a két
// migrációs ág (normalizeAppState()/applyImportedJson()) 5 forgatókönyvét fedi le.
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

    // 0) Regresszió-alap: a meglévő 16/16-os smoke check nem sérült.
    const reg = await page.evaluate(async () => await runRegressionChecks());
    const regFails = reg.filter(x => x['Eredmény'] !== 'PASS');
    results.push({ name: 'runRegressionChecks() nem romlott el', pass: regFails.length === 0, detail: JSON.stringify({ total: reg.length, fails: regFails.length, failNames: regFails.map(x=>x['Teszt']) }) });

    // 1) Friss (első indítású) állapotban a Pénzügyek megnyitása NEM hoz létre history-bejegyzést,
    // mert defaultState() már a mai hónapra inicializálja a currentMonth-ot.
    const r1 = await page.evaluate(() => {
      App.ui.financeTab = 'attekintes';
      RENDERERS.finance();
      return { historyLen: (App.state.finance.history||[]).length, currentMonth: App.state.finance.currentMonth, nowMonth: (new Date()).toISOString().slice(0,7) };
    });
    {
      const ok = r1.historyLen === 0 && r1.currentMonth === r1.nowMonth;
      results.push({ name: '1) Friss állapotban a Pénzügyek megnyitása NEM hoz létre history-bejegyzést', pass: ok, detail: JSON.stringify(r1) });
    }

    // 2) currentMonth mesterségesen múltbeli hónapra állítva + spent/amount beállítva, majd a
    // Pénzügyek fül újrarenderelése -> (a) history-ban megjelenik a RÉGI hónap RÉGI adatokkal,
    // (b) discretionary[].spent mind 0, (c) currentMonth a mai hónapra frissül.
    const r2 = await page.evaluate(() => {
      const f = App.state.finance;
      const oldMonth = '2025-06';
      f.currentMonth = oldMonth;
      f.mandatory[1].amount = 18500; // Áram
      f.discretionary[0].spent = 42000;
      f.discretionary[0].limit = 60000;
      RENDERERS.finance(); // ez futtatja checkFinanceMonthRollover()-t
      const entry = (f.history||[]).find(h => h.month === oldMonth);
      return {
        entry: entry ? { month: entry.month, mandAmount: entry.mandatory[1].amount, discSpent: entry.discretionary[0].spent, discLimit: entry.discretionary[0].limit } : null,
        spentNow: f.discretionary.map(x=>x.spent),
        limitsNow: f.discretionary.map(x=>x.limit),
        currentMonth: f.currentMonth,
        nowMonth: (new Date()).toISOString().slice(0,7),
      };
    });
    {
      const ok = r2.entry && r2.entry.mandAmount === 18500 && r2.entry.discSpent === 42000 && r2.entry.discLimit === 60000
        && r2.spentNow.every(s => s === 0) && r2.limitsNow[0] === 60000 // limit megmarad, csak a spent nullázódik
        && r2.currentMonth === r2.nowMonth;
      results.push({ name: '2) Hónapváltás-detektálás: history-snapshot a régi adatokkal, spent nullázva, limit megmarad, currentMonth frissül', pass: !!ok, detail: JSON.stringify(r2) });
    }

    // 3) A "Korábbi hónapok" listában a bejegyzésre kattintva a sheet a HELYES, archivált
    // adatokat mutatja.
    const r3 = await page.evaluate(() => {
      viewFinanceHistorySheet('2025-06');
      const sheetText = document.getElementById('sheet').innerText;
      return { sheetText, open: document.getElementById('sheetbg').classList.contains('open') };
    });
    {
      const ok = r3.open && r3.sheetText.includes('2025') && r3.sheetText.includes('augusztus') === false && r3.sheetText.includes('18 500') || r3.sheetText.includes('18 500') || r3.sheetText.includes('18500');
      // pontosabb, formátum-független ellenőrzés:
      const hasAmount = /18[\s ]?500/.test(r3.sheetText);
      const hasSpent = /42[\s ]?000/.test(r3.sheetText);
      const pass = r3.open && hasAmount && hasSpent;
      results.push({ name: '3) viewFinanceHistorySheet(): a sheet a helyes, archivált 2025-06 adatokat mutatja', pass, detail: JSON.stringify({ open: r3.open, hasAmount, hasSpent, snippet: r3.sheetText.slice(0,300) }) });
    }
    await page.evaluate(() => closeSheet());

    // 3b) Az "Korábbi hónapok" szekció ténylegesen megjelenik a listában (UI-szintű ellenőrzés).
    const r3b = await page.evaluate(() => {
      RENDERERS.finance();
      const rows = Array.from(document.querySelectorAll('#view-finance .menurow')).map(el => el.textContent.trim());
      return rows.filter(t => /2025|augusztus|június|202\d\. /.test(t));
    });
    results.push({ name: '3b) "Korábbi hónapok" sor megjelenik a listában', pass: r3b.length > 0, detail: JSON.stringify(r3b) });

    // 4) Migráció: finance objektum history/currentMonth NÉLKÜL -> normalizeAppState() után
    // mindkettő helyesen pótlódik, ÉS ez nem vált ki azonnali hamis rollovert.
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(400);
    const r4 = await page.evaluate(() => {
      const f = App.state.finance;
      delete f.history;
      delete f.currentMonth;
      f.discretionary[0].spent = 12345; // ha hamis rollover történne, ez nullázódna
      normalizeAppState();
      const nowMonth = (new Date()).toISOString().slice(0,7);
      const afterHistoryLen = Array.isArray(f.history) ? f.history.length : -1;
      const afterCurrentMonth = f.currentMonth;
      // Egy második normalizeAppState()-hívás (vagy a Pénzügyek megnyitása) sem generálhat
      // hamis history-bejegyzést, hiszen currentMonth már a mai hónapra állt.
      RENDERERS.finance();
      return {
        historyIsArrayAfterMigration: Array.isArray(f.history),
        historyLenAfterMigration: afterHistoryLen,
        currentMonthAfterMigration: afterCurrentMonth,
        nowMonth,
        historyLenAfterRender: f.history.length,
        spentUnaffected: f.discretionary[0].spent,
      };
    });
    {
      const ok = r4.historyIsArrayAfterMigration && r4.historyLenAfterMigration === 0
        && r4.currentMonthAfterMigration === r4.nowMonth
        && r4.historyLenAfterRender === 0
        && r4.spentUnaffected === 12345;
      results.push({ name: '4) normalizeAppState(): history/currentMonth pótlása, nincs hamis rollover', pass: ok, detail: JSON.stringify(r4) });
    }

    // 4b) Ugyanez applyImportedJson() útján (a másik migrációs ág).
    const r4b = await page.evaluate(() => {
      const backup = {
        finance: {
          mandatory: [{ id: 'm1', name: 'Bérlet', amount: 1000 }],
          discretionary: [{ id: 'd1', name: 'Kaja', icon: '🍔', spent: 500, limit: 5000 }],
          savings: [],
          // history/currentMonth szándékosan hiányzik - régi export szimulálása
        },
      };
      applyImportedJson(JSON.stringify(backup));
      const nowMonth = (new Date()).toISOString().slice(0,7);
      return {
        historyIsArray: Array.isArray(App.state.finance.history),
        historyLen: (App.state.finance.history||[]).length,
        currentMonth: App.state.finance.currentMonth,
        nowMonth,
      };
    });
    {
      const ok = r4b.historyIsArray && r4b.historyLen === 0 && r4b.currentMonth === r4b.nowMonth;
      results.push({ name: '4b) applyImportedJson(): history/currentMonth pótlása régi (mező nélküli) exportnál', pass: ok, detail: JSON.stringify(r4b) });
    }

    // 5) 24-es korlát: 25 history-bejegyzés mesterséges feltöltése, majd hónapváltás ->
    // a lista 24-re vágódik, a LEGRÉGEBBI (a tömb VÉGÉN lévő, unshift-es sorrend miatt) esik ki.
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(400);
    const r5 = await page.evaluate(() => {
      const f = App.state.finance;
      // Valós használatban a history mindig ÚJ-a-régebbi sorrendben épül (unshift), tehát a
      // teszt-adatot is így kell szinkronban feltölteni: index 0 a "legújabb" fake hónap, a
      // legutolsó index a "legrégebbi" (2020-01) - ez esik ki elsőként a 24-es korlátnál.
      f.history = [];
      for (let i = 25; i >= 1; i--) {
        const mm = String(i).padStart(2, '0');
        f.history.push({ month: `2020-${mm}`, mandatory: [], discretionary: [], totalIncome: 0, savedAt: new Date().toISOString() });
      }
      f.currentMonth = '2025-06'; // egy múltbeli hónap, hogy a rollover lefusson
      RENDERERS.finance();
      return { len: f.history.length, months: f.history.map(h => h.month) };
    });
    {
      // 25 fake bejegyzés + 1 új (rollover) = 26 -> 24-re vágva a 2 LEGRÉGEBBI (2020-01, 2020-02) esik ki.
      const ok = r5.len === 24 && !r5.months.includes('2020-01') && !r5.months.includes('2020-02') && r5.months.includes('2020-03') && r5.months[0] === '2025-06';
      results.push({ name: '5) 24-es korlát: 25+1 bejegyzésből 24 marad, a legrégebbi (2020-01/02) esik ki, a legújabb elöl van', pass: ok, detail: JSON.stringify({ len: r5.len, first: r5.months[0], last: r5.months[r5.months.length-1], has2020_01: r5.months.includes('2020-01') }) });
    }

    console.log('\n=== Havi pénzügyi történet (finance.history) feature tesztjei ===');
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
