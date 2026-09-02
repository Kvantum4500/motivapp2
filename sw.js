/* MotivApp 2.0 — service worker
   Cél: az app teljesen offline is működjön az első sikeres betöltés után.
   Az app egyetlen, önmagában álló HTML fájl (nincs külső CDN/font-hívás),
   ezért elég ezt a néhány fájlt gyorsítótárazni ahhoz, hogy internet
   nélkül is teljes értékűen elinduljon és működjön (a MotivAI-chat
   kivételével, ami értelemszerűen hálózatot igényel).

   Verziófrissítésnél a CACHE_NAME-et emeld (pl. a fő fájl APP_VERSION-jét
   követve) — ez kényszeríti ki, hogy a böngésző/TWA letöltse az új
   verziót, és a régi cache-t eldobja.
*/
const CACHE_NAME = 'motivapp-cache-v2.1.1';
const APP_SHELL = [
  './index.html',
  './motivapp2-2_etezes_penzugy_jovahagyas_vegleges.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// Stratégia: network-first, cache-fallback — ha van net, mindig a friss
// verziót próbálja hozni (hogy egy módosítás gyorsan látszódjon), de ha
// nincs kapcsolat, a gyorsítótárazott verzióból tölt be, tehát offline is
// működik. A cache háttérben mindig frissül egy sikeres hálózati válasszal.
// { cache: 'no-store' }: sima fetch() nélkül ez csak "próbáljuk meg a
// hálózatot" volt, DE a böngésző saját HTTP-cache-e (és a GitHub Pages
// CDN kb. 10 perces cache-e) így is kiszolgálhatott volna egy régebbi,
// még nem lejárt választ hálózati kérés nélkül — emiatt egy friss push
// után percekig a régi tartalom látszódhatott, annak ellenére, hogy a
// "network-first" logika helyesen futott le. A no-store ezt zárja ki:
// mindig valódi hálózati kérés megy ki, cache-olvasás/írás nélkül a
// böngésző HTTP-rétegében (a saját Cache API-s tárolásunkat lentebb ez
// nem érinti).
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // Navigációs (oldalbetöltési) kérésnél, ha se net, se cache-találat
          // nincs (pl. első látogatás offline), essünk vissza a fő app-fájlra.
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return undefined;
        })
      )
  );
});
