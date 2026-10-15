using System.Text.Json.Nodes;
using Daylens.Capture.Core;
using Xunit;

public class ClipTests
{
    [Fact]
    public void OverlongIdentityFieldsAreClippedToTheValidatorLimits()
    {
        var app = new AppInfo(new string('a', 5000), new string('n', 600) + "😀", new string('p', 9000), 1, false, IdentityState.Ok, null);
        var bytes = Envelope.Line("r", 0, "b", new EventTime(1, 1, "UTC", 0), "windows", "win_event", "focus", Obs.Focus(FocusTrigger.AppChanged, app, WindowInfo.Read("w", "t")));
        var obs = JsonNode.Parse(bytes)!["obs"]!["app"]!;
        Assert.Equal(1024, obs["app_id"]!.GetValue<string>().Length);
        Assert.Equal(512, obs["name"]!.GetValue<string>().Length);
        Assert.Equal(2048, obs["path"]!.GetValue<string>().Length);
    }
}
