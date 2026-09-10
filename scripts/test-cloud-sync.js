#!/usr/bin/env node
/*
 * test-cloud-sync.js
 *
 * Kiegészítő, könnyűsúlyú Playwright-tesztek a "Fiók és szinkronizáció"
 * (Firebase) funkcióhoz, VALÓDI Firebase-backend NÉLKÜL:
 *
 *  1) Alap-regresszió: runRegressionChecks() továbbra is 100%-ban PASS,
 *     amíg a Beállítások nézet meg sincs nyitva (ez a CI normál esete is) -
 *     ez a ci-regression-check.js-szel egyező, önálló megerősítés.
 *  2) "Nincs Firebase-hálózat" ellenálló-képesség: a Beállítások nézetet
 *     MEGNYITVA, miközben a gstatic.com/googleapis.com/firebaseio.com
 *     hálózati kérések el vannak vágva (route().abort()) - az app NEM
 *     omlik össze (nincs pageerror), a "Fiók és szinkronizáció" kártya a
 *     "nem elérhető" tartalék szöveget mutatja, és a nézet többi része
 *     (Adatok kártya, mentés-badge stb.) továbbra is normálisan renderel.
 *  3) Kliensoldali validáció + magyar hibaüzenet-térkép, egy INJEKTÁLT,
 *     hamis `window.firebase` compat objektummal (valós hálózat/backend
 *     nélkül): érvénytelen e-mail, túl rövid jelszó regisztrációnál,
 *     `auth/wrong-password` és `auth/user-not-found` hibakódok Firebase
 *     Auth-szerű elutasításként szimulálva, majd egy sikeres bejelentkezés
 *     + kijelentkezés teljes körben.
 *
 * Futtatás: node scripts/test-cloud-sync.js
 * (Ugyanúgy a "playwright" csomag efemer telepítését feltételezi, mint a
 * scripts/ci-regression-check.js - ld. ottani doksit.)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        let filePath = path.join(REPO_ROOT, urlPath === '/' ? '/index.html' : urlPath);
        if (!filePath.startsWith(REPO_ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
        fs.readFile(filePath, (err, data) => {
          if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found: ' + urlPath); return; }
          const ext = path.extname(filePath).toLowerCase();
          res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
          res.end(data);
        });
      } catch (e) { res.writeHead(500); res.end('Internal server error'); }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Hamis, compat-alakú `window.firebase` - a valódi Auth/Firestore compat SDK
// felszínét utánozza annyira, amennyire a fő script használja, hálózat
// nélkül, teljesen a teszt által vezérelve (window.__mockAuthError,
// window.__mockUser).
function installFakeFirebase() {
  window.__mockCalls = [];
  window.__mockAuthError = null;
  window.__mockUser = null;
  let authStateCb = null;
  const fakeAuth = {
    get currentUser() { return window.__mockUser; },
    onAuthStateChanged(cb) { authStateCb = cb; window.__authStateCb = cb; setTimeout(() => cb(window.__mockUser), 0); return () => {}; },
    setPersistence() { return Promise.resolve(); },
    createUserWithEmailAndPassword(email, password) {
      window.__mockCalls.push(['register', email, password]);
      if (window.__mockAuthError) { const err = { code: window.__mockAuthError, message: 'mock' }; window.__mockAuthError = null; return Promise.reject(err); }
      window.__mockUser = { uid: 'u1', email };
      setTimeout(() => authStateCb && authStateCb(window.__mockUser), 0);
      return Promise.resolve({ user: window.__mockUser });
    },
    signInWithEmailAndPassword(email, password) {
      window.__mockCalls.push(['login', email, password]);
      if (window.__mockAuthError) { const err = { code: window.__mockAuthError, message: 'mock' }; window.__mockAuthError = null; return Promise.reject(err); }
      window.__mockUser = { uid: 'u1', email };
      setTimeout(() => authStateCb && authStateCb(window.__mockUser), 0);
      return Promise.resolve({ user: window.__mockUser });
    },
    signOut() {
      window.__mockUser = null;
      setTimeout(() => authStateCb && authStateCb(null), 0);
      return Promise.resolve();
    },
  };
  const fakeDoc = {
    get() { return Promise.resolve({ exists: false, data: () => ({}) }); },
    set() { return Promise.resolve(); },
    onSnapshot(cb) { setTimeout(() => cb({ exists: false, metadata: { hasPendingWrites: false }, data: () => ({}) }), 0); return () => {}; },
  };
  const fakeDb = {
    collection() { return { doc() { return fakeDoc; } }; },
    enablePersistence() { return Promise.resolve(); },
  };
  window.firebase = {
    initializeApp() { return {}; },
    auth() { return fakeAuth; },
    firestore() { return fakeDb; },
  };
  window.firebase.auth.Auth = { Persistence: { LOCAL: 'local' } };
  window.firebase.firestore.FieldValue = { serverTimestamp() { return 'MOCK_SERVER_TS'; } };
}

async function main() {
  console.log('=== MotivApp2 Fiók és szinkronizáció - kiegészítő tesztek ===\n');
  const { chromium } = require('playwright');
  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/index.html`;
  let browser;
  let failures = 0;
  const results = [];
  function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ('  [' + detail + ']') : ''));
    if (!ok) failures++;
  }

  try {
    browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined });

    // ---- Teszt 1: alap-regresszió, Beállítások meg sincs nyitva ----
    {
      const page = await browser.newPage();
      const consoleErrors = []; const pageErrors = [];
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('typeof runRegressionChecks === "function"', { timeout: 30000 });
      const res = await page.evaluate(async () => await runRegressionChecks());
      const allPass = Array.isArray(res) && res.length > 0 && res.every(r => r['Eredmény'] === 'PASS');
      record('1) runRegressionChecks() 100% PASS, Beállítások nézet nélkül', allPass, res.length + ' teszt');
      record('1b) Nincs console.error/pageerror a Beállítások megnyitása NÉLKÜL', consoleErrors.length === 0 && pageErrors.length === 0, `console:${consoleErrors.length} page:${pageErrors.length}`);
      await page.close();
    }

    // ---- Teszt 2: Beállítások megnyitva, Firebase-hálózat blokkolva ----
    {
      const page = await browser.newPage();
      await page.route('**://*.gstatic.com/**', route => route.abort());
      await page.route('**://*.googleapis.com/**', route => route.abort());
      await page.route('**://*.firebaseio.com/**', route => route.abort());
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('typeof runRegressionChecks === "function"', { timeout: 30000 });
      await page.evaluate(() => openSub('settings'));
      // Türelmi idő a (sikertelen) SDK-betöltési kísérletnek.
      await page.waitForTimeout(1500);
      const cardText = await page.evaluate(() => {
        const el = document.getElementById('cloud-sync-section');
        return el ? el.textContent : null;
      });
      record('2) Beállítások megnyitása blokkolt Firebase-hálózattal nem dob pageerror-t', pageErrors.length === 0, 'pageerror:' + pageErrors.length);
      record('2b) "Fiók és szinkronizáció" kártya megjelenik és nem üres', !!cardText && cardText.includes('Fiók és szinkronizáció'), JSON.stringify((cardText || '').slice(0, 80)));
      record('2c) Blokkolt hálózat esetén a "nem elérhető" tartalék szöveg jelenik meg', !!cardText && cardText.includes('nem elérhető'), '');
      const dataCardVisible = await page.evaluate(() => !!document.getElementById('save-status-badge'));
      record('2d) A Beállítások nézet többi része (Adatok kártya) továbbra is renderel', dataCardVisible, '');
      await page.close();
    }

    // ---- Teszt 3: injektált hamis firebase - validáció + hibaüzenet-térkép + sikeres be/kijelentkezés ----
    {
      const page = await browser.newPage();
      // A valódi CDN-t is blokkoljuk, hogy garantáltan a hamis window.firebase-t használja.
      await page.route('**://*.gstatic.com/**', route => route.abort());
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.addInitScript(installFakeFirebase);
      await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('typeof runRegressionChecks === "function"', { timeout: 30000 });
      await page.evaluate(() => openSub('settings'));
      await page.waitForSelector('#cloud-email', { timeout: 10000 });

      // 3a) érvénytelen e-mail
      await page.fill('#cloud-email', 'nem-email');
      await page.fill('#cloud-password', 'akarmi');
      await page.click('#cloud-submit-btn');
      await page.waitForTimeout(150);
      let errText = await page.textContent('#cloud-auth-error').catch(() => null);
      record('3a) Érvénytelen e-mail -> magyar validációs hiba', !!errText && errText.includes('érvényes e-mail'), errText);

      // 3b) túl rövid jelszó regisztrációnál
      await page.click('#cloud-tab-register');
      await page.fill('#cloud-email', 'teszt@pelda.hu');
      await page.fill('#cloud-password', '123');
      await page.click('#cloud-submit-btn');
      await page.waitForTimeout(150);
      errText = await page.textContent('#cloud-auth-error').catch(() => null);
      record('3b) Túl rövid jelszó regisztrációnál -> magyar validációs hiba', !!errText && errText.includes('6 karakter'), errText);

      // 3c) auth/wrong-password mapping (login módban)
      await page.click('#cloud-tab-login');
      await page.evaluate(() => { window.__mockAuthError = 'auth/wrong-password'; });
      await page.fill('#cloud-email', 'teszt@pelda.hu');
      await page.fill('#cloud-password', 'helyes-jelszo-de-mockolt');
      await page.click('#cloud-submit-btn');
      await page.waitForTimeout(200);
      errText = await page.textContent('#cloud-auth-error').catch(() => null);
      record('3c) auth/wrong-password -> "Hibás jelszó." magyar üzenet', !!errText && errText.includes('Hibás jelszó'), errText);

      // 3d) auth/user-not-found mapping
      // A #cloud-sync-section minden submit után újrarajzolódik (outerHTML
      // csere), ami a jelszómezőt SZÁNDÉKOSAN üresen hagyja (nem
      // perzisztáljuk a jelszót a hibaüzenet megjelenítése között) - ezért
      // minden újabb próbálkozás előtt újra ki kell tölteni.
      await page.evaluate(() => { window.__mockAuthError = 'auth/user-not-found'; });
      await page.fill('#cloud-email', 'teszt@pelda.hu');
      await page.fill('#cloud-password', 'helyes-jelszo-de-mockolt');
      await page.click('#cloud-submit-btn');
      await page.waitForTimeout(200);
      errText = await page.textContent('#cloud-auth-error').catch(() => null);
      record('3d) auth/user-not-found -> "Nincs ilyen e-mail címmel regisztrált fiók." üzenet', !!errText && errText.includes('Nincs ilyen e-mail címmel'), errText);

      // 3e) auth/too-many-requests mapping
      await page.evaluate(() => { window.__mockAuthError = 'auth/too-many-requests'; });
      await page.fill('#cloud-email', 'teszt@pelda.hu');
      await page.fill('#cloud-password', 'helyes-jelszo-de-mockolt');
      await page.click('#cloud-submit-btn');
      await page.waitForTimeout(200);
      errText = await page.textContent('#cloud-auth-error').catch(() => null);
      record('3e) auth/too-many-requests -> "Túl sok sikertelen próbálkozás" üzenet', !!errText && errText.toLowerCase().includes('túl sok'), errText);

      // 3f) sikeres (mockolt) bejelentkezés -> fiók-kártya + Kijelentkezés gomb
      await page.fill('#cloud-email', 'teszt@pelda.hu');
      await page.fill('#cloud-password', 'helyes-jelszo-de-mockolt');
      await page.click('#cloud-submit-btn'); // most nincs __mockAuthError beállítva -> sikeres
      await page.waitForSelector('#cloud-signout-btn', { timeout: 5000 });
      const emailShown = await page.textContent('#cloud-account-email').catch(() => null);
      record('3f) Sikeres (mockolt) bejelentkezés után az e-mail + Kijelentkezés gomb megjelenik', (emailShown || '').includes('teszt@pelda.hu'), emailShown);

      // 3g) kijelentkezés -> visszaáll a bejelentkező form
      await page.click('#cloud-signout-btn');
      await page.waitForSelector('#cloud-email', { timeout: 5000 });
      const backToForm = await page.$('#cloud-email');
      record('3g) Kijelentkezés után újra a bejelentkező/regisztrációs form látszik', !!backToForm, '');

      record('3h) Egyik mock-forgatókönyv sem dobott pageerror-t', pageErrors.length === 0, 'pageerror:' + pageErrors.length);

      // 3i) regresszió továbbra is teljes - a fiók-funkció használata nem tör el más funkciót
      const res2 = await page.evaluate(async () => await runRegressionChecks());
      const allPass2 = Array.isArray(res2) && res2.length > 0 && res2.every(r => r['Eredmény'] === 'PASS');
      record('3i) runRegressionChecks() továbbra is 100% PASS a fiók-funkció használata UTÁN is', allPass2, res2.length + ' teszt');

      await page.close();
    }

    // ---- Teszt 4: első bejelentkezés, ÉRDEMI helyi adattal, üres felhővel
    //      -> migrációs megerősítő sheet jelenik meg (SOHA nem ír felül
    //      hallgatólagosan) ----
    {
      const page = await browser.newPage();
      await page.route('**://*.gstatic.com/**', route => route.abort());
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.addInitScript(installFakeFirebase);
      await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('typeof runRegressionChecks === "function"', { timeout: 30000 });
      // Érdemi helyi adat felvétele bejelentkezés ELŐTT (isLocalStateTrivial() === false).
      await page.evaluate(() => {
        App.state.tasks.push({ id: 'tt1', title: 'Teszt feladat', done: false });
        saveState();
      });
      await page.evaluate(() => openSub('settings'));
      await page.waitForSelector('#cloud-email', { timeout: 10000 });
      await page.fill('#cloud-email', 'masodikeszkoz@pelda.hu');
      await page.fill('#cloud-password', 'jelszo123');
      await page.click('#cloud-submit-btn');
      // A fakeDoc.get() exists:false-t ad vissza -> "no-cloud" migrációs sheet nyílik,
      // mert isLocalStateTrivial() itt false (van egy nem-alapértelmezett task).
      await page.waitForSelector('#cloud-migrate-upload', { timeout: 5000 });
      const sheetText = await page.textContent('#sheet').catch(() => null);
      record('4) Érdemi helyi adat + üres felhő -> migrációs megerősítő sheet jelenik meg (nincs hallgatólagos felülírás)', !!sheetText && sheetText.includes('kiinduló'), (sheetText || '').slice(0, 60));
      await page.click('#cloud-migrate-upload');
      await page.waitForTimeout(300);
      const sheetClosed = await page.evaluate(() => !document.getElementById('sheetbg').classList.contains('open'));
      record('4b) "Igen, feltöltöm" választás után a sheet bezáródik', sheetClosed, '');
      record('4c) A migrációs folyamat nem dobott pageerror-t', pageErrors.length === 0, 'pageerror:' + pageErrors.length);
      await page.close();
    }
  } catch (err) {
    console.error('\n!!! Váratlan hiba a teszt futtatása közben:');
    console.error(err && err.stack ? err.stack : err);
    failures++;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('\n--- Összegzés ---');
  console.log(`${results.length - failures}/${results.length} PASS`);
  console.log(failures === 0 ? '=== EREDMÉNY: SIKERES ===' : '=== EREDMÉNY: SIKERTELEN ===');
  process.exit(failures === 0 ? 0 : 1);
}

main();
