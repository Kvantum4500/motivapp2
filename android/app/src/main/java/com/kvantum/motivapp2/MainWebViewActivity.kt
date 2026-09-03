package com.kvantum.motivapp2

import android.annotation.SuppressLint
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * The app's launcher entry point (replacing the Bubblewrap-generated LauncherActivity,
 * which still exists for its https deep-link / TWA intent-filter but is no longer the
 * launcher - see AndroidManifest.xml).
 *
 * Hosts a plain WebView loading the live MotivApp PWA and exposes [NativeBridge] to it
 * as `window.NativeBridge`, so notification-derived pending records written by
 * [NotificationForwarderService] can be handed to the web app.
 */
class MainWebViewActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var nativeBridge: NativeBridge

    private val pendingNotificationReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            checkPendingNotifications()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        // Standard sane settings for a PWA: JS + DOM storage so localStorage (the API
        // key, MotivAI state, draft autosave) and the sw.js service worker registration
        // this page already relies on work the same way they do in a full browser.
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
        }

        webView.webViewClient = object : WebViewClient() {
            // Deliberately overriding only the (WebView, String) overload rather than
            // the WebResourceRequest one added in API 24: minSdkVersion is 21, and the
            // framework's default WebResourceRequest overload just forwards to this one,
            // so this single override behaves correctly on every supported API level.
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                val uri = Uri.parse(url)
                return if (uri.host == LAUNCH_HOST) {
                    false // let the WebView handle navigation within the app's own site
                } else {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    true
                }
            }
        }
        webView.webChromeClient = WebChromeClient()

        nativeBridge = NativeBridge(this, webView)
        webView.addJavascriptInterface(nativeBridge, "NativeBridge")

        if (savedInstanceState == null) {
            webView.loadUrl(LAUNCH_URL)
        }

        // In case a notification arrived while the app wasn't running at all.
        checkPendingNotifications()
    }

    override fun onResume() {
        super.onResume()
        val filter = IntentFilter(NotificationForwarderService.ACTION_PENDING_NOTIFICATION_UPDATED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(pendingNotificationReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(pendingNotificationReceiver, filter)
        }
        // In case a notification arrived while the app was backgrounded (but still alive).
        checkPendingNotifications()
    }

    override fun onPause() {
        super.onPause()
        try {
            unregisterReceiver(pendingNotificationReceiver)
        } catch (e: IllegalArgumentException) {
            // Receiver wasn't registered - onResume/onPause can be unbalanced across
            // fast activity re-creation; safe to ignore.
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    /** Called on the UI thread from onCreate/onResume and from
     * [pendingNotificationReceiver] (a foregrounded app gets notified promptly of a
     * new pending record via the broadcast NotificationForwarderService sends). */
    private fun checkPendingNotifications() {
        PendingNotificationStore.getPendingBankRecord(applicationContext)?.let { record ->
            nativeBridge.onBankNotification(record.amount, record.rawText, record.sourcePackage)
        }
        PendingNotificationStore.getPendingFoodRecord(applicationContext)?.let { record ->
            nativeBridge.onFoodoraNotification(record.amount, record.rawText)
        }
    }

    companion object {
        private const val LAUNCH_HOST = "kvantum4500.github.io"
        private const val LAUNCH_URL = "https://kvantum4500.github.io/motivapp2/index.html"
    }
}
