package com.viro.workcare.phone

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.provider.Settings
import com.viro.workcare.data.Component
import com.viro.workcare.data.Evidence
import com.viro.workcare.data.EvidenceType
import com.viro.workcare.data.Finding
import com.viro.workcare.data.Severity
import com.viro.workcare.data.Tier
import java.io.File
import java.security.KeyStore

/** One deep check: what it is called and what it looks at. The free scan lists these as "not run" without claiming anything about the result. */
data class DeepCheck(val id: String, val title: String, val why: String)

object AuditCatalog {
    /** Everything the phone's deep audit actually runs (see [PhoneDeepReader]). Kept next to the code that implements it so the list cannot drift into promising more than it does. */
    val phone = listOf(
        DeepCheck("deep.accessibility", "Apps with accessibility control", "Accessibility services can read the screen and tap for you. It is the most abused permission on Android."),
        DeepCheck("deep.notification_listeners", "Apps that read your notifications", "Notification access exposes one-time codes and private messages."),
        DeepCheck("deep.device_admins", "Device administrators", "An administrator app can lock, wipe or block removal of apps."),
        DeepCheck("deep.user_certificates", "Certificates added by a person or organisation", "A user-installed certificate lets someone inspect encrypted traffic."),
        DeepCheck("deep.proxy", "Traffic proxy", "A proxy sends your connections through another server."),
        DeepCheck("deep.debugging", "USB debugging and developer mode", "Debugging gives a connected computer deep access to the phone."),
        DeepCheck("deep.build_integrity", "System integrity", "Looks for signs of rooting or a non-production Android build."),
        DeepCheck("deep.sideloaded_sensitive", "Apps from outside Google Play that can use your microphone, camera, location or messages", "Unvetted apps with sensitive access are where phone malware usually lives."),
        DeepCheck("deep.permissions_overview", "Which apps hold sensitive permissions", "A plain count of the apps that can use the camera, microphone, location, messages, contacts and call history."),
    )
}

/** Everything the deep phone audit reads. Read on the phone, kept on the phone: nothing here is uploaded. */
data class PhoneDeep(
    val takenAtMillis: Long,
    val accessibility: List<String>, val notificationListeners: List<String>, val deviceAdmins: List<String>,
    val userCertificates: Int?, val proxy: String?, val privateDns: String?, val vpnActive: Boolean?,
    val adbEnabled: Boolean?, val developerOptions: Boolean?,
    val buildTags: String, val buildType: String, val rootIndicators: List<String>,
    val appsChecked: Int?, val sideloaded: List<String>, val permissionApps: Map<String, List<String>>,
)

object PhoneDeepReader {
    private val stores = setOf("com.android.vending", "com.sec.android.app.samsungapps", "com.amazon.venezia", "com.huawei.appmarket", "com.heytap.market", "com.xiaomi.mipicks", "com.transsion.palmstore", "com.oppo.market", "com.vivo.appstore")
    private val groups = mapOf(
        "Camera" to "android.permission.CAMERA", "Microphone" to "android.permission.RECORD_AUDIO", "Precise location" to "android.permission.ACCESS_FINE_LOCATION",
        "Messages (SMS)" to "android.permission.READ_SMS", "Contacts" to "android.permission.READ_CONTACTS", "Call history" to "android.permission.READ_CALL_LOG",
    )

    @Suppress("DEPRECATION")
    fun read(ctx: Context): PhoneDeep {
        val cr = ctx.contentResolver
        fun secure(k: String) = try { Settings.Secure.getString(cr, k) } catch (e: Exception) { null }
        fun comps(s: String?) = s?.split(':')?.filter { it.isNotBlank() }.orEmpty()
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val admins = try { dpm.activeAdmins?.map { it.flattenToShortString() }.orEmpty() } catch (e: Exception) { emptyList() }
        val certs = try { val ks = KeyStore.getInstance("AndroidCAStore"); ks.load(null); ks.aliases().toList().count { it.startsWith("user:") } } catch (e: Exception) { null }
        val proxy = try { cm.defaultProxy?.let { if (it.host.isNullOrBlank()) null else "${it.host}:${it.port}" } } catch (e: Exception) { null }
        val vpn = try { cm.allNetworks.any { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true } } catch (e: Exception) { null }
        val adb = try { Settings.Global.getInt(cr, Settings.Global.ADB_ENABLED, 0) == 1 } catch (e: Exception) { null }
        val dev = try { Settings.Global.getInt(cr, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) == 1 } catch (e: Exception) { null }
        val dns = try { Settings.Global.getString(cr, "private_dns_mode") } catch (e: Exception) { null }
        val su = listOf("/system/bin/su", "/system/xbin/su", "/sbin/su", "/system/app/Superuser.apk", "/system/bin/.ext/.su", "/data/local/xbin/su", "/data/local/bin/su", "/su/bin/su", "/system/app/Magisk.apk").filter { try { File(it).exists() } catch (e: Exception) { false } }

        // Installed apps. Android only lets an app list the apps it is allowed to see (the manifest declares launcher apps), so this is "the apps you can open", not every package.
        val pm = ctx.packageManager
        var checked: Int? = null; val sideloaded = ArrayList<String>(); val perms = groups.keys.associateWith { ArrayList<String>() }
        try {
            val all: List<PackageInfo> = if (Build.VERSION.SDK_INT >= 33) pm.getInstalledPackages(PackageManager.PackageInfoFlags.of(PackageManager.GET_PERMISSIONS.toLong())) else pm.getInstalledPackages(PackageManager.GET_PERMISSIONS)
            val mine = ctx.packageName
            val user = all.filter { val ai = it.applicationInfo; ai != null && (ai.flags and (android.content.pm.ApplicationInfo.FLAG_SYSTEM or android.content.pm.ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) == 0 && it.packageName != mine }
            checked = user.size
            for (pi in user) {
                val label = try { pm.getApplicationLabel(pi.applicationInfo!!).toString() } catch (e: Exception) { pi.packageName }
                val installer = try { if (Build.VERSION.SDK_INT >= 30) pm.getInstallSourceInfo(pi.packageName).installingPackageName else pm.getInstallerPackageName(pi.packageName) } catch (e: Exception) { null }
                val fromStore = installer != null && installer in stores
                if (!fromStore) sideloaded.add(label)
                val granted = pi.requestedPermissions?.indices?.filter { (pi.requestedPermissionsFlags!![it] and PackageInfo.REQUESTED_PERMISSION_GRANTED) != 0 }?.map { pi.requestedPermissions!![it] }?.toSet().orEmpty()
                groups.forEach { (g, p) -> if (p in granted) perms[g]!!.add(label + if (!fromStore) " (outside a store)" else "") }
            }
        } catch (e: Exception) { checked = null }
        return PhoneDeep(System.currentTimeMillis(), comps(secure(Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)), comps(secure("enabled_notification_listeners")), admins, certs, proxy, dns, vpn, adb, dev, Build.TAGS ?: "", Build.TYPE ?: "", su, checked, sideloaded, perms)
    }
}

/** The rules for the deep phone audit. Same discipline as the essentials: measured facts, honest evidence labels, advice only when something is actually off. */
object PhoneDeepFindings {
    private val systemPrefixes = listOf("com.android.", "com.google.android.", "com.samsung.", "com.sec.android.", "com.huawei.", "com.miui.", "com.transsion.", "com.mediatek.", "com.qualcomm.", "android/")
    private fun pkg(c: String) = c.substringBefore('/')
    private fun isSystemish(c: String) = systemPrefixes.any { c.startsWith(it) }
    private fun f(id: String, c: Component, s: Severity, title: String, summary: String, t: EvidenceType, ev: List<Evidence>, action: String? = null) = Finding(id, c, s, title, summary, t, ev, action, Tier.DEEP)

    fun evaluate(d: PhoneDeep): List<Finding> {
        val out = ArrayList<Finding>()
        run {
            val unknown = d.accessibility.filterNot { isSystemish(it) }
            out.add(if (d.accessibility.isEmpty()) f("deep.accessibility", Component.SECURITY, Severity.HEALTHY, "No app has accessibility control", "No accessibility service is switched on.", EvidenceType.MEASURED, listOf(Evidence("accessibilityServices", "0", null)))
            else f("deep.accessibility", Component.SECURITY, if (unknown.isEmpty()) Severity.HEALTHY else Severity.ATTENTION, if (unknown.isEmpty()) "Only system accessibility services are on" else "${unknown.size} app${if (unknown.size == 1) "" else "s"} with accessibility control",
                "Switched on: " + d.accessibility.joinToString(", ") { pkg(it) } + ".", EvidenceType.MEASURED, listOf(Evidence("accessibilityServices", d.accessibility.size.toString(), null)),
                if (unknown.isEmpty()) null else "Keep only apps you installed on purpose for this (screen readers, password managers). Turn the rest off in Settings > Accessibility."))
        }
        run {
            val unknown = d.notificationListeners.filterNot { isSystemish(it) }
            if (d.notificationListeners.isNotEmpty()) out.add(f("deep.notification_listeners", Component.SECURITY, if (unknown.isEmpty()) Severity.HEALTHY else Severity.ATTENTION, if (unknown.isEmpty()) "Only system apps read notifications" else "${unknown.size} app${if (unknown.size == 1) "" else "s"} can read your notifications",
                "Notification access: " + d.notificationListeners.joinToString(", ") { pkg(it) } + ".", EvidenceType.MEASURED, listOf(Evidence("notificationListeners", d.notificationListeners.size.toString(), null)), if (unknown.isEmpty()) null else "Remove access for any app you do not need in Settings > Notifications > Device and app notifications."))
            else out.add(f("deep.notification_listeners", Component.SECURITY, Severity.HEALTHY, "No app reads your notifications", "No notification listener is switched on.", EvidenceType.MEASURED, listOf(Evidence("notificationListeners", "0", null))))
        }
        run {
            val unknown = d.deviceAdmins.filterNot { isSystemish(it) }
            if (d.deviceAdmins.isNotEmpty()) out.add(f("deep.device_admins", Component.SECURITY, if (unknown.isEmpty()) Severity.HEALTHY else Severity.ATTENTION, if (unknown.isEmpty()) "Only system device administrators" else "${unknown.size} device administrator app${if (unknown.size == 1) "" else "s"}",
                "Active: " + d.deviceAdmins.joinToString(", ") { pkg(it) } + ".", EvidenceType.MEASURED, listOf(Evidence("deviceAdmins", d.deviceAdmins.size.toString(), null)), if (unknown.isEmpty()) null else "If you do not recognise an administrator, remove it in Settings > Security > Device admin apps."))
        }
        d.userCertificates?.let { n -> out.add(if (n == 0) f("deep.user_certificates", Component.NETWORK, Severity.HEALTHY, "No added certificates", "No certificate has been installed by a person or organisation.", EvidenceType.MEASURED, listOf(Evidence("userCertificates", "0", null)))
            else f("deep.user_certificates", Component.NETWORK, Severity.ATTENTION, "$n certificate${if (n == 1) "" else "s"} added to this phone", "Certificates installed by a user or organisation can let whoever issued them inspect secure traffic.", EvidenceType.MEASURED, listOf(Evidence("userCertificates", n.toString(), null)), "If this is not a work or school phone, remove them in Settings > Security > Encryption and credentials > User credentials.")) }
        d.proxy?.let { p -> out.add(f("deep.proxy", Component.NETWORK, Severity.ATTENTION, "Connections go through a proxy", "A proxy is set: $p. Everything that uses it passes through that server.", EvidenceType.MEASURED, listOf(Evidence("proxy", p, null)), "Remove the proxy in the Wi-Fi network settings unless you set it yourself.")) }
        if (d.adbEnabled != null || d.developerOptions != null) {
            val adb = d.adbEnabled == true; val dev = d.developerOptions == true
            out.add(f("deep.debugging", Component.SYSTEM, if (adb) Severity.ATTENTION else Severity.HEALTHY, if (adb) "USB debugging is on" else if (dev) "Developer options are on, USB debugging is off" else "Debugging is off",
                if (adb) "A computer connected by USB, once authorised, can read data and install apps without unlocking the phone's apps." else "USB debugging is off.", EvidenceType.MEASURED, listOf(Evidence("usbDebugging", adb.toString(), null), Evidence("developerOptions", dev.toString(), null)),
                if (adb) "Turn off USB debugging in Settings > Developer options when you are not using it." else null))
        }
        run {
            val test = d.buildTags.contains("test-keys") || (d.buildType.isNotEmpty() && d.buildType != "user")
            val signs = d.rootIndicators
            val sev = if (signs.isNotEmpty() || test) Severity.ATTENTION else Severity.HEALTHY
            out.add(f("deep.build_integrity", Component.SYSTEM, sev, if (signs.isNotEmpty()) "Signs this phone may be rooted" else if (test) "Android is a non-production build" else "Android looks like an unmodified build",
                if (signs.isNotEmpty()) "Found: ${signs.joinToString(", ")}. Rooted phones lose Android's app isolation." else if (test) "Build type is ${d.buildType} (${d.buildTags})." else "No root files were found and the build is signed as a production release. This cannot prove the phone is clean.",
                EvidenceType.INFERRED, listOf(Evidence("buildType", d.buildType, null), Evidence("rootFilesFound", signs.size.toString(), null)), if (sev == Severity.HEALTHY) null else "If you did not do this yourself, restore the official software."))
        }
        d.appsChecked?.let { n ->
            val risky = d.sideloaded.filter { app -> d.permissionApps.values.any { l -> l.any { it.startsWith(app) } } }
            out.add(f("deep.sideloaded_sensitive", Component.APPS, if (risky.isEmpty()) Severity.HEALTHY else Severity.ATTENTION,
                if (risky.isEmpty()) "No outside-store app holds sensitive access" else "${risky.size} app${if (risky.size == 1) "" else "s"} from outside a store can use sensitive features",
                if (risky.isEmpty()) "Of $n apps you installed, ${d.sideloaded.size} came from outside a known app store and none of them holds camera, microphone, location, messages, contacts or call-history access." else "From outside a known app store with sensitive access: ${risky.take(6).joinToString(", ")}.",
                EvidenceType.MEASURED, listOf(Evidence("appsChecked", n.toString(), null), Evidence("outsideStoreApps", d.sideloaded.size.toString(), null)), if (risky.isEmpty()) null else "Uninstall any of these you do not recognise, and check their permissions in Settings > Apps."))
            out.add(f("deep.permissions_overview", Component.APPS, Severity.HEALTHY, "Apps with sensitive permissions", d.permissionApps.entries.joinToString(" · ") { "${it.key}: ${it.value.size}" } + " (among $n apps you installed that this phone lets WorkCare see).",
                EvidenceType.MEASURED, d.permissionApps.map { Evidence(it.key, it.value.size.toString(), "apps") }, null))
        }
        return out
    }
}
