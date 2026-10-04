using System.Collections.Concurrent;

namespace Viro.Agent;

/// <summary>Minimal daily-rotating file log (ProgramData\Viro\Agent\logs). Keeps 14 days; never throws into the caller.</summary>
public static class FileLog
{
    public static string LogDir => Path.Combine(AgentConfig.DataDir, "logs");
}

public sealed class FileLoggerProvider : ILoggerProvider
{
    readonly string _dir; readonly object _gate = new(); DateTime _lastPrune = DateTime.MinValue;
    public FileLoggerProvider(string? dir = null) { _dir = dir ?? FileLog.LogDir; }
    public ILogger CreateLogger(string category) => new L(this, category);
    public void Dispose() { }

    void Write(string line)
    {
        try
        {
            lock (_gate)
            {
                Directory.CreateDirectory(_dir);
                File.AppendAllText(Path.Combine(_dir, $"agent-{DateTime.UtcNow:yyyyMMdd}.log"), line + Environment.NewLine);
                if (DateTime.UtcNow - _lastPrune > TimeSpan.FromHours(6))
                {
                    _lastPrune = DateTime.UtcNow;
                    foreach (var f in Directory.EnumerateFiles(_dir, "agent-*.log")) if (File.GetLastWriteTimeUtc(f) < DateTime.UtcNow.AddDays(-14)) File.Delete(f);
                }
            }
        }
        catch { /* logging must never break the agent */ }
    }

    sealed class L(FileLoggerProvider p, string cat) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => level >= LogLevel.Information;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? ex, Func<TState, Exception?, string> fmt)
        {
            if (!IsEnabled(level)) return;
            var msg = fmt(state, ex);
            p.Write($"{DateTime.UtcNow:O} [{level.ToString()[..3].ToUpperInvariant()}] {cat.Split('.').Last()}: {msg}{(ex is null ? "" : " | " + ex)}");
        }
    }
}
