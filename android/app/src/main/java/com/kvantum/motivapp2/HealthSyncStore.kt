package com.kvantum.motivapp2

import android.content.Context
import org.json.JSONObject

/**
 * Egyszerű, WebView-tól független natív tároló a HealthSyncWorker (WorkManager
 * által ütemezve, a háttérben) legutóbbi eredményének. A MainActivity/JS induláskor
 * kiolvassa (ld. HealthConnectBridge.getPendingBackgroundResult és az index.html
 * pullPendingBackgroundHealthResult hívása), és a meglévő window.onAndroidHealthResult
 * szerződést újrahasználva illeszti a WebView állapotába, majd törli, hogy ugyanazt
 * az eredményt kétszer ne dolgozza fel.
 *
 * A payload JSON-ként (nem kulcsonkénti SharedPreferences-mezőkként) van eltárolva —
 * így ha a HealthDataFetcher később újabb mezőkkel bővül, itt nem kell semmit
 * módosítani, csak a saveResult(JSONObject) hívónak kell átadnia az új payloadot.
 */
object HealthSyncStore {
    private const val PREFS = "motivapp2_health_sync"
    private const val KEY_PENDING_JSON = "pending_json"

    fun saveResult(context: Context, payload: JSONObject) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_PENDING_JSON, payload.toString())
            .apply()
    }

    fun takePendingResultJson(context: Context): String? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val json = prefs.getString(KEY_PENDING_JSON, null) ?: return null
        prefs.edit().remove(KEY_PENDING_JSON).apply()
        return json
    }
}
