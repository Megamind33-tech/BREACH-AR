using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Breach.Core.Diagnostics
{
    /// <summary>
    /// Ordered key/value sections rendered as a plain-text test report the
    /// tester can paste back without knowing anything about Unity.
    /// </summary>
    public sealed class DiagnosticsReport
    {
        readonly List<(string section, List<(string key, string value)> rows)> _sections = new();

        public DiagnosticsReport Section(string name)
        {
            _sections.Add((name, new List<(string, string)>()));
            return this;
        }

        public DiagnosticsReport Row(string key, string value)
        {
            if (_sections.Count == 0) Section("GENERAL");
            _sections[_sections.Count - 1].rows.Add((key, value ?? "UNKNOWN"));
            return this;
        }

        public DiagnosticsReport Row(string key, float value, string format = "0.0") =>
            Row(key, value.ToString(format, CultureInfo.InvariantCulture));

        public DiagnosticsReport Row(string key, bool value) => Row(key, value ? "yes" : "no");

        public IReadOnlyList<(string section, List<(string key, string value)> rows)> Sections => _sections;

        public string ToText(string title = "BREACH AR TEST REPORT")
        {
            var sb = new StringBuilder();
            sb.AppendLine(title);
            sb.AppendLine(new string('=', title.Length));
            foreach (var (section, rows) in _sections)
            {
                sb.AppendLine();
                sb.AppendLine("[" + section + "]");
                int pad = 0;
                foreach (var (k, _) in rows) pad = System.Math.Max(pad, k.Length);
                foreach (var (k, v) in rows) sb.Append(k.PadRight(pad + 2)).AppendLine(v);
            }
            return sb.ToString();
        }
    }
}
