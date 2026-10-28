using Daylens.Capture.Core;
using static Daylens.Capture.Core.Tests.TestSupport;

namespace Daylens.Capture.Core.Tests;

public class WindowInfoTests
{
    static readonly string Moon = U(0xD83C, 0xDF18);

    [Fact]
    public void LimitIs1024Utf16Units() => Assert.Equal(1024, WindowInfo.MaxTitleUtf16);

    [Fact]
    public void TitleAtTheLimitIsKept()
    {
        var title = new string('a', 1024);
        Assert.Equal(title, WindowInfo.Read("w", title).Title);
    }

    [Fact]
    public void TitleOverTheLimitIsCutTo1024()
    {
        var w = WindowInfo.Read("w", new string('a', 1025));
        Assert.Equal(new string('a', 1024), w.Title);
        Assert.Equal(TitleState.Ok, w.TitleState);
    }

    [Fact]
    public void PairStraddlingTheLimitIsDroppedWhole()
    {
        var w = WindowInfo.Read("w", new string('a', 1023) + Moon + Moon);
        Assert.Equal(new string('a', 1023), w.Title);
    }

    [Fact]
    public void PairEndingExactlyAtTheLimitIsKept()
    {
        var title = new string('a', 1022) + Moon;
        Assert.Equal(title, WindowInfo.Read("w", title).Title);
        Assert.Equal(new string('a', 1022) + Moon, WindowInfo.Read("w", title + "tail").Title);
    }

    [Fact]
    public void PairStartingAfterTheLimitIsDroppedWhole()
    {
        Assert.Equal(new string('a', 1024), WindowInfo.Read("w", new string('a', 1024) + Moon).Title);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    public void LongRunsOfPairsNeverSplitAPair(int prefix)
    {
        var title = new string('a', prefix) + string.Concat(Enumerable.Repeat(Moon, 2000));
        var cut = WindowInfo.Read("w", title).Title!;
        Assert.True(cut.Length is 1023 or 1024);
        Assert.True(IsWellFormedUtf16(cut));
        Assert.StartsWith(cut, title, StringComparison.Ordinal);
    }

    [Fact]
    public void LoneHighSurrogateAtTheCutIsDropped()
    {
        var title = new string('a', 1023) + U(0xD800) + "bbb";
        Assert.Equal(new string('a', 1023), WindowInfo.Read("w", title).Title);
    }

    [Fact]
    public void ShortTitlesAreUntouchedEvenWithLoneSurrogates()
    {
        var title = "x" + U(0xDC00) + "y" + U(0xD800);
        Assert.Equal(title, WindowInfo.Read("w", title).Title);
    }

    [Fact]
    public void EmptyTitleIsEmptyState()
    {
        var w = WindowInfo.Read("w", "");
        Assert.Equal(TitleState.Empty, w.TitleState);
        Assert.Null(w.Title);
        Assert.Equal("w", w.Window);
    }

    [Fact]
    public void NullTitleIsUnavailable()
    {
        var w = WindowInfo.Read("w", null);
        Assert.Equal(TitleState.Unavailable, w.TitleState);
        Assert.Null(w.Title);
        Assert.Equal("w", w.Window);
    }

    [Fact]
    public void WhitespaceTitleIsKeptAsIs()
    {
        var w = WindowInfo.Read("w", " ");
        Assert.Equal(TitleState.Ok, w.TitleState);
        Assert.Equal(" ", w.Title);
    }

    [Theory]
    [InlineData(TitleState.Empty)]
    [InlineData(TitleState.NoPermission)]
    [InlineData(TitleState.Timeout)]
    [InlineData(TitleState.Unavailable)]
    public void NonOkStatesNeverCarryATitle(TitleState state)
    {
        var w = new WindowInfo("w", "secret", state);
        Assert.Null(w.Title);
        Assert.Equal(state, w.TitleState);
    }

    [Fact]
    public void ConstructorWithOkTruncatesToo()
    {
        Assert.Equal(1024, new WindowInfo("w", new string('a', 5000), TitleState.Ok).Title!.Length);
    }

    [Fact]
    public void OkWithoutATitleIsNotOk()
    {
        var missing = new WindowInfo("w", null, TitleState.Ok);
        Assert.Null(missing.Title);
        Assert.Equal(TitleState.Unavailable, missing.TitleState);
        var empty = new WindowInfo("w", "", TitleState.Ok);
        Assert.Null(empty.Title);
        Assert.Equal(TitleState.Empty, empty.TitleState);
    }

    // Resolver.Loop dedupes focus lines with record equality on WindowInfo.
    [Fact]
    public void EqualityIsByValue()
    {
        Assert.Equal(WindowInfo.Read("w", "t"), WindowInfo.Read("w", "t"));
        Assert.NotEqual(WindowInfo.Read("w", "t"), WindowInfo.Read("w", "u"));
        Assert.NotEqual(WindowInfo.Read("w", "t"), WindowInfo.Read("v", "t"));
        Assert.NotEqual(WindowInfo.Read("w", ""), WindowInfo.Read("w", null));
        Assert.Equal(WindowInfo.Read("w", new string('a', 2000)), WindowInfo.Read("w", new string('a', 1024)));
    }
}
