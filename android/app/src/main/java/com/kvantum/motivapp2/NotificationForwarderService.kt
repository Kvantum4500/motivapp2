package com.kvantum.motivapp2

import android.app.Notification
import android.content.Intent
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Receives every notification posted on the device (that's how
 * [NotificationListenerService] works - there is no way to subscribe to only some
 * packages at the OS level) and immediately discards anything whose [sbn.packageName]
 * is not one of exactly three hardcoded sources below. No storage, no logging, no
 * processing of any kind happens for anything else.
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
 */
class NotificationForwarderService : NotificationListenerService() {

    companion object {
        private const val PACKAGE_KH_BANK = "hu.khb"
        private const val PACKAGE_UNICREDIT_BANK_HU = "hr.asseco.android.jimba.mUCI.hu"
        private const val PACKAGE_FOODORA = "se.onlinepizza"

        private val BANK_PACKAGES: Set<String> = setOf(PACKAGE_KH_BANK, PACKAGE_UNICREDIT_BANK_HU)

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
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val packageName = sbn.packageName ?: return

        when {
            packageName in BANK_PACKAGES -> handleAllowedNotification(
                sbn = sbn,
                packageName = packageName,
                save = PendingNotificationStore::savePendingBankRecord
            )
            packageName == PACKAGE_FOODORA -> handleAllowedNotification(
                sbn = sbn,
                packageName = packageName,
                save = PendingNotificationStore::savePendingFoodRecord
            )
            else -> {
                // Not one of the three allow-listed sources: discard immediately, no
                // storage/logging/processing of any kind.
                return
            }
        }
    }

    private fun handleAllowedNotification(
        sbn: StatusBarNotification,
        packageName: String,
        save: (context: android.content.Context, amount: Double, rawText: String, sourcePackage: String) -> Unit
    ) {
        val combinedText = extractTitleAndText(sbn)

        // Plaintext keyword/pattern check happens here, before any encryption/storage
        // step. If nothing usable is found, discard - same as an unlisted package.
        if (!hasAmountMarker(combinedText)) return

        val amount = extractAmount(combinedText) ?: 0.0

        save(applicationContext, amount, combinedText, packageName)
        notifyForegroundApp()
    }

    private fun notifyForegroundApp() {
        val intent = Intent(ACTION_PENDING_NOTIFICATION_UPDATED).apply {
            setPackage(applicationContext.packageName)
        }
        sendBroadcast(intent)
    }
}
