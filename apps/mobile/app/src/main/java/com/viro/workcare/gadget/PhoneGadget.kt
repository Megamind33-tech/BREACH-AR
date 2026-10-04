package com.viro.workcare.gadget

import android.app.ActivityManager
import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.SystemClock
import android.util.DisplayMetrics
import android.view.WindowManager
import com.viro.workcare.data.EvidenceType
import com.viro.workcare.data.Severity
import com.viro.workcare.phone.PhoneFindings
import com.viro.workcare.phone.PhoneSnapshot
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** A result from the Lab (a test this person ran). Stored on the phone. */
data class LabResult(val id: String, val ok: Boolean?, val value: String, val at: Long)

/**
 * Reads this phone as a gadget: what it is, how old it can be, what condition each part is in, and the one decision that follows.
 * Every fact comes from Android or from a test the person ran. Where Android does not say, the report says "Not available on this device".
 */
object PhoneGadget {
    private val apiYear = mapOf(21 to "2014", 22 to "2015", 23 to "2015", 24 to "2016", 25 to "2016", 26 to "2017", 27 to "2017", 28 to "2018", 29 to "2019", 30 to "2020", 31 to "2021", 32 to "2022", 33 to "2022", 34 to "2023", 35 to "2024", 36 to "2025")
    private val apiVersion = mapOf(21 to "5.0", 22 to "5.1", 23 to "6", 24 to "7", 25 to "7.1", 26 to "8", 27 to "8.1", 28 to "9", 29 to "10", 30 to "11", 31 to "12", 32 to "12L", 33 to "13", 34 to "14", 35 to "15", 36 to "16")
    private val day = SimpleDateFormat("yyyy-MM-dd", Locale.US)

    private fun prop(name: String): String? = try { val p = Runtime.getRuntime().exec(arrayOf("getprop", name)); p.inputStream.bufferedReader().readText().trim().ifEmpty { null } } catch (e: Exception) { null }
    private fun gb(b: Long) = String.format(Locale.US, "%.1f", b / 1073741824.0).removeSuffix(".0")

    /** The battery's design capacity in mAh, from the Android framework's own power profile. Many phones hide it; then this is null. */
    fun designCapacityMah(ctx: Context): Double? = try {
        val c = Class.forName("com.android.internal.os.PowerProfile"); val o = c.getConstructor(Context::class.java).newInstance(ctx)
        (c.getMethod("getBatteryCapacity").invoke(o) as Double).takeIf { it > 500 }
    } catch (e: Throwable) { null }

    /** Estimated full-charge capacity from the fuel gauge: remaining charge divided by the percentage. Only trusted between 15% and 99%. */
    fun estimatedFullMah(p: PhoneSnapshot): Double? {
        val c = p.chargeCounterUah; val pct = p.batteryPercent ?: return null
        if (c == null || c <= 0 || pct !in 15..99) return null
        return c / 1000.0 / (pct / 100.0)
    }

    fun read(ctx: Context, p: PhoneSnapshot, findings: List<com.viro.workcare.data.Finding>, lab: Map<String, LabResult>, boughtYear: Int?, now: Long = System.currentTimeMillis()): GadgetReport {
        val facts = ArrayList<Fact>(); fun f(g: String, l: String, v: String?, t: EvidenceType = EvidenceType.MEASURED) { if (!v.isNullOrBlank()) facts.add(Fact(g, l, v, t)) }
        val firstApi = prop("ro.product.first_api_level")?.toIntOrNull(); val patchDays = PhoneFindings.patchAgeDays(p.securityPatch, now)?.toInt()

        // ---------------------------------------------------------------- age: bounds, never a guess
        val ageLines = ArrayList<String>(); var approx: Double? = null; var conf = "LOW"
        if (boughtYear != null) { approx = (Calendar2.year(now) - boughtYear).coerceAtLeast(0).toDouble(); ageLines.add("You told WorkCare you got it in $boughtYear."); conf = "MEDIUM" }
        val ceiling = firstApi?.let { apiYear[it]?.toIntOrNull() }?.let { Calendar2.year(now) - it }
        if (firstApi != null) { ageLines.add("Shipped with Android ${apiVersion[firstApi] ?: firstApi} (released ${apiYear[firstApi] ?: "?"}), so it is not older than that." + (ceiling?.let { " At most about $it years." } ?: "")) }
        ageLines.add("Software on it was built " + day.format(Date(Build.TIME)) + (patchDays?.let { "; security patch from ${p.securityPatch} ($it days old)." } ?: "."))
        val headline = when { boughtYear != null -> "About ${approx!!.toInt()} year${if (approx.toInt() == 1) "" else "s"} old (your date)"; ceiling != null -> "No older than about $ceiling years"; else -> "Age not available on this device" }
        val age = AgeView(headline, ageLines + "Android does not store the day a phone was made, so WorkCare only states what it can prove.", approx, conf)

        // ---------------------------------------------------------------- facts
        f("Identity", "Model", p.displayNameForGadget()); f("Identity", "Android", "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"); f("Identity", "Security patch", p.securityPatch)
        f("Identity", "Software built", day.format(Date(Build.TIME))); firstApi?.let { f("Identity", "Shipped with Android", "${apiVersion[it] ?: it} (${apiYear[it] ?: "?"})") }
        f("Identity", "Running since last restart", "${SystemClock.elapsedRealtime() / 86_400_000L} days")
        val cores = Runtime.getRuntime().availableProcessors(); var maxMhz: Long? = null
        try { maxMhz = (0 until cores).mapNotNull { i -> File("/sys/devices/system/cpu/cpu$i/cpufreq/cpuinfo_max_freq").takeIf { it.canRead() }?.readText()?.trim()?.toLongOrNull() }.maxOrNull()?.div(1000) } catch (e: Exception) { }
        f("Hardware", "Processor", listOfNotNull(if (Build.VERSION.SDK_INT >= 31) Build.SOC_MODEL.takeIf { it.isNotBlank() && it != "unknown" } else null, "$cores cores", maxMhz?.let { "up to ${"%.1f".format(it / 1000.0)} GHz" }).joinToString(" · "))
        f("Hardware", "Architecture", Build.SUPPORTED_ABIS.firstOrNull())
        p.memTotal?.let { f("Hardware", "Memory", gb(it) + " GB") }; p.storageTotal?.let { f("Hardware", "Storage", gb(it) + " GB, " + gb(p.storageFree ?: 0) + " GB free") }
        try { val dm = DisplayMetrics(); @Suppress("DEPRECATION") val d = (ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay; @Suppress("DEPRECATION") d.getRealMetrics(dm); f("Hardware", "Screen", "${dm.widthPixels} × ${dm.heightPixels} px · ${dm.densityDpi} dpi · ${"%.0f".format(d.refreshRate)} Hz") } catch (e: Exception) { }
        val design = designCapacityMah(ctx); val est = estimatedFullMah(p)
        design?.let { f("Battery", "Design capacity", "${it.toInt()} mAh") }; est?.let { f("Battery", "Holds now (estimate)", "${it.toInt()} mAh", EvidenceType.INFERRED) }
        p.cycleCount?.let { f("Battery", "Charge cycles", it.toString()) }; p.batteryTempC?.let { f("Battery", "Temperature now", "${"%.1f".format(it)} °C") }
        try { val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager; cm.cameraIdList.forEach { id -> val c = cm.getCameraCharacteristics(id); val facing = when (c.get(CameraCharacteristics.LENS_FACING)) { CameraCharacteristics.LENS_FACING_FRONT -> "Front"; CameraCharacteristics.LENS_FACING_BACK -> "Back"; else -> "External" }
            val size = c.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE); f("Cameras", "$facing camera (id $id)", size?.let { "%.1f MP".format(it.width * it.height / 1e6) }) } } catch (e: Exception) { }
        val pm = ctx.packageManager
        listOf("Fingerprint reader" to "android.hardware.fingerprint", "NFC" to "android.hardware.nfc", "GPS" to "android.hardware.location.gps", "Bluetooth LE" to "android.hardware.bluetooth_le", "Wi-Fi" to "android.hardware.wifi", "Gyroscope" to "android.hardware.sensor.gyroscope", "Flash" to "android.hardware.camera.flash")
            .forEach { (l, feat) -> f("Features", l, if (pm.hasSystemFeature(feat)) "Present" else "Not on this phone") }
        f("Features", "Sensors listed by Android", p.sensorCount?.toString())

        // ---------------------------------------------------------------- parts
        val parts = ArrayList<Part>()
        // battery
        run {
            val pct = if (design != null && est != null) Math.round(est / design * 100).toInt().coerceAtMost(110) else null
            val (cond, ev) = Decide.batteryByCapacity(pct, p.cycleCount)
            val reported = when (p.batteryHealth) { 3 -> "Android reports it overheated." to Condition.DEGRADED; 4 -> "Android reports it dead." to Condition.CRITICAL; 6 -> "Android reports a failure." to Condition.CRITICAL; else -> null }
            val c = reported?.let { if (cond == Condition.NOT_MEASURED) it.second else cond.worse(it.second) } ?: cond
            val evidence = ev + listOfNotNull(reported?.first) + (if (pct != null) listOf("Estimated from the fuel gauge, so treat it as ±10 points.") else listOf("Android does not give this phone's design capacity or wear to apps." ))
            parts.add(Part("battery", "Battery", c, when (c) { Condition.NOT_MEASURED -> "Wear not available"; else -> pct?.let { "holds about $it%" } ?: reported?.first ?: c.label }, evidence, when (c) { Condition.HEALTHY -> "No action needed."; Condition.WATCH -> "Ageing. No action yet."; Condition.DEGRADED -> "Plan a battery replacement."; Condition.REPLACEMENT_ADVISED -> "Replace the battery. Software cannot restore lost capacity."; Condition.CRITICAL -> "Replace the battery now."; Condition.NOT_MEASURED -> "Run the charger test in the Lab to see how it behaves." }, if (pct != null) EvidenceType.INFERRED else EvidenceType.MEASURED))
        }
        // memory
        p.memTotal?.let { m -> val g = m / 1073741824.0; val c = if (g < 2.0) Condition.DEGRADED else if (g < 3.5) Condition.WATCH else Condition.HEALTHY
            parts.add(Part("memory", "Memory", c, "${gb(m)} GB", listOf("${gb(m)} GB of memory in total."), when (c) { Condition.HEALTHY -> "Enough for current apps."; Condition.WATCH -> "Fine for basic use; heavy apps will be slow."; else -> "Too little for today's apps. It cannot be upgraded." }, EvidenceType.MEASURED)) }
        // storage space (software, not a wear reading)
        if (p.storageTotal != null && p.storageFree != null && p.storageTotal > 0) { val pct = p.storageFree * 100.0 / p.storageTotal; val c = if (pct < 5) Condition.DEGRADED else if (pct < 12) Condition.WATCH else Condition.HEALTHY
            parts.add(Part("space", "Storage space", c, "${gb(p.storageFree)} GB free", listOf("${gb(p.storageFree)} GB free of ${gb(p.storageTotal)} GB (${"%.0f".format(pct)}%).", "Android does not report storage wear to apps."), if (c == Condition.HEALTHY) "No action needed." else "Free up space with Clean.", EvidenceType.MEASURED)) }
        // cooling
        run { val t = p.batteryTempC; val th = p.thermalStatus; val c = when { th != null && th >= 3 -> Condition.CRITICAL; (th != null && th >= 2) || (t != null && t >= 45) -> Condition.WATCH; t != null || th != null -> Condition.HEALTHY; else -> Condition.NOT_MEASURED }
            parts.add(Part("cooling", "Heat", c, t?.let { "${"%.0f".format(it)} °C" } ?: "Not available", listOfNotNull(t?.let { "Battery at ${"%.1f".format(it)} °C right now." }, th?.let { "Android thermal status $it." }), if (c == Condition.HEALTHY) "No action needed." else "Take it out of the sun and stop charging until it cools.", EvidenceType.MEASURED)) }
        // lab-tested parts
        fun tested(key: String, label: String, id: String, passText: String, failText: String, action: String) {
            val r = lab[id]; val c = when (r?.ok) { true -> Condition.HEALTHY; false -> Condition.DEGRADED; null -> Condition.NOT_MEASURED }
            parts.add(Part(key, label, c, if (r == null) "Not tested" else if (r.ok == true) passText else failText, listOfNotNull(r?.let { "Tested ${SimpleDateFormat("d MMM", Locale.US).format(Date(it.at))}: ${it.value}" }), if (r == null) "Run the $label test in the Lab." else if (r.ok == true) "No action needed." else action, EvidenceType.TESTED))
        }
        tested("display", "Screen", "screen", "even, no dead pixels", "problems seen", "Dead pixels or tint cannot be fixed in software; a screen replacement is the repair.")
        tested("touch", "Touch", "touch", "every square responded", "dead zones", "Dead touch zones usually mean a damaged digitizer or screen.")
        tested("speaker", "Speaker", "speaker", "tone heard", "no tone", "Check for blocked grilles; otherwise the speaker needs repair.")
        tested("vibration", "Vibration motor", "vibration", "felt", "not felt", "The vibration motor needs repair.")
        tested("flash", "Flash", "flash", "lit", "did not light", "The flash or its connector needs repair.")
        // software support
        run { val d = patchDays; val c = when { d == null -> Condition.NOT_MEASURED; d > 540 -> Condition.CRITICAL; d > 365 -> Condition.DEGRADED; d > 180 -> Condition.WATCH; else -> Condition.HEALTHY }
            parts.add(Part("software", "Software support", c, d?.let { "patch $it days old" } ?: "Not available", listOfNotNull(p.securityPatch?.let { "Latest security patch: $it" }, "Android ${Build.VERSION.RELEASE}"), when (c) { Condition.CRITICAL, Condition.DEGRADED -> "Check for a system update. If none exists, the maker has stopped supporting this phone."; Condition.WATCH -> "Check for updates."; else -> "Up to date enough." }, EvidenceType.MEASURED)) }
        val open = findings.count { it.severity != Severity.HEALTHY }
        val unsupported = (patchDays ?: 0) > 540
        val v = Decide.verdict(Kind.PHONE, approx, parts, unsupported, open)
        return GadgetReport(Kind.PHONE, "this-phone", p.displayNameForGadget(), Build.MODEL, now, parts, facts, age, v, open)
    }

    private fun PhoneSnapshot.displayNameForGadget() = if (model.startsWith(manufacturer, ignoreCase = true)) model else "$manufacturer $model".trim()
}

private object Calendar2 { fun year(ms: Long) = java.util.Calendar.getInstance().apply { timeInMillis = ms }.get(java.util.Calendar.YEAR) }
