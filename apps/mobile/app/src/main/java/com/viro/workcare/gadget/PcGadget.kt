package com.viro.workcare.gadget

import android.content.Context
import com.viro.workcare.data.EvidenceType
import com.viro.workcare.data.Finding
import com.viro.workcare.data.Severity
import com.viro.workcare.pairing.ScanResult
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Locale

/** Turns what QuickCheck read from a computer into the same report a phone gets. The rules are the Windows product's. */
object PcGadget {
    private fun ev(f: Finding, name: String) = f.evidence.firstOrNull { it.name == name }?.value?.toDoubleOrNull()
    private fun sev(s: Severity) = when (s) { Severity.CRITICAL -> Condition.CRITICAL; Severity.ATTENTION -> Condition.DEGRADED; Severity.HEALTHY -> Condition.HEALTHY }

    fun fromScan(r: ScanResult, now: Long = System.currentTimeMillis(), boughtYear: Int? = null): GadgetReport {
        val fs = r.findings; val facts = r.facts
        fun fact(label: String) = facts.firstOrNull { it.label == label }?.value
        val parts = ArrayList<Part>()

        // drive(s): the worst of what the drive reports
        val drives = fs.filter { it.id.startsWith("storage.nvme_") || it.id.startsWith("storage.health") || it.id == "storage.unsafe_shutdowns.0" || it.id.startsWith("storage.unsafe") }
        if (drives.isNotEmpty()) {
            val wear = fs.firstOrNull { it.id.startsWith("storage.nvme_life") }?.let { ev(it, "percentageUsed")?.toInt() }
            val hours = facts.firstOrNull { it.label == "Drive powered on" }?.value?.substringBefore(" hours")?.replace(",", "")?.toDoubleOrNull()
            var (c, evid) = Decide.driveByWear(wear, if (fs.any { it.id.startsWith("storage.health") && it.severity == Severity.CRITICAL }) "Unhealthy" else if (fs.any { it.id.startsWith("storage.health") && it.severity == Severity.ATTENTION }) "Warning" else if (fs.any { it.id.startsWith("storage.health") }) "Healthy" else null, hours)
            val unsafe = fs.firstOrNull { it.id.startsWith("storage.unsafe_shutdowns") }; val extra = ArrayList<String>()
            unsafe?.takeIf { it.severity != Severity.HEALTHY }?.let { extra.add(it.summary); c = if (c == Condition.NOT_MEASURED) Condition.WATCH else c.worse(Condition.WATCH) }
            fs.filter { it.id.startsWith("storage.nvme_critical") || it.id.startsWith("storage.nvme_media") || it.id.startsWith("storage.nvme_spare") }.filter { it.severity != Severity.HEALTHY }.forEach { extra.add(it.summary); c = c.worse(sev(it.severity)) }
            parts.add(Part("drive", "Drive", c, wear?.let { "$it% of its write life used" } ?: c.label, evid + extra, when (c) { Condition.HEALTHY -> "No action needed."; Condition.WATCH -> "Fine for now. Keep backups."; Condition.DEGRADED -> "Back up, and plan a replacement."; Condition.REPLACEMENT_ADVISED -> "Back up now and replace the drive."; Condition.CRITICAL -> "Back up immediately. The drive may fail."; Condition.NOT_MEASURED -> "The drive did not report health data." }, EvidenceType.MEASURED))
        }
        // battery
        fs.firstOrNull { it.id == "battery.capacity" }?.let { b -> val pct = ev(b, "capacityPercent")?.toInt(); val cyc = ev(b, "cycleCount")?.toInt(); val (c, e) = Decide.batteryByCapacity(pct, cyc)
            parts.add(Part("battery", "Battery", c, pct?.let { "holds $it% of new" } ?: c.label, e + listOfNotNull(ev(b, "designCapacityWh")?.let { "Designed for ${"%.1f".format(it)} Wh." }), when (c) { Condition.HEALTHY -> "No action needed."; Condition.WATCH -> "Ageing. No action yet."; Condition.DEGRADED -> "Plan a replacement."; Condition.REPLACEMENT_ADVISED -> "Replace the battery."; Condition.CRITICAL -> "Replace the battery now."; else -> "" }, EvidenceType.MEASURED)) }
        // memory
        fs.firstOrNull { it.id == "memory.capacity" }?.let { m -> val g = ev(m, "installedGb") ?: m.summary.filter { it.isDigit() || it == '.' }.toDoubleOrNull(); val c = when { g == null -> Condition.NOT_MEASURED; g < 4 -> Condition.DEGRADED; g < 8 -> Condition.WATCH; else -> Condition.HEALTHY }
            parts.add(Part("memory", "Memory", c, g?.let { "${"%.0f".format(it)} GB" } ?: "Not measured", listOf(m.summary), when (c) { Condition.HEALTHY -> "Enough for current use."; Condition.WATCH -> "Fine for light use; more would help."; else -> "Too little for modern Windows. Memory can usually be upgraded." }, EvidenceType.MEASURED)) }
        // cooling
        fs.filter { it.id.startsWith("cpu.") }.let { l -> if (l.isNotEmpty()) { val c = l.fold(Condition.HEALTHY) { a, f -> a.worse(if (f.severity == Severity.HEALTHY) Condition.HEALTHY else if (f.severity == Severity.CRITICAL) Condition.CRITICAL else Condition.WATCH) }
            parts.add(Part("cooling", "Cooling", c, l.first().title, l.map { it.summary }, if (c == Condition.HEALTHY) "No action needed." else "Clean the fans and vents; if it stays hot, the thermal paste may need renewing.", EvidenceType.MEASURED)) } }
        // security + software
        val sec = fs.filter { it.id.startsWith("security.") || it.id.startsWith("deep.defender") || it.id in setOf("deep.bitlocker", "deep.secure_boot", "deep.tpm") }
        if (sec.isNotEmpty()) { val c = sec.fold(Condition.HEALTHY) { a, f -> a.worse(if (f.severity == Severity.HEALTHY) Condition.HEALTHY else sev(f.severity)) }; parts.add(Part("security", "Protection", c, sec.filter { it.severity != Severity.HEALTHY }.firstOrNull()?.title ?: "Protection is on", sec.map { it.summary }, if (c == Condition.HEALTHY) "No action needed." else sec.firstOrNull { it.severity != Severity.HEALTHY }?.action ?: "Review the findings.", EvidenceType.MEASURED)) }
        val os = fs.firstOrNull { it.id == "deep.os_support" }
        val unsupported = os != null && os.severity == Severity.CRITICAL
        os?.let { parts.add(Part("software", "Windows support", sev(it.severity), it.title, listOf(it.summary), it.action ?: "No action needed.", EvidenceType.INFERRED)) }
        fs.filter { it.id.startsWith("deep.update_age") || it.id == "deep.pending_reboot" }.firstOrNull { it.severity != Severity.HEALTHY }?.let { parts.add(Part("updates", "Windows updates", sev(it.severity), it.title, listOf(it.summary), it.action ?: "", EvidenceType.MEASURED)) }
        fs.filter { it.id.startsWith("deep.bluescreens") || it.id.startsWith("deep.disk_errors") || it.id.startsWith("deep.unexpected") }.let { l -> if (l.isNotEmpty()) { val c = l.fold(Condition.HEALTHY) { a, f -> a.worse(if (f.severity == Severity.HEALTHY) Condition.HEALTHY else sev(f.severity)) }; parts.add(Part("stability", "Stability", c, l.firstOrNull { it.severity != Severity.HEALTHY }?.title ?: "No crashes", l.map { it.summary }, l.firstOrNull { it.severity != Severity.HEALTHY }?.action ?: "No action needed.", EvidenceType.MEASURED)) } }

        // age from what the machine says about itself
        val bios = fact("BIOS release date"); val osInst = fact("Windows installed"); val drive = fact("Drive powered on")
        val biosYears = bios?.let { try { (now - SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(it)!!.time) / 3.15576e10 } catch (e: Exception) { null } }
        val ageLines = ArrayList<String>()
        if (boughtYear != null) ageLines.add("You told WorkCare you got it in $boughtYear.")
        bios?.let { ageLines.add("Firmware (BIOS) dated $it. Most computers are made within a year of their BIOS date, unless it was updated since.") }
        osInst?.let { ageLines.add("Windows was installed on $it. A reinstall resets this, so it can only show the computer is at least that old.") }
        drive?.let { ageLines.add("Drive: ${it.substringAfter("(").removeSuffix(")")}.") }
        val approx = if (boughtYear != null) (java.util.Calendar.getInstance().get(java.util.Calendar.YEAR) - boughtYear).toDouble() else biosYears
        val head = when { boughtYear != null -> "About ${approx!!.toInt()} years old (your date)"; biosYears != null -> "About ${Math.round(biosYears)} years old (from the BIOS date)"; else -> "Age not available" }
        val age = AgeView(head, ageLines.ifEmpty { listOf("This computer did not report a BIOS date.") }, approx, if (boughtYear != null) "MEDIUM" else if (biosYears != null) "MEDIUM" else "LOW")
        val open = fs.count { it.severity != Severity.HEALTHY && !it.id.startsWith("storage.") && it.id != "battery.capacity" && it.id != "memory.capacity" }
        val v = Decide.verdict(Kind.PC, approx, parts, unsupported, open)
        return GadgetReport(Kind.PC, "pc-" + r.deviceName, r.deviceName, r.deviceModel, now, parts, facts, age, v, open)
    }
}

/** Gadgets this person has checked, kept on this phone, newest first. */
object GadgetStore {
    private fun file(ctx: Context) = File(ctx.filesDir, "gadgets.json")
    fun all(ctx: Context): List<GadgetReport> = try { val a = JSONArray(file(ctx).takeIf { it.exists() }?.readText() ?: "[]"); (0 until a.length()).mapNotNull { fromJson(a.getJSONObject(it)) } } catch (e: Exception) { emptyList() }
    fun save(ctx: Context, r: GadgetReport) { val list = (listOf(r) + all(ctx).filter { it.id != r.id }).take(30); try { file(ctx).writeText(JSONArray(list.map { toJson(it) }).toString()) } catch (e: Exception) { } }
    fun remove(ctx: Context, id: String) { val list = all(ctx).filter { it.id != id }; try { file(ctx).writeText(JSONArray(list.map { toJson(it) }).toString()) } catch (e: Exception) { } }

    fun toJson(r: GadgetReport) = JSONObject().put("kind", r.kind.name).put("id", r.id).put("name", r.name).put("model", r.model ?: JSONObject.NULL).put("at", r.takenAt).put("open", r.findingsOpen)
        .put("parts", JSONArray(r.parts.map { JSONObject().put("key", it.key).put("label", it.label).put("cond", it.condition.name).put("head", it.headline).put("ev", JSONArray(it.evidence)).put("act", it.action).put("type", it.type.name) }))
        .put("facts", JSONArray(r.facts.map { JSONObject().put("g", it.group).put("l", it.label).put("v", it.value).put("t", it.type.name) }))
        .put("age", JSONObject().put("head", r.age.headline).put("lines", JSONArray(r.age.lines)).put("yrs", r.age.approxYears ?: JSONObject.NULL).put("conf", r.age.confidence))
        .put("verdict", JSONObject().put("action", r.verdict.action.name).put("head", r.verdict.headline).put("reasons", JSONArray(r.verdict.reasons)).put("conf", r.verdict.confidence).put("score", r.verdict.score))
    fun fromJson(o: JSONObject): GadgetReport? = try {
        fun strs(a: JSONArray) = (0 until a.length()).map { a.getString(it) }
        val pa = o.getJSONArray("parts"); val fa = o.getJSONArray("facts"); val ag = o.getJSONObject("age"); val vd = o.getJSONObject("verdict")
        GadgetReport(Kind.valueOf(o.getString("kind")), o.getString("id"), o.getString("name"), if (o.isNull("model")) null else o.getString("model"), o.getLong("at"),
            (0 until pa.length()).map { val p = pa.getJSONObject(it); Part(p.getString("key"), p.getString("label"), Condition.valueOf(p.getString("cond")), p.getString("head"), strs(p.getJSONArray("ev")), p.getString("act"), EvidenceType.valueOf(p.getString("type"))) },
            (0 until fa.length()).map { val f = fa.getJSONObject(it); Fact(f.getString("g"), f.getString("l"), f.getString("v"), EvidenceType.valueOf(f.getString("t"))) },
            AgeView(ag.getString("head"), strs(ag.getJSONArray("lines")), if (ag.isNull("yrs")) null else ag.getDouble("yrs"), ag.getString("conf")),
            Verdict(Action.valueOf(vd.getString("action")), vd.getString("head"), strs(vd.getJSONArray("reasons")), vd.getString("conf"), vd.getInt("score")), o.getInt("open"))
    } catch (e: Exception) { null }
}
