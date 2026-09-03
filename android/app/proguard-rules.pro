# Google Tink (transitive dependency of androidx.security:security-crypto,
# used by PendingNotificationStore's EncryptedSharedPreferences) references
# JSR-305 annotation classes (javax.annotation.Nullable,
# javax.annotation.concurrent.GuardedBy) that are compile-time-only and not
# present at runtime/on the classpath R8 sees. This is a well-known Tink+R8
# packaging gap - the annotations are never actually needed at runtime, so
# it's safe to tell R8 to stop treating the missing classes as a build error.
-dontwarn javax.annotation.Nullable
-dontwarn javax.annotation.concurrent.GuardedBy
