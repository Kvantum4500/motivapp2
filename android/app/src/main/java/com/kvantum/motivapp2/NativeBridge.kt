package com.kvantum.motivapp2

import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject

/**
 * Native-to-JS pipe for pending notification records, registered on the loaded page via
 * `webView.addJavascriptInterface(NativeBridge(this, webView), "NativeBridge")`.
 *
 * onBankNotifications/onFoodoraNotifications are driven from native code
 * (MainWebViewActivity, once it has found queued records in PendingNotificationStore) -
 * they are NEVER called by the web page itself, so they are deliberately NOT annotated
 * @JavascriptInterface: that annotation would make them reflectively callable BY
 * arbitrary JS running in the WebView's currently-loaded origin, letting it spoof a fake
 * "bank notification" (attacker-chosen amount/text) into the category-picker UI. Each one
 * pushes the FULL current queue for its type into the page in one call, as a JSON array,
 * by invoking the matching `window.onBankNotifications` / `window.onFoodoraNotifications`
 * JS global the web side implements (window.* function name intentionally matches this
 * class's method name, pluralized to make the native<->JS contract change from the old
 * single-record `window.onBankNotification`/`window.onFoodoraNotification` calls
 * unmistakable rather than silently colliding with them).
 *
 * Unlike the old single-record version, records are deliberately NOT cleared from
 * PendingNotificationStore here - only once the web page tells native (via
 * [acknowledgeBankNotification]/[acknowledgeFoodoraNotification] below) that the user has
 * actually acted on one (confirmed OR explicitly dismissed its confirmation sheet), so
 * that killing the app mid-review never silently loses a record still awaiting a
 * decision - see PendingNotificationStore's class doc comment.
 */
class NativeBridge(private val activity: MainWebViewActivity, private val webView: WebView) {

    fun onBankNotifications(records: List<PendingNotificationStore.PendingRecord>) {
        if (records.isEmpty()) return
        val json = recordsToJson(records)
        activity.runOnUiThread {
            val script = "window.onBankNotifications(${JSONObject.quote(json)})"
            webView.evaluateJavascript(script, null)
        }
    }

    fun onFoodoraNotifications(records: List<PendingNotificationStore.PendingRecord>) {
        if (records.isEmpty()) return
        val json = recordsToJson(records)
        activity.runOnUiThread {
            val script = "window.onFoodoraNotifications(${JSONObject.quote(json)})"
            webView.evaluateJavascript(script, null)
        }
    }

    private fun recordsToJson(records: List<PendingNotificationStore.PendingRecord>): String {
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

    /** JS -> native acknowledgement that the user has actually acted (confirmed OR
     * explicitly dismissed) on one queued bank record, identified by the [postTime] it
     * was originally delivered with in [onBankNotifications] - see this class's and
     * PendingNotificationStore's doc comments.
     *
     * Deliberately IS @JavascriptInterface, unlike [onBankNotifications] above: that one
     * is native-driven and pushes data INTO the page, so making it reflectively callable
     * would let page JS spoof fake notification data. This direction is the opposite -
     * page JS telling native "I'm done with the record you already gave me, identified by
     * an id you already handed me" - and can only ever REMOVE an already-delivered record
     * from the native queue. Worst case a compromised/malicious page calls this early and
     * makes a real pending record disappear before the user reviews it (a self-inflicted
     * nuisance on the compromised page); it can never inject or alter any amount/category
     * into App.state.finance, since that only ever happens via the page's own explicit
     * saveBankNotification()/saveFoodoraOrder() plus the user's "Mentés" tap. */
    @JavascriptInterface
    fun acknowledgeBankNotification(postTime: Long) {
        PendingNotificationStore.removePendingBankRecord(activity.applicationContext, postTime)
    }

    /** Same as [acknowledgeBankNotification] but for the food (Foodora) queue. */
    @JavascriptInterface
    fun acknowledgeFoodoraNotification(postTime: Long) {
        PendingNotificationStore.removePendingFoodRecord(activity.applicationContext, postTime)
    }
}
