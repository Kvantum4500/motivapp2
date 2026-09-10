#!/usr/bin/env node
/*
 * test-webauthn-lock.js
 *
 * Kiegészítő, könnyűsúlyú Playwright-tesztek a "Helyi ujjlenyomatos
 * gyorsbelépés" (WebAuthn, Phase B) funkcióhoz, VALÓDI Firebase-backend
 * NÉLKÜL - ld. az index.html "HELYI UJJLENYOMATOS GYORSBELÉPÉS" szekciójának
 * doksiját a pontos biztonsági keretezésről (ez NEM szerver által
 * kriptográfiailag ellenőrzött WebAuthn login, hanem egy helyi eszköz-
 * feloldó kapu a Phase A Firebase-munkamenete fölött; a jelszavas B opció a
 * VALÓDI, szerver-ellenőrzött hátsó védelmi vonal).
 *
 * A WebAuthn hívásokhoz (navigator.credentials.create/get) ahol lehetséges
 * VALÓDI Chromium DevTools Protocol "virtuális hitelesítő" funkciót
 * használunk (WebAuthn.enable + WebAuthn.addVirtualAuthenticator egy
 * page.context().newCDPSession(page) munkameneten át) - ez sokkal erősebb
 * bizonyíték, mint egy puszta window.navigator.credentials mock, mert a
 * böngésző TÉNYLEGES WebAuthn-implementációja fut végig (challenge,
 * allowCredentials-szűrés, userVerification stb.), csak a "fizikai"
 * ujjlenyomat-érzékelőt helyettesíti egy szoftveres hitelesítő. A
 * sikertelen/elutasított kísérlet teszteléséhez (5. teszt) a virtuális
 * hitelesítőt szándékosan "not present"/eltávolított állapotba állítjuk -
 * ez a valódi navigator.credentials.get() promise-t utasíttatja el a
 * böngészővel, NEM egy kézzel dobott hibával.
 *
 * Futtatás: node scripts/test-webauthn-lock.js
 * (Ugyanúgy a "playwright" csomag efemer telepítését feltételezi, mint a
 * scripts/ci-regression-check.js és a scripts/test-cloud-sync.js - ld.
 * ottani doksit.)
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

// Ugyanaz a hamis, compat-alakú window.firebase, mint scripts/test-cloud-sync.js-ben,
// kiegészítve reauthenticateWithCredential-lel (a jelszavas B opció útja),
// amit a fő script fbAuth.currentUser-en hív.
function installFakeFirebase() {
  window.__mockCalls = [];
  window.__mockAuthError = null;
  window.__mockReauthError = null;
  window.__mockUser = null;
  let authStateCb = null;
  function makeUser(email) {
    return {
      uid: 'u1',
      email,
      reauthenticateWithCredential(cred) {
        window.__mockCalls.push(['reauth', cred]);
        if (window.__mockReauthError) {
          const err = { code: window.__mockReauthError, message: 'mock' };
          window.__mockReauthError = null;
          return Promise.reject(err);
        }
        return Promise.resolve({ user: window.__mockUser });
      },
    };
  }
  const fakeAuth = {
    get currentUser() { return window.__mockUser; },
    onAuthStateChanged(cb) { authStateCb = cb; window.__authStateCb = cb; setTimeout(() => cb(window.__mockUser), 0); return () => {}; },
    setPersistence() { return Promise.resolve(); },
    createUserWithEmailAndPassword(email, password) {
      window.__mockCalls.push(['register', email, password]);
      if (window.__mockAuthError) { const err = { code: window.__mockAuthError, message: 'mock' }; window.__mockAuthError = null; return Promise.reject(err); }
      window.__mockUser = makeUser(email);
      setTimeout(() => authStateCb && authStateCb(window.__mockUser), 0);
      return Promise.resolve({ user: window.__mockUser });
    },
    signInWithEmailAndPassword(email, password) {
      window.__mockCalls.push(['login', email, password]);
      if (window.__mockAuthError) { const err = { code: window.__mockAuthError, message: 'mock' }; window.__mockAuthError = null; return Promise.reject(err); }
      window.__mockUser = makeUser(email);
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
  window.firebase.auth.EmailAuthProvider = { credential(email, password) { return { email, password, providerId: 'password' }; } };
  window.firebase.firestore.FieldValue = { serverTimestamp() { return 'MOCK_SERVER_TS'; } };
  // Teszt-eszközök számára is elérhetővé tesszük a "teljes funkciójú" (reauth
  // hívás-naplózással + __mockReauthError-t tisztelő) mock user gyártót, hogy
  // a tesztek NE egy kézzel írt, csonka objektumot injektáljanak
  // window.__mockUser-ként (ld. lentebb a 6./7. tesztet).
  window.__makeMockUser = makeUser;
  window.__authStateCb = null;
}

// Beállítja a "korábban bejelentkezett + beregisztrált ujjlenyomat" eszköz-
// állapotot localStorage-ban, MIELŐTT az oldal betöltődne (addInitScript) -
// ez szimulálja azt, hogy egy korábbi munkamenetben már megtörtént a
// bejelentkezés + a webauthnEnroll() sikeres lefutása.
function installEnrolledDeviceState({ uid, credId }) {
  try {
    localStorage.setItem('motivapp2:cloudLoggedIn', '1');
    localStorage.setItem('motivapp2:webauthnEnrolledUid', uid);
    localStorage.setItem('motivapp2:webauthnCred:' + uid, credId);
  } catch (e) { /* no-op */ }
}

async function addVirtualAuthenticator(page, opts) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const res = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: Object.assign({
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    }, opts || {}),
  });
  return { cdp, authenticatorId: res.authenticatorId };
}

async function main() {
  console.log('=== MotivApp2 Helyi ujjlenyomatos gyorsbelépés (WebAuthn) - kiegészítő tesztek ===\n');
  const { chromium } = require('playwright');
  const server = await startServer();
  const { port } = server.address();
  // FONTOS: "localhost", NEM "127.0.0.1" - a WebAuthn navigator.credentials
  // API (Chromium) a rp.id-t "valid domain string"-nek várja, és egy IP-cím
  // literál (127.0.0.1) ezt a feltételt NEM elégíti ki (SecurityError:
  // "This is an invalid domain."), míg a "localhost" speciális, mindig
  // engedélyezett esetként kezelt domain WebAuthn célra Chromium-ban - így
  // a szerver ugyanazt a 127.0.0.1-re bindelt portot szolgálja ki, csak a
  // navigáció "localhost" host-névvel történik.
  const baseUrl = `http://localhost:${port}/index.html`;
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

    // ---- Teszt 1: tiszta localStorage -> SOHA nem jelenik meg az overlay
    //      (ez a CI regresszió normál esete is), ÉS a beiratkozási UI sem
    //      jelenik meg (nincs bejelentkezett user) ----
    {
      const page = await browser.newPage();
      const pageErrors = []; const consoleErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('typeof runRegressionChecks === "function"', { timeout: 30000 });
      await page.waitForTimeout(300);
      const overlayOpen = await page.evaluate(() => document.getElementById('webauthn-lock-overlay').classList.contains('open'));
      record('1) Tiszta localStorage -> a zároló overlay SOHA nem jelenik meg induláskor', overlayOpen === false, 'open=' + overlayOpen);
      const res = await page.evaluate(async () => await runRegressionChecks());
      const allPass = Array.isArray(res) && res.length > 0 && res.every(r => r['Eredmény'] === 'PASS');
      record('1b) runRegressionChecks() továbbra is 100% PASS (tiszta localStorage)', allPass, res.length + ' teszt');
      record('1c) Nincs console.error/pageerror', consoleErrors.length === 0 && pageErrors.length === 0, `console:${consoleErrors.length} page:${pageErrors.length}`);
      await page.close();
    }

    // ---- Teszt 2: beiratkozási UI CSAK bejelentkezett usernek, és CSAK ha
    //      a platform-hitelesítő feature-detect igazat ad ----
    {
      const page = await browser.newPage();
      await page.route('**://*.gstatic.com/**', route => route.abort());
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.addInitScript(installFakeFirebase);
      // Feature-detect mockolása: isUserVerifyingPlatformAuthenticatorAvailable() -> true.
      await page.addInitScript(() => {
        window.PublicKeyCredential = window.PublicKeyCredential || function () {};
        window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(true);
      });
      await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('typeof runRegressionChecks === "function"', { timeout: 30000 });
      await page.evaluate(() => openSub('settings'));

      // 2a) Beiratkozás előtt (nincs bejelentkezve) -> nincs enroll kártya.
      await page.waitForTimeout(300);
      let enrollBtn = await page.$('#webauthn-enroll-btn');
      record('2a) Kijelentkezett állapotban NINCS beiratkozási UI (bejelentkező form látszik helyette)', !enrollBtn, '');

      // 2b) Bejelentkezés (mockolt) -> a feature-detect true-ra fut, a
      // beiratkozási kártya megjelenik.
      await page.waitForSelector('#cloud-email', { timeout: 10000 });
      await page.fill('#cloud-email', 'teszt@pelda.hu');
      await page.fill('#cloud-password', 'jelszo123');
      await page.click('#cloud-submit-btn');
      await page.waitForSelector('#webauthn-enroll-btn', { timeout: 5000 });
      enrollBtn = await page.$('#webauthn-enroll-btn');
      record('2b) Bejelentkezve + platform-hitelesítő elérhető -> megjelenik a beiratkozási gomb', !!enrollBtn, '');

      record('2c) Nem dobott pageerror-t', pageErrors.length === 0, 'pageerror:' + pageErrors.length);
      await page.close();
    }

    // ---- Teszt 3: feature-detect FALSE (nincs platform hitelesítő) ->
    //      SEMMILYEN enroll UI nem jelenik meg, még bejelentkezve sem, és
    //      nincs hibaüzenet/pageerror (csendben hiányzik) ----
    {
      const page = await browser.newPage();
      await page.route('**://*.gstatic.com/**', route => route.abort());
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.addInitScript(installFakeFirebase);
      await page.addInitScript(() => {
        window.PublicKeyCredential = window.PublicKeyCredential || function () {};
        window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
      });
      await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('typeof runRegressionChecks === "function"', { timeout: 30000 });
      await page.evaluate(() => openSub('settings'));
      await page.waitForSelector('#cloud-email', { timeout: 10000 });
      await page.fill('#cloud-email', 'teszt@pelda.hu');
      await page.fill('#cloud-password', 'jelszo123');
      await page.click('#cloud-submit-btn');
      await page.waitForSelector('#cloud-signout-btn', { timeout: 5000 });
      await page.waitForTimeout(500); // idő a feature-detect Promise lefutására
      const enrollBtn = await page.$('#webauthn-enroll-btn');
      const enrollCard = await page.$('#webauthn-enroll-card');
      record('3) Nem elérhető platform-hitelesítő -> NINCS enroll UI, még bejelentkezve sem (csendben hiányzik)', !enrollBtn && !enrollCard, '');
      record('3b) Nem dobott pageerror-t (a hiányzó feature-detect nem hiba)', pageErrors.length === 0, 'pageerror:' + pageErrors.length);
      await page.close();
    }

    // ---- Teszt 4: VALÓDI end-to-end enrollment + zárolás + sikeres
    //      biometrikus feloldás Chromium CDP virtuális hitelesítővel ----
    {
      const page = await browser.newPage();
      await page.route('**://*.gstatic.com/**', route => route.abort());
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.addInitScript(installFakeFirebase);
      await page.addInitScript(() => {
        window.PublicKeyCredential = window.PublicKeyCredential || function () {};
        window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(true);
      });
      await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });
      // A virtuális hitelesítőt EGYETLEN CDP session-ön (ugyanezen a
      // target-en) regisztráljuk - a hozzá tartozó credential-ek ehhez a
      // session-höz/target-hez kötöttek, ezért az "app újraindítása" lépést
      // lentebb page.reload()-dal szimuláljuk (ÚJ tab/target helyett), hogy
      // ugyanaz a virtuális hitelesítő (és az imént beregisztrált
      // credential) elérhető maradjon navigator.credentials.get()-hez.
      const { authenticatorId } = await addVirtualAuthenticator(page);
      await page.waitForFunction('typeof runRegressionChecks === "function"', { timeout: 30000 });
      await page.evaluate(() => openSub('settings'));
      await page.waitForSelector('#cloud-email', { timeout: 10000 });
      await page.fill('#cloud-email', 'harmadikeszkoz@pelda.hu');
      await page.fill('#cloud-password', 'jelszo123');
      await page.click('#cloud-submit-btn');
      await page.waitForSelector('#webauthn-enroll-btn', { timeout: 5000 });

      // Valódi navigator.credentials.create() a CDP virtuális hitelesítővel.
      await page.click('#webauthn-enroll-btn');
      await page.waitForSelector('#webauthn-enroll-card:has-text("Be van kapcsolva")', { timeout: 5000 }).catch(() => {});
      const enrolledText = await page.textContent('#webauthn-enroll-card').catch(() => '');
      record('4a) VALÓDI navigator.credentials.create() (CDP virtuális hitelesítő) -> "Be van kapcsolva" állapot', (enrolledText || '').includes('Be van kapcsolva'), (enrolledText || '').slice(0, 60));

      const storedCredId = await page.evaluate(() => localStorage.getItem('motivapp2:webauthnCred:u1'));
      record('4b) A credential.id ténylegesen bekerült a localStorage-ba (uid-hez kötve)', !!storedCredId, 'len=' + (storedCredId || '').length);
      const enrolledUidFlag = await page.evaluate(() => localStorage.getItem('motivapp2:webauthnEnrolledUid'));
      record('4c) A webauthnEnrolledUid jelző beállt', enrolledUidFlag === 'u1', String(enrolledUidFlag));

      // "App újraindítása ezen az eszközön": page.reload() - ugyanaz a
      // target/CDP session (és így ugyanaz a virtuális hitelesítő +
      // credential) marad érvényben, a localStorage (ugyanaz az origin)
      // természetesen túléli az újratöltést is.
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('typeof runRegressionChecks === "function"', { timeout: 30000 });
      await page.waitForTimeout(300);
      const overlayOpen = await page.evaluate(() => document.getElementById('webauthn-lock-overlay').classList.contains('open'));
      record('4d) Újratöltés (app-újraindítás), enrolled-flag jelen -> a zároló overlay AZONNAL megjelenik induláskor', overlayOpen === true, 'open=' + overlayOpen);

      // Valódi navigator.credentials.get() a (még mindig regisztrált)
      // virtuális hitelesítővel -> sikeres feloldás.
      await page.click('#webauthn-lock-biometric-btn');
      await page.waitForFunction(
        () => !document.getElementById('webauthn-lock-overlay').classList.contains('open'),
        { timeout: 5000 }
      );
      const overlayOpenAfter = await page.evaluate(() => document.getElementById('webauthn-lock-overlay').classList.contains('open'));
      record('4e) VALÓDI navigator.credentials.get() sikeres feloldás (CDP virtuális hitelesítő) -> az overlay eltűnik', overlayOpenAfter === false, 'open=' + overlayOpenAfter);
      record('4f) A teljes enrollment+zárolás folyamat nem dobott pageerror-t', pageErrors.length === 0, 'pageerror:' + pageErrors.length);

      await page.close();
    }

    // ---- Teszt 5: elutasított/sikertelen biometrikus kísérlet -> az
    //      overlay NYITVA marad, hibaüzenet jelenik meg, és a jelszavas B
    //      opció felkínálódik. A virtuális hitelesítőt "nincs jelen"
    //      állapotba állítjuk (isUserVerified:false), ami a VALÓDI
    //      navigator.credentials.get()-et utasíttatja el a böngészővel. ----
    {
      const page = await browser.newPage();
      await page.route('**://*.gstatic.com/**', route => route.abort());
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.addInitScript(installFakeFirebase);
      await page.addInitScript(() => {
        window.PublicKeyCredential = window.PublicKeyCredential || function () {};
        window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(true);
      });
      // Előre beállított "korábban bejelentkezett + enrolled" eszközállapot,
      // DE a tárolt credential.id-hez nem tartozik semmilyen ténylegesen
      // regisztrált credential a (lent hozzáadott) virtuális hitelesítőn -
      // a VALÓDI navigator.credentials.get() emiatt gyorsan elutasítással
      // fut le (NotAllowedError - "nincs egyező hitelesítő"), ami pontosan a
      // "biometrikus azonosítás sikertelen" ágat gyakorolja be, ténylegesen
      // a böngésző WebAuthn-implementációján keresztül, NEM kézzel dobott
      // hibával.
      await page.addInitScript(installEnrolledDeviceState, { uid: 'u1', credId: 'ZmFrZS1jcmVkLWlk' });
      await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });
      await addVirtualAuthenticator(page);
      await page.waitForFunction('typeof runRegressionChecks === "function"', { timeout: 30000 });
      await page.waitForTimeout(300);
      const overlayOpen = await page.evaluate(() => document.getElementById('webauthn-lock-overlay').classList.contains('open'));
      record('5a) Enrolled-flag jelen, de nincs valódi hitelesítő -> overlay mégis megjelenik (a hiba csak feloldáskor derül ki)', overlayOpen === true, 'open=' + overlayOpen);

      await page.click('#webauthn-lock-biometric-btn');
      await page.waitForSelector('#webauthn-lock-error', { timeout: 5000 });
      const errText = await page.textContent('#webauthn-lock-error').catch(() => null);
      record('5b) Sikertelen/elutasított navigator.credentials.get() -> magyar hibaüzenet, overlay NYITVA marad', !!errText && errText.includes('Nem sikerült az ujjlenyomatos azonosítás'), errText);
      const overlayStillOpen = await page.evaluate(() => document.getElementById('webauthn-lock-overlay').classList.contains('open'));
      record('5c) Az overlay a sikertelen kísérlet után is NYITVA marad (nincs hallgatólagos feloldás)', overlayStillOpen === true, 'open=' + overlayStillOpen);
      const passwordLink = await page.$('#webauthn-lock-password-link');
      record('5d) A "Jelszóval" B opció gomb elérhető marad', !!passwordLink, '');
      record('5e) Nem dobott pageerror-t (a WebAuthn elutasítás elkapott, kezelt eset)', pageErrors.length === 0, 'pageerror:' + pageErrors.length);
      await page.close();
    }

    // ---- Teszt 6: jelszavas B opció - sikeres reauthenticateWithCredential
    //      -> overlay eltűnik; sikertelen -> mapped magyar hiba ----
    {
      const page = await browser.newPage();
      await page.route('**://*.gstatic.com/**', route => route.abort());
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.addInitScript(installFakeFirebase);
      await page.addInitScript(() => {
        window.PublicKeyCredential = window.PublicKeyCredential || function () {};
        window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(true);
      });
      await page.addInitScript(installEnrolledDeviceState, { uid: 'u1', credId: 'ZmFrZS1jcmVkLWlk' });
      // A mock window.firebase.onAuthStateChanged(user=null)-lel indul (nincs
      // __mockUser beállítva) - ez szimulálja azt, hogy a Firebase Auth
      // állapota MÉG NEM állt vissza, amikor a felhasználó rögtön a
      // jelszavas opcióra vált -> a submit függvénynek várnia kell rá.
      await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('typeof runRegressionChecks === "function"', { timeout: 30000 });
      await page.waitForSelector('#webauthn-lock-overlay.open', { timeout: 5000 });

      await page.click('#webauthn-lock-password-link');
      await page.waitForSelector('#webauthn-lock-email', { timeout: 5000 });

      // 6a) Előbb beállítjuk, hogy a MAJDANI reauth sikeres legyen, majd
      // "visszaállítjuk" a mock currentUser-t (a valódi appban ezt a
      // LOCAL persistence állítja vissza aszinkron onAuthStateChanged-del) -
      // itt kézzel hívjuk meg a mock authStateCb-t egy user-rel, hogy a
      // submit "várakozás fbAuth.currentUser-re" ága ténylegesen
      // gyakorlásra kerüljön, majd sikeresen lezáruljon.
      await page.fill('#webauthn-lock-email', 'negyedikeszkoz@pelda.hu');
      await page.fill('#webauthn-lock-password', 'jelszo123');
      const submitPromise = page.click('#webauthn-lock-submit-btn');
      await page.waitForTimeout(300); // a submit már a "várunk fbAuth.currentUser-re" ágban van
      await page.evaluate(() => {
        window.__mockUser = window.__makeMockUser('negyedikeszkoz@pelda.hu');
        window.__authStateCb && window.__authStateCb(window.__mockUser);
      });
      await submitPromise;
      await page.waitForFunction(
        () => !document.getElementById('webauthn-lock-overlay').classList.contains('open'),
        { timeout: 8000 }
      );
      const overlayOpenAfter = await page.evaluate(() => document.getElementById('webauthn-lock-overlay').classList.contains('open'));
      record('6a) Jelszavas B opció: sikeres (mockolt) reauthenticateWithCredential -> az overlay eltűnik', overlayOpenAfter === false, 'open=' + overlayOpenAfter);
      const reauthCalls = await page.evaluate(() => window.__mockCalls.filter(c => c[0] === 'reauth').length);
      record('6b) A reauthenticateWithCredential ténylegesen meghívódott (VALÓDI Firebase szerver-ellenőrzés útja)', reauthCalls >= 1, 'hívások: ' + reauthCalls);
      await page.close();
    }

    // ---- Teszt 7: jelszavas B opció sikertelen -> a cloudAuthErrorMessage()
    //      ugyanaz a magyar hibatérkép jelenik meg, mint a normál bejelentkező
    //      formnál ----
    {
      const page = await browser.newPage();
      await page.route('**://*.gstatic.com/**', route => route.abort());
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.addInitScript(installFakeFirebase);
      await page.addInitScript(() => {
        window.PublicKeyCredential = window.PublicKeyCredential || function () {};
        window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(true);
      });
      await page.addInitScript(installEnrolledDeviceState, { uid: 'u1', credId: 'ZmFrZS1jcmVkLWlk' });
      // Már a boot elején "visszaállt" (teljes funkciójú, reauthenticateWithCredential-t
      // is tudó) mock user, hogy a submit ne várakozzon rá - installFakeFirebase()
      // MÁR lefutott ezen a ponton (fentebb, korábbi addInitScript hívás), tehát
      // window.__makeMockUser elérhető.
      await page.addInitScript(() => {
        window.__mockUser = window.__makeMockUser('otodikeszkoz@pelda.hu');
      });
      await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('typeof runRegressionChecks === "function"', { timeout: 30000 });
      await page.waitForSelector('#webauthn-lock-overlay.open', { timeout: 5000 });
      await page.click('#webauthn-lock-password-link');
      await page.waitForSelector('#webauthn-lock-email', { timeout: 5000 });

      await page.evaluate(() => { window.__mockReauthError = 'auth/wrong-password'; });
      await page.fill('#webauthn-lock-password', 'rossz-jelszo');
      await page.click('#webauthn-lock-submit-btn');
      await page.waitForSelector('#webauthn-lock-error', { timeout: 8000 });
      const errText = await page.textContent('#webauthn-lock-error').catch(() => null);
      record('7a) Jelszavas B opció sikertelen reauth (auth/wrong-password) -> "Hibás jelszó." (ugyanaz a cloudAuthErrorMessage() térkép)', !!errText && errText.includes('Hibás jelszó'), errText);
      const overlayStillOpen = await page.evaluate(() => document.getElementById('webauthn-lock-overlay').classList.contains('open'));
      record('7b) Sikertelen jelszavas kísérlet után az overlay NYITVA marad', overlayStillOpen === true, 'open=' + overlayStillOpen);
      record('7c) Nem dobott pageerror-t', pageErrors.length === 0, 'pageerror:' + pageErrors.length);
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
