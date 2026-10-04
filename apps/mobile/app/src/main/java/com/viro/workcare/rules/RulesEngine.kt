package com.viro.workcare.rules

import com.viro.workcare.data.Component
import com.viro.workcare.data.Evidence
import com.viro.workcare.data.EvidenceType
import com.viro.workcare.data.Finding
import com.viro.workcare.data.Severity
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.floor

/**
 * Evaluator for the shared rule set (packages/health-rules/rules.json). It must produce exactly what the TypeScript reference and the C# evaluator in QuickCheck produce;
 * the shared vectors (vectors.json) are executed against this file in RulesEngineTest. A rule whose input is unreadable is skipped, never guessed.
 */
class RulesEngine(rulesJson: String) {
    private val rules: JSONArray = JSONObject(rulesJson).getJSONArray("rules")
    val version: Int = JSONObject(rulesJson).getInt("rulesetVersion")

    class Result(val findings: List<Finding>, val skipped: List<String>)

    fun evaluate(inventory: JSONObject): Result {
        val findings = ArrayList<Finding>(); val skipped = LinkedHashSet<String>()
        for (ri in 0 until rules.length()) {
            val rule = rules.getJSONObject(ri); val id = rule.getString("id")
            val items: List<Triple<Any?, String, String>> = if (rule.has("each")) {
                val arr = get(inventory, rule.getString("each")) as? JSONArray
                if (arr == null) emptyList() else (0 until arr.length()).map { i -> val it = arr.optJSONObject(i); Triple(it as Any?, ".$i", it?.optString("model")?.takeIf { m -> m.isNotEmpty() && !it.isNull("model") } ?: "Drive ${i + 1}") }
            } else listOf(Triple(inventory as Any?, "", ""))
            if (items.isEmpty()) skipped.add(id)
            for ((ctx, suffix, label) in items) {
                val value = metricOf(rule, ctx)
                if (value == null) { skipped.add(id); continue }
                val bands = rule.getJSONArray("bands")
                var band: JSONObject? = null
                for (bi in 0 until bands.length()) { val b = bands.getJSONObject(bi); if (matches(b, value)) { band = b; break } }
                if (band == null) continue
                val sev = band.getString("severity"); if (sev == "none") continue
                fun text(t: String) = t.replaceFirst("{value}", fmt(value)).replaceFirst("{item}", label)
                val evidence = ArrayList<Evidence>(); val refs = rule.getJSONArray("evidence")
                for (ei in 0 until refs.length()) {
                    val e = refs.getJSONObject(ei)
                    val v: Any? = if (e.optBoolean("metric")) value else get(ctx, e.optString("path"))
                    if (v == null || v == JSONObject.NULL) continue
                    val shown = if (v is Number) fmtNumber(v.toDouble()) else v.toString()
                    evidence.add(Evidence(e.getString("name"), shown, if (e.has("unit")) e.getString("unit") else null))
                }
                findings.add(Finding(id + suffix, Component.parse(rule.getString("component")), Severity.parse(sev), text(band.getString("title")), text(band.getString("summary")),
                    EvidenceType.parse(rule.getString("evidenceType")), evidence, if (band.has("action")) band.getString("action") else null,
                    if (rule.optString("tier") == "deep") com.viro.workcare.data.Tier.DEEP else com.viro.workcare.data.Tier.ESSENTIAL))
            }
        }
        return Result(findings, skipped.toList())
    }

    // ------------------------------------------------------------------------------------------ helpers
    private fun get(root: Any?, path: String): Any? {
        var cur: Any? = root
        for (k in path.split('.')) { cur = if (cur is JSONObject && cur.has(k) && !cur.isNull(k)) cur.get(k) else return null }
        return cur
    }
    private fun num(v: Any?): Double? = (v as? Number)?.toDouble()?.takeIf { it.isFinite() }

    /** Number, String or Boolean; null when the input could not be read. */
    private fun metricOf(rule: JSONObject, ctx: Any?): Any? {
        val m = rule.getJSONObject("metric")
        if (m.has("ratioPct")) {
            val r = m.getJSONArray("ratioPct"); val a = num(get(ctx, r.getString(0))); val b = num(get(ctx, r.getString(1)))
            return if (a != null && b != null && b > 0) Math.round(a / b * 100.0 * 1e6) / 1e6 else null
        }
        val v = get(ctx, m.getString("path"))
        num(v)?.let { return if (m.has("scale")) it * m.getDouble("scale") else it }
        return if (v is String || v is Boolean) v else null
    }
    private fun matches(b: JSONObject, v: Any): Boolean {
        if (b.has("eq")) return b.get("eq") == v || (b.get("eq") is Number && v is Number && (b.get("eq") as Number).toDouble() == v.toDouble())
        val d = (v as? Number)?.toDouble() ?: return false
        return (!b.has("lt") || d < b.getDouble("lt")) && (!b.has("gte") || d >= b.getDouble("gte")) && (!b.has("gt") || d > b.getDouble("gt"))
    }
    private fun fmtNumber(v: Double): String { val r = if (abs(v - Math.round(v)) < 1e-9) Math.round(v).toDouble() else Math.round(v * 10) / 10.0; return if (r == floor(r) && abs(r) < 1e15) r.toLong().toString() else r.toString() }
    private fun fmt(v: Any): String = if (v is Number) fmtNumber(v.toDouble()) else v.toString()
}
