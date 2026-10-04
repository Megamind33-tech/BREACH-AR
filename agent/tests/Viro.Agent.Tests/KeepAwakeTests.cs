using Viro.Agent;
using Xunit;

public class KeepAwakeTests
{
    [Fact]
    public void A_power_request_is_taken_and_released_and_disposing_twice_is_harmless()
    {
        var k = new KeepAwake("Viro test");
        Assert.True(k.Active);          // the OS granted the request
        k.Dispose(); Assert.False(k.Active);
        k.Dispose();
    }
}
