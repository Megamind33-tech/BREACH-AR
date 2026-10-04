package com.viro.workcare.phone

import android.app.ActivityManager
import android.app.KeyguardManager
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.Sensor
import android.hardware.SensorManager
import android.hardware.biometrics.BiometricManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import com.viro.workcare.data.Component
import com.viro.workcare.data.ComponentHealth
import com.viro.workcare.data.DeviceHealth
import com.viro.workcare.data.Evidence
import com.viro.workcare.data.EvidenceType
import com.viro.workcare.data.Finding
import com.viro.workcare.data.Freshness
import com.viro.workcare.data.Severity
import java.text.SimpleDateFormat
import java.util.Locale

/** What Android actually exposes about this phone. A null field means "not available on this device": it is shown that way and never estimated. */
data class PhoneSnapshot(
    val takenAtMillis: Long, val manufacturer: String, val model: String, val androidRelease: String, val sdk: Int, val securityPatch: String?,
    val batteryPercent: Int?, val batteryHealth: Int?, val batteryTempC: Double?, val charging: Boolean?, val plugged: String?, val cycleCount: Int?, val chargeCounterUah: Long?, val capacityPercentProp: Int?,
    val storageTotal: Long?, val storageFree: Long?, val memTotal: Long?, val memAvail: Long?, val lowMemory: Boolean?,
    val thermalStatus: Int?, val secureLock: Boolean?, val encryptionActive: Boolean?, val biometricAvailable: Boolean?,
    val network: String?, val networkValidated: Boolean?, val sensors: List<String>, val sensorCount: Int?, val uptimeDays: Int? = null,
)

/** "TECNO CI6", not "TECNO TECNO CI6": many models already begin with the maker's name. */
val PhoneSnapshot.displayName: String get() = if (model.startsWith(manufacturer, ignoreCase = true)) model else "$manufacturer $model".trim()

object PhoneReader {
    fun read(ctx: Context): PhoneSnapshot {
        val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val i: Intent? = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = i?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1; val scale = i?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val status = i?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val plugged = when (i?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) { BatteryManager.BATTERY_PLUGGED_AC -> "AC"; BatteryManager.BATTERY_PLUGGED_USB -> "USB"; BatteryManager.BATTERY_PLUGGED_WIRELESS -> "Wireless"; else -> null }
        val temp = i?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)?.takeIf { it != Int.MIN_VALUE }?.let { it / 10.0 }
        val cycle = if (Build.VERSION.SDK_INT >= 34) i?.getIntExtra(BatteryManager.EXTRA_CYCLE_COUNT, -1)?.takeIf { it >= 0 } else null
        val stat = try { StatFs(Environment.getDataDirectory().path) } catch (e: Exception) { null }
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mi = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        val kg = ctx.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val enc = dpm.storageEncryptionStatus
        val bio = try { (ctx.getSystemService(Context.BIOMETRIC_SERVICE) as BiometricManager).let { b -> if (Build.VERSION.SDK_INT >= 30) b.canAuthenticate(android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_WEAK) == BiometricManager.BIOMETRIC_SUCCESS else null } } catch (e: Exception) { null }
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        val net = when { caps == null -> "Offline"; caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"; caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "Mobile data"; caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "Ethernet"; else -> "Connected" }
        val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val sensorNames = listOf(Sensor.TYPE_ACCELEROMETER to "Accelerometer", Sensor.TYPE_GYROSCOPE to "Gyroscope", Sensor.TYPE_MAGNETIC_FIELD to "Compass", Sensor.TYPE_PROXIMITY to "Proximity", Sensor.TYPE_LIGHT to "Light", Sensor.TYPE_PRESSURE to "Barometer", Sensor.TYPE_STEP_COUNTER to "Step counter")
            .filter { sm.getDefaultSensor(it.first) != null }.map { it.second }
        return PhoneSnapshot(
            System.currentTimeMillis(), Build.MANUFACTURER.replaceFirstChar { it.uppercase() }, Build.MODEL, Build.VERSION.RELEASE, Build.VERSION.SDK_INT, if (Build.VERSION.SDK_INT >= 23) Build.VERSION.SECURITY_PATCH else null,
            if (level >= 0 && scale > 0) Math.round(level * 100f / scale) else null, i?.getIntExtra(BatteryManager.EXTRA_HEALTH, -1)?.takeIf { it > 0 }, temp,
            if (status == -1) null else status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL, plugged, cycle,
            bm.getLongProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER).takeIf { it != Long.MIN_VALUE && it > 0 }, bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).takeIf { it != Int.MIN_VALUE && it > 0 },
            stat?.totalBytes, stat?.availableBytes, mi.totalMem.takeIf { it > 0 }, mi.availMem.takeIf { it > 0 }, mi.lowMemory,
            if (Build.VERSION.SDK_INT >= 29) pm.currentThermalStatus else null, kg.isDeviceSecure, enc == DevicePolicyManager.ENCRYPTION_STATUS_ACTIVE || enc == DevicePolicyManager.ENCRYPTION_STATUS_ACTIVE_PER_USER || enc == DevicePolicyManager.ENCRYPTION_STATUS_ACTIVE_DEFAULT_KEY,
            bio, net, caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED), sensorNames, sm.getSensorList(Sensor.TYPE_ALL).size.takeIf { it > 0 }, (android.os.SystemClock.elapsedRealtime() / 86_400_000L).toInt(),
        )
    }
}

/** Deterministic phone rules. Presentation renders these findings; it does not add warnings of its own. Pure Kotlin so it is unit-tested without a device. */
object PhoneFindings {
    private fun gb(b: Long) = String.format(Locale.US, "%.1f", b / 1073741824.0)
    private fun f(id: String, c: Component, s: Severity, title: String, summary: String, t: EvidenceType, ev: List<Evidence>, action: String? = null) = Finding(id, c, s, title, summary, t, ev, action)

    fun evaluate(p: PhoneSnapshot): List<Finding> {
        val out = ArrayList<Finding>()
        // Battery condition as Android reports it. Android does not tell apps the design capacity, so there is no "% of original capacity" for a phone.
        p.batteryHealth?.let { h ->
            val (sev, title) = when (h) { 2 -> Severity.HEALTHY to "Battery reports good condition"; 3 -> Severity.ATTENTION to "Battery is overheating"; 4 -> Severity.CRITICAL to "Battery reports it is dead"; 5 -> Severity.ATTENTION to "Battery is over voltage"; 6 -> Severity.CRITICAL to "Battery reported a failure"; 7 -> Severity.ATTENTION to "Battery is too cold"; else -> Severity.HEALTHY to "Battery condition not classified" }
            if (h in 2..7) out.add(f("battery.health", Component.BATTERY, sev, title, "Android reports the battery as ${listOf("", "unknown", "good", "overheated", "dead", "over voltage", "failed", "cold")[h]}.", EvidenceType.MEASURED, listOf(Evidence("androidBatteryHealth", h.toString(), null)),
                if (sev == Severity.HEALTHY) null else "Let the phone cool down or charge away from heat. If it keeps happening, have the battery checked."))
        }
        p.batteryTempC?.let { t -> if (t >= 45) out.add(f("battery.temperature", Component.COOLING, if (t >= 50) Severity.CRITICAL else Severity.ATTENTION, "Battery is hot", "The battery is at ${fmt(t)}°C.", EvidenceType.MEASURED, listOf(Evidence("batteryTemperature", fmt(t), "°C")), "Stop charging and heavy use until it cools.")) }
        val total = p.storageTotal; val free = p.storageFree
        if (total != null && free != null && total > 0) {
            val pct = free * 100.0 / total
            val sev = if (pct < 5) Severity.CRITICAL else if (pct < 10) Severity.ATTENTION else Severity.HEALTHY
            out.add(f("storage.free_space", Component.STORAGE, sev, if (sev == Severity.HEALTHY) "Storage has room" else "Storage is nearly full", "${gb(free)} GB free of ${gb(total)} GB.", EvidenceType.MEASURED,
                listOf(Evidence("freeBytes", free.toString(), "bytes"), Evidence("totalBytes", total.toString(), "bytes"), Evidence("freePercent", fmt(pct), "%")), if (sev == Severity.HEALTHY) null else "Free up space: remove unused apps, large videos and downloads."))
        }
        p.lowMemory?.let { low -> if (low) out.add(f("memory.low", Component.MEMORY, Severity.ATTENTION, "Memory is under pressure", "Android reports low available memory right now.", EvidenceType.MEASURED, listOfNotNull(p.memAvail?.let { Evidence("availableBytes", it.toString(), "bytes") }), "Close apps you are not using.")) }
        p.thermalStatus?.let { s -> if (s >= 2) out.add(f("thermal.status", Component.COOLING, if (s >= 3) Severity.CRITICAL else Severity.ATTENTION, if (s >= 3) "Phone is overheating" else "Phone is running warm", "Android reports a thermal status of ${listOf("none", "light", "moderate", "severe", "critical", "emergency", "shutdown").getOrElse(s) { "unknown" }}.", EvidenceType.MEASURED, listOf(Evidence("thermalStatus", s.toString(), null)), "Take the phone out of the sun and stop charging until it cools.")) }
        p.secureLock?.let { s -> out.add(f("security.screen_lock", Component.SECURITY, if (s) Severity.HEALTHY else Severity.ATTENTION, if (s) "Screen lock is on" else "No screen lock", if (s) "A PIN, pattern or password protects this phone." else "Anyone who picks up this phone can open it.", EvidenceType.MEASURED, listOf(Evidence("secureLock", s.toString(), null)), if (s) null else "Set a PIN or biometric lock in Android settings.")) }
        p.encryptionActive?.let { e -> if (!e) out.add(f("security.encryption", Component.SECURITY, Severity.ATTENTION, "Storage encryption is not active", "Android does not report this phone's storage as encrypted.", EvidenceType.MEASURED, listOf(Evidence("encryptionActive", e.toString(), null)), "Check encryption in Android security settings.")) }
        patchAgeDays(p.securityPatch, p.takenAtMillis)?.let { d ->
            val sev = if (d > 540) Severity.CRITICAL else if (d > 365) Severity.ATTENTION else Severity.HEALTHY
            out.add(f("system.security_patch", Component.SYSTEM, sev, if (sev == Severity.HEALTHY) "Security updates are recent" else "Security updates are out of date", "The latest security patch on this phone is $d days old (${p.securityPatch}).", EvidenceType.MEASURED,
                listOf(Evidence("securityPatchLevel", p.securityPatch ?: "", null), Evidence("patchAgeDays", d.toString(), "days")), if (sev == Severity.HEALTHY) null else "Check for a system update."))
        }
        p.uptimeDays?.let { d -> if (d >= 7) out.add(f("system.uptime", Component.SYSTEM, Severity.ATTENTION, "Phone has not restarted in $d days", "A restart clears memory leaks and stuck background processes that build up over time.", EvidenceType.MEASURED, listOf(Evidence("uptimeDays", d.toString(), "days")), "Restart the phone.")) }
        return out
    }
    private fun fmt(v: Double) = String.format(Locale.US, "%.1f", v).removeSuffix(".0")
    fun patchAgeDays(patch: String?, nowMillis: Long): Long? = try { patch?.let { (nowMillis - SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(it)!!.time) / 86_400_000L }?.takeIf { it >= 0 } } catch (e: Exception) { null }

    /** The same HealthModel shape the PC uses, so every screen renders a phone and a PC the same way. */
    fun health(p: PhoneSnapshot, idStr: String = "this-phone", deep: PhoneDeep? = null): DeviceHealth {
        val findings = evaluate(p) + (deep?.let { PhoneDeepFindings.evaluate(it) } ?: emptyList())
        fun comp(c: Component, detail: String?, have: Boolean, why: String? = null): ComponentHealth {
            val mine = findings.filter { it.component == c }
            return if (!have && mine.isEmpty()) ComponentHealth(c, c.label, detail, null, why ?: "Not available on this device", emptyList())
            else ComponentHealth(c, c.label, detail, mine.fold(Severity.HEALTHY) { a, x -> a.worse(x.severity) }, null, mine.map { it.id })
        }
        val components = listOf(
            comp(Component.BATTERY, p.batteryPercent?.let { "$it%${if (p.charging == true) " · charging" else ""}${p.cycleCount?.let { c -> " · $c cycles" } ?: ""}" }, p.batteryHealth != null, "Android does not share the battery's original capacity with apps"),
            comp(Component.STORAGE, if (p.storageTotal != null && p.storageFree != null) "${gb(p.storageFree)} GB free of ${gb(p.storageTotal)} GB" else null, p.storageTotal != null),
            comp(Component.MEMORY, p.memTotal?.let { "${gb(it)} GB · ${gb(p.memAvail ?: 0)} GB available" }, p.memTotal != null),
            comp(Component.COOLING, p.batteryTempC?.let { "Battery ${fmt(it)}°C" }, p.batteryTempC != null || p.thermalStatus != null),
            comp(Component.SECURITY, listOfNotNull(p.secureLock?.let { if (it) "Screen lock on" else "No screen lock" }, p.securityPatch?.let { "Patch $it" }).joinToString(" · ").ifEmpty { null }, p.secureLock != null),
            comp(Component.SYSTEM, "Android ${p.androidRelease} · API ${p.sdk}", true),
            comp(Component.NETWORK, p.network, p.network != null),
            comp(Component.SENSORS, if (p.sensors.isEmpty()) null else p.sensors.joinToString(", "), p.sensors.isNotEmpty()),
            comp(Component.APPS, deep?.appsChecked?.let { "$it apps you installed" }, deep?.appsChecked != null, if (deep == null) "Part of the deep audit, which has not run" else "Android limits which apps WorkCare is allowed to list"),
        )
        val status = findings.fold(Severity.HEALTHY) { a, x -> a.worse(x.severity) }
        val headline = if (status == Severity.HEALTHY) "Working normally" else findings.first { it.severity == status }.title
        return DeviceHealth(idStr, status, headline, components, findings, components.filter { !it.available }.map { "${it.label}: ${it.unavailableReason}" }, java.time.Instant.ofEpochMilli(p.takenAtMillis).toString(), Freshness.LIVE)
    }
}
