package com.viro.workcare.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import com.viro.workcare.data.Finding

/** What the person can do about a finding. Either open the exact Android settings screen where it is fixed, or go to a WorkCare tool. WorkCare never changes these settings itself. */
sealed class FixAction(val label: String) {
    class Settings(label: String, val action: String) : FixAction(label)
    class Tool(label: String, val route: String) : FixAction(label)
    class Instruction(label: String) : FixAction(label)
}

object Fixes {
    private val S = android.provider.Settings::class.java
    fun forFinding(f: Finding): FixAction? = when {
        f.id == "storage.free_space" -> FixAction.Tool("Free up space", R.CLEAN)
        f.id == "system.security_patch" -> FixAction.Settings("Check for updates", "android.settings.SYSTEM_UPDATE_SETTINGS")
        f.id == "system.uptime" -> FixAction.Instruction("Restart now")
        f.id == "security.screen_lock" || f.id == "security.encryption" -> FixAction.Settings("Open security settings", android.provider.Settings.ACTION_SECURITY_SETTINGS)
        f.id.startsWith("battery.") || f.id == "thermal.status" -> FixAction.Settings("See what uses the battery", Intent.ACTION_POWER_USAGE_SUMMARY)
        f.id == "memory.low" -> FixAction.Settings("Manage apps", android.provider.Settings.ACTION_MANAGE_ALL_APPLICATIONS_SETTINGS)
        f.id == "deep.accessibility" -> FixAction.Settings("Review accessibility apps", android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS)
        f.id == "deep.notification_listeners" -> FixAction.Settings("Review notification access", "android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")
        f.id == "deep.device_admins" -> FixAction.Settings("Review device administrators", android.provider.Settings.ACTION_SECURITY_SETTINGS)
        f.id == "deep.user_certificates" -> FixAction.Settings("Review certificates", android.provider.Settings.ACTION_SECURITY_SETTINGS)
        f.id == "deep.proxy" -> FixAction.Settings("Open Wi-Fi settings", android.provider.Settings.ACTION_WIFI_SETTINGS)
        f.id == "deep.debugging" -> FixAction.Settings("Open developer options", android.provider.Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
        f.id == "deep.sideloaded_sensitive" || f.id == "deep.permissions_overview" -> FixAction.Settings("Review apps and permissions", android.provider.Settings.ACTION_MANAGE_ALL_APPLICATIONS_SETTINGS)
        else -> null
    }

    /** Opens a settings screen, falling back to the main Settings list if this phone's maker removed the page. Returns false if nothing could be opened. */
    fun open(ctx: Context, action: String, packageUri: String? = null): Boolean {
        fun tryIt(i: Intent) = try { i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(i); true } catch (e: Exception) { false }
        val i = Intent(action).apply { if (packageUri != null) data = Uri.parse(packageUri) }
        return tryIt(i) || tryIt(Intent(android.provider.Settings.ACTION_SETTINGS))
    }
}

/** Access that other apps and services hold on this phone, each with the screen where it is switched off. */
data class Connection(val title: String, val detail: String, val action: String, val packageUri: String? = null)
object Connections {
    fun all(ctx: Context) = listOf(
        Connection("Accessibility apps", "Can read the screen and tap for you", android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS),
        Connection("Notification access", "Can read your notifications, including one-time codes", "android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"),
        Connection("Apps with access to all files", "Can read and change every file in shared storage", android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION),
        Connection("Install unknown apps", "Apps allowed to install other apps", android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES),
        Connection("Display over other apps", "Apps that can draw on top of what you are doing", android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION),
        Connection("Usage access", "Apps that can see which apps you use and when", android.provider.Settings.ACTION_USAGE_ACCESS_SETTINGS),
        Connection("Accounts and sync", "Accounts signed in on this phone, and what syncs", android.provider.Settings.ACTION_SYNC_SETTINGS),
        Connection("Bluetooth devices", "Devices paired with this phone", android.provider.Settings.ACTION_BLUETOOTH_SETTINGS),
        Connection("Saved Wi-Fi networks", "Networks this phone joins on its own", android.provider.Settings.ACTION_WIFI_SETTINGS),
        Connection("Device administrators", "Apps that can lock or wipe this phone", android.provider.Settings.ACTION_SECURITY_SETTINGS),
    )
}
