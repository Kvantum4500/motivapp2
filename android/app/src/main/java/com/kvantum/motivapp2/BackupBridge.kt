package com.kvantum.motivapp2

import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

/**
 * JS <-> natív híd a Beállítások nézet "Adatok exportálása" gombjához.
 *
 * A JS oldali exportData() (index.html) már eddig is elkészítette a teljes állapot
 * JSON mentését — böngészőben/webes verzióban ez egy sima <a download> blob-linkkel
 * működik. A natív Android WebView viszont NEM kezeli le a <a download> blob-linkeket
 * (nincs beépített letöltés-támogatása), ezért ez a gomb a natív appban eddig
 * némán semmit nem csinált. Ez a híd helyettesíti azt: a JS közvetlenül idehívja a
 * kész JSON szöveget, mi pedig a rendszer natív "Mentés másként" (Storage Access
 * Framework) párbeszédablakán keresztül kiírjuk oda, ahova a felhasználó akarja
 * (Letöltések, Google Drive stb.).
 */
class BackupBridge(private val activity: ComponentActivity) {

    private var pendingJson: String? = null

    private val createDocumentLauncher = activity.registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/json")
    ) { uri ->
        val json = pendingJson
        pendingJson = null
        if (uri == null || json == null) return@registerForActivityResult
        try {
            activity.contentResolver.openOutputStream(uri)?.use { out ->
                out.write(json.toByteArray(Charsets.UTF_8))
            }
            Toast.makeText(activity, "Mentés sikeres", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(activity, "Hiba a mentés közben: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    @JavascriptInterface
    fun exportJson(json: String, suggestedFileName: String) {
        pendingJson = json
        activity.runOnUiThread {
            try {
                createDocumentLauncher.launch(suggestedFileName)
            } catch (e: Exception) {
                Toast.makeText(activity, "Nem sikerült megnyitni a mentés ablakot.", Toast.LENGTH_LONG).show()
            }
        }
    }
}
