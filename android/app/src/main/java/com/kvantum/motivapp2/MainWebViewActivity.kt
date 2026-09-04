package com.kvantum.motivapp2

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.GeolocationPermissions
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebChromeClient.FileChooserParams
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

/**
 * The app's launcher entry point (replacing the Bubblewrap-generated LauncherActivity,
 * which still exists for its https deep-link / TWA intent-filter but is no longer the
 * launcher - see AndroidManifest.xml).
 *
 * Hosts a plain WebView loading the live MotivApp PWA and exposes [NativeBridge] to it
 * as `window.NativeBridge`, so notification-derived pending records written by
 * [NotificationForwarderService] can be handed to the web app; [HealthConnectBridge]
 * as `window.AndroidHealth` (Health Connect sync), [BackupBridge] as `window.AndroidBackup`
 * (native "save as" export), [TrackingBridge] as `window.AndroidTracking` (background
 * GPS tracking for the "Térkép" hike-tracking view) and [NotifyBridge] as
 * `window.AndroidNotify` (local notifications + native streak tracking for the
 * Életkampány/RPG feature) are wired the same way.
 *
 * Base class is androidx.activity.ComponentActivity, NOT plain android.app.Activity:
 * registerForActivityResult (used below for the geolocation prompt, the file chooser,
 * the POST_NOTIFICATIONS runtime permission, and by HealthConnectBridge/BackupBridge's
 * own permission/document-picker flows) is only available on ComponentActivity and its
 * subclasses. AppCompatActivity was deliberately NOT used: this app is a full-screen
 * WebView with no ActionBar/Toolbar or other AppCompat UI, and our manifest's
 * application theme (@android:style/Theme.Translucent.NoTitleBar, a raw platform theme)
 * is incompatible with AppCompatActivity's AppCompat theme machinery - that exact
 * combination crashed at startup in the separate reference project this Health
 * Connect/backup/tracking port is based on. Plain ComponentActivity avoids that crash
 * entirely while still providing registerForActivityResult.
 */
class MainWebViewActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var nativeBridge: NativeBridge
    private lateinit var healthConnectBridge: HealthConnectBridge

    private var pendingGeoOrigin: String? = null
    private var pendingGeoCallback: GeolocationPermissions.Callback? = null
    private var pendingFilePathCallback: ValueCallback<Array<Uri>>? = null

    private val locationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
            val granted = results[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
                results[Manifest.permission.ACCESS_COARSE_LOCATION] == true
            val origin = pendingGeoOrigin
            val callback = pendingGeoCallback
            pendingGeoOrigin = null
            pendingGeoCallback = null
            callback?.invoke(origin, granted, false)
        }

    // Backs the WebView's file chooser (see onShowFileChooser below) - without this,
    // the "Adatok importálása" button's <input type="file"> silently opens nothing in
    // the WebView, since plain WebView has no built-in file-picker UI of its own.
    private val getContentLauncher =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            val callback = pendingFilePathCallback
            pendingFilePathCallback = null
            callback?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
        }

    // Android 13+ (API 33) requires a runtime permission to post notifications -
    // without requesting it, native notifications (tracking's foreground-service
    // notification, and a future native-reminders feature) would silently never show.
    // We don't care about the result here: if denied, the relevant feature just
    // quietly skips notifying, it doesn't crash.
    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private val pendingNotificationReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            checkPendingNotifications()
        }
    }

    init {
        onBackPressedDispatcher.addCallback(this) {
            if (::webView.isInitialized && webView.canGoBack()) {
                webView.goBack()
            } else {
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

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
            // Needed for onGeolocationPermissionsShowPrompt (below) to ever fire at all -
            // WebView geolocation is off by default. Backs the web app's watchPosition
            // GPS tracking ("Térkép" view).
            setGeolocationEnabled(true)
            // allowFileAccess=false: this app only ever loads the live https:// PWA (see
            // LAUNCH_URL below), so it never needs general filesystem access from WebView
            // content (e.g. file:///sdcard/...). The file CHOOSER (input type="file",
            // handled natively via onShowFileChooser below) is unaffected by this setting.
            // Defense in depth: narrows the attack surface with no functional change.
            allowFileAccess = false
        }

        webView.webViewClient = object : WebViewClient() {
            // Deliberately overriding only the (WebView, String) overload rather than
            // the WebResourceRequest one added in API 24: the framework's default
            // WebResourceRequest overload just forwards to this one, so this single
            // override behaves correctly on every supported API level.
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                val uri = Uri.parse(url)
                // Host-only used to check here; kvantum4500.github.io is a GitHub Pages
                // user site that ALSO hosts a second, unrelated app (an RPG campaign
                // tracker) at a different path. A host-only check would let the WebView
                // navigate in-place to that other app's page too, exposing every
                // @JavascriptInterface bridge (bank data, Health Connect, backup, GPS
                // tracking) to content this app never intended to trust. Requiring the
                // /motivapp2/ path prefix scopes in-WebView navigation to this app only;
                // everything else still opens externally via the Intent below.
                val isOwnApp = uri.host == LAUNCH_HOST && (uri.path ?: "").startsWith(LAUNCH_PATH_PREFIX)
                return if (isOwnApp) {
                    false // let the WebView handle navigation within the app's own site
                } else {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    true
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            // Backs navigator.geolocation (watchPosition/getCurrentPosition) in the web
            // app's "Térkép" hike-tracking view. Without this override, the WebView's
            // default WebChromeClient silently denies every geolocation prompt.
            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: GeolocationPermissions.Callback?
            ) {
                if (origin == null || callback == null) return
                val fine = ContextCompat.checkSelfPermission(
                    this@MainWebViewActivity, Manifest.permission.ACCESS_FINE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED
                val coarse = ContextCompat.checkSelfPermission(
                    this@MainWebViewActivity, Manifest.permission.ACCESS_COARSE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED
                if (!fine && !coarse) {
                    pendingGeoOrigin = origin
                    pendingGeoCallback = callback
                    locationPermissionLauncher.launch(
                        arrayOf(
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION
                        )
                    )
                } else {
                    callback.invoke(origin, true, false)
                }
            }

            // Backs the "Adatok importálása" button's <input type="file"> - see
            // getContentLauncher above.
            override fun onShowFileChooser(
                view: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                // Only one still-pending request can exist at a time - if a previous one
                // was somehow left pending, close it out with an empty result before
                // starting the new one (this is the WebView's documented expectation).
                pendingFilePathCallback?.onReceiveValue(null)
                pendingFilePathCallback = filePathCallback
                val mimeType = fileChooserParams?.acceptTypes?.firstOrNull { it.isNotBlank() } ?: "*/*"
                return try {
                    getContentLauncher.launch(mimeType)
                    true
                } catch (e: Exception) {
                    pendingFilePathCallback = null
                    false
                }
            }
        }

        nativeBridge = NativeBridge(this, webView)
        webView.addJavascriptInterface(nativeBridge, "NativeBridge")

        healthConnectBridge = HealthConnectBridge(this, webView)
        webView.addJavascriptInterface(healthConnectBridge, "AndroidHealth")
        // Idempotent (ExistingPeriodicWorkPolicy.KEEP): a no-op if already scheduled.
        // HealthSyncWorker itself checks at run time whether Health Connect permission
        // has even been granted - without it, it silently returns - so this is safe to
        // call unconditionally on every app start, regardless of permission state.
        HealthSyncScheduler.schedule(applicationContext)

        webView.addJavascriptInterface(BackupBridge(this), "AndroidBackup")
        webView.addJavascriptInterface(TrackingBridge(this), "AndroidTracking")

        webView.addJavascriptInterface(NotifyBridge(this), "AndroidNotify")
        // Idempotent (ExistingPeriodicWorkPolicy.KEEP), same reasoning as
        // HealthSyncScheduler.schedule above - safe to call unconditionally on every
        // app start; RpgStreakWorker itself no-ops if the RPG feature was never used.
        RpgStreakScheduler.schedule(applicationContext)

        webView.loadUrl(LAUNCH_URL)

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

    override fun onDestroy() {
        healthConnectBridge.cancel()
        super.onDestroy()
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
        private const val LAUNCH_PATH_PREFIX = "/motivapp2/"
        private const val LAUNCH_URL = "https://kvantum4500.github.io/motivapp2/index.html"
    }
}
