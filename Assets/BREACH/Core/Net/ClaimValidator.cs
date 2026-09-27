using System;
using System.Collections.Generic;
using System.Numerics;

namespace Breach.Core.Net
{
    public enum ClaimVerdict
    {
        Accepted,
        RejectedNoTarget,
        RejectedStaleSpawn,
        RejectedTooFar,
        RejectedRate,
        RejectedDamage,
    }

    /// <summary>
    /// Host-side sanity check for a client's "I hit the Hunter" claim. The
    /// client resolves its own hit (it sees the Hunter where it renders it);
    /// the host accepts only plausible claims: right Hunter, near where the
    /// Hunter really was recently, not faster than the rifle can fire, and
    /// no more damage than one round can do.
    /// </summary>
    public sealed class ClaimValidator
    {
        readonly Dictionary<ulong, double> _lastClaim = new Dictionary<ulong, double>();
        readonly (double time, Vector3 pos)[] _history = new (double, Vector3)[64];
        int _histCount, _histHead;

        public float MaxDamagePerRound { get; set; } = 34f;
        public float MinSecondsBetweenClaims { get; set; } = 60f / 690f * 0.8f;
        /// <summary>Allowed distance between the claimed hit point and the Hunter's recent root positions.</summary>
        public float PositionTolerance { get; set; } = 1.6f;
        /// <summary>How far back the host looks for a matching Hunter position (covers latency + interpolation delay).</summary>
        public float HistorySeconds { get; set; } = 0.6f;

        public void RecordHunter(double time, Vector3 rootPosition)
        {
            _history[_histHead] = (time, rootPosition);
            _histHead = (_histHead + 1) % _history.Length;
            if (_histCount < _history.Length) _histCount++;
        }

        public void ResetHistory()
        {
            _histCount = 0;
            _histHead = 0;
        }

        public ClaimVerdict Validate(ulong client, double now, bool hunterAlive, ushort claimSpawnId, ushort currentSpawnId,
            Vector3 claimedPoint, float claimedDamage)
        {
            if (!hunterAlive) return ClaimVerdict.RejectedNoTarget;
            if (claimSpawnId != currentSpawnId) return ClaimVerdict.RejectedStaleSpawn;
            if (claimedDamage <= 0 || claimedDamage > MaxDamagePerRound * 1.001f) return ClaimVerdict.RejectedDamage;
            if (_lastClaim.TryGetValue(client, out var last) && now - last < MinSecondsBetweenClaims) return ClaimVerdict.RejectedRate;

            bool near = false;
            for (int i = 0; i < _histCount; i++)
            {
                var (t, p) = _history[i];
                if (now - t > HistorySeconds) continue;
                var flat = new Vector3(claimedPoint.X - p.X, 0, claimedPoint.Z - p.Z);
                float dy = claimedPoint.Y - p.Y;
                if (flat.Length() <= PositionTolerance && dy > -0.5f && dy < 2.6f)
                {
                    near = true;
                    break;
                }
            }
            if (!near) return ClaimVerdict.RejectedTooFar;
            _lastClaim[client] = now;
            return ClaimVerdict.Accepted;
        }
    }
}
