package com.kvantum.motivapp2

import android.app.AlertDialog
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.GoogleMap
import com.google.android.gms.maps.SupportMapFragment
import com.google.android.gms.maps.model.BitmapDescriptorFactory
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.LatLngBounds
import com.google.android.gms.maps.model.MarkerOptions
import com.google.android.gms.maps.model.PolylineOptions

/**
 * Natív, valódi térképcsempéken (Google Maps) rajzolt túra-nézet - a webes app
 * (index.html) meglévő renderRouteSvg()-alapú SVG útvonalnézetét NEM helyettesíti,
 * csak kiegészíti: az mindig, hálózat/API-kulcs nélkül is elérhető marad, ez a
 * képernyő csak a natív Android appban, window.AndroidMaps.openJourneyMap()-en
 * keresztül nyílik meg (ld. MapsBridge.kt).
 *
 * A [JourneyMapDataStore]-ból olvassa ki a megjelenítendő túra pontjait/nevét, majd a
 * [MapsUsageStore] önmaga által számolt havi térkép-betöltési keretét ellenőrzi: ha a
 * keret 5% alá csökkent és a felhasználó ebben a hónapban még nem oldotta fel kézzel,
 * egy teljes képernyős "lezárt" állapotot mutat a térkép helyett (a SupportMapFragment
 * ekkor egyáltalán nem jön létre - egyetlen csempekérés/betöltés sem történik). A
 * tényleges betöltést csak a sikeres térkép-renderelés UTÁN, a GoogleMap
 * setOnMapLoadedCallback-jában számoljuk el ([MapsUsageStore.recordLoad]).
 *
 * Base class: androidx.fragment.app.FragmentActivity, NEM plain androidx.activity.
 * ComponentActivity (mint a MainWebViewActivity) és NEM AppCompatActivity. Ennek a
 * képernyőnek Fragment-et kell tudnia hosztolni (a Maps SDK SupportMapFragment-je csak
 * androidx.fragment.app.FragmentManager-en keresztül csatolható - getMapAsync az egyetlen
 * dokumentált belépési pont), ehhez pedig getSupportFragmentManager() kell, ami plain
 * ComponentActivity-n nem létezik. FragmentActivity ugyanakkor MAGA IS egy
 * androidx.activity.ComponentActivity leszármazott (1.2.0 óta), tehát megtartja
 * ugyanazt a registerForActivityResult-alapú API-t, és - ellentétben
 * AppCompatActivity-vel - nem igényel Theme.AppCompat-ot: nem alkalmaz semmilyen saját
 * AppCompat-delegáltat/téma-ellenőrzést, tehát ez a raw platform téma
 * (Theme.Translucent.NoTitleBar) alatt is biztonságos, ugyanúgy, ahogy a
 * MainWebViewActivity dokumentációja leírja az AppCompatActivite-vel kapcsolatos
 * összeomlást - az ott leírt konkrét ütközés (AppCompat téma-gépezet) itt nem áll fenn.
 */
class JourneyMapActivity : FragmentActivity() {

    private var pendingJourney: JourneyMapDataStore.PendingJourney? = null

    private lateinit var topOverlay: LinearLayout
    private lateinit var journeyNameText: TextView
    private lateinit var usageBarFill: View
    private lateinit var usagePctText: TextView
    private lateinit var lockedOverlay: LinearLayout
    private lateinit var lockedMessage: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_journey_map)

        val journey = JourneyMapDataStore.readPending(this)
        if (journey == null) {
            Toast.makeText(this, R.string.journeyMapNoJourney, Toast.LENGTH_SHORT).show()
            finish()
            return
        }
        pendingJourney = journey

        topOverlay = findViewById(R.id.top_overlay)
        journeyNameText = findViewById(R.id.journey_name_text)
        usageBarFill = findViewById(R.id.usage_bar_fill)
        usagePctText = findViewById(R.id.usage_pct_text)
        lockedOverlay = findViewById(R.id.locked_overlay)
        lockedMessage = findViewById(R.id.locked_message)

        journeyNameText.text = journey.name

        findViewById<ImageButton>(R.id.close_button).setOnClickListener { finish() }
        findViewById<ImageButton>(R.id.settings_button).setOnClickListener { showBudgetDialog() }
        findViewById<Button>(R.id.unlock_button).setOnClickListener { confirmUnlock() }
        findViewById<Button>(R.id.locked_close_button).setOnClickListener { finish() }

        checkAccessAndProceed()
    }

    /** Minden belépéskor (első betöltés, feloldás után) újra lefut - ez dönti el,
     *  a lezárt állapotot vagy a térképet mutassuk. */
    private fun checkAccessAndProceed() {
        val usage = MapsUsageStore.getUsage(this)
        if (usage.locked) {
            showLockedState(usage)
        } else {
            showMapState(usage)
        }
    }

    private fun showLockedState(usage: MapsUsageStore.Usage) {
        topOverlay.visibility = View.GONE
        lockedOverlay.visibility = View.VISIBLE
        lockedMessage.text = getString(R.string.journeyMapLockedMessageFormat, usage.loadCount, usage.budgetLoads)
    }

    private fun confirmUnlock() {
        AlertDialog.Builder(this)
            .setMessage(R.string.journeyMapUnlockConfirmMessage)
            .setPositiveButton(R.string.journeyMapUnlockConfirmYes) { _, _ ->
                MapsUsageStore.unlockForRestOfMonth(this)
                // Ugyanaz az ellenőrzés fut le újra - most már át fog engedni, hiszen a
                // feloldás erre a hónapra szól.
                checkAccessAndProceed()
            }
            .setNegativeButton(R.string.journeyMapUnlockConfirmNo, null)
            .show()
    }

    private fun showMapState(usage: MapsUsageStore.Usage) {
        lockedOverlay.visibility = View.GONE
        topOverlay.visibility = View.VISIBLE
        updateUsageBar(usage)

        val points = pendingJourney?.points ?: return
        if (points.isEmpty()) return

        val existing = supportFragmentManager.findFragmentById(R.id.map_container) as? SupportMapFragment
        val mapFragment = existing ?: SupportMapFragment.newInstance().also { fragment ->
            supportFragmentManager.beginTransaction()
                .replace(R.id.map_container, fragment)
                .commitNow()
        }
        mapFragment.getMapAsync { googleMap -> setupMap(googleMap, points) }
    }

    private fun setupMap(map: GoogleMap, points: List<LatLng>) {
        if (points.size > 1) {
            map.addPolyline(
                PolylineOptions()
                    .addAll(points)
                    .color(ContextCompat.getColor(this, R.color.journeyMapGold))
                    .width(8f)
            )
        }
        map.addMarker(
            MarkerOptions()
                .position(points.first())
                .title("Rajt")
                .icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_GREEN))
        )
        if (points.size > 1) {
            map.addMarker(
                MarkerOptions()
                    .position(points.last())
                    .title("Cél")
                    .icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_RED))
            )
        }

        // Csak a SIKERES renderelés (csempék ténylegesen betöltve) UTÁN számoljuk el a
        // betöltést - ez az egyetlen pillanat, ami valóban megfelel annak, hogy
        // "renderáltunk egy térképet".
        map.setOnMapLoadedCallback {
            fitCameraToRoute(map, points)
            MapsUsageStore.recordLoad(this)
            refreshUsageBar()
        }
    }

    private fun fitCameraToRoute(map: GoogleMap, points: List<LatLng>) {
        if (points.size <= 1) {
            map.moveCamera(CameraUpdateFactory.newLatLngZoom(points.first(), SINGLE_POINT_ZOOM))
            return
        }
        var minLat = 90.0
        var maxLat = -90.0
        var minLng = 180.0
        var maxLng = -180.0
        points.forEach { p ->
            if (p.latitude < minLat) minLat = p.latitude
            if (p.latitude > maxLat) maxLat = p.latitude
            if (p.longitude < minLng) minLng = p.longitude
            if (p.longitude > maxLng) maxLng = p.longitude
        }
        val latSpan = maxLat - minLat
        val lngSpan = maxLng - minLng
        // Nagyon apró (pl. álló helyben GPS-zajból adódó) útvonal-doboz egyes Maps SDK
        // verziókon elhasalhat a newLatLngBounds hívásban (nulla/majdnem-nulla méretű
        // bounds) - ilyenkor egyszerű pont+zoom kamera-mozgásra váltunk.
        if (latSpan < MIN_BOUNDS_SPAN_DEGREES && lngSpan < MIN_BOUNDS_SPAN_DEGREES) {
            val center = LatLng((minLat + maxLat) / 2, (minLng + maxLng) / 2)
            map.moveCamera(CameraUpdateFactory.newLatLngZoom(center, SINGLE_POINT_ZOOM))
            return
        }
        try {
            val bounds = LatLngBounds.Builder().apply { points.forEach { include(it) } }.build()
            map.animateCamera(CameraUpdateFactory.newLatLngBounds(bounds, CAMERA_PADDING_PX))
        } catch (e: Exception) {
            // Védekező tartalék, ha az SDK mégis elhasal (pl. a térkép nézete még nincs
            // véglegesen kimérve) - egy útvonal se omlaszthassa össze a képernyőt.
            map.moveCamera(CameraUpdateFactory.newLatLngZoom(points.first(), SINGLE_POINT_ZOOM))
        }
    }

    private fun showBudgetDialog() {
        val usage = MapsUsageStore.getUsage(this)
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER
            setText(usage.budgetLoads.toString())
            setSelection(text.length)
        }
        val paddingPx = (16 * resources.displayMetrics.density).toInt()
        val container = LinearLayout(this).apply {
            setPadding(paddingPx, paddingPx / 2, paddingPx, 0)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.journeyMapBudgetDialogTitle)
            .setView(container)
            .setPositiveButton(R.string.journeyMapBudgetSave) { _, _ ->
                input.text.toString().toIntOrNull()?.let { newBudget ->
                    MapsUsageStore.setBudget(this, newBudget)
                }
                refreshUsageBar()
            }
            .setNegativeButton(R.string.journeyMapBudgetCancel, null)
            .show()
    }

    private fun refreshUsageBar() {
        updateUsageBar(MapsUsageStore.getUsage(this))
    }

    private fun updateUsageBar(usage: MapsUsageStore.Usage) {
        usagePctText.text = "${usage.loadCount}/${usage.budgetLoads} betöltés ebben a hónapban · ${usage.remainingPct}% keret maradt"
        usageBarFill.post {
            val track = usageBarFill.parent as? View ?: return@post
            val trackWidth = track.width
            if (trackWidth <= 0) return@post
            val usedFraction = if (usage.budgetLoads > 0) {
                (usage.loadCount.toDouble() / usage.budgetLoads).coerceIn(0.0, 1.0)
            } else 1.0
            val params = usageBarFill.layoutParams
            params.width = (trackWidth * usedFraction).toInt().coerceAtLeast(0)
            usageBarFill.layoutParams = params
        }
    }

    companion object {
        private const val SINGLE_POINT_ZOOM = 15f
        private const val CAMERA_PADDING_PX = 96
        // Kb. 11 méter szélesség/magasság az egyenlítőnél - ennél kisebb doboz "gyakorlatilag
        // egyetlen pont"-nak számít a kamera-illesztés szempontjából.
        private const val MIN_BOUNDS_SPAN_DEGREES = 0.0001
    }
}
