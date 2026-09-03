package com.kvantum.motivapp2

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Genuinely-temporary holding spot for at most one pending bank-transaction record and
 * one pending food-order record, encrypted at rest with an Android-Keystore-backed
 * AES-256-GCM key via Jetpack Security Crypto (androidx.security.crypto).
 *
 * A record only ever gets here after NotificationForwarderService has already checked,
 * in plaintext and before this class is ever touched, that the notification looks like
 * it carries a usable amount - this class has no idea what "looks usable" means and
 * never sees an unfiltered notification.
 *
 * Records are cleared as soon as MainWebViewActivity/NativeBridge has handed them to the
 * web app (see NativeBridge.onBankNotification / onFoodoraNotification) - they are never
 * retained any longer than that, and there is no history/log of past records.
 */
object PendingNotificationStore {

    private const val PREFS_FILE_NAME = "motivapp2_pending_notifications"

    private const val KEY_BANK_AMOUNT = "pending_bank_amount"
    private const val KEY_BANK_RAW_TEXT = "pending_bank_raw_text"
    private const val KEY_BANK_SOURCE_PACKAGE = "pending_bank_source_package"
    private const val KEY_BANK_TIMESTAMP = "pending_bank_timestamp"

    private const val KEY_FOOD_AMOUNT = "pending_food_amount"
    private const val KEY_FOOD_RAW_TEXT = "pending_food_raw_text"
    private const val KEY_FOOD_SOURCE_PACKAGE = "pending_food_source_package"
    private const val KEY_FOOD_TIMESTAMP = "pending_food_timestamp"

    data class PendingRecord(
        val amount: Double,
        val rawText: String,
        val sourcePackage: String,
        val timestamp: Long
    )

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
    fun savePendingBankRecord(context: Context, amount: Double, rawText: String, sourcePackage: String) {
        prefs(context).edit()
            .putString(KEY_BANK_AMOUNT, amount.toString())
            .putString(KEY_BANK_RAW_TEXT, rawText)
            .putString(KEY_BANK_SOURCE_PACKAGE, sourcePackage)
            .putLong(KEY_BANK_TIMESTAMP, System.currentTimeMillis())
            .apply()
    }

    @Synchronized
    fun getPendingBankRecord(context: Context): PendingRecord? {
        val p = prefs(context)
        val rawText = p.getString(KEY_BANK_RAW_TEXT, null) ?: return null
        val amount = p.getString(KEY_BANK_AMOUNT, null)?.toDoubleOrNull() ?: 0.0
        val sourcePackage = p.getString(KEY_BANK_SOURCE_PACKAGE, "") ?: ""
        val timestamp = p.getLong(KEY_BANK_TIMESTAMP, 0L)
        return PendingRecord(amount, rawText, sourcePackage, timestamp)
    }

    @Synchronized
    fun clearPendingBankRecord(context: Context) {
        prefs(context).edit()
            .remove(KEY_BANK_AMOUNT)
            .remove(KEY_BANK_RAW_TEXT)
            .remove(KEY_BANK_SOURCE_PACKAGE)
            .remove(KEY_BANK_TIMESTAMP)
            .apply()
    }

    @Synchronized
    fun savePendingFoodRecord(context: Context, amount: Double, rawText: String, sourcePackage: String) {
        prefs(context).edit()
            .putString(KEY_FOOD_AMOUNT, amount.toString())
            .putString(KEY_FOOD_RAW_TEXT, rawText)
            .putString(KEY_FOOD_SOURCE_PACKAGE, sourcePackage)
            .putLong(KEY_FOOD_TIMESTAMP, System.currentTimeMillis())
            .apply()
    }

    @Synchronized
    fun getPendingFoodRecord(context: Context): PendingRecord? {
        val p = prefs(context)
        val rawText = p.getString(KEY_FOOD_RAW_TEXT, null) ?: return null
        val amount = p.getString(KEY_FOOD_AMOUNT, null)?.toDoubleOrNull() ?: 0.0
        val sourcePackage = p.getString(KEY_FOOD_SOURCE_PACKAGE, "") ?: ""
        val timestamp = p.getLong(KEY_FOOD_TIMESTAMP, 0L)
        return PendingRecord(amount, rawText, sourcePackage, timestamp)
    }

    @Synchronized
    fun clearPendingFoodRecord(context: Context) {
        prefs(context).edit()
            .remove(KEY_FOOD_AMOUNT)
            .remove(KEY_FOOD_RAW_TEXT)
            .remove(KEY_FOOD_SOURCE_PACKAGE)
            .remove(KEY_FOOD_TIMESTAMP)
            .apply()
    }
}
