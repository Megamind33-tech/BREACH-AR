package com.viro.workcare.rescue

import com.viro.workcare.data.DeviceHealth
import com.viro.workcare.data.Evidence
import com.viro.workcare.data.Finding
import com.viro.workcare.data.Severity

/**
 * WorkCare Rescue selects, from a device's real findings, the ones that can explain a symptom. It adds no readings and no warnings of its own: every
 * conclusion cites findings the shared rules (or the desktop analyzers) already produced, and it states what looks fine and what could not be measured.
 */
enum class Symptom(val label: String, val prefixes: List<String>) {
    SLOW("Computer is slow", listOf("cpu.throttling", "cpu.temperature", "thermal.", "memory.", "storage.free_space", "storage.system_low", "perf.", "storage.health", "storage.nvme")),
    HOT("It is running hot", listOf("cpu.throttling", "cpu.temperature", "thermal.", "battery.temperature", "storage.hot", "storage.warm")),
    BATTERY("Battery drains quickly", listOf("battery.", "perf.")),
    FREEZES("It freezes", listOf("storage.", "memory.", "cpu.throttling", "cpu.temperature", "reliability.", "perf.ram")),
    CRASHES("It crashes", listOf("reliability.", "storage.", "memory.", "drivers.", "cpu.temperature")),
    STORAGE("Storage is full", listOf("storage.free_space", "storage.system_low", "storage.")),
    INTERNET("Internet is slow", emptyList()),
    OTHER("Something else", emptyList());
}

class RescueOutcome(
    val symptom: Symptom, val causeFound: Boolean, val title: String, val explanation: String, val evidence: List<Evidence>, val finding: Finding?,
    val steps: List<String>, val ruledOut: List<String>, val notMeasured: List<String>, val honestLimit: String?,
)

object RescueRules {
    fun evaluate(symptom: Symptom, h: DeviceHealth): RescueOutcome {
        if (symptom == Symptom.INTERNET) return RescueOutcome(symptom, false, "WorkCare cannot test internet speed yet", "A speed test needs a measurement WorkCare does not take. Nothing here can tell you the connection is the cause or is not.", emptyList(), null,
            listOf("Restart the router and test again.", "Compare another device on the same network."), emptyList(), listOf("Network speed"), "Not measured")
        val relevant = if (symptom == Symptom.OTHER) h.findings else h.findings.filter { f -> symptom.prefixes.any { f.id.startsWith(it) } }
        val problems = relevant.filter { it.severity != Severity.HEALTHY }.sortedWith(compareByDescending<Finding> { it.severity.ordinal }.thenBy { f -> symptom.prefixes.indexOfFirst { f.id.startsWith(it) }.let { if (it < 0) 99 else it } })
        val ruledOut = relevant.filter { it.severity == Severity.HEALTHY }.map { it.title }.distinct()
        val unmeasured = h.components.filter { !it.available }.map { it.label } + h.notMeasured.take(3)
        val top = problems.firstOrNull()
        if (top == null) return RescueOutcome(symptom, false, "No clear cause found", "The checks WorkCare has run do not explain ${symptom.label.lowercase()}. That does not mean nothing is wrong: it means these checks found nothing.",
            emptyList(), null, listOf("Run a deeper check if one is available for this device.", "Note when the problem happens and what you were doing."), ruledOut, unmeasured.distinct(), null)
        val steps = problems.mapNotNull { it.action }.distinct().take(3)
        return RescueOutcome(symptom, true, top.title, top.summary, top.evidence, top, steps, ruledOut, unmeasured.distinct(), null)
    }
}
