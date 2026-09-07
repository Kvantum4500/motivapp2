# Google Tink (transitive dependency of androidx.security:security-crypto,
# used by PendingNotificationStore's EncryptedSharedPreferences) references
# JSR-305 annotation classes (javax.annotation.Nullable,
# javax.annotation.concurrent.GuardedBy) that are compile-time-only and not
# present at runtime/on the classpath R8 sees. This is a well-known Tink+R8
# packaging gap - the annotations are never actually needed at runtime, so
# it's safe to tell R8 to stop treating the missing classes as a build error.
-dontwarn javax.annotation.Nullable
-dontwarn javax.annotation.concurrent.GuardedBy

# @JavascriptInterface-annotated methods (BackupBridge, HealthConnectBridge,
# MapsBridge, NotificationAccessBridge, NotifyBridge, TrackingBridge) are only ever
# invoked via the WebView's own JS-to-Java reflection - nothing in this app's Kotlin
# ever calls them directly. Without this rule, R8's release-build minification
# (minifyEnabled true, see app/build.gradle) has no reachable call site for them and
# is free to rename or strip them, which silently breaks every native bridge the web
# app calls into (Health Connect sync, GPS tracking, native maps, the bank/Foodora
# notification-access test button, the "Mentés fájlba" native save-file bridge) in
# the actual signed release APK - JS calling e.g. window.AndroidBackup.exportJson(...)
# throws "exportJson is not a function" against the renamed method, exactly like
# calling a method that was never there. This is a well-known, official Android
# WebView + ProGuard/R8 gotcha (see developer.android.com/reference/android/webkit/
# JavascriptInterface) that the default AGP proguard-android.txt does NOT cover.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
