package com.kvantum.motivapp2

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Beütemezi a HealthSyncWorker-t 15 percenként (ez a WorkManager rendszerszintű
 * minimuma periodikus munkára — ennél gyakoribbat maga az Android nem enged).
 * Az enqueueUniquePeriodicWork(..., KEEP, ...) idempotens: ha már ütemezve van,
 * a hívás no-op, tehát bátran hívható minden app-induláskor (ld. MainActivity).
 */
object HealthSyncScheduler {
    private const val UNIQUE_WORK_NAME = "health_connect_periodic_sync"

    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<HealthSyncWorker>(15, TimeUnit.MINUTES)
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
