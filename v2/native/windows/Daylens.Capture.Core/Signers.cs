namespace Daylens.Capture.Core;

public static class Signers
{
    /// The publisher from an Authenticode certificate subject: the organization (O=), else the common name (CN=).
    public static string? PublisherFromSubject(string? subject)
    {
        if (string.IsNullOrWhiteSpace(subject)) return null;
        string? cn = null;
        foreach (var part in SplitRdn(subject))
        {
            var eq = part.IndexOf('=');
            if (eq <= 0) continue;
            var key = part[..eq].Trim();
            var value = Unquote(part[(eq + 1)..].Trim());
            if (key.Equals("O", StringComparison.OrdinalIgnoreCase)) return value;
            if (key.Equals("CN", StringComparison.OrdinalIgnoreCase)) cn ??= value;
        }
        return cn;
    }

    // Splits on commas outside quotes, as in: CN="Slack Technologies, LLC", O="Slack Technologies, LLC", C=US
    static IEnumerable<string> SplitRdn(string s)
    {
        var start = 0;
        var quoted = false;
        for (var i = 0; i < s.Length; i++)
        {
            if (s[i] == '"') quoted = !quoted;
            else if (s[i] == ',' && !quoted)
            {
                yield return s[start..i];
                start = i + 1;
            }
        }
        yield return s[start..];
    }

    static string Unquote(string v) => v.Length >= 2 && v[0] == '"' && v[^1] == '"' ? v[1..^1].Replace("\"\"", "\"") : v;
}
