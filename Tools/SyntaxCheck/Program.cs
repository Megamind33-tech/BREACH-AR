using System;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

var root = args.Length > 0 ? args[0] : "../../Assets";
var opts = new CSharpParseOptions(LanguageVersion.CSharp9, preprocessorSymbols: new[] { "UNITY_ANDROID" });
int files = 0, errors = 0;
foreach (var path in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories).OrderBy(p => p))
{
    files++;
    var tree = CSharpSyntaxTree.ParseText(File.ReadAllText(path), opts, path);
    foreach (var d in tree.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error))
    {
        errors++;
        Console.WriteLine($"{d.Location.GetLineSpan().Path}:{d.Location.GetLineSpan().StartLinePosition.Line + 1}: {d.Id} {d.GetMessage()}");
    }
}
Console.WriteLine($"syntax check: {files} files, {errors} errors");
return errors == 0 ? 0 : 1;
