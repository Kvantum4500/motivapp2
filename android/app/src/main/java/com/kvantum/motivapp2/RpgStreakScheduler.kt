package com.kvantum.motivapp2

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Beütemezi az RpgStreakWorker-t óránként - gyakoribb, mint a HealthSyncScheduler
 * 15 perces Health Connect szinkronja, mert itt nem az adat frissessége a cél
 * (egy dátum + egy számláló), hanem hogy a napi este ~19 órás emlékeztető-ablakot
 * (RpgStreakWorker.EVENING_REMINDER_HOUR) elég sűrűn ellenőrizzük ahhoz, hogy a
 * WorkManager ütemezési bizonytalansága (Doze, battery optimization) mellett is
 * ténylegesen elinduljon aznap. Az enqueueUniquePeriodicWork(..., KEEP, ...)
 * idempotens: ha már ütemezve van, a hívás no-op, tehát bátran hívható minden
 * app-induláskor (ld. MainWebViewActivity).
 */
object RpgStreakScheduler {
    private const val UNIQUE_WORK_NAME = "rpg_streak_check"

    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<RpgStreakWorker>(1, TimeUnit.HOURS)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.NOT_REQUIRED)
                    .build()
            )
            .build()

        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            UNIQUE_WORK_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            request
        )
    }
}
