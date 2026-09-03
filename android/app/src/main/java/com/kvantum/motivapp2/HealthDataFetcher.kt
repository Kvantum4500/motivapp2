package com.kvantum.motivapp2

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.FloorsClimbedRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/**
 * Közös "mai" Health Connect lekérdezés és összegzés. Mind a kézi gombnyomásra
 * induló szinkron (HealthConnectBridge.syncToday), mind a WorkManager-es natív
 * háttér-szinkron (HealthSyncWorker) ezt hívja, hogy a két útvonal soha ne
 * térjen el egymástól.
 *
 * Minden mezőt önállóan, egymástól függetlenül próbál lekérni: ha egy adattípusra
 * nincs engedély, vagy a lekérdezése hibázik, az a többit nem akasztja meg — a
 * payload egyszerűen nem fogja tartalmazni azt a mezőt (a JS oldal ezt már eddig
 * is így kezelte, ld. index.html onAndroidHealthResult).
 */
object HealthDataFetcher {

    suspend fun fetchToday(client: HealthConnectClient): JSONObject {
        val result = JSONObject().put("type", "data")

        val granted = try {
            client.permissionController.getGrantedPermissions()
        } catch (e: Exception) {
            return JSONObject().apply {
                put("type", "error")
                put("message", "Hiba a Health Connect engedélyek lekérdezésekor.")
            }
        }

        val zone = ZoneId.systemDefault()
        val startOfDay = Instant.now().atZone(zone).toLocalDate().atStartOfDay(zone).toInstant()
        val now = Instant.now()
        val range = TimeRangeFilter.between(startOfDay, now)

        if (HealthPermission.getReadPermission(StepsRecord::class) in granted) {
            try {
                val steps = client.readRecords(ReadRecordsRequest(StepsRecord::class, range))
                    .records.sumOf { it.count }
                if (steps > 0) result.put("steps", steps)
            } catch (e: Exception) {
            }
        }

        if (HealthPermission.getReadPermission(SleepSessionRecord::class) in granted) {
            try {
                val minutes = client.readRecords(ReadRecordsRequest(SleepSessionRecord::class, range))
                    .records.sumOf { ChronoUnit.MINUTES.between(it.startTime, it.endTime) }
                // Rounded to one decimal place at the source (fix for the
                // "6.133333333333334 ó" display bug - index.html's fmtHealthNum()
                // already rounds defensively for display, but the stored/synced
                // value itself should be sane too, e.g. via getPendingBackgroundResult()
                // JSON round-tripping the raw value).
                if (minutes > 0) result.put("sleepH", Math.round(minutes / 60.0 * 10) / 10.0)
            } catch (e: Exception) {
            }
        }

        if (HealthPermission.getReadPermission(HeartRateRecord::class) in granted) {
            try {
                val lastSample = client.readRecords(ReadRecordsRequest(HeartRateRecord::class, range))
                    .records.flatMap { it.samples }
                    .maxByOrNull { it.time }
                if (lastSample != null) result.put("pulse", lastSample.beatsPerMinute)
            } catch (e: Exception) {
            }
        }

        // Megtett táv (km) — a "Térkép" nézet GPS-alapú túrakövetését egészíti ki
        // órán/telefonon mért, a Health Connectbe már beírt napi távolsággal.
        if (HealthPermission.getReadPermission(DistanceRecord::class) in granted) {
            try {
                val meters = client.readRecords(ReadRecordsRequest(DistanceRecord::class, range))
                    .records.sumOf { it.distance.inMeters }
                if (meters > 0) result.put("distanceKm", meters / 1000.0)
            } catch (e: Exception) {
            }
        }

        // Megmászott szintek (pl. lépcsőzés).
        if (HealthPermission.getReadPermission(FloorsClimbedRecord::class) in granted) {
            try {
                val floors = client.readRecords(ReadRecordsRequest(FloorsClimbedRecord::class, range))
                    .records.sumOf { it.floors }
                if (floors > 0) result.put("floorsClimbed", floors)
            } catch (e: Exception) {
            }
        }

        // Aktív (mozgással elégetett) kalória — szándékosan nem a "teljes" (alap-
        // anyagcserét is tartalmazó) változat, mert ez felel meg annak, amit a
        // felhasználó intuitívan "elégetett kalóriaként" ért egy adott napra.
        if (HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class) in granted) {
            try {
                val kcal = client.readRecords(ReadRecordsRequest(ActiveCaloriesBurnedRecord::class, range))
                    .records.sumOf { it.energy.inKilocalories }
                if (kcal > 0) result.put("caloriesBurned", kcal)
            } catch (e: Exception) {
            }
        }

        // Edzés-munkamenetek összesített időtartama (perc) — nem az app saját,
        // kézzel kategorizált edzésnaplójába (workouts) kerül, mert az izomcsoport-
        // alapú kategorizálást (category, muscleGroups) a Health Connect generikus
        // edzéstípusaiból nem lehetne megbízhatóan, találgatás nélkül leképezni;
        // emiatt ez egy önálló, csak összesített napi szám a healthLog bejegyzésben.
        if (HealthPermission.getReadPermission(ExerciseSessionRecord::class) in granted) {
            try {
                val minutes = client.readRecords(ReadRecordsRequest(ExerciseSessionRecord::class, range))
                    .records.sumOf { ChronoUnit.MINUTES.between(it.startTime, it.endTime) }
                if (minutes > 0) result.put("exerciseMin", minutes)
            } catch (e: Exception) {
            }
        }

        // Testsúly — a legutóbbi mai mérés, kg-ban; a JS oldal ezt nem a healthLog-ba,
        // hanem a meglévő weightLog-ba illeszti (ugyanaz a {date, kg} alak, mint a
        // kézi "Testsúly rögzítése" funkciónál).
        if (HealthPermission.getReadPermission(WeightRecord::class) in granted) {
            try {
                val lastWeight = client.readRecords(ReadRecordsRequest(WeightRecord::class, range))
                    .records.maxByOrNull { it.time }
                if (lastWeight != null) result.put("weightKg", lastWeight.weight.inKilograms)
            } catch (e: Exception) {
            }
        }

        return result
    }
}
