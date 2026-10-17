using Daylens.Capture.Core;
using Xunit;

public class FileStampTests
{
    [Fact]
    public void AnUpdatedExecutableHasANewStampSoNoCachedVerdictSurvivesIt()
    {
        var dir = Path.Combine(Path.GetTempPath(), "daylens-stamp-" + Guid.NewGuid());
        Directory.CreateDirectory(dir);
        var exe = Path.Combine(dir, "Thing.exe");
        File.WriteAllBytes(exe, new byte[100]);
        var before = FileStamp.Of(exe);
        Assert.NotNull(before);
        Assert.Equal(before, FileStamp.Of(exe));
        File.WriteAllBytes(exe, new byte[5000]);
        File.SetLastWriteTimeUtc(exe, DateTime.UtcNow.AddMinutes(1));
        Assert.NotEqual(before, FileStamp.Of(exe));
    }

    [Fact]
    public void AMissingFileHasNoStampAndIsNeverCached() => Assert.Null(FileStamp.Of(Path.Combine(Path.GetTempPath(), "missing-" + Guid.NewGuid())));
}
