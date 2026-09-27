using System;
using System.Net;

namespace Breach.Core.Net
{
    /// <summary>
    /// Human-friendly LAN room codes. The host's IPv4 address on the shared
    /// Wi-Fi is shown as its last two octets ("1.37"); the joining phone
    /// fills in the first two from its own address. A bare last octet ("37")
    /// assumes the same /24 as the joiner.
    /// </summary>
    public static class RoomCode
    {
        public static string FromAddress(IPAddress hostAddress)
        {
            var b = hostAddress.GetAddressBytes();
            if (b.Length != 4) throw new ArgumentException("IPv4 only", nameof(hostAddress));
            return $"{b[2]}.{b[3]}";
        }

        public static bool TryResolve(string code, IPAddress localAddress, out IPAddress hostAddress)
        {
            hostAddress = null;
            if (string.IsNullOrWhiteSpace(code) || localAddress == null) return false;
            var local = localAddress.GetAddressBytes();
            if (local.Length != 4) return false;
            var parts = code.Trim().Split('.');
            if (parts.Length == 4 && IPAddress.TryParse(code.Trim(), out var full))
            {
                hostAddress = full;
                return true;
            }
            if (parts.Length == 1 && byte.TryParse(parts[0], out var d))
            {
                hostAddress = new IPAddress(new[] { local[0], local[1], local[2], d });
                return true;
            }
            if (parts.Length == 2 && byte.TryParse(parts[0], out var c) && byte.TryParse(parts[1], out var d2))
            {
                hostAddress = new IPAddress(new[] { local[0], local[1], c, d2 });
                return true;
            }
            return false;
        }
    }
}
