package com.kvantum.motivapp2

import android.app.Notification
import android.content.Intent
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Receives every notification posted on the device (that's how
 * [NotificationListenerService] works - there is no way to subscribe to only some
 * packages at the OS level) and immediately discards anything whose [sbn.packageName]
 * is not one of the hardcoded sources below. No storage, no logging, no processing of
 * any kind happens for anything else.
 *
 * [onNotificationPosted] alone only ever sees notifications posted AFTER this listener
 * is connected - a bank/Foodora notification that arrived before the user granted
 * notification access, or before the OS finished rebinding the listener after a reboot
 * or an app update, would never reach it and would be silently missed forever (the
 * notification itself stays sitting in the shade, but this service never gets told
 * about it again). [onListenerConnected] closes that gap: it runs once, right after the
 * OS finishes connecting this listener, and backfills anything already active at that
 * moment through [scanActiveNotifications]. That same scan is also exposed on demand via
 * [instance] + [scanActiveNotifications] for [NotificationAccessBridge]'s manual test
 * button (Integrációk view) - useful because [onListenerConnected] only fires when the
 * OS actually (re)connects the listener, which the user has no direct way to force.
 *
 * This allow-list is intentionally compiled-in and there is intentionally no in-app
 * settings UI to change it, ever - see the class-level comment on the manifest
 * declaration of this service for how a user actually grants it notification access.
 *
 * Package IDs below were confirmed by the user against their own installed apps' real
 * Play Store listings, not guessed:
 *  - K&H Bank: hu.khb
 *  - UniCredit Bank Hungary: hr.asseco.android.jimba.mUCI.hu
 *  - Foodora: se.onlinepizza
 *
 * IMPORTANT, discovered from a real device screenshot: for a contactless (NFC tap-to-pay)
 * card provisioned into Google Wallet, the transaction notification the user actually
 * receives and sees ("730,00 Ft a következővel: K&H Mastercard alap ••6491") comes from
 * GOOGLE WALLET, not from the K&H app itself - K&H's own app notifications (per its
 * "KiberPajzs" feature) deliberately carry no transaction amount at all, for security
 * reasons, so they could never have worked for this purpose regardless of any code
 * change here. [PACKAGE_GOOGLE_WALLET] below is the standard, long-stable Google
 * Wallet/Google Pay NFC package id - UNLIKE the three above, this one has NOT yet been
 * confirmed by the user against their own device's actual installed package (Settings ->
 * Alkalmazások -> Google Wallet -> the package name is shown on that screen, or share the
 * app's Play Store listing - the link contains "id=<package>"). If the manual test button
 * (Integrációk) still finds 0 candidates after this ships, that ID is the first thing to
 * verify/correct.
 */
class NotificationForwarderService : NotificationListenerService() {

    companion object {
        private const val PACKAGE_KH_BANK = "hu.khb"
        private const val PACKAGE_UNICREDIT_BANK_HU = "hr.asseco.android.jimba.mUCI.hu"
        private const val PACKAGE_FOODORA = "se.onlinepizza"
        private const val PACKAGE_GOOGLE_WALLET = "com.google.android.apps.walletnfcrel"

        private val BANK_PACKAGES: Set<String> =
            setOf(PACKAGE_KH_BANK, PACKAGE_UNICREDIT_BANK_HU, PACKAGE_GOOGLE_WALLET)

        /** Broadcast sent (to this app's own package only) after a pending record is written,
         * so an already-foregrounded MainWebViewActivity can pick it up immediately instead
         * of waiting for its next onResume. */
        const val ACTION_PENDING_NOTIFICATION_UPDATED =
            "com.kvantum.motivapp2.action.PENDING_NOTIFICATION_UPDATED"

        // Non-breaking space (U+00A0): ICU-formatted Hungarian currency strings commonly
        // use it as the thousands separator instead of an ordinary space.
        private const val NBSP = "\u00A0"

        // Plaintext-only checks, run BEFORE anything is ever handed to
        // PendingNotificationStore/EncryptedSharedPreferences. Searching encrypted content
        // for a keyword doesn't work with real encryption, so this check has to happen
        // first, on the plaintext notification text, or not at all.
        private val FORINT_MARKER_REGEX = Regex("(?i)\\bFt\\b")
        private val NUMERIC_AMOUNT_REGEX =
            Regex("-?\\d{1,3}([ $NBSP.,]\\d{3})+([.,]\\d+)?|-?\\d+[.,]\\d{2}\\b")

        // Used only to pull a best-effort amount out of a notification that already
        // passed the marker check above; e.g. "12 345 Ft" or "-3 500,00 Ft".
        private val AMOUNT_EXTRACT_REGEX = Regex("(?i)(-?[0-9][0-9 $NBSP.,]*)\\s*Ft\\b")

        private fun hasAmountMarker(text: String): Boolean {
            return FORINT_MARKER_REGEX.containsMatchIn(text) || NUMERIC_AMOUNT_REGEX.containsMatchIn(text)
        }

        private fun extractAmount(text: String): Double? {
            val match = AMOUNT_EXTRACT_REGEX.find(text) ?: return null
            val normalized = match.groupValues[1]
                .replace(" ", "")
                .replace(NBSP, "")
                .replace(".", "")
                .replace(",", ".")
            return normalized.toDoubleOrNull()
        }

        private fun extractTitleAndText(sbn: StatusBarNotification): String {
            val extras = sbn.notification?.extras ?: return ""
            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
            val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
            val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString().orEmpty()
            return listOf(title, text, bigText).filter { it.isNotBlank() }.joinToString(" ")
        }

        /** Set only from [onListenerConnected]/[onListenerDisconnected] on this exact
         * service instance - lets [NotificationAccessBridge] (running inside
         * MainWebViewActivity, a completely separate component) reach the currently-bound
         * listener on demand, since Android gives no other way to obtain a live
         * NotificationListenerService instance from outside the service itself. */
        @Volatile
        var instance: NotificationForwarderService? = null
            private set
    }

    /** (candidatesFound = how many active notifications matched an allow-listed package,
     * savedCount = how many of those actually carried a recognizable amount and were
     * saved as a pending record - see [hasAmountMarker]). Exposed so both the automatic
     * [onListenerConnected] backfill and [NotificationAccessBridge]'s manual test button
     * can report something meaningful, not just "done". */
    data class ScanResult(val candidatesFound: Int, val savedCount: Int)

    /** Re-scans whatever is CURRENTLY active (not yet dismissed) in the notification
     * shade for the 3 allow-listed packages and processes each exactly like a live
     * [onNotificationPosted] event - see the class-level doc for why this needs to exist
     * on demand, not just once at connection time. [getActiveNotifications] can include
     * notifications posted long before this call (they were simply sitting there the
     * whole time); that is intentional - both the cold-start backfill and the manual test
     * button are meant to catch historical, still-visible notifications too, not just ones
     * posted from this exact moment forward. Processed oldest-first (by
     * [StatusBarNotification.getPostTime]), so if more than one matching notification of
     * the same kind (bank vs. Foodora) is active at once, the LAST one processed (the most
     * recently posted) is the one that ends up as the stored pending record - the same
     * "latest wins" behavior a real-time stream of postings would give, since
     * [PendingNotificationStore] only ever holds one record per type. */
    fun scanActiveNotifications(): ScanResult {
        var candidatesFound = 0
        var savedCount = 0
        try {
            activeNotifications
                ?.filter { it.packageName in BANK_PACKAGES || it.packageName == PACKAGE_FOODORA }
                ?.sortedBy { it.postTime }
                ?.forEach { sbn ->
                    candidatesFound++
                    if (processNotification(sbn)) savedCount++
                }
        } catch (e: SecurityException) {
            // Some OEM builds can throw here if the connection isn't fully settled yet -
            // not fatal, the caller just sees a lower savedCount than reality; a genuine
            // onNotificationPosted() event still reaches this service normally either way.
        }
        return ScanResult(candidatesFound, savedCount)
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        instance = this
        scanActiveNotifications()
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        if (instance === this) instance = null
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        processNotification(sbn)
    }

    /** Returns true iff [sbn] was from an allow-listed package AND carried a recognizable
     * amount, i.e. a pending record was actually saved. Shared by the real-time
     * [onNotificationPosted] path and the on-demand [scanActiveNotifications] backfill. */
    private fun processNotification(sbn: StatusBarNotification): Boolean {
        val packageName = sbn.packageName ?: return false

        val save: (context: android.content.Context, amount: Double, rawText: String, sourcePackage: String) -> Unit =
            when {
                packageName in BANK_PACKAGES -> PendingNotificationStore::savePendingBankRecord
                packageName == PACKAGE_FOODORA -> PendingNotificationStore::savePendingFoodRecord
                else -> {
                    // Not one of the three allow-listed sources: discard immediately, no
                    // storage/logging/processing of any kind.
                    return false
                }
            }

        val combinedText = extractTitleAndText(sbn)

        // Plaintext keyword/pattern check happens here, before any encryption/storage
        // step. If nothing usable is found, discard - same as an unlisted package.
        if (!hasAmountMarker(combinedText)) return false

        val amount = extractAmount(combinedText) ?: 0.0

        save(applicationContext, amount, combinedText, packageName)
        notifyForegroundApp()
        return true
    }

    private fun notifyForegroundApp() {
        val intent = Intent(ACTION_PENDING_NOTIFICATION_UPDATED).apply {
            setPackage(applicationContext.packageName)
        }
        sendBroadcast(intent)
    }
}
