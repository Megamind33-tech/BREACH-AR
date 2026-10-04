using System.Text.Json.Nodes;

namespace WorkCare.QuickCheck;

/// <summary>
/// C# evaluator for the shared rule set (packages/health-rules/rules.json). Behaviourally identical to the TypeScript reference and the Kotlin evaluator on the phone;
/// RulesConformanceTests runs every shared vector through this class. A rule whose input is unreadable is skipped and reported, never guessed.
/// </summary>
public sealed class RulesEvaluator
{
    readonly JsonArray _rules;
    public int Version { get; }
    public RulesEvaluator(string rulesJson) { var root = JsonNode.Parse(rulesJson)!.AsObject(); _rules = root["rules"]!.AsArray(); Version = root["rulesetVersion"]!.GetValue<int>(); }

    public sealed record Result(List<JsonObject> Findings, List<string> Skipped);

    /// <param name="includeDeep">False for the free scan: deep rules are neither evaluated nor reported as skipped.</param>
    public Result Evaluate(JsonNode inventory, bool includeDeep = true)
    {
        var findings = new List<JsonObject>(); var skipped = new List<string>();
        void Skip(string id) { if (!skipped.Contains(id)) skipped.Add(id); }
        foreach (var node in _rules)
        {
            var rule = node!.AsObject(); var id = rule["id"]!.GetValue<string>();
            if (!includeDeep && rule["tier"] is not null) continue;
            var items = new List<(JsonNode? ctx, string suffix, string label)>();
            if (rule["each"] is JsonNode each)
            {
                if (Get(inventory, each.GetValue<string>()) is JsonArray arr)
                    for (var i = 0; i < arr.Count; i++) items.Add((arr[i], "." + i, (arr[i] as JsonObject)?["model"] is JsonNode m && m.GetValueKind() == System.Text.Json.JsonValueKind.String && m.GetValue<string>().Length > 0 ? m.GetValue<string>() : $"Drive {i + 1}"));
                if (items.Count == 0) Skip(id);
            }
            else items.Add((inventory, "", ""));
            foreach (var (ctx, suffix, label) in items)
            {
                var value = MetricOf(rule, ctx);
                if (value is null) { Skip(id); continue; }
                JsonObject? band = null;
                foreach (var b in rule["bands"]!.AsArray()) if (Matches(b!.AsObject(), value)) { band = b.AsObject(); break; }
                if (band is null) continue;
                var sev = band["severity"]!.GetValue<string>(); if (sev == "none") continue;
                string Text(string t) { var v = Fmt(value); var i1 = t.IndexOf("{value}", StringComparison.Ordinal); if (i1 >= 0) t = t.Remove(i1, 7).Insert(i1, v); var i2 = t.IndexOf("{item}", StringComparison.Ordinal); if (i2 >= 0) t = t.Remove(i2, 6).Insert(i2, label); return t; }
                var evidence = new JsonArray();
                foreach (var en in rule["evidence"]!.AsArray())
                {
                    var e = en!.AsObject(); object? v = e["metric"]?.GetValue<bool>() == true ? value : Raw(Get(ctx, e["path"]?.GetValue<string>() ?? ""));
                    if (v is null) continue;
                    var ev = new JsonObject { ["name"] = e["name"]!.GetValue<string>() };
                    ev["value"] = v switch { double d => JsonValue.Create(double.Parse(Fmt(d), System.Globalization.CultureInfo.InvariantCulture)), bool b => JsonValue.Create(b), _ => JsonValue.Create(v.ToString()) };
                    if (e["unit"] is JsonNode u) ev["unit"] = u.GetValue<string>();
                    evidence.Add(ev);
                }
                var f = new JsonObject
                {
                    ["id"] = id + suffix, ["component"] = rule["component"]!.GetValue<string>(), ["severity"] = sev, ["title"] = Text(band["title"]!.GetValue<string>()), ["summary"] = Text(band["summary"]!.GetValue<string>()),
                    ["evidenceType"] = rule["evidenceType"]!.GetValue<string>(), ["evidence"] = evidence,
                };
                if (band["action"] is JsonNode act) f["recommendedAction"] = act.GetValue<string>();
                if (rule["tier"] is JsonNode tier) f["tier"] = tier.GetValue<string>();
                findings.Add(f);
            }
        }
        return new(findings, skipped);
    }

    // ------------------------------------------------------------------------------------------ helpers
    static JsonNode? Get(JsonNode? root, string path)
    {
        var cur = root;
        foreach (var k in path.Split('.')) { if (cur is JsonObject o && o.TryGetPropertyValue(k, out var n) && n is not null) cur = n; else return null; }
        return cur;
    }
    static object? Raw(JsonNode? n)
    {
        if (n is not JsonValue v) return null;
        return v.GetValueKind() switch { System.Text.Json.JsonValueKind.Number => NumberOf(v), System.Text.Json.JsonValueKind.True => true, System.Text.Json.JsonValueKind.False => false, System.Text.Json.JsonValueKind.String => v.GetValue<string>(), _ => null };
    }
    /// <summary>Inventory values built in code carry CLR types (int, long, float...) while parsed JSON carries doubles; read either.</summary>
    static double NumberOf(JsonValue v) => v.TryGetValue(out double d) ? d : v.TryGetValue(out long l) ? l : v.TryGetValue(out int i) ? i : v.TryGetValue(out decimal m) ? (double)m : v.TryGetValue(out float f) ? f : v.TryGetValue(out ulong u) ? u : double.Parse(v.ToJsonString(), System.Globalization.CultureInfo.InvariantCulture);
    static double? Num(JsonNode? n) => Raw(n) is double d && double.IsFinite(d) ? d : null;
    static object? MetricOf(JsonObject rule, JsonNode? ctx)
    {
        var m = rule["metric"]!.AsObject();
        if (m["ratioPct"] is JsonArray r)
        {
            var a = Num(Get(ctx, r[0]!.GetValue<string>())); var b = Num(Get(ctx, r[1]!.GetValue<string>()));
            return a is not null && b is not null && b > 0 ? Math.Round(a.Value / b.Value * 100.0 * 1e6) / 1e6 : null;
        }
        var v = Raw(Get(ctx, m["path"]!.GetValue<string>()));
        if (v is double d && double.IsFinite(d)) return m["scale"] is JsonNode s ? d * s.GetValue<double>() : d;
        return v is string or bool ? v : null;
    }
    static bool Matches(JsonObject b, object v)
    {
        if (b["eq"] is JsonNode eq)
        {
            var want = Raw(eq);
            return want switch { double wd => v is double vd && wd == vd, bool wb => v is bool vb && wb == vb, string ws => v is string vs && ws == vs, _ => false };
        }
        if (v is not double d) return false;
        return (b["lt"] is not JsonNode lt || d < lt.GetValue<double>()) && (b["gte"] is not JsonNode gte || d >= gte.GetValue<double>()) && (b["gt"] is not JsonNode gt || d > gt.GetValue<double>());
    }
    /// <summary>Same as the reference: integers print as integers, anything else rounds to one decimal.</summary>
    static string Fmt(object v)
    {
        if (v is not double d) return v.ToString() ?? "";
        var r = Math.Abs(d - Math.Round(d, MidpointRounding.AwayFromZero)) < 1e-9 ? Math.Round(d, MidpointRounding.AwayFromZero) : Math.Floor(d * 10 + 0.5) / 10;
        return r == Math.Floor(r) && Math.Abs(r) < 1e15 ? ((long)r).ToString(System.Globalization.CultureInfo.InvariantCulture) : r.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
    }
}
