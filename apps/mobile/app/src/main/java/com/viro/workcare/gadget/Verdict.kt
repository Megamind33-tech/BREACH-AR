package com.viro.workcare.gadget

import com.viro.workcare.data.EvidenceType

/**
 * The same ladder and the same decision logic WorkCare for Windows uses (server/src/condition.ts and lifecycle.ts), applied to any gadget this app can read:
 * a part is HEALTHY, WATCH, DEGRADED, REPLACEMENT_ADVISED or CRITICAL from what it reports; the gadget then gets one explainable decision.
 * No failure date is ever predicted, and a part that cannot be read is NOT_MEASURED, never guessed.
 */
enum class Condition(val label: String, val rank: Int) {
    NOT_MEASURED("Not measured", -1), HEALTHY("Healthy", 0), WATCH("Watch", 1), DEGRADED("Worn", 2), REPLACEMENT_ADVISED("Replace", 3), CRITICAL("Critical", 4);
    fun worse(o: Condition) = if (o.rank > rank) o else this
}

enum class Action(val label: String, val short: String) {
    KEEP("Keep it", "KEEP"), MONITOR("Keep it and keep watching", "WATCH"), MAINTAIN("Keep it, fix the software", "FIX SOFTWARE"),
    REPAIR("Replace one part", "REPLACE A PART"), REPLACE("Replace the whole gadget", "REPLACE IT"),
}

data class Part(val key: String, val label: String, val condition: Condition, val headline: String, val evidence: List<String>, val action: String, val type: EvidenceType, val detail: String? = null)
data class Fact(val group: String, val label: String, val value: String, val type: EvidenceType = EvidenceType.MEASURED)
data class Verdict(val action: Action, val headline: String, val reasons: List<String>, val confidence: String, val score: Int)

enum class Kind(val label: String) { PHONE("Phone"), PC("Computer") }

data class GadgetReport(val kind: Kind, val id: String, val name: String, val model: String?, val takenAt: Long, val parts: List<Part>, val facts: List<Fact>, val age: AgeView, val verdict: Verdict, val findingsOpen: Int)

/** How old, in words that never claim more than is known. */
data class AgeView(val headline: String, val lines: List<String>, val approxYears: Double?, val confidence: String)

object Decide {
    /**
     * [ageYears] is the best available figure (see [AgeView]); null means unknown. [unsupported] is true when the maker no longer ships security updates.
     * [openProblems] counts software findings that need attention.
     */
    fun verdict(kind: Kind, ageYears: Double?, parts: List<Part>, unsupported: Boolean, openProblems: Int, limits: List<String> = emptyList()): Verdict {
        val old = ageYears != null && ageYears >= (if (kind == Kind.PHONE) 4.0 else 5.0)
        val hw = parts.filter { it.key != "software" && it.key != "security" && it.key != "space" }
        val bad = hw.filter { it.condition.rank >= Condition.REPLACEMENT_ADVISED.rank }
        val critical = hw.filter { it.condition == Condition.CRITICAL }
        val signals = ArrayList<Pair<Int, String>>()
        bad.forEach { signals.add((if (old) 2 else 1) to "${it.label} needs replacing (${it.headline.lowercase()})${if (old) " on an older gadget" else ""}.") }
        if (unsupported) signals.add(2 to "The maker no longer ships security updates for this ${kind.label.lowercase()}.")
        val worn = hw.count { it.condition == Condition.DEGRADED }
        if (worn >= 2) signals.add(1 to "$worn parts show wear.")
        if (openProblems >= 4) signals.add(1 to "$openProblems open problems.")
        if (limits.isNotEmpty() && old) signals.add(1 to "Hardware limits (${limits.joinToString(", ")}) on an older gadget.")
        val score = signals.sumOf { it.first }
        val reasons = signals.map { it.second }.toMutableList()
        val measured = parts.count { it.condition != Condition.NOT_MEASURED }
        val conf = when { ageYears != null && measured >= 4 -> "HIGH"; measured >= 3 -> "MEDIUM"; else -> "LOW" }
        val (action, head) = when {
            score >= 4 || (critical.size >= 2) -> Action.REPLACE to "Not worth putting more money into"
            bad.size == 1 && !old -> { reasons.add(0, "One part is worn out; the rest is in good condition."); Action.REPAIR to "Replace the ${bad[0].label.lowercase()}" }
            bad.isNotEmpty() -> { reasons.add(0, "Parts that need replacing: ${bad.joinToString(", ") { it.label.lowercase() }}."); Action.REPAIR to "Replace the ${bad.joinToString(" and ") { it.label.lowercase() }}" }
            unsupported -> { reasons.add(0, "The hardware is serviceable but it no longer gets security fixes."); Action.REPLACE to "Safe to use offline, not to trust" }
            openProblems > 0 -> { reasons.add(0, "The hardware is serviceable; software problems can be fixed."); Action.MAINTAIN to "Fine, with problems to fix" }
            hw.any { it.condition.rank >= Condition.WATCH.rank } -> { reasons.add(0, "Nothing needs replacing yet, but ${hw.filter { it.condition.rank >= Condition.WATCH.rank }.joinToString(", ") { it.label.lowercase() }} is showing wear."); Action.MONITOR to "Good for now, watch the wear" }
            else -> { reasons.add(0, "No part shows wear that needs action."); Action.KEEP to if (old) "Old but healthy" else "Healthy" }
        }
        return Verdict(action, head, reasons, conf, score)
    }

    // ---- part rules (the thresholds Windows uses for the same parts) ----
    fun batteryByCapacity(pct: Int?, cycles: Int?): Pair<Condition, List<String>> {
        val ev = ArrayList<String>(); var c = Condition.NOT_MEASURED
        if (pct != null) { ev.add("Holds about $pct% of its design capacity."); c = when { pct >= 80 -> Condition.HEALTHY; pct >= 65 -> Condition.WATCH; pct >= 50 -> Condition.REPLACEMENT_ADVISED; else -> Condition.CRITICAL } }
        if (cycles != null) { ev.add("$cycles charge cycles recorded."); val cc = if (cycles > 1000) Condition.DEGRADED else if (cycles > 800) Condition.WATCH else Condition.HEALTHY; c = if (c == Condition.NOT_MEASURED) cc else c.worse(cc) }
        return c to ev
    }
    fun driveByWear(percentUsed: Int?, health: String?, hours: Double?): Pair<Condition, List<String>> {
        val ev = ArrayList<String>(); var c = Condition.NOT_MEASURED
        fun bump(x: Condition, why: String) { c = if (c == Condition.NOT_MEASURED) x else c.worse(x); ev.add(why) }
        if (health == "Unhealthy") bump(Condition.CRITICAL, "Windows reports the drive as Unhealthy.") else if (health == "Warning") bump(Condition.DEGRADED, "Windows reports a health warning.") else if (health == "Healthy") bump(Condition.HEALTHY, "Windows reports the drive as healthy.")
        if (percentUsed != null) { val x = when { percentUsed >= 100 -> Condition.CRITICAL; percentUsed >= 90 -> Condition.REPLACEMENT_ADVISED; percentUsed >= 80 -> Condition.DEGRADED; percentUsed >= 50 -> Condition.WATCH; else -> Condition.HEALTHY }; bump(x, "$percentUsed% of the rated write life is used.") }
        if (hours != null) ev.add("Powered on for ${"%,d".format(hours.toLong())} hours (about ${"%.1f".format(hours / 8760.0)} years of running time).")
        return c to ev
    }
}
