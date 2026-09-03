package com.kvantum.motivapp2

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
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
 *
 * Android-Keystore-backed AES-256-GCM titkosítás (Jetpack Security Crypto), ugyanaz
 * a beállítás, mint a PendingNotificationStore-nál — biztonsági szempontból ez az
 * adat (súly, pulzus, alvás, elégetett kalória) nem kevésbé érzékeny, mint egy banki
 * összeg, tehát nem indokolt gyengébb védelmet adni neki csak azért, mert máshonnan
 * (Health Connectből, nem banki értesítésből) származik.
 */
object HealthSyncStore {
    private const val PREFS_FILE_NAME = "motivapp2_health_sync"
    private const val KEY_PENDING_JSON = "pending_json"

    @Volatile
    private var cachedPrefs: SharedPreferences? = null

    private fun prefs(context: Context): SharedPreferences {
        cachedPrefs?.let { return it }
        synchronized(this) {
            cachedPrefs?.let { return it }
            val appContext = context.applicationContext
            val masterKey = MasterKey.Builder(appContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            val created = EncryptedSharedPreferences.create(
                appContext,
                PREFS_FILE_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
            cachedPrefs = created
            return created
        }
    }

    @Synchronized
    fun saveResult(context: Context, payload: JSONObject) {
        prefs(context).edit()
            .putString(KEY_PENDING_JSON, payload.toString())
            .apply()
    }

    @Synchronized
    fun takePendingResultJson(context: Context): String? {
        val p = prefs(context)
        val json = p.getString(KEY_PENDING_JSON, null) ?: return null
        p.edit().remove(KEY_PENDING_JSON).apply()
        return json
    }
}
