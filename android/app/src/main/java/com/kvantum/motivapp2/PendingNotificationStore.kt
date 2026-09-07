package com.kvantum.motivapp2

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Genuinely-temporary holding spot for pending bank-transaction records and pending
 * food-order records, encrypted at rest with an Android-Keystore-backed AES-256-GCM key
 * via Jetpack Security Crypto (androidx.security.crypto).
 *
 * Each type (bank, food) holds a QUEUE of records, not just one - a neglected
 * notification shade can easily have several distinct unprocessed bank/Foodora
 * notifications sitting in it at once (confirmed via a real user screenshot: 5 at once,
 * from different merchants/times), and every one of them represents real spending the
 * user should get a chance to confirm, not just the single most recently seen one. The
 * whole queue is stored as one JSON array (org.json, same approach already used
 * elsewhere in this codebase, e.g. NotificationAccessBridge) inside a single encrypted
 * string value per type - EncryptedSharedPreferences only encrypts individual string
 * values, not a native list type, so this is the natural way to keep a queue under that
 * same encryption.
 *
 * A record only ever gets here after NotificationForwarderService has already checked,
 * in plaintext and before this class is ever touched, that the notification looks like
 * it carries a usable amount - this class has no idea what "looks usable" means and
 * never sees an unfiltered notification.
 *
 * Dedup key: [PendingRecord.postTime], threaded through from the originating
 * [android.service.notification.StatusBarNotification.getPostTime] (NOT
 * System.currentTimeMillis() at save time) - the same still-active notification can
 * legitimately be seen more than once (once via the real-time onNotificationPosted
 * callback, then again later via a scanActiveNotifications() re-scan while it is still
 * sitting, unconfirmed, in the shade), and postTime is the one natural, stable-per-
 * posted-notification identifier available to recognize "already queued this one" and
 * avoid piling up duplicate entries for it.
 *
 * A record is removed ONLY once the web app has told native (via
 * NativeBridge.acknowledgeBankNotification/acknowledgeFoodoraNotification) that the user
 * actually acted on it - confirmed ("Mentés") OR explicitly dismissed (closed its
 * confirmation sheet without saving) - never merely because it was handed to the page.
 * That way, if the app is killed mid-review, nothing already-shown-but-not-yet-decided
 * is lost: it is simply offered again the next time the queue is delivered.
 *
 * Each queue is capped at [MAX_RECORDS_PER_TYPE], oldest-dropped-first, matching this
 * codebase's existing convention of capping other unbounded arrays (e.g.
 * App.state.finance.spendLedger caps at 500 entries in index.html) - so a badly
 * neglected notification shade can't grow the encrypted store unboundedly.
 */
object PendingNotificationStore {

    private const val PREFS_FILE_NAME = "motivapp2_pending_notifications"

    private const val KEY_BANK_RECORDS = "pending_bank_records_json"
    private const val KEY_FOOD_RECORDS = "pending_food_records_json"

    private const val MAX_RECORDS_PER_TYPE = 20

    data class PendingRecord(
        val postTime: Long,
        val amount: Double,
        val rawText: String,
        val sourcePackage: String
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

    /** Appends a new pending bank record, deduped by [postTime]. Returns true iff a new
     * entry was actually added (false if [postTime] was already queued - a re-scan
     * seeing the same still-active notification again, not a new one). */
    @Synchronized
    fun addPendingBankRecord(
        context: Context,
        postTime: Long,
        amount: Double,
        rawText: String,
        sourcePackage: String
    ): Boolean = addRecord(context, KEY_BANK_RECORDS, postTime, amount, rawText, sourcePackage)

    /** Same as [addPendingBankRecord] but for the food (Foodora) queue. */
    @Synchronized
    fun addPendingFoodRecord(
        context: Context,
        postTime: Long,
        amount: Double,
        rawText: String,
        sourcePackage: String
    ): Boolean = addRecord(context, KEY_FOOD_RECORDS, postTime, amount, rawText, sourcePackage)

    @Synchronized
    fun getPendingBankRecords(context: Context): List<PendingRecord> =
        readRecords(prefs(context), KEY_BANK_RECORDS)

    @Synchronized
    fun getPendingFoodRecords(context: Context): List<PendingRecord> =
        readRecords(prefs(context), KEY_FOOD_RECORDS)

    /** Removes exactly one bank record by [postTime] - call only once the user has
     * actually acted on it (see class doc comment). A no-op if it is already gone
     * (e.g. acknowledged twice, or the queue was cleared some other way). */
    @Synchronized
    fun removePendingBankRecord(context: Context, postTime: Long) =
        removeRecord(context, KEY_BANK_RECORDS, postTime)

    @Synchronized
    fun removePendingFoodRecord(context: Context, postTime: Long) =
        removeRecord(context, KEY_FOOD_RECORDS, postTime)

    private fun addRecord(
        context: Context,
        key: String,
        postTime: Long,
        amount: Double,
        rawText: String,
        sourcePackage: String
    ): Boolean {
        val p = prefs(context)
        val list = readRecords(p, key).toMutableList()
        if (list.any { it.postTime == postTime }) return false
        list.add(PendingRecord(postTime, amount, rawText, sourcePackage))
        list.sortBy { it.postTime }
        // Oldest-dropped-first once over the cap - see class doc comment.
        while (list.size > MAX_RECORDS_PER_TYPE) list.removeAt(0)
        p.edit().putString(key, recordsToJson(list)).apply()
        return true
    }

    private fun removeRecord(context: Context, key: String, postTime: Long) {
        val p = prefs(context)
        val list = readRecords(p, key).filterNot { it.postTime == postTime }
        p.edit().putString(key, recordsToJson(list)).apply()
    }

    private fun readRecords(p: SharedPreferences, key: String): List<PendingRecord> {
        val raw = p.getString(key, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                PendingRecord(
                    postTime = o.optLong("postTime", 0L),
                    amount = o.optDouble("amount", 0.0),
                    rawText = o.optString("rawText", ""),
                    sourcePackage = o.optString("sourcePackage", "")
                )
            }
        } catch (e: JSONException) {
            // Corrupt/unexpected stored value (shouldn't normally happen - only this
            // class ever writes this key) - treat as an empty queue rather than crashing.
            emptyList()
        }
    }

    private fun recordsToJson(records: List<PendingRecord>): String {
        val arr = JSONArray()
        records.forEach { r ->
            val o = JSONObject()
            o.put("postTime", r.postTime)
            o.put("amount", r.amount)
            o.put("rawText", r.rawText)
            o.put("sourcePackage", r.sourcePackage)
            arr.put(o)
        }
        return arr.toString()
    }
}
