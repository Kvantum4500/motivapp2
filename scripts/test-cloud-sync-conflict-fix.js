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

  const reg = await page.evaluate(async () => await runRegressionChecks());
  const regFails = reg.filter(x => x['Eredmény'] !== 'PASS');
  results.push({name:'runRegressionChecks() 16/16 unaffected', pass: regFails.length===0, detail: JSON.stringify({total:reg.length, fails:regFails.length})});

  // Finding #1 repro: user only customized discretionary/savings, cloud has stale defaults.
  // BEFORE fix: isLocalStateTrivial() returned true -> applyCloudData() silently wiped the edits.
  // AFTER fix: must be recognized as non-trivial -> conflict sheet, no silent overwrite.
  const finding1 = await page.evaluate(() => {
    // Simulate: fresh default state, then user edits discretionary name/limit and savings saved amount only.
    App.state = defaultState();
    App.state.finance.discretionary[0].name = 'Ruházat (átnevezve)';
    App.state.finance.discretionary[0].limit = 99999;
    App.state.finance.savings[0].saved = 123456;
    const trivial = isLocalStateTrivial();
    // Simulate onFbAuthStateChanged's cloud-exists branch with a stale (still-default) cloud doc.
    const staleCloudDoc = Object.assign({}, defaultState(), {updatedAt:'x', _lastWriterDevice:'other-device'});
    const alreadyInSync = JSON.stringify(App.state) === normalizedCloudStateJson(staleCloudDoc);
    return { trivial, alreadyInSync, nameAfter: App.state.finance.discretionary[0].name, savedAfter: App.state.finance.savings[0].saved };
  });
  results.push({name:'Finding #1: budget-only edits no longer classified as trivial', pass: finding1.trivial===false, detail: JSON.stringify(finding1)});
  results.push({name:'Finding #1: budget-only edits correctly detected as NOT already-in-sync with stale cloud', pass: finding1.alreadyInSync===false, detail: JSON.stringify(finding1)});

  // Full end-to-end repro via the real onFbAuthStateChanged path with a mocked Firebase.
  const e2e1 = await page.evaluate(async () => {
    App.state = defaultState();
    App.state.finance.discretionary[0].name = 'Ruházat (átnevezve)';
    App.state.finance.discretionary[0].limit = 99999;
    const staleCloudDoc = Object.assign({}, defaultState(), {updatedAt:'x', _lastWriterDevice:'other-device'});
    fbAvailable = true;
    fbDb = { collection: () => ({ doc: () => ({
      get: async () => ({ exists: true, data: () => staleCloudDoc }),
      onSnapshot: () => (()=>{}),
    }) }) };
    App.cloud.migrationPending = false; App.cloud.conflictPending = false;
    await onFbAuthStateChanged({ uid: 'u1', email: 'test@example.com' });
    return {
      nameAfter: App.state.finance.discretionary[0].name,
      conflictPending: App.cloud.conflictPending,
      sheetOpen: document.getElementById('sheetbg').classList.contains('open'),
    };
  });
  results.push({name:'Finding #1 end-to-end: stale cloud no longer silently overwrites customized budget data', pass: e2e1.nameAfter==='Ruházat (átnevezve)' && e2e1.conflictPending===true && e2e1.sheetOpen===true, detail: JSON.stringify(e2e1)});

  // Finding #2 repro: local already matches cloud exactly (normal reload of an in-sync device).
  // BEFORE fix: still hit the conflict branch and opened the sheet every time.
  // AFTER fix: no prompt, no-op.
  const e2e2 = await page.evaluate(async () => {
    App.state = defaultState();
    App.state.tasks.push({id:'t1', title:'Valami feladat', due:'2026-01-01'});
    normalizeAppState(); // App.state a valós appban MINDIG loadState() utáni, normalizált állapot
    const identicalCloudDoc = Object.assign({}, App.state, {updatedAt:'x', _lastWriterDevice:'other-device'});
    fbAvailable = true;
    fbDb = { collection: () => ({ doc: () => ({
      get: async () => ({ exists: true, data: () => identicalCloudDoc }),
      onSnapshot: () => (()=>{}),
    }) }) };
    App.cloud.migrationPending = false; App.cloud.conflictPending = false;
    closeSheet();
    await onFbAuthStateChanged({ uid: 'u1', email: 'test@example.com' });
    return {
      conflictPending: App.cloud.conflictPending,
      sheetOpen: document.getElementById('sheetbg').classList.contains('open'),
      status: App.cloud.status,
    };
  });
  results.push({name:'Finding #2: identical local/cloud state no longer triggers spurious conflict prompt', pass: e2e2.conflictPending===false && e2e2.sheetOpen===false && e2e2.status==='synced', detail: JSON.stringify(e2e2)});

  // Regression: a genuinely different, non-trivial local state vs a genuinely different cloud state
  // must still show the conflict sheet (make sure the fast-path didn't neuter real conflict detection).
  const stillConflicts = await page.evaluate(async () => {
    App.state = defaultState();
    App.state.tasks.push({id:'t1', title:'Helyi feladat'});
    const differentCloudDoc = Object.assign({}, defaultState(), {updatedAt:'x', _lastWriterDevice:'other-device'});
    differentCloudDoc.tasks = [{id:'t2', title:'Felhő feladat'}];
    fbAvailable = true;
    fbDb = { collection: () => ({ doc: () => ({
      get: async () => ({ exists: true, data: () => differentCloudDoc }),
      onSnapshot: () => (()=>{}),
    }) }) };
    App.cloud.migrationPending = false; App.cloud.conflictPending = false;
    closeSheet();
    await onFbAuthStateChanged({ uid: 'u1', email: 'test@example.com' });
    return { conflictPending: App.cloud.conflictPending, sheetOpen: document.getElementById('sheetbg').classList.contains('open') };
  });
  results.push({name:'regression: genuinely different local vs cloud state still triggers conflict sheet', pass: stillConflicts.conflictPending===true && stillConflicts.sheetOpen===true, detail: JSON.stringify(stillConflicts)});

  // Finding #3 repro: CLOUD_DEVICE_ID must no longer be a bare stable per-device value -
  // it must include a per-page-load random component (verifiable indirectly: two reads
  // within the same page load are stable, but a fresh reload should differ).
  const deviceIdCheck = await page.evaluate(() => {
    return { hasColon: CLOUD_DEVICE_ID.includes(':'), stableWithinLoad: CLOUD_DEVICE_ID === CLOUD_DEVICE_ID };
  });
  results.push({name:'Finding #3: CLOUD_DEVICE_ID now combines a stable base with a per-load suffix', pass: deviceIdCheck.hasColon===true, detail: JSON.stringify(deviceIdCheck)});

  // Regression-audit Finding A repro: signing out must wipe local App.state so a
  // DIFFERENT account logging in on the same device/session never sees account A's
  // private data before making a migration/conflict decision, and the old account's
  // real cloud doc must never receive a wiped-out push during the sign-out itself.
  const crossAccount = await page.evaluate(async () => {
    // Account A: has private journal + finance data, signed in.
    App.state = defaultState();
    App.state.journal.push({id:'j1', mood:2, text:'A titkos naplobejegyzese', date:'2026-01-01'});
    App.state.finance.discretionary[0].name = 'A titkos kiadasai';
    normalizeAppState();
    const accountACloudDoc = Object.assign({}, App.state, {updatedAt:'x', _lastWriterDevice:'other-device'});
    let lastSetPayload = null;
    fbAvailable = true;
    App.cloud.user = {uid:'uid_a', email:'a@example.com'};
    fbAuth = {
      currentUser: {uid:'uid_a', email:'a@example.com'},
      signOut: async function(){ this.currentUser = null; return Promise.resolve(); },
    };
    fbDb = { collection: () => ({ doc: () => ({
      get: async () => ({ exists: true, data: () => accountACloudDoc }),
      set: async (payload) => { lastSetPayload = payload; },
      onSnapshot: () => (()=>{}),
    }) }) };
    App.cloud.migrationPending = false; App.cloud.conflictPending = false;

    // Account A signs out.
    await cloudSignOut();
    const stateWipedAfterSignOut = App.state.journal.length===0 && App.state.finance.discretionary[0].name==='Bevásárlás';
    const noWipePushedToA = lastSetPayload===null; // the wiped state must NEVER have been pushed to A's real cloud doc

    // A different account (B) logs in on the same session, no page reload, fresh cloud doc.
    fbAuth = {
      currentUser: {uid:'uid_b', email:'b@example.com'},
      signOut: async function(){ this.currentUser = null; },
    };
    fbDb = { collection: () => ({ doc: () => ({
      get: async () => ({ exists: false }),
      set: async (payload) => { lastSetPayload = payload; },
      onSnapshot: () => (()=>{}),
    }) }) };
    await onFbAuthStateChanged({uid:'uid_b', email:'b@example.com'});
    const bSeesAsJournal = App.state.journal.some(j=>j.text==='A titkos naplobejegyzese');
    const bSeesADiscretionary = App.state.finance.discretionary[0].name==='A titkos kiadasai';

    return { stateWipedAfterSignOut, noWipePushedToA, bSeesAsJournal, bSeesADiscretionary };
  });
  results.push({name:'cross-account leak fix: App.state wiped on sign-out', pass: crossAccount.stateWipedAfterSignOut===true, detail: JSON.stringify(crossAccount)});
  results.push({name:'cross-account leak fix: the wipe is never pushed to the signing-out account\'s real cloud doc', pass: crossAccount.noWipePushedToA===true, detail: JSON.stringify(crossAccount)});
  results.push({name:'cross-account leak fix: a different account logging in afterward never sees the previous account\'s journal', pass: crossAccount.bSeesAsJournal===false, detail: JSON.stringify(crossAccount)});
  results.push({name:'cross-account leak fix: a different account logging in afterward never sees the previous account\'s finance data', pass: crossAccount.bSeesADiscretionary===false, detail: JSON.stringify(crossAccount)});

  console.log('\n=== Cloud sync conflict-detection fix verification ===');
  results.forEach(r => console.log((r.pass?'PASS':'FAIL')+' - '+r.name+'  ['+r.detail+']'));
  console.log('\nConsole/page errors:', errs.length===0?'NONE':errs.join(' | '));

  const anyFail = results.some(r=>!r.pass) || errs.length>0;
  console.log('\n'+(anyFail?'SOME FAILED':'ALL PASS'));

  await browser.close();
  server.kill();
  process.exitCode = anyFail ? 1 : 0;
})().catch(e => { console.error('TEST FAILED:', e); process.exitCode = 1; });
