package com.kvantum.motivapp2

import android.app.AlertDialog
import android.content.Intent
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import com.google.android.gms.maps.model.LatLng

/**
 * JS <-> natív híd (window.AndroidMaps) a "Térkép" nézet kettő al-füléhez, egy valódi
 * (Google Maps csempéken rajzolt) natív térképhez.
 *
 * A meglévő renderRouteSvg()-alapú SVG útvonalnézet (index.html) VÁLTOZATLAN marad — mindig
 * elérhető, hálózat/API-kulcs nélkül is működő alapértelmezett nézet.
 *
 * Két, egymástól teljesen független belépési pont van innen:
 *
 * 1) openJourneysMap(journeysJson): a TÚRÁK al-fül per-túra 🗺️ gombja / "Összes út" - egy
 *    TELJES KÉPERNYŐS natív térképet nyit ([JourneyMapActivity]) a [JourneyMapDataStore]-on
 *    keresztül átadott túra(ák)kal. EZ A RÉGI, MÁR MŰKÖDŐ FOLYAMAT - VÁLTOZATLAN.
 *
 * 2) showEmbeddedMap/updateEmbeddedMapRect/hideEmbeddedMap/isMapEmbedLocked/
 *    requestEmbeddedMapUnlock: az ÚTVONALAK al-fülbe ágyazott (a webes #route-map-slot
 *    kártya pontos képernyő-téglalapjára pozicionált) natív térkép-overlay-t vezérlik - ld.
 *    [MainWebViewActivity] osztály-doksija a mechanizmus részletes leírásáért
 *    (embeddedMapView, egy sima MapView, NEM SupportMapFragment, a WebView fölé rétegzett
 *    FrameLayout-testvérként). Ez a natív térkép SOSE helyettesíti a DOM-beli SVG nézetet -
 *    tisztán vizuális overlay fölötte -, tehát bármilyen hiba (nincs Play Services, lezárt
 *    keret, pozicionálási hiba) esetén az SVG nézet változatlanul látszik alatta.
 *
 * Mindkét belépési pont ugyanazt a [MapRouteRenderer]-t hívja az útvonalak/marker-ek
 * kirajzolásához és a kamera illesztéséhez - egyetlen implementáció, két belépési pont.
 */
class MapsBridge(private val activity: MainWebViewActivity, private val webView: WebView) {

    // Csak addig true, amíg az embedded overlay ténylegesen látszik a képernyőn - kizárólag
    // arra kell, hogy a MapsUsageStore.recordLoad() PONTOSAN EGYSZER fusson le egy "az
    // overlay épp most vált láthatóvá" átmenetenként, sose az updateEmbeddedMapRect() gyakori
    // (minden scroll/resize eseménynél újra meghívott) pozíció-szinkronizáló hívásaira.
    private var embeddedMapCurrentlyShown = false

    @JavascriptInterface
    fun openJourneysMap(journeysJson: String) {
        JourneyMapDataStore.writePending(activity.applicationContext, journeysJson)
        activity.runOnUiThread {
            try {
                activity.startActivity(Intent(activity, JourneyMapActivity::class.java))
            } catch (e: Exception) {
                Toast.makeText(activity, "Nem sikerült megnyitni a natív térképet.", Toast.LENGTH_LONG).show()
            }
        }
    }

    /** @param journeysJson ugyanaz a JSON TÖMB alak, mint openJourneysMap()-nél
     *  ({"name":...,"points":[{"lat":...,"lng":...},...]} elemenként) - ld. parseJourneys
     *  lent. Ha a JSON érvénytelen / nincs benne legalább egy 2+ pontos túra, vagy a havi
     *  keret épp lezárt állapotban van, csendben nem csinál semmit (a JS oldal amúgy is csak
     *  akkor hívja ezt, ha androidMapsAvailable() && hasRoutes && !isMapEmbedLocked()). */
    @JavascriptInterface
    fun showEmbeddedMap(journeysJson: String) {
        val journeys = parseJourneys(journeysJson)
        activity.runOnUiThread {
            if (journeys.isNullOrEmpty()) return@runOnUiThread
            if (MapsUsageStore.getUsage(activity).locked) return@runOnUiThread
            activity.embeddedMapView.visibility = View.VISIBLE
            activity.ensureEmbeddedGoogleMap { googleMap ->
                googleMap.clear()
                MapRouteRenderer.drawJourneys(activity, googleMap, journeys)
                googleMap.setOnMapLoadedCallback {
                    MapRouteRenderer.fitCameraToRoutes(googleMap, journeys.flatMap { it.points })
                    // Csak az "eddig nem volt látható -> most látható" átmeneten számoljuk
                    // el a betöltést - ld. embeddedMapCurrentlyShown doksi fent.
                    if (!embeddedMapCurrentlyShown) {
                        embeddedMapCurrentlyShown = true
                        MapsUsageStore.recordLoad(activity)
                    }
                }
            }
        }
    }

    /** Gyakori hívás (minden scroll/resize eseménynél a JS oldalról) - szándékosan olcsó:
     *  kizárólag az overlay LayoutParams-át frissíti, semmiféle térkép-újrarajzolást/
     *  csempekérést NEM indít. */
    @JavascriptInterface
    fun updateEmbeddedMapRect(xPx: Int, yPx: Int, widthPx: Int, heightPx: Int) {
        activity.runOnUiThread {
            val mapView = activity.embeddedMapView
            val params = (mapView.layoutParams as? FrameLayout.LayoutParams)
                ?: FrameLayout.LayoutParams(widthPx, heightPx)
            params.width = widthPx
            params.height = heightPx
            params.leftMargin = xPx
            params.topMargin = yPx
            mapView.layoutParams = params
            mapView.requestLayout()
        }
    }

    @JavascriptInterface
    fun hideEmbeddedMap() {
        activity.runOnUiThread {
            activity.embeddedMapView.visibility = View.GONE
            embeddedMapCurrentlyShown = false
        }
    }

    /** Szinkron visszatérés a JS oldalnak - ugyanaz a minta, mint a
     *  [HealthConnectBridge.isAvailable]-nél: a SharedPreferences-alapú
     *  [MapsUsageStore.getUsage] bármelyik szálról biztonságosan olvasható, ehhez nem kell
     *  UI szál, és a JS oldalnak épp EGY szinkron visszatérési értékre van szüksége (nem egy
     *  külön window.on... callback-re), tehát ez szándékosan NINCS runOnUiThread-be
     *  csomagolva. */
    @JavascriptInterface
    fun isMapEmbedLocked(): Boolean = MapsUsageStore.getUsage(activity).locked

    /** Ugyanaz a megerősítő párbeszédablak-szöveg/stílus, mint [JourneyMapActivity]
     *  meglévő feloldás-megerősítésénél (journeyMapUnlockConfirm* stringek) - fogalmilag
     *  ugyanaz a művelet (a hónap hátralévő részére feloldani a havi keretet), nem indokolt
     *  külön szöveget kitalálni hozzá. Sikeres feloldás után a natív->JS hívási konvenciót
     *  követve (ld. window.onAndroidHealthResult / window.onBankNotification) egy globális
     *  JS függvényt hív meg, hogy a webes oldal újrapróbálhassa a beágyazást. */
    @JavascriptInterface
    fun requestEmbeddedMapUnlock() {
        activity.runOnUiThread {
            AlertDialog.Builder(activity)
                .setMessage(R.string.journeyMapUnlockConfirmMessage)
                .setPositiveButton(R.string.journeyMapUnlockConfirmYes) { _, _ ->
                    MapsUsageStore.unlockForRestOfMonth(activity)
                    webView.evaluateJavascript(
                        "window.onEmbeddedMapUnlocked && window.onEmbeddedMapUnlocked();",
                        null
                    )
                }
                .setNegativeButton(R.string.journeyMapUnlockConfirmNo, null)
                .show()
        }
    }

    /** Ugyanaz a kis JSON-feldolgozó logika, mint a [JourneyMapDataStore.readPending]
     *  belsejében - szándékosan itt is megismételve (nem [JourneyMapDataStore]-ból
     *  kiemelve/megosztva), mert az onnan fájlon keresztül olvas, ez pedig közvetlenül a
     *  JS hívás argumentumából dolgozik; egy adott elem feldolgozási hibája (érvénytelen
     *  objektum, hiányzó/üres points) csak azt az egy elemet dobja el. */
    private fun parseJourneys(journeysJson: String): List<JourneyMapDataStore.JourneyEntry>? {
        return try {
            val journeysArray = JSONArray(journeysJson)
            val entries = ArrayList<JourneyMapDataStore.JourneyEntry>(journeysArray.length())
            for (i in 0 until journeysArray.length()) {
                val entryObj = journeysArray.optJSONObject(i) ?: continue
                val name = entryObj.optString("name", "")
                val pointsArray = entryObj.optJSONArray("points") ?: continue
                val points = ArrayList<LatLng>(pointsArray.length())
                for (j in 0 until pointsArray.length()) {
                    val p: JSONObject = pointsArray.optJSONObject(j) ?: continue
                    if (!p.has("lat") || !p.has("lng")) continue
                    points.add(LatLng(p.getDouble("lat"), p.getDouble("lng")))
                }
                if (points.size > 1) entries.add(JourneyMapDataStore.JourneyEntry(name = name, points = points))
            }
            if (entries.isEmpty()) null else entries
        } catch (e: Exception) {
            null
        }
    }
}
