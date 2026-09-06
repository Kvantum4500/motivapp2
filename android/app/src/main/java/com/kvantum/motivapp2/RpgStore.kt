package com.kvantum.motivapp2

import android.content.Context
import android.content.SharedPreferences

/**
 * Kis, nem érzékeny (nincs banki/egészségügyi adat, csak egy dátum és egy számláló)
 * natív tükrözés a webes Életkampány (App.state.rpg) aktivitásáról, hogy az
 * [RpgStreakWorker] a WebView-tól teljesen függetlenül, a háttérben is el tudja
 * dönteni, kell-e "sorozat veszélyben" emlékeztetőt küldenie. A JS oldal
 * [NotifyBridge.reportActivity] hívásával frissíti minden mentéskor.
 *
 * Sima (nem titkosított) SharedPreferences, mert az itt tárolt adat (egy ISO
 * dátum-string és egy egész szám) nem indokolja az EncryptedSharedPreferences
 * (PendingNotificationStore/HealthSyncStore) többletköltségét.
 */
object RpgStore {
    private const val PREFS_FILE_NAME = "motivapp2_rpg"
    // Régebbi néven "streak_days" volt - a webes rpgCurrentStreak() valójában EGYMÁST
    // KÖVETŐ HETEKET számol (ld. index.html "X hetes sorozat" szövege), nem napokat.
    // Az elnevezés-csere miatt egy már telepített app egyszeri, ártalmatlan 0-ra
    // visszaálló számlálót lát ennél a mezőnél - ez csak egy natívan tükrözött,
    // származtatott érték, nem az igazság forrása (az a JS oldali App.state.rpg).
    private const val KEY_STREAK_WEEKS = "streak_weeks"
    private const val KEY_LAST_ACTIVE_DATE = "last_active_date"
    private const val KEY_LAST_NOTIFIED_DATE = "last_notified_date"

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_FILE_NAME, Context.MODE_PRIVATE)

    fun saveActivity(context: Context, streakWeeks: Int, lastActiveDateIso: String) {
        prefs(context).edit()
            .putInt(KEY_STREAK_WEEKS, streakWeeks)
            .putString(KEY_LAST_ACTIVE_DATE, lastActiveDateIso)
            .apply()
    }

    fun lastActiveDate(context: Context): String? = prefs(context).getString(KEY_LAST_ACTIVE_DATE, null)

    fun streakWeeks(context: Context): Int = prefs(context).getInt(KEY_STREAK_WEEKS, 0)

    fun lastNotifiedDate(context: Context): String? = prefs(context).getString(KEY_LAST_NOTIFIED_DATE, null)

    fun markNotified(context: Context, dateIso: String) {
        prefs(context).edit().putString(KEY_LAST_NOTIFIED_DATE, dateIso).apply()
    }
}
