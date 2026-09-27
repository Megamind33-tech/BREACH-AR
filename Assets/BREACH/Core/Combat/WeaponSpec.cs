namespace Breach.Core.Combat
{
    /// <summary>
    /// Tunable description of a single hitscan rifle. Values are in SI units
    /// (seconds, metres, degrees). BREACH ships exactly one rifle for now.
    /// </summary>
    public sealed class WeaponSpec
    {
        public string Id = "br-rifle-556";
        public string DisplayName = "BR-16";
        public int MagazineSize = 30;
        public int StartingReserve = 120;
        public bool InfiniteReserve;
        public float RoundsPerMinute = 690f;
        /// <summary>Reload when the magazine still holds a round (chamber kept).</summary>
        public float TacticalReloadSeconds = 1.85f;
        /// <summary>Reload from an empty magazine (bolt must be released).</summary>
        public float EmptyReloadSeconds = 2.45f;
        public float Damage = 34f;
        public float Range = 60f;

        // Recoil is expressed as an aim offset (degrees) because the AR camera
        // pose belongs to the real device and cannot be kicked.
        public float RecoilPitchPerShot = 0.55f;
        public float RecoilYawJitter = 0.28f;
        public float RecoilMaxPitch = 4.5f;
        public float RecoilRecoveryPerSecond = 9f;
        public float BaseSpreadDegrees = 0.15f;
        public float SpreadPerShot = 0.12f;
        public float MaxSpreadDegrees = 1.6f;
        public float SpreadRecoveryPerSecond = 3.5f;

        public float SecondsBetweenShots => 60f / RoundsPerMinute;

        public static WeaponSpec DefaultRifle() => new WeaponSpec();
    }
}
