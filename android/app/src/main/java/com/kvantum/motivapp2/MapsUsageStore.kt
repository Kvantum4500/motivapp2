package com.kvantum.motivapp2

import android.content.Context
import android.content.SharedPreferences
import java.time.YearMonth
import kotlin.math.roundToInt

/**
 * Kis, nem érzékeny (csak egy hónap-kulcs string és két egész szám) natív tároló a
 * [JourneyMapActivity] saját, ÖNMAGA által számolt havi térkép-betöltési "költségvetéséhez".
 *
 * Szándékosan NEM a Google Cloud valódi számlázási API-ját kérdezzük le — ahhoz privilegizált
 * service-account hitelesítő adatokat kellene az appba ágyazni (komoly titokkiszivárgási
 * kockázat), és a valós használat 24-48 órát is késhet a tényleges betöltésekhez képest. Ehelyett
 * az app a SAJÁT betöltéseit számolja egy a felhasználó által beállított havi keret ellenében —
 * ez a keret a felhasználó saját Google Cloud Console-jában beállított biztonsági határnak felel
 * meg, amit ő maga hangol a [JourneyMapActivity] beállítás-dialógusában.
 *
 * A [BUDGET_LOADS_DEFAULT] alapérték NEM a Google jelenlegi valós ingyenes kvótáját/árazását
 * próbálja találgatni vagy tükrözni — csak egy óvatos kiinduló érték, amit a felhasználó a saját
 * költségvetéséhez kell hogy hangoljon.
 *
 * Sima (nem titkosított) SharedPreferences, ugyanúgy, mint az [RpgStore]-nál — az itt tárolt
 * adat (egy hónap-string és két szám) nem indokolja az EncryptedSharedPreferences többletköltségét.
 */
object MapsUsageStore {
    private const val PREFS_FILE_NAME = "motivapp2_maps_usage"
    private const val KEY_MONTH_KEY = "month_key"
    private const val KEY_LOAD_COUNT = "load_count"
    private const val KEY_BUDGET_LOADS = "budget_loads"
    private const val KEY_UNLOCKED_MONTH_KEY = "unlocked_month_key"

    // Lásd a fenti osztály-doksit: csak egy óvatos kiinduló érték, nem a Google valódi
    // árazásának/kvótájának tükrözése — a felhasználó a beállítás-dialógusban hangolja.
    private const val BUDGET_LOADS_DEFAULT = 1000

    data class Usage(
        val loadCount: Int,
        val budgetLoads: Int,
        val remainingPct: Int,
        val locked: Boolean
    )

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_FILE_NAME, Context.MODE_PRIVATE)

    private fun currentMonthKey(): String = YearMonth.now().toString()

    /** Ha a tárolt hónap-kulcs eltér a jelenlegitől, az új hónap mindig 0 betöltéssel indul —
     *  ezt itt, olvasás/írás előtt igazítjuk, külön "reset" logika nélkül. Az unlockedMonthKey-t
     *  nem kell explicit törölni: a getUsage() úgyis csak a JELENLEGI hónap kulcsával hasonlítja
     *  össze, tehát egy előző hónapra szóló feloldás magától érvénytelenné válik. */
    private fun rolloverIfNewMonth(p: SharedPreferences): String {
        val nowKey = currentMonthKey()
        val storedKey = p.getString(KEY_MONTH_KEY, null)
        if (storedKey != nowKey) {
            p.edit()
                .putString(KEY_MONTH_KEY, nowKey)
                .putInt(KEY_LOAD_COUNT, 0)
                .apply()
        }
        return nowKey
    }

    @Synchronized
    fun getUsage(context: Context): Usage {
        val p = prefs(context)
        rolloverIfNewMonth(p)
        val nowKey = currentMonthKey()
        val loadCount = p.getInt(KEY_LOAD_COUNT, 0)
        val budgetLoads = p.getInt(KEY_BUDGET_LOADS, BUDGET_LOADS_DEFAULT)
        val remainingPct = if (budgetLoads <= 0) {
            0
        } else {
            val pct = ((budgetLoads - loadCount) / budgetLoads.toDouble() * 100).roundToInt()
            pct.coerceAtLeast(0)
        }
        val unlockedThisMonth = p.getString(KEY_UNLOCKED_MONTH_KEY, null) == nowKey
        val locked = remainingPct <= 5 && !unlockedThisMonth
        return Usage(loadCount = loadCount, budgetLoads = budgetLoads, remainingPct = remainingPct, locked = locked)
    }

    @Synchronized
    fun recordLoad(context: Context) {
        val p = prefs(context)
        rolloverIfNewMonth(p)
        val loadCount = p.getInt(KEY_LOAD_COUNT, 0)
        p.edit().putInt(KEY_LOAD_COUNT, loadCount + 1).apply()
    }

    @Synchronized
    fun setBudget(context: Context, newBudget: Int) {
        if (newBudget <= 0) return
        prefs(context).edit().putInt(KEY_BUDGET_LOADS, newBudget).apply()
    }

    @Synchronized
    fun unlockForRestOfMonth(context: Context) {
        val p = prefs(context)
        rolloverIfNewMonth(p)
        p.edit().putString(KEY_UNLOCKED_MONTH_KEY, currentMonthKey()).apply()
    }
}
