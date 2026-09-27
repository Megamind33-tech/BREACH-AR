using System;

namespace Breach.Core.Match
{
    public enum MatchMode
    {
        /// <summary>Hunter can kill the player; score kills until death.</summary>
        Hunt,
        /// <summary>No player death, infinite reserve — learn the rifle and the Hunter.</summary>
        Training,
    }

    public enum MatchPhase
    {
        Idle,
        Scanning,
        Countdown,
        Live,
        /// <summary>Hunter down — short breath before the next encounter.</summary>
        Intermission,
        PlayerDown,
        Ended,
    }

    public sealed class MatchConfig
    {
        public MatchMode Mode = MatchMode.Hunt;
        public float CountdownSeconds = 3f;
        public float IntermissionSeconds = 3.5f;
        public float PlayerMaxHealth = 100f;
        public float PlayerRegenDelay = 4.5f;
        public float PlayerRegenPerSecond = 9f;
        public float PlayerHitInvulnerability = 0.35f;
    }

    /// <summary>
    /// Phase flow, score, timers and statistics for one match.
    /// Pattern reference: ShootAR (MIT) GameState events + ScoreManager, rewritten.
    /// </summary>
    public sealed class MatchState
    {
        public MatchConfig Config { get; }
        public MatchPhase Phase { get; private set; } = MatchPhase.Idle;
        public int Score { get; private set; }
        public int Kills { get; private set; }
        public int Headshots { get; private set; }
        public int ShotsFired { get; private set; }
        public int ShotsHit { get; private set; }
        public int Encounter { get; private set; }
        public double LiveSeconds { get; private set; }
        public float DamageTaken { get; private set; }

        double _phaseStarted;

        public event Action<MatchPhase, MatchPhase> PhaseChanged;
        public event Action<int> ScoreChanged;
        /// <summary>Raised when a new encounter should begin (spawn the Hunter). Arg: encounter index.</summary>
        public event Action<int> EncounterStarted;

        public MatchState(MatchConfig config)
        {
            Config = config ?? new MatchConfig();
        }

        public float Accuracy => ShotsFired == 0 ? 0f : (float)ShotsHit / ShotsFired;
        public double PhaseElapsed(double now) => now - _phaseStarted;

        public float CountdownRemaining(double now) =>
            Phase == MatchPhase.Countdown ? (float)Math.Max(0, Config.CountdownSeconds - PhaseElapsed(now)) : 0f;

        void SetPhase(MatchPhase next, double now)
        {
            if (next == Phase) return;
            var prev = Phase;
            Phase = next;
            _phaseStarted = now;
            PhaseChanged?.Invoke(prev, next);
        }

        public void BeginScanning(double now)
        {
            Score = Kills = Headshots = ShotsFired = ShotsHit = Encounter = 0;
            LiveSeconds = 0;
            DamageTaken = 0;
            SetPhase(MatchPhase.Scanning, now);
        }

        /// <summary>Room is scanned and the safe area confirmed.</summary>
        public void ArenaReady(double now)
        {
            if (Phase == MatchPhase.Scanning) SetPhase(MatchPhase.Countdown, now);
        }

        public void Tick(double now, float dt)
        {
            switch (Phase)
            {
                case MatchPhase.Countdown:
                    if (PhaseElapsed(now) >= Config.CountdownSeconds) StartEncounter(now);
                    break;
                case MatchPhase.Live:
                    LiveSeconds += dt;
                    break;
                case MatchPhase.Intermission:
                    LiveSeconds += dt;
                    if (PhaseElapsed(now) >= Config.IntermissionSeconds) StartEncounter(now);
                    break;
            }
        }

        void StartEncounter(double now)
        {
            SetPhase(MatchPhase.Live, now);
            EncounterStarted?.Invoke(Encounter);
        }

        public void RecordShot(bool hit, bool headshot)
        {
            // Intermission included: the killing round resolves after the phase flips.
            if (Phase != MatchPhase.Live && Phase != MatchPhase.Intermission) return;
            ShotsFired++;
            if (hit) ShotsHit++;
            if (hit && headshot) Headshots++;
        }

        public void RecordDamageTaken(float amount)
        {
            if (amount > 0) DamageTaken += amount;
        }

        public void HunterKilled(int killScore, bool headshot, int headshotBonus, double now)
        {
            if (Phase != MatchPhase.Live) return;
            Kills++;
            int gained = killScore + (headshot ? headshotBonus : 0);
            Score += gained;
            ScoreChanged?.Invoke(Score);
            Encounter++;
            SetPhase(MatchPhase.Intermission, now);
        }

        public void PlayerKilled(double now)
        {
            if (Config.Mode == MatchMode.Training) return;
            if (Phase == MatchPhase.Live || Phase == MatchPhase.Intermission)
                SetPhase(MatchPhase.PlayerDown, now);
        }

        public void End(double now) => SetPhase(MatchPhase.Ended, now);
        public void Abort(double now) => SetPhase(MatchPhase.Idle, now);
    }
}
