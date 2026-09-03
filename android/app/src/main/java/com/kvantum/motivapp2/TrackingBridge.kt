package com.kvantum.motivapp2

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.webkit.JavascriptInterface
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat

/**
 * JS <-> natív híd a Térkép nézet túrakövetéséhez. A JS a saját watchPosition-jét
 * továbbra is használja, amíg az app előtérben van — ez a híd egy PÁRHUZAMOS, a
 * WebView-tól független natív GPS-gyűjtést indít/állít (TrackingForegroundService),
 * hogy zárolt kijelzőnél/háttérbe küldésnél se szakadjon meg a rögzítés. A pontokat
 * a JS a takePendingPointsJson()-on keresztül kérdezi le (ld. index.html
 * pullNativeTrackPoints), és a saját, meglévő szűrőlogikáján engedi át őket.
 */
class TrackingBridge(private val activity: ComponentActivity) {

    @JavascriptInterface
    fun start() {
        // Android 14+ (API 34) megköveteli, hogy location-típusú foreground service
        // indításakor már legyen helymeghatározási engedély, különben kivételt dob —
        // ha még nincs (pl. a felhasználó ezután fogja megadni a fenti watchPosition
        // rendszerpromptjában), inkább csendben kihagyjuk, mint hogy összeomoljon az
        // app. A JS oldal ezt a hívást másodpercenként újrapróbálja tracking közben.
        val hasFine = ContextCompat.checkSelfPermission(
            activity, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        val hasCoarse = ContextCompat.checkSelfPermission(
            activity, Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        if (!hasFine && !hasCoarse) return

        val intent = Intent(activity, TrackingForegroundService::class.java)
        activity.runOnUiThread {
            try {
                ContextCompat.startForegroundService(activity, intent)
            } catch (e: Exception) {
                // Ritka rendszerkorlátozás esetén is maradjon használható az app —
                // ez csak a lezárt kijelzős kiegészítés, az előtér-alapú watchPosition
                // ettől függetlenül működik.
            }
        }
    }

    @JavascriptInterface
    fun stop() {
        val intent = Intent(activity, TrackingForegroundService::class.java)
        activity.runOnUiThread {
            try {
                activity.stopService(intent)
            } catch (e: Exception) {
            }
        }
    }

    @JavascriptInterface
    fun takePendingPointsJson(): String = TrackPointStore.takeAllAsJsonArray(activity)
}
