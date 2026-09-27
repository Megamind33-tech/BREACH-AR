namespace Breach.Core.Hunter
{
    public sealed class HunterConfig
    {
        public float MaxHealth = 170f;

        public float StalkSpeed = 0.75f;
        public float RepositionSpeed = 2.0f;
        public float RushSpeed = 3.1f;
        public float RetreatSpeed = 2.3f;
        /// <summary>Speed multiplier while the player cannot see the Hunter — it relocates fast when unobserved.</summary>
        public float UnobservedSpeedMultiplier = 1.8f;

        public float EmergeSeconds = 1.1f;
        public float AttackRange = 1.05f;
        public float AttackWindupSeconds = 0.5f;
        public float AttackRecoverSeconds = 0.45f;
        public float AttackDamage = 24f;
        /// <summary>Strike still lands if the player backs off slightly during the wind-up.</summary>
        public float AttackReachTolerance = 1.35f;

        public float StaggerDamageThreshold = 45f;
        public float StaggerWindowSeconds = 0.8f;
        public float StaggerSeconds = 0.55f;

        /// <summary>Seconds the player can keep eyes on a stalking Hunter before it reacts.</summary>
        public float ExposureTolerance = 1.4f;
        public float RushTriggerDistance = 2.2f;
        public float StalkTimeoutSeconds = 7f;
        public float RushTimeoutSeconds = 4f;
        public float RepositionTimeoutSeconds = 3.5f;
        public float RetreatTimeoutSeconds = 2.6f;

        public float StalkRingMin = 1.6f;
        public float StalkRingMax = 3.6f;

        /// <summary>0..1 — probability-weighted preference for rushing over repositioning.</summary>
        public float Aggression = 0.35f;

        public int KillScore = 100;
        public int HeadshotKillBonus = 50;

        /// <summary>Each encounter the Hunter grows bolder and faster, capped.</summary>
        public static HunterConfig ForEncounter(int encounterIndex)
        {
            var c = new HunterConfig();
            float t = System.Math.Clamp(encounterIndex / 8f, 0f, 1f);
            c.Aggression = 0.3f + 0.45f * t;
            c.StalkSpeed *= 1f + 0.25f * t;
            c.RushSpeed *= 1f + 0.15f * t;
            c.ExposureTolerance *= 1f - 0.35f * t;
            c.AttackWindupSeconds *= 1f - 0.2f * t;
            return c;
        }
    }
}
