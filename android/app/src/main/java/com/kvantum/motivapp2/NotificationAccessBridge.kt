package com.kvantum.motivapp2

import android.content.Intent
import android.provider.Settings
import android.webkit.JavascriptInterface
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
class NotificationAccessBridge(private val activity: MainWebViewActivity) {

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
     * Sikeres szkennelés után (listener csatlakoztatva) rögtön meg is hívja
     * [MainWebViewActivity.checkPendingNotifications]-t, hogy a most bekerült (vagy már
     * korábban is várakozó, még nem nyugtázott) rekordok azonnal, a gomb megnyomásának
     * eredményeként megjelenjenek a jóváhagyó lapokon - nem csak a következő natural
     * app-megnyitáskor/resume-nál -, így a kézi teszt-gomb legalább annyira hasznos marad,
     * mint az automatikus resume-alapú felismerés.
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
            // Deliver the (now possibly updated) queues to the page right away - see the
            // doc comment above. checkPendingNotifications() itself re-runs
            // scanActiveNotifications() once more, but that's a harmless dedup no-op;
            // simpler and safer than duplicating its record-reading/JS-delivery logic here.
            // Own try/catch: a delivery hiccup here must not clobber the scan result
            // above, which already succeeded and is worth reporting regardless.
            try {
                activity.checkPendingNotifications()
            } catch (e: Exception) {
                // Ignored - the scan itself (reflected in `result` already) still
                // succeeded; the queued records simply get delivered on the next natural
                // checkPendingNotifications() call (e.g. the next resume) instead.
            }
        } catch (e: Exception) {
            result.put("listenerConnected", false)
            result.put("candidatesFound", 0)
            result.put("savedCount", 0)
        }
        return result.toString()
    }
}
