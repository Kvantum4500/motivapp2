#!/usr/bin/env node
/*
 * ci-regression-check.js
 *
 * Miért van ez a fájl?
 * ---------------------
 * Az index.html-be épített runRegressionChecks() egy elég alapos, aszinkron
 * öntesztkészlet (lásd az "async function runRegressionChecks()" definíciót
 * az index.html-ben), de EDDIG csak úgy futott le, ha valaki manuálisan
 * megnyitotta az appot böngészőben, és a Beállítások -> "Adatok" kártyából
 * elindította a fejlesztői önteszt menüpontot (runDevSelfTest()). Ez azt
 * jelenti, hogy egy regresszió simán landolhatott a main ágon anélkül, hogy
 * bárki észrevette volna - a CI eddig soha nem futtatta le ezeket a
 * teszteket.
 *
 * Ez a szkript pontosan ezt a rést zárja be: elindít egy lokális HTTP
 * szervert a repo gyökeréből, Playwright-tal fejnélküli Chromium-ban
 * megnyitja az index.html-t (tehát a VALÓDI, éles appot, nem valami
 * mock-olt verziót), lefuttatja a böngészőben magát a runRegressionChecks()
 * függvényt, összegyűjti az eredményeket, és ha bármelyik teszt FAIL,
 * vagy a betöltés/futás közben bármilyen konzol- vagy oldalhiba történt,
 * a szkript nemnulla kilépőkóddal áll le - ez buktatja a CI job-ot.
 *
 * Nincs build lépés, nincs package.json a repo gyökerében: ez a szkript
 * feltételezi, hogy a "playwright" csomag már telepítve van (a CI workflow
 * `npm install --no-save playwright` + `npx playwright install --with-deps
 * chromium` lépésével), és sima `node scripts/ci-regression-check.js`-ként
 * futtatható.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 0; // 0 = az OS válasszon szabad portot, hogy ne ütközzön semmivel

// Nagyon egyszerű statikus fájlkiszolgáló - csak annyi kell, hogy az
// index.html és a hozzá tartozó relatív erőforrások (pl. manifest.json,
// ikonok) betölthetők legyenek ugyanabból a mappából, ahogy éles környezetben
// (GitHub Pages) is egy statikus gyökérből szolgálja ki őket.
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

        // Ne engedjünk a repo gyökere fölé kilépni.
        if (!filePath.startsWith(REPO_ROOT)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found: ' + urlPath);
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
          res.end(data);
        });
      } catch (e) {
        res.writeHead(500);
        res.end('Internal server error');
      }
    });

    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  console.log('=== MotivApp2 CI regressziós ellenőrzés ===');

  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/index.html`;
  console.log(`Lokális szerver elindult: ${baseUrl}`);

  const consoleErrors = [];
  const pageErrors = [];
  let browser;
  let exitCode = 0;

  try {
    // A "playwright" csomagot a CI workflow (vagy a lokális ellenőrzés
    // előtt futtatott `npm install --no-save playwright`) telepíti - ez a
    // fájl szándékosan a sima, alapértelmezett Chromium-indítást használja
    // (nincs benne sandbox-specifikus executablePath), mert a valódi CI
    // futtató saját, a `playwright install` által letett Chromiumot ad.
    const { chromium } = require('playwright');
    browser = await chromium.launch();

    const page = await browser.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err && err.message ? err.message : String(err));
    });

    console.log('Oldal betöltése...');
    await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });

    // Adjunk egy kis türelmi időt az app induló inicializálásának
    // (service worker regisztráció, App.init, stb.), mielőtt a tesztet
    // elindítjuk - a runRegressionChecks() globális függvényként kell,
    // hogy elérhető legyen ezen a ponton.
    await page.waitForFunction('typeof runRegressionChecks === "function"', { timeout: 30000 });

    console.log('runRegressionChecks() futtatása a böngészőben...');
    const results = await page.evaluate(async () => await runRegressionChecks());

    if (!Array.isArray(results) || results.length === 0) {
      throw new Error('runRegressionChecks() nem adott vissza (nem üres) tömböt eredményekkel.');
    }

    const failed = results.filter((r) => r['Eredmény'] !== 'PASS');
    const passedCount = results.length - failed.length;

    console.log('');
    console.log('--- Eredmények ---');
    console.log(`Összesen: ${results.length} teszt, ${passedCount} PASS, ${failed.length} FAIL`);
    console.log('');

    for (const r of results) {
      const ok = r['Eredmény'] === 'PASS';
      console.log(`${ok ? 'PASS' : 'FAIL'} - ${r['Teszt']}`);
    }

    if (failed.length > 0) {
      console.log('');
      console.log('--- Sikertelen tesztek részletei ---');
      for (const r of failed) {
        console.log(`\nFAIL: ${r['Teszt']}`);
        console.log(`  Részlet: ${r['Részlet'] || '(nincs részlet)'}`);
      }
      exitCode = 1;
    }
  } catch (err) {
    console.error('');
    console.error('!!! Váratlan hiba a regressziós ellenőrzés futtatása közben:');
    console.error(err && err.stack ? err.stack : err);
    exitCode = 1;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('');
  console.log('--- Böngésző konzolhibák / oldalhibák a futás alatt ---');
  if (consoleErrors.length === 0 && pageErrors.length === 0) {
    console.log('Nem történt console.error vagy elkapatlan (pageerror) hiba.');
  } else {
    if (consoleErrors.length > 0) {
      console.log(`console.error hívások (${consoleErrors.length}):`);
      consoleErrors.forEach((msg, i) => console.log(`  [${i + 1}] ${msg}`));
    }
    if (pageErrors.length > 0) {
      console.log(`Elkapatlan kivételek / pageerror (${pageErrors.length}):`);
      pageErrors.forEach((msg, i) => console.log(`  [${i + 1}] ${msg}`));
    }
    exitCode = 1;
  }

  console.log('');
  console.log(exitCode === 0 ? '=== EREDMÉNY: SIKERES ===' : '=== EREDMÉNY: SIKERTELEN ===');
  process.exit(exitCode);
})().catch((err) => {
  console.error('Kezeletlen kivétel a CI regressziós szkriptben:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
