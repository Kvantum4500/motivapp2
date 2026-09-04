package com.kvantum.motivapp2

import android.content.Context
import com.google.android.gms.maps.model.LatLng
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Kis natív átadó a [MapsBridge]/JS oldal és a [JourneyMapActivity] között egy túra GPS-pontjainak
 * és nevének továbbítására. Szándékosan NEM Intent extra-kon keresztül adjuk át — egy több órás
 * túrának több ezer pontja is lehet, az Intent extrák (Binder-transakció) mérete korlátozott,
 * egy fájlé nem. Egyetlen JSON fájl a context.filesDir-ben.
 *
 * Ellentétben a [TrackPointStore] "vedd el egyszer" (take-once, olvasáskor törlő) szemantikájával,
 * ez a store olvasáskor NEM törli a fájlt: a [JourneyMapActivity] újra létrejöhet (elforgatás,
 * folyamat-megszakítás), és minden újralétrejöttkor újra el kell tudnia olvasni ugyanazt a
 * függőben lévő túrát — egészen addig, amíg egy ÚJ openJourneyMap hívás felül nem írja.
 */
object JourneyMapDataStore {
    private const val FILE_NAME = "pending_journey_map.json"

    data class PendingJourney(val name: String, val points: List<LatLng>)

    @Synchronized
    fun writePending(context: Context, name: String, pointsJson: String) {
        try {
            val pointsArray = JSONArray(pointsJson)
            val payload = JSONObject().apply {
                put("name", name)
                put("points", pointsArray)
            }
            File(context.filesDir, FILE_NAME).writeText(payload.toString())
        } catch (e: Exception) {
            // Érvénytelen JSON a WebView oldaláról — soha ne omoljon össze emiatt, csak
            // hagyjuk a korábbi (vagy nemlétező) állapotot változatlanul.
        }
    }

    @Synchronized
    fun readPending(context: Context): PendingJourney? {
        val file = File(context.filesDir, FILE_NAME)
        if (!file.exists()) return null
        return try {
            val payload = JSONObject(file.readText())
            val name = payload.optString("name", "")
            val pointsArray = payload.optJSONArray("points") ?: return null
            val points = ArrayList<LatLng>(pointsArray.length())
            for (i in 0 until pointsArray.length()) {
                val p = pointsArray.optJSONObject(i) ?: continue
                if (!p.has("lat") || !p.has("lng")) continue
                points.add(LatLng(p.getDouble("lat"), p.getDouble("lng")))
            }
            if (points.isEmpty()) null else PendingJourney(name = name, points = points)
        } catch (e: Exception) {
            null
        }
    }
}
