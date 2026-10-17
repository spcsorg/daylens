namespace Daylens.Capture.Core;

/// Names the current boot so the service knows when two monotonic readings can be compared.
/// The kernel's boot counter does not move when the wall clock is set; boot time computed as
/// wall time minus uptime does, so it is only a fallback for systems without the counter.
public static class BootIdentity
{
    public static string Compute(uint? kernelBootCounter, long wallMs, long monoUs) =>
        kernelBootCounter is uint c ? $"boot-{c}" : $"bootclock-{(wallMs - monoUs / 1000) / 60_000}";

    /// Hello reports "clock" for the fallback, so capture health shows the boot identity as degraded.
    public static bool IsFromKernel(string bootId) => !bootId.StartsWith("bootclock-", StringComparison.Ordinal);
}
