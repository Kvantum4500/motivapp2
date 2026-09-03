package com.kvantum.motivapp2

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * WorkManager-ütemezésű, natív, a WebView/JS rétegtől teljesen független
 * időszakos Health Connect lekérdezés (ld. HealthSyncScheduler). Akkor is
 * lefut, ha az app be van zárva vagy a képernyő le van zárva — ez a valódi
 * natív háttér-worker, amit a korábbi, csak-WebView-alapú megoldás nem tudott
 * adni (az ugyanis csak addig szinkronizált, amíg az app ténylegesen nyitva volt).
 *
 * Az eredményt natívan (HealthSyncStore, SharedPreferences) teszi el, mert a
 * WebView localStorage-át élő WebView nélkül nem biztonságos/támogatott
 * közvetlenül módosítani; a JS oldal a következő megnyitáskor olvassa ki.
 */
class HealthSyncWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val client = try {
            if (HealthConnectClient.getSdkStatus(applicationContext) != HealthConnectClient.SDK_AVAILABLE) {
                // Nincs telepítve / nem elérhető Health Connect ezen az eszközön —
                // ez nem hiba, csak nincs mit tenni, sikeresként zárjuk le a futást.
                return Result.success()
            }
            HealthConnectClient.getOrCreate(applicationContext)
        } catch (e: Exception) {
            return Result.retry()
        }

        val payload = HealthDataFetcher.fetchToday(client)
        if (payload.optString("type") == "error") return Result.retry()

        HealthSyncStore.saveResult(applicationContext, payload)
        return Result.success()
    }
}
