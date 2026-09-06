package com.kvantum.motivapp2

import android.content.Context
import androidx.core.content.ContextCompat
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.GoogleMap
import com.google.android.gms.maps.model.BitmapDescriptorFactory
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.LatLngBounds
import com.google.android.gms.maps.model.MarkerOptions
import com.google.android.gms.maps.model.PolylineOptions

/**
 * Megosztott "rajzold ki ezeket a túrákat egy GoogleMap-re" logika — kivonva
 * [JourneyMapActivity]-ből, hogy az embedded (index.html ÚTVONALAK al-fül) natív
 * térkép-overlay ([MapsBridge.showEmbeddedMap]) UGYANAZT a színpalettát/marker-logikát/
 * kamera-illesztést használja, egyetlen implementáció nélkül duplikálva. Tisztán
 * viselkedés-megőrző kivonás: a paletta-ciklikusság, a HUE_RED cél-marker, az
 * egy-pontos/több-pontos eset kezelése és a degenerált (majdnem nulla méretű) bounding
 * box tartalék-logikája bit-azonos azzal, ami korábban [JourneyMapActivity] saját
 * privát setupMap()/fitCameraToRoutes() függvényeiben volt.
 */
object MapRouteRenderer {

    private const val SINGLE_POINT_ZOOM = 15f
    private const val CAMERA_PADDING_PX = 96

    // Kb. 11 méter szélesség/magasság az egyenlítőnél - ennél kisebb doboz "gyakorlatilag
    // egyetlen pont"-nak számít a kamera-illesztés szempontjából.
    private const val MIN_BOUNDS_SPAN_DEGREES = 0.0001

    // Ugyanaz az 5 útvonal-szín, ugyanabban a sorrendben, mint a webes app
    // renderRouteSvg()-jének colors tömbje (index.html) - index szerint ciklikusan
    // választva, hogy több egyidejűleg mutatott túra vizuálisan megkülönböztethető
    // legyen, és a natív/webes nézet összhangban maradjon.
    private val ROUTE_COLORS = intArrayOf(
        R.color.journeyMapRoute1,
        R.color.journeyMapRoute2,
        R.color.journeyMapRoute3,
        R.color.journeyMapRoute4,
        R.color.journeyMapRoute5
    )

    // Kezdő (Rajt) marker árnyalat túránként, index szerint ciklikusan - a Cél marker
    // ezzel szemben MINDIG HUE_RED marad minden túránál (ld. drawJourneys), ugyanazt az
    // "piros = cél" mentális modellt követve, mint amit az SVG nézet tinta-színű
    // végpontja már megalapozott.
    private val START_MARKER_HUES = floatArrayOf(
        BitmapDescriptorFactory.HUE_GREEN,
        BitmapDescriptorFactory.HUE_YELLOW,
        BitmapDescriptorFactory.HUE_ORANGE,
        BitmapDescriptorFactory.HUE_AZURE,
        BitmapDescriptorFactory.HUE_VIOLET
    )

    /** Egy útvonal-szín/kezdőmarker-szín per bejegyzés, index szerint ciklikusan — ld.
     *  ROUTE_COLORS / START_MARKER_HUES. A végpont (Cél) mindenhol egységesen piros marad,
     *  ugyanaz a "piros = cél" szemantika, mint az SVG nézet tinta-színű végpontjánál. */
    fun drawJourneys(context: Context, map: GoogleMap, journeys: List<JourneyMapDataStore.JourneyEntry>) {
        journeys.forEachIndexed { index, entry ->
            val points = entry.points
            if (points.isEmpty()) return@forEachIndexed
            val routeColor = ContextCompat.getColor(context, ROUTE_COLORS[index % ROUTE_COLORS.size])
            if (points.size > 1) {
                map.addPolyline(
                    PolylineOptions()
                        .addAll(points)
                        .color(routeColor)
                        .width(8f)
                )
            }
            map.addMarker(
                MarkerOptions()
                    .position(points.first())
                    .title("Rajt")
                    .icon(BitmapDescriptorFactory.defaultMarker(START_MARKER_HUES[index % START_MARKER_HUES.size]))
            )
            if (points.size > 1) {
                map.addMarker(
                    MarkerOptions()
                        .position(points.last())
                        .title("Cél")
                        .icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_RED))
                )
            }
        }
    }

    fun fitCameraToRoutes(map: GoogleMap, points: List<LatLng>) {
        if (points.isEmpty()) return
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
            // véglegesen kimérve) - egyetlen útvonal se omlaszthassa össze a képernyőt.
            map.moveCamera(CameraUpdateFactory.newLatLngZoom(points.first(), SINGLE_POINT_ZOOM))
        }
    }
}
