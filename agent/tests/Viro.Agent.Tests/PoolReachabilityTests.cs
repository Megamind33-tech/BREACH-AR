using Viro.Compute;
using Xunit;

public class PoolReachabilityTests
{
    static readonly DateTime T0 = new(2026, 10, 3, 12, 0, 0, DateTimeKind.Utc);

    [Fact] public void Not_running_yet_is_never_reported_as_unreachable() => Assert.Null(PoolReachability.Describe(null, null, T0, "pool.hashvault.pro"));

    [Fact] public void A_brand_new_run_gets_a_grace_period_before_being_called_unreachable()
    {
        Assert.Null(PoolReachability.Describe(T0, null, T0.AddSeconds(20), "pool.hashvault.pro"));
        Assert.NotNull(PoolReachability.Describe(T0, null, T0.AddSeconds(46), "pool.hashvault.pro"));
    }

    [Fact] public void The_reason_names_the_pool_and_blames_security_software_not_the_PC()
    {
        var r = PoolReachability.Describe(T0, null, T0.AddMinutes(2), "pool.hashvault.pro");
        Assert.Contains("pool.hashvault.pro", r); Assert.Contains("firewall or antivirus", r); Assert.Contains("does not work around security software", r);
    }

    [Fact] public void A_connection_that_was_working_gets_a_longer_grace_before_being_called_unreachable_again()
    {
        var connectedAt = T0.AddMinutes(5);
        Assert.Null(PoolReachability.Describe(T0, connectedAt, connectedAt.AddMinutes(2), "pool.hashvault.pro"));          // a brief drop is not reported
        Assert.NotNull(PoolReachability.Describe(T0, connectedAt, connectedAt.AddMinutes(4), "pool.hashvault.pro"));       // but a sustained one is
    }

    [Fact] public void A_missing_pool_host_still_produces_a_plain_words_reason() =>
        Assert.Contains("the configured pool", PoolReachability.Describe(T0, null, T0.AddMinutes(1), null));
}
