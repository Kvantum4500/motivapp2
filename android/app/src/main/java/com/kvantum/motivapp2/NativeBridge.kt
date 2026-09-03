package com.kvantum.motivapp2

import android.webkit.WebView
import org.json.JSONObject

/**
 * Native-to-JS pipe for pending notification records, registered on the loaded page via
 * `webView.addJavascriptInterface(NativeBridge(this, webView), "NativeBridge")`.
 *
 * onBankNotification/onFoodoraNotification are driven from native code
 * (MainWebViewActivity, once it has found a pending record in
 * PendingNotificationStore) - they are NEVER called by the web page itself, so they are
 * deliberately NOT annotated @JavascriptInterface: that annotation would make them
 * reflectively callable BY arbitrary JS running in the WebView's currently-loaded origin,
 * letting it spoof a fake "bank notification" (attacker-chosen amount/text) into the
 * category-picker UI, and - as a side effect of the real handler's cleanup step - discard
 * a genuine pending record before the user ever sees it. Each one pushes the record into
 * the page by invoking the matching `window.onBankNotification` / `window.onFoodoraNotification`
 * JS global the web side implements (window.* function name intentionally matches this
 * class's method name), then clears the pending record so it is never delivered twice.
 */
class NativeBridge(private val activity: MainWebViewActivity, private val webView: WebView) {

    fun onBankNotification(amount: Double, rawText: String, sourcePackage: String) {
        activity.runOnUiThread {
            val script = "window.onBankNotification(" +
                "$amount, " +
                "${JSONObject.quote(rawText)}, " +
                "${JSONObject.quote(sourcePackage)})"
            webView.evaluateJavascript(script, null)
        }
        PendingNotificationStore.clearPendingBankRecord(activity.applicationContext)
    }

    fun onFoodoraNotification(amount: Double, rawText: String) {
        activity.runOnUiThread {
            val script = "window.onFoodoraNotification(" +
                "$amount, " +
                "${JSONObject.quote(rawText)})"
            webView.evaluateJavascript(script, null)
        }
        PendingNotificationStore.clearPendingFoodRecord(activity.applicationContext)
    }
}
