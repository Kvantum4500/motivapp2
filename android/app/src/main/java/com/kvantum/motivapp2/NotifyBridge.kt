package com.kvantum.motivapp2

import android.webkit.JavascriptInterface
import androidx.activity.ComponentActivity

/**
 * JS <-> natív híd (window.AndroidNotify) az Életkampány (RPG) funkciónak.
 *
 * Két célra használja a webes oldal:
 *  - notify(id, title, body): azonnali, előtér-eseményhez kötött értesítés (pl.
 *    szintlépés, negyedéves boss legyőzve) - ugyanaz a [LocalNotifier], amit a
 *    háttérben az [RpgStreakWorker] is használ a "sorozat veszélyben" emlékeztetőhöz.
 *  - reportActivity(streakDays, lastActiveDateIso): minden alkalommal meghívva, amikor
 *    a webes állapot (App.state.rpg) mentésre kerül és aznap történt XP-szerzés -
 *    ez frissíti az [RpgStore]-t, amit a WebView-tól függetlenül futó
 *    [RpgStreakWorker] olvas. A WebView saját localStorage-a natívan (WebView
 *    motorja nélkül) nem olvasható ki, ezért kell ez a külön, kis natív tükrözés -
 *    ugyanaz a minta, mint a HealthSyncStore/PendingNotificationStore esetén.
 */
class NotifyBridge(private val activity: ComponentActivity) {

    @JavascriptInterface
    fun notify(id: Int, title: String, body: String) {
        LocalNotifier.notify(activity.applicationContext, id, title, body)
    }

    @JavascriptInterface
    fun reportActivity(streakDays: Int, lastActiveDateIso: String) {
        RpgStore.saveActivity(activity.applicationContext, streakDays, lastActiveDateIso)
    }
}
