package com.kvantum.motivapp2

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Egyszerű, megosztott natív helyi-értesítés küldő. Ezt használja mind a JS-hívható
 * [NotifyBridge] (azonnali, előtér-eseményekhez — pl. szintlépés, boss legyőzve),
 * mind az [RpgStreakWorker] (háttérből, WorkManagerrel, pl. "sorozat veszélyben"
 * emlékeztetőhöz). A csatorna (channel) létrehozása idempotens és olcsó, ezért
 * minden notify() hívás elején újra lefuttatjuk, ahelyett hogy külön induláskori
 * inicializálást igényelne.
 *
 * A POST_NOTIFICATIONS (API 33+) futásidejű engedélyt a MainWebViewActivity már
 * induláskor kéri — itt csak defenzíven ellenőrizzük a tényleges állapotot, mielőtt
 * kiküldenénk, hogy megtagadott engedély esetén csendben, kivétel nélkül no-op legyen.
 */
object LocalNotifier {
    private const val CHANNEL_ID = "rpg_events"

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            CHANNEL_ID, "Életkampány", NotificationManager.IMPORTANCE_DEFAULT
        ).apply { description = "Szintlépés, boss fight és sorozat-emlékeztető értesítések" }
        manager.createNotificationChannel(channel)
    }

    fun notify(context: Context, notificationId: Int, title: String, body: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ActivityCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        ensureChannel(context)
        val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val contentIntent = launchIntent?.let {
            PendingIntent.getActivity(
                context, notificationId, it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setAutoCancel(true)
            .setContentIntent(contentIntent)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(notificationId, notification)
        } catch (e: SecurityException) {
            // Engedély időközben visszavonva a fenti ellenőrzés és a tényleges
            // notify() hívás között - csendben eldobjuk, nem indokolt összeomlás.
        }
    }
}
