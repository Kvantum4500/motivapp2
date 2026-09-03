package com.kvantum.motivapp2

import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.FloorsClimbedRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * JS <-> natív híd a WebView-nak. A szerződés (window.AndroidHealth.*, valamint a
 * window.onAndroidHealthResult válasz-callback) az index.html-ben van dokumentálva,
 * és NEM változott — a getPendingBackgroundResult() egy kiegészítés hozzá, a
 * WorkManager-es natív háttér-szinkron (HealthSyncWorker) eredményének átadására.
 */
class HealthConnectBridge(
    private val activity: ComponentActivity,
    private val webView: WebView
) {

    private val scope = CoroutineScope(Dispatchers.Main + Job())

    private val stepsPermission = HealthPermission.getReadPermission(StepsRecord::class)
    private val sleepPermission = HealthPermission.getReadPermission(SleepSessionRecord::class)
    private val heartRatePermission = HealthPermission.getReadPermission(HeartRateRecord::class)
    private val distancePermission = HealthPermission.getReadPermission(DistanceRecord::class)
    private val floorsPermission = HealthPermission.getReadPermission(FloorsClimbedRecord::class)
    private val activeCaloriesPermission = HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class)
    private val exercisePermission = HealthPermission.getReadPermission(ExerciseSessionRecord::class)
    private val weightPermission = HealthPermission.getReadPermission(WeightRecord::class)

    // Mindet egyszerre kérjük a rendszer engedélykérő ablakában — a felhasználó ott
    // egyenként ki/be tud kapcsolni típusokat, a HealthDataFetcher pedig típusonként
    // önállóan ellenőrzi a tényleges engedélyt, tehát részleges megadás is jól működik.
    private val readPermissions = setOf(
        stepsPermission, sleepPermission, heartRatePermission,
        distancePermission, floorsPermission, activeCaloriesPermission,
        exercisePermission, weightPermission
    )
    // Csak ez a kettő számít bele a JS felé jelzett "granted" sikeresség-jelzőbe —
    // ez marad a UI szempontjából "alap" engedély, a többi opcionális kiegészítés.
    private val requiredPermissions = setOf(stepsPermission, sleepPermission)

    private val permissionLauncher = activity.registerForActivityResult(
        PermissionController.createRequestPermissionResultContract()
    ) { granted ->
        val ok = granted.containsAll(requiredPermissions)
        sendResult(JSONObject().apply {
            put("type", "permissions")
            put("granted", ok)
            put(
                "message",
                if (ok) "Health Connect engedélyek megadva."
                else "A lépés- és/vagy alvás-engedély megtagadva vagy csak részben adott."
            )
        })
        // A WorkManager periodikus munkája már úgyis ütemezve van (ld.
        // MainActivity.onCreate -> HealthSyncScheduler.schedule), de az első natív
        // háttér-frissítésre nem kell 15 percet várni: engedélyezés után rögtön
        // szinkronizálunk is a meglévő (WebView-t frissítő) útvonalon.
        if (ok) syncToday()
    }

    private fun clientOrNull(): HealthConnectClient? = try {
        if (HealthConnectClient.getSdkStatus(activity) == HealthConnectClient.SDK_AVAILABLE) {
            HealthConnectClient.getOrCreate(activity)
        } else null
    } catch (e: Exception) {
        null
    }

    @JavascriptInterface
    fun isAvailable(): Boolean {
        val available = try {
            HealthConnectClient.getSdkStatus(activity) == HealthConnectClient.SDK_AVAILABLE
        } catch (e: Exception) {
            false
        }
        sendResult(JSONObject().apply {
            put("type", "availability")
            put("available", available)
            put(
                "message",
                if (available) "Health Connect elérhető."
                else "Health Connect nincs telepítve vagy nem elérhető ezen az eszközön."
            )
        })
        return available
    }

    @JavascriptInterface
    fun requestPermissions() {
        if (clientOrNull() != null) {
            permissionLauncher.launch(readPermissions)
        } else {
            sendResult(errorJson("A Health Connect nincs telepítve vagy nem elérhető ezen az eszközön."))
        }
    }

    @JavascriptInterface
    fun syncToday() {
        val client = clientOrNull()
        if (client == null) {
            sendResult(errorJson("A Health Connect nincs telepítve vagy nem elérhető ezen az eszközön."))
            return
        }
        scope.launch {
            sendResult(HealthDataFetcher.fetchToday(client))
        }
    }

    /** A HealthSyncWorker (WorkManager, natív háttér-szinkron) által esetlegesen már
     *  lekért, még fel nem dolgozott legutóbbi eredményt adja vissza JSON stringként
     *  (vagy null-t, ha nincs ilyen), és egyúttal törli, hogy ugyanazt kétszer ne
     *  dolgozza fel a JS oldal. */
    @JavascriptInterface
    fun getPendingBackgroundResult(): String? = HealthSyncStore.takePendingResultJson(activity)

    fun cancel() {
        scope.coroutineContext[Job]?.cancel()
    }

    private fun errorJson(message: String) = JSONObject().apply {
        put("type", "error")
        put("message", message)
    }

    private fun sendResult(json: JSONObject) {
        activity.runOnUiThread {
            webView.evaluateJavascript("window.onAndroidHealthResult($json);", null)
        }
    }
}
