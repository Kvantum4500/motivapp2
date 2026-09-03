package com.kvantum.motivapp2

import android.content.Context
import android.location.Location
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Natív, a WebView-tól/JS-től teljesen független sor a TrackingForegroundService
 * által gyűjtött nyers GPS-pontoknak. Egyszerű, soronként egy JSON-objektumot
 * tartalmazó szövegfájl (JSON Lines) — append-only íráshoz nem kell mindig a
 * teljes fájlt újraszerializálni, és több órás túránál is csak pár száz KB.
 *
 * Szándékosan NEM szűri/dedupolja itt a pontokat — az index.html
 * shouldAcceptTrackPoint()-ja végzi ugyanazt a szűrést, amit az élő
 * watchPosition-ből jövő pontoknál is használ (ld. TrackingBridge.kt teteje),
 * hogy a szabály egyetlen helyen legyen karbantartva.
 */
object TrackPointStore {
    private const val FILE_NAME = "native_track_points.jsonl"

    @Synchronized
    fun append(context: Context, location: Location) {
        val line = JSONObject().apply {
            put("lat", location.latitude)
            put("lng", location.longitude)
            put("t", location.time)
            if (location.hasAccuracy()) put("acc", location.accuracy.toDouble())
        }.toString()
        try {
            File(context.filesDir, FILE_NAME).appendText(line + "\n")
        } catch (e: Exception) {
        }
    }

    @Synchronized
    fun takeAllAsJsonArray(context: Context): String {
        val file = File(context.filesDir, FILE_NAME)
        if (!file.exists()) return "[]"
        val array = JSONArray()
        try {
            file.forEachLine { line ->
                if (line.isNotBlank()) {
                    try {
                        array.put(JSONObject(line))
                    } catch (e: Exception) {
                    }
                }
            }
        } catch (e: Exception) {
        }
        try {
            file.delete()
        } catch (e: Exception) {
        }
        return array.toString()
    }
}
