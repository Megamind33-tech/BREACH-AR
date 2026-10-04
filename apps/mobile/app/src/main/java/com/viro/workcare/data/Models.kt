package com.viro.workcare.data

import org.json.JSONArray
import org.json.JSONObject

/* Twin contracts (schema version 1), hand-mapped from packages/contracts. Readers ignore unknown fields and refuse a schema version they do not know. */
const val SCHEMA_VERSION = 1

class ContractException(message: String) : Exception(message)

enum class Severity { HEALTHY, ATTENTION, CRITICAL;
    companion object { fun parse(s: String?) = when (s) { "critical" -> CRITICAL; "attention" -> ATTENTION; else -> HEALTHY } }
    fun worse(o: Severity) = if (ordinal >= o.ordinal) this else o
}
enum class EvidenceType(val label: String) { MEASURED("MEASURED"), TESTED("TESTED"), INFERRED("INFERRED");
    companion object { fun parse(s: String?) = when (s) { "tested" -> TESTED; "inferred" -> INFERRED; else -> MEASURED } }
}
enum class Freshness { LIVE, RECENT, STALE, NEVER;
    companion object { fun parse(s: String?) = when (s) { "live" -> LIVE; "recent" -> RECENT; "stale" -> STALE; else -> NEVER } }
}
enum class Component(val key: String, val label: String) {
    PROCESSOR("processor", "Processor"), MEMORY("memory", "Memory"), STORAGE("storage", "Storage"), BATTERY("battery", "Battery"), GRAPHICS("graphics", "Graphics"),
    COOLING("cooling", "Cooling"), NETWORK("network", "Network"), WINDOWS("windows", "Windows"), SECURITY("security", "Security"), DISPLAY("display", "Display"),
    SYSTEM("system", "System"), APPS("apps", "Apps"), SENSORS("sensors", "Sensors");
    companion object { fun parse(s: String?) = entries.firstOrNull { it.key == s } ?: SYSTEM }
}

data class Evidence(val name: String, val value: String, val unit: String?)
/** Essentials are free and always include anything that is a safety problem. Deep checks look further and are part of WorkCare Plus. */
enum class Tier { ESSENTIAL, DEEP }
data class Finding(val id: String, val component: Component, val severity: Severity, val title: String, val summary: String, val type: EvidenceType, val evidence: List<Evidence>, val action: String?, val tier: Tier = Tier.ESSENTIAL)
data class ComponentHealth(val component: Component, val label: String, val detail: String?, val severity: Severity?, val unavailableReason: String?, val findingIds: List<String>) {
    val available get() = severity != null
}
data class DeviceSummary(val id: String, val name: String, val model: String?, val status: Severity, val headline: String, val lastSeenAt: String?, val freshness: Freshness, val isThisDevice: Boolean, val isPhone: Boolean)
data class DeviceHealth(val id: String, val status: Severity, val headline: String, val components: List<ComponentHealth>, val findings: List<Finding>, val notMeasured: List<String>, val lastSeenAt: String?, val freshness: Freshness)
data class PassportEvent(val id: String, val at: String, val kind: String, val title: String, val detail: String?, val origin: String)
data class AlertItem(val id: String, val deviceId: String, val severity: Severity, val title: String, val summary: String, val openedAt: String)
data class ComputeStatus(val available: Boolean, val enabledByPolicy: Boolean, val state: String?, val reason: String?, val cpuCapPercent: Double?, val cpuTempC: Double?, val gate: String?, val consentRecorded: Boolean, val canPause: Boolean, val canResume: Boolean)

private fun JSONObject.str(k: String): String? = if (isNull(k)) null else optString(k).ifEmpty { null }
private inline fun <T> JSONArray?.mapObjects(f: (JSONObject) -> T): List<T> { val a = this ?: return emptyList(); return (0 until a.length()).map { f(a.getJSONObject(it)) } }
private fun JSONObject.requireVersion() { if (has("schemaVersion") && optInt("schemaVersion", SCHEMA_VERSION) != SCHEMA_VERSION) throw ContractException("This app and the server use different WorkCare data versions. Update WorkCare.") }

fun parseFinding(o: JSONObject) = Finding(
    id = o.getString("id"), component = Component.parse(o.str("component")), severity = Severity.parse(o.str("severity")), title = o.optString("title"), summary = o.optString("summary"),
    type = EvidenceType.parse(o.str("evidenceType")),
    evidence = o.optJSONArray("evidence").mapObjects { e -> Evidence(e.getString("name"), e.get("value").toString(), e.str("unit")) }, action = o.str("recommendedAction"),
    tier = if (o.optString("tier") == "deep") Tier.DEEP else Tier.ESSENTIAL,
)
fun parseDevices(o: JSONObject): List<DeviceSummary> = o.optJSONArray("devices").mapObjects(::parseDeviceSummary)
fun parseDeviceSummary(o: JSONObject): DeviceSummary { o.requireVersion(); return DeviceSummary(o.getString("deviceId"), o.getString("name"), o.str("model"), Severity.parse(o.str("status")), o.optString("headline"), o.str("lastSeenAt"), Freshness.parse(o.str("freshness")), o.optBoolean("isThisDevice"), o.optString("kind") == "phone") }
fun parseDeviceHealth(o: JSONObject): DeviceHealth {
    o.requireVersion()
    val comps = o.optJSONArray("components").mapObjects { c ->
        val st = c.optString("status")
        ComponentHealth(Component.parse(c.str("component")), c.optString("label"), c.str("detail"), if (st == "unavailable") null else Severity.parse(st), c.str("unavailableReason"), c.optJSONArray("findingIds").let { a -> if (a == null) emptyList() else (0 until a.length()).map { a.getString(it) } })
    }
    return DeviceHealth(o.getString("deviceId"), Severity.parse(o.str("status")), o.optString("headline"), comps, o.optJSONArray("findings").mapObjects(::parseFinding),
        o.optJSONArray("notMeasured").let { a -> if (a == null) emptyList() else (0 until a.length()).map { a.getString(it) } }, o.str("lastSeenAt"), Freshness.parse(o.str("freshness")))
}
fun parsePassport(o: JSONObject): List<PassportEvent> = o.optJSONArray("events").mapObjects { e -> PassportEvent(e.getString("id"), e.getString("at"), e.optString("kind"), e.optString("title"), e.str("detail"), e.optString("origin")) }
fun parseAlerts(o: JSONObject): List<AlertItem> = o.optJSONArray("alerts").mapObjects { a -> AlertItem(a.getString("id"), a.getString("deviceId"), Severity.parse(a.str("severity")), a.optString("title"), a.optString("summary"), a.optString("openedAt")) }
fun parseCompute(o: JSONObject) = ComputeStatus(o.optBoolean("available"), o.optBoolean("enabledByPolicy"), o.str("state"), o.str("reason"), if (o.isNull("cpuCapPercent")) null else o.optDouble("cpuCapPercent"), if (o.isNull("cpuTempC")) null else o.optDouble("cpuTempC"),
    o.str("gate"), o.optBoolean("consentRecorded"), o.optBoolean("canPause"), o.optBoolean("canResume"))
