using System.Text.Json;

namespace Viro.Agent;

/// <summary>Bounded, file-backed FIFO of heartbeat payloads captured while the server is unreachable (survives reboot).</summary>
public sealed class OfflineQueue(string path, int capacity = 2880)
{
    readonly object _gate = new();

    public void Enqueue(JsonElement item)
    {
        lock (_gate)
        {
            var lines = Read();
            lines.Add(item.GetRawText());
            if (lines.Count > capacity) lines.RemoveRange(0, lines.Count - capacity);
            Write(lines);
        }
    }

    public int Count { get { lock (_gate) return Read().Count; } }

    /// <summary>Send oldest-first; an exception from <paramref name="send"/> propagates and leaves the rest queued.</summary>
    public async Task<int> DrainAsync(Func<JsonElement, Task> send)
    {
        var sent = 0;
        while (true)
        {
            string head;
            lock (_gate) { var l = Read(); if (l.Count == 0) return sent; head = l[0]; }
            using var doc = JsonDocument.Parse(head);
            await send(doc.RootElement.Clone());
            lock (_gate) { var l = Read(); if (l.Count > 0) l.RemoveAt(0); Write(l); }
            sent++;
        }
    }

    List<string> Read() => File.Exists(path) ? [.. File.ReadAllLines(path).Where(l => l.Length > 0)] : [];
    void Write(List<string> lines)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllLines(path, lines);
    }
}

/// <summary>Which failures are worth retrying later. A 4xx (other than timeout/throttle/auth) means the server will never accept that message.</summary>
public static class Transient
{
    public static bool IsPermanentRejection(HttpRequestException e) =>
        e.StatusCode is { } c && (int)c is >= 400 and < 500 and not (401 or 408 or 429);
}
