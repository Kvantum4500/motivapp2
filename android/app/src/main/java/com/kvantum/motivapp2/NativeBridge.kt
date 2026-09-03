package com.kvantum.motivapp2

import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/**
 * JS bridge registered on the loaded page via
 * `webView.addJavascriptInterface(NativeBridge(this, webView), "NativeBridge")`.
 *
 * onBankNotification/onFoodoraNotification are driven from native code
 * (MainWebViewActivity, once it has found a pending record in
 * PendingNotificationStore) rather than being called by the web page itself. Each one
 * pushes the record into the page by invoking the matching `window.onBankNotification` /
 * `window.onFoodoraNotification` JS global the web side implements
 * (window.* function name intentionally matches this class's method name), then clears
 * the pending record so it is never delivered twice.
 */
class NativeBridge(private val activity: MainWebViewActivity, private val webView: WebView) {

    @JavascriptInterface
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

    @JavascriptInterface
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
