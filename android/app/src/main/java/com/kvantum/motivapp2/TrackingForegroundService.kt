package com.kvantum.motivapp2

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Foreground service, ami a "Túra indítása" gomb megnyomásától a leállításig fut,
 * és a WebView/JS-től teljesen függetlenül, natívan gyűjti a GPS-pontokat
 * (TrackPointStore-ba írva). Ez teszi lehetővé, hogy zárolt kijelzőnél vagy
 * háttérbe küldött appnál se szakadjon meg a túrakövetés — a tisztán JS/WebView-
 * alapú watchPosition ugyanis leáll/erősen ritkul, amint a WebView nincs látható
 * előtérben (ezt jelezte eddig az app saját "natív verzió oldja meg" szövege).
 *
 * Hatókör: a folyamat teljes kilövése (pl. memóriaszűke miatti Android-oldali
 * kill) esetén ez a service is leáll, és nem indul újra magától (START_NOT_STICKY)
 * — ez a normál képernyőzár/háttérbe küldés miatti megszakadást oldja meg, NEM a
 * teljes app-kilövést túlélő, tartós háttérkövetést (az egy jóval nagyobb,
 * állapot-helyreállítást is igénylő feature lenne, külön indokolt kérésre).
 */
class TrackingForegroundService : Service() {

    private lateinit var locationManager: LocationManager
    private var listening = false

    private val listener = LocationListener { location -> TrackPointStore.append(applicationContext, location) }

    override fun onCreate() {
        super.onCreate()
        locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())
        startListening()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopListening()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startListening() {
        if (listening) return
        try {
            locationManager.requestLocationUpdates(
                LocationManager.GPS_PROVIDER,
                MIN_TIME_MS,
                MIN_DISTANCE_M,
                listener
            )
            listening = true
        } catch (e: SecurityException) {
            // Nincs (még) helymeghatározási engedély — a service ilyenkor is elindul
            // és fut, de pontot sosem kap. A JS oldal (index.html startTracking) ezt
            // másodpercenként újrapróbálja, tehát amint az engedély megvan, magától
            // helyrejön a következő induláskor.
        } catch (e: Exception) {
        }
    }

    private fun stopListening() {
        if (!listening) return
        try {
            locationManager.removeUpdates(listener)
        } catch (e: Exception) {
        }
        listening = false
    }

    private fun buildNotification(): Notification {
        val channelId = "tracking_channel"
        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId, "Túrakövetés", NotificationManager.IMPORTANCE_LOW
            ).apply { description = "Folyamatban lévő túra GPS-rögzítése" }
            notificationManager.createNotificationChannel(channel)
        }
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val contentIntent = launchIntent?.let {
            PendingIntent.getActivity(
                this, 0, it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
        return NotificationCompat.Builder(this, channelId)
            .setContentTitle("Túra rögzítése folyamatban")
            .setContentText("A MotivApp a háttérben is követi az útvonaladat.")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setContentIntent(contentIntent)
            .build()
    }

    companion object {
        private const val NOTIFICATION_ID = 4201
        private const val MIN_TIME_MS = 2000L
        private const val MIN_DISTANCE_M = 3f
    }
}
