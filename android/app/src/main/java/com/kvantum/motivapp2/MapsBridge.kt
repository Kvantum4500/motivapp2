package com.kvantum.motivapp2

import android.content.Intent
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.activity.ComponentActivity

/**
 * JS <-> natív híd (window.AndroidMaps) a "Térkép" nézet Túrák al-fülének, egy valódi
 * (Google Maps csempéken rajzolt) natív térkép-képernyőhöz.
 *
 * A meglévő renderRouteSvg()-alapú SVG útvonalnézet (index.html) VÁLTOZATLAN marad — mindig
 * elérhető, hálózat/API-kulcs nélkül is működő alapértelmezett nézet. Ez a híd egy KIEGÉSZÍTŐ,
 * csak a natív Android appban elérhető lehetőséget nyit meg: window.AndroidMaps jelenléte
 * (androidMapsAvailable() a JS oldalon) jelzi, hogy a gomb egyáltalán megjelenjen-e.
 *
 * openJourneyMap(pointsJson, journeyName): a JS oldal egy már szerializált JSON tömb
 * stringet ad át a túra pontjaival ([{lat,lng},...]) és a túra nevét. A hívás a
 * [JourneyMapDataStore]-on keresztül adja át ezeket a [JourneyMapActivity]-nek (nem Intent
 * extra-kon keresztül — ld. JourneyMapDataStore doksi), majd elindítja azt.
 */
class MapsBridge(private val activity: ComponentActivity) {

    @JavascriptInterface
    fun openJourneyMap(pointsJson: String, journeyName: String) {
        JourneyMapDataStore.writePending(activity.applicationContext, journeyName, pointsJson)
        activity.runOnUiThread {
            try {
                activity.startActivity(Intent(activity, JourneyMapActivity::class.java))
            } catch (e: Exception) {
                Toast.makeText(activity, "Nem sikerült megnyitni a natív térképet.", Toast.LENGTH_LONG).show()
            }
        }
    }
}
