package com.kvantum.motivapp2

import android.content.Intent
import android.provider.Settings
import android.webkit.JavascriptInterface
import androidx.activity.ComponentActivity
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/**
 * JS <-> natív híd (window.AndroidNotifAccess) a banki/Foodora értesítés-figyelő
 * (NotificationForwarderService) diagnosztikájához/kézi teszteléséhez - az Integrációk
 * nézet "Teszt: aktív értesítések újraellenőrzése" gombja hívja.
 *
 * Miért kell ez: NotificationForwarderService.onListenerConnected() (ami a már aktív,
 * a szolgáltatás csatlakozása ELŐTT is ott ülő értesítéseket pótolja be) csak akkor fut
 * le, amikor az OS ténylegesen (újra)csatlakoztatja a listenert - ez tipikusan az
 * engedély megadásakor, egy újraindításnál vagy egy alkalmazásfrissítésnél történik. A
 * felhasználónak nincs közvetlen módja ezt kikényszeríteni, és az sem látszik számára,
 * hogy egyáltalán csatlakoztatva van-e a szolgáltatás vagy meg van-e adva az engedély -
 * ez a híd mindkettőre ad módot: [isAccessGranted]/[openAccessSettings] a jogosultság
 * ellenőrzésére/megadására, [testScanNow] pedig a NotificationForwarderService.instance
 * (ha épp csatlakozva van) [NotificationForwarderService.scanActiveNotifications]
 * függvényének kézi, azonnali újrafuttatására.
 *
 * Kizárólag OLVASÁS és a MÁR MEGADOTT engedély alapján amúgy is elérhető aktív-
 * értesítés-lista újra-átvizsgálása - nem ad semmilyen ÚJ jogosultságot vagy
 * hozzáférést a webes oldalnak.
 */
class NotificationAccessBridge(private val activity: ComponentActivity) {

    @JavascriptInterface
    fun isAccessGranted(): Boolean {
        val enabled = NotificationManagerCompat.getEnabledListenerPackages(activity)
        return activity.packageName in enabled
    }

    @JavascriptInterface
    fun openAccessSettings() {
        activity.runOnUiThread {
            try {
                activity.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            } catch (e: Exception) {
                // Nincs ilyen rendszerbeállítás-képernyő ezen az OEM-en - csendben eldobjuk,
                // a webes oldal az isAccessGranted() false értékéből úgyis jelzi a hiányt.
            }
        }
    }

    /** Szinkron hívás, JSON stringet ad vissza: {"listenerConnected":bool,
     * "candidatesFound":szám,"savedCount":szám}. Ha a listener épp nincs csatlakoztatva
     * (pl. az engedély megvan, de az OS még nem kötötte be újra a szolgáltatást), csak
     * listenerConnected:false jön vissza - ilyenkor a webes oldal javasolhatja az app
     * újraindítását vagy egy pillanatnyi várakozást.
     *
     * A teljes törzs try/catch-ben fut: [NotificationForwarderService.scanActiveNotifications]
     * a [PendingNotificationStore]-on keresztül a titkosított tárolót is írhatja, ami
     * elméletileg (pl. Keystore-probléma esetén) más kivételt is dobhat, mint a már ott
     * kezelt SecurityException-t - mivel ez a függvény mostantól a felhasználó egy
     * gombnyomásával BÁRMIKOR, közvetlenül kiváltható (nem csak a ritka
     * onListenerConnected() eseménynél), egy itt elszabaduló kivétel nem omolhat át a
     * JS-hídon: inkább egy "nincs csatlakoztatva" jellegű, biztonságosan kezelt
     * eredményt adunk vissza, amit a webes oldal újrapróbálásra ösztönző üzenetként
     * jelenít meg. */
    @JavascriptInterface
    fun testScanNow(): String {
        val result = JSONObject()
        try {
            val service = NotificationForwarderService.instance
            if (service == null) {
                result.put("listenerConnected", false)
                result.put("candidatesFound", 0)
                result.put("savedCount", 0)
                return result.toString()
            }
            val scan = service.scanActiveNotifications()
            result.put("listenerConnected", true)
            result.put("candidatesFound", scan.candidatesFound)
            result.put("savedCount", scan.savedCount)
        } catch (e: Exception) {
            result.put("listenerConnected", false)
            result.put("candidatesFound", 0)
            result.put("savedCount", 0)
        }
        return result.toString()
    }
}
