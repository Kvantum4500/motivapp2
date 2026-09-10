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
 * actually CONFIRMED it ("Mentés") - never merely because it was handed to the page, and
 * NOT on a mere dismiss (closing the confirmation sheet without saving) either: that
 * intentionally leaves the record in the queue so it gets offered again next time (see
 * _finishActiveNotifQueueItem() in index.html, which only calls the acknowledge bridge
 * method when acknowledge===true). That way, if the app is killed mid-review, nothing
 * already-shown-but-not-yet-decided is lost either.
 *
 * Each queue is capped at [MAX_RECORDS_PER_TYPE], oldest-dropped-first, matching this
 * codebase's existing convention of capping other unbounded arrays (e.g.
 * App.state.finance.spendLedger caps at 500 entries in index.html) - so a badly
 * neglected notification shade can't grow the encrypted store unboundedly.
 *
 * ACKNOWLEDGED-HISTORY, separate from the pending queue above: Android does NOT
 * automatically dismiss/cancel most bank or Google Wallet transaction notifications just
 * because this app has processed them - the same notification typically keeps sitting,
 * unswiped, in the real notification shade until the user manually clears it (rare
 * exceptions aside). That means [NotificationForwarderService.scanActiveNotifications],
 * which re-scans EVERY currently active notification on every app open/resume (and via
 * the manual "Teszt: aktív értesítések újraellenőrzése" button), will very often see the
 * postTime of a notification the user just confirmed and saved moments ago, still
 * sitting there. Since confirming removes the record from the pending queue (see above)
 * and the plain dedup check above only looks at what is CURRENTLY queued, that postTime
 * would look brand new again and get re-added - resurfacing an already-saved bank/Foodora
 * entry as if it were a fresh, unconfirmed suggestion. [KEY_BANK_ACKNOWLEDGED]/
 * [KEY_FOOD_ACKNOWLEDGED] fix that: every postTime removed via an actual confirm (never a
 * mere dismiss - see above) is also recorded here, permanently enough that [addRecord]
 * refuses to re-queue it even after it's gone from the pending queue. Capped at
 * [MAX_ACKNOWLEDGED_PER_TYPE], oldest-dropped-first, same convention as the pending
 * queues - notifications don't realistically linger in the shade forever, so this only
 * needs to be large enough to outlast the "just confirmed, still visible" window, not
 * serve as a permanent audit log.
 */
object PendingNotificationStore {

    private const val PREFS_FILE_NAME = "motivapp2_pending_notifications"

    private const val KEY_BANK_RECORDS = "pending_bank_records_json"
    private const val KEY_FOOD_RECORDS = "pending_food_records_json"

    // Acknowledged-history keys - see class doc comment ("ACKNOWLEDGED-HISTORY" section)
    // for why these exist alongside the pending-queue keys above. Each stores a plain
    // JSON array of Long postTime values (not full records - by the time a postTime lands
    // here, the record itself has already been confirmed/saved into App.state.finance on
    // the JS side, so nothing but the identifier is needed to recognize it next time).
    private const val KEY_BANK_ACKNOWLEDGED = "acknowledged_bank_posttimes_json"
    private const val KEY_FOOD_ACKNOWLEDGED = "acknowledged_food_posttimes_json"

    private const val MAX_RECORDS_PER_TYPE = 20

    // See class doc comment - only needs to outlast the "just confirmed, still sitting in
    // the shade" window, not serve as a permanent audit log.
    private const val MAX_ACKNOWLEDGED_PER_TYPE = 50

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
    ): Boolean = addRecord(
        context, KEY_BANK_RECORDS, KEY_BANK_ACKNOWLEDGED, postTime, amount, rawText, sourcePackage
    )

    /** Same as [addPendingBankRecord] but for the food (Foodora) queue. */
    @Synchronized
    fun addPendingFoodRecord(
        context: Context,
        postTime: Long,
        amount: Double,
        rawText: String,
        sourcePackage: String
    ): Boolean = addRecord(
        context, KEY_FOOD_RECORDS, KEY_FOOD_ACKNOWLEDGED, postTime, amount, rawText, sourcePackage
    )

    @Synchronized
    fun getPendingBankRecords(context: Context): List<PendingRecord> =
        readRecords(prefs(context), KEY_BANK_RECORDS)

    @Synchronized
    fun getPendingFoodRecords(context: Context): List<PendingRecord> =
        readRecords(prefs(context), KEY_FOOD_RECORDS)

    /** Removes exactly one bank record by [postTime] - call only once the user has
     * actually CONFIRMED it (see class doc comment; never call this for a mere dismiss).
     * A no-op removal if it is already gone (e.g. acknowledged twice, or the queue was
     * cleared some other way) - but [postTime] is unconditionally recorded into the
     * bank acknowledged-history regardless, so a redundant call is harmless. */
    @Synchronized
    fun removePendingBankRecord(context: Context, postTime: Long) =
        removeRecord(context, KEY_BANK_RECORDS, KEY_BANK_ACKNOWLEDGED, postTime)

    @Synchronized
    fun removePendingFoodRecord(context: Context, postTime: Long) =
        removeRecord(context, KEY_FOOD_RECORDS, KEY_FOOD_ACKNOWLEDGED, postTime)

    private fun addRecord(
        context: Context,
        key: String,
        acknowledgedKey: String,
        postTime: Long,
        amount: Double,
        rawText: String,
        sourcePackage: String
    ): Boolean {
        val p = prefs(context)
        val list = readRecords(p, key).toMutableList()
        if (list.any { it.postTime == postTime }) return false
        // Already confirmed/saved earlier and removed from the queue - the notification
        // itself is very likely just still sitting, unswiped, in the shade (see class doc
        // comment's ACKNOWLEDGED-HISTORY section). Refuse to re-queue it as if new.
        if (readAcknowledged(p, acknowledgedKey).contains(postTime)) return false
        list.add(PendingRecord(postTime, amount, rawText, sourcePackage))
        list.sortBy { it.postTime }
        // Oldest-dropped-first once over the cap - see class doc comment.
        while (list.size > MAX_RECORDS_PER_TYPE) list.removeAt(0)
        p.edit().putString(key, recordsToJson(list)).apply()
        return true
    }

    private fun removeRecord(context: Context, key: String, acknowledgedKey: String, postTime: Long) {
        val p = prefs(context)
        val list = readRecords(p, key).filterNot { it.postTime == postTime }
        p.edit().putString(key, recordsToJson(list)).apply()
        addAcknowledged(context, acknowledgedKey, postTime)
    }

    /** Records [postTime] into the acknowledged-history for [acknowledgedKey], capped at
     * [MAX_ACKNOWLEDGED_PER_TYPE] with the oldest entries dropped first - see class doc
     * comment's ACKNOWLEDGED-HISTORY section. Called from [removeRecord] (the only place a
     * postTime is ever confirmed-acknowledged); kept as its own small function rather than
     * inlined there so the read-dedupe-cap-write steps for this simpler Long-only value
     * stay easy to follow on their own, mirroring how [readRecords]/[recordsToJson] are
     * factored out for the full-record queues above. Marked @Synchronized in its own right
     * (redundant while every caller is already @Synchronized, but cheap insurance against
     * a future caller that isn't). */
    @Synchronized
    private fun addAcknowledged(context: Context, acknowledgedKey: String, postTime: Long) {
        val p = prefs(context)
        val list = readAcknowledged(p, acknowledgedKey).toMutableList()
        list.remove(postTime) // avoid a duplicate entry if somehow already present
        list.add(postTime)
        // Oldest-dropped-first once over the cap - same convention as the pending queues.
        while (list.size > MAX_ACKNOWLEDGED_PER_TYPE) list.removeAt(0)
        p.edit().putString(acknowledgedKey, acknowledgedToJson(list)).apply()
    }

    /** Reads the acknowledged-history postTimes for [acknowledgedKey]. Returns an empty
     * list on first run (no value stored yet) or on any corrupt/unexpected stored value,
     * same defensive approach as [readRecords]. */
    private fun readAcknowledged(p: SharedPreferences, acknowledgedKey: String): List<Long> {
        val raw = p.getString(acknowledgedKey, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { i -> arr.optLong(i, 0L) }
        } catch (e: JSONException) {
            emptyList()
        }
    }

    private fun acknowledgedToJson(postTimes: List<Long>): String {
        val arr = JSONArray()
        postTimes.forEach { arr.put(it) }
        return arr.toString()
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
