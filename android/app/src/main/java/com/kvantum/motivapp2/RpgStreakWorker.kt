package com.kvantum.motivapp2

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.time.LocalDate
import java.time.LocalTime

/**
 * WorkManager-ütemezésű, natív, a WebView/JS rétegtől teljesen független
 * időszakos ellenőrzés (ld. RpgStreakScheduler), ami a HealthSyncWorker mintáját
 * követi: akkor is lefut, ha az app be van zárva vagy a képernyő le van zárva.
 *
 * Célja: ha a felhasználó az Életkampányban (App.state.rpg) ma még nem szerzett
 * XP-t, és már este van, natív emlékeztetőt küld ("sorozat veszélyben"), mielőtt
 * a napi sorozat megszakadna. Az [RpgStore]-ban tárolt, a JS oldal által
 * [NotifyBridge.reportActivity] híváson keresztül frissített legutóbbi aktivitás-
 * dátumot olvassa - a WebView localStorage-át natívan, élő WebView nélkül nem
 * lehet közvetlenül kiolvasni, ezért kell ez a kis natív tükrözés.
 *
 * Ha a felhasználó még sosem használta az Életkampány funkciót (nincs eltárolt
 * aktivitás-dátum), szándékosan NEM küld emlékeztetőt - nem akarunk egy
 * ki sem próbált funkcióhoz értesítéssel zaklatni senkit.
 */
class RpgStreakWorker(appContext: Context, params: WorkerParameters) :
    Worker(appContext, params) {

    override fun doWork(): Result {
        val lastActive = RpgStore.lastActiveDate(applicationContext) ?: return Result.success()

        val today = LocalDate.now().toString()
        if (lastActive == today) return Result.success()

        val lastNotified = RpgStore.lastNotifiedDate(applicationContext)
        if (lastNotified == today) return Result.success()

        if (LocalTime.now().hour < EVENING_REMINDER_HOUR) return Result.success()

        val streak = RpgStore.streakDays(applicationContext)
        val body = if (streak > 0) {
            "Még nem szereztél XP-t ma - ne törd meg a(z) $streak hetes sorozatot!"
        } else {
            "Még nem szereztél XP-t ma az Életkampányban."
        }
        LocalNotifier.notify(applicationContext, NOTIFICATION_ID, "Életkampány", body)
        RpgStore.markNotified(applicationContext, today)
        return Result.success()
    }

    companion object {
        private const val NOTIFICATION_ID = 4301
        private const val EVENING_REMINDER_HOUR = 19
    }
}
