package com.kvantum.motivapp2

import android.content.Context
import com.google.android.gms.maps.model.LatLng
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Kis natív átadó a [MapsBridge]/JS oldal és a [JourneyMapActivity] között egy vagy több túra
 * GPS-pontjainak és nevének továbbítására. Szándékosan NEM Intent extra-kon keresztül adjuk át -
 * egy több órás túrának több ezer pontja is lehet, az Intent extrák (Binder-transakció) mérete
 * korlátozott, egy fájlé nem. Egyetlen JSON fájl a context.filesDir-ben.
 *
 * Ellentétben a [TrackPointStore] "vedd el egyszer" (take-once, olvasáskor törlő) szemantikájával,
 * ez a store olvasáskor NEM törli a fájlt: a [JourneyMapActivity] újra létrejöhet (elforgatás,
 * folyamat-megszakítás), és minden újralétrejöttkor újra el kell tudnia olvasni ugyanazt a
 * függőben lévő túra-listát - egészen addig, amíg egy ÚJ openJourneysMap hívás felül nem írja.
 */
object JourneyMapDataStore {
    private const val FILE_NAME = "pending_journey_map.json"

    data class JourneyEntry(val name: String, val points: List<LatLng>)

    /**
     * @param journeysJson egy JSON TÖMB stringje, elemenként {"name":"...","points":[{"lat":...,
     * "lng":...},...]} alakban (ld. openJourneysNativeMap() az index.html-ben). Egy adott elem
     * feldolgozási hibája (érvénytelen objektum, hiányzó/üres points) csak azt az egy elemet
     * dobja el - egyetlen rossz bejegyzés se vigye el a teljes listát.
     */
    @Synchronized
    fun writePending(context: Context, journeysJson: String) {
        try {
            val journeysArray = JSONArray(journeysJson)
            File(context.filesDir, FILE_NAME).writeText(journeysArray.toString())
        } catch (e: Exception) {
            // Érvénytelen JSON a WebView oldaláról - soha ne omoljon össze emiatt, csak
            // hagyjuk a korábbi (vagy nemlétező) állapotot változatlanul.
        }
    }

    @Synchronized
    fun readPending(context: Context): List<JourneyEntry>? {
        val file = File(context.filesDir, FILE_NAME)
        if (!file.exists()) return null
        return try {
            val journeysArray = JSONArray(file.readText())
            val entries = ArrayList<JourneyEntry>(journeysArray.length())
            for (i in 0 until journeysArray.length()) {
                val entryObj = journeysArray.optJSONObject(i) ?: continue
                val name = entryObj.optString("name", "")
                val pointsArray = entryObj.optJSONArray("points") ?: continue
                val points = ArrayList<LatLng>(pointsArray.length())
                for (j in 0 until pointsArray.length()) {
                    val p = pointsArray.optJSONObject(j) ?: continue
                    if (!p.has("lat") || !p.has("lng")) continue
                    points.add(LatLng(p.getDouble("lat"), p.getDouble("lng")))
                }
                if (points.isNotEmpty()) entries.add(JourneyEntry(name = name, points = points))
            }
            if (entries.isEmpty()) null else entries
        } catch (e: Exception) {
            null
        }
    }
}
