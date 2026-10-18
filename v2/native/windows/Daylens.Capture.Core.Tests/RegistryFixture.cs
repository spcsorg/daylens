using Microsoft.Win32.SafeHandles;

namespace Microsoft.Win32;

// The linked resolver uses this registry on every host; the Windows build still binds the OS registry.
public sealed class RegistryKey : IDisposable
{
    readonly Dictionary<string, RegistryKey> _children = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<string, object> _values = new(StringComparer.OrdinalIgnoreCase);
    public static long Reads, Version;
    public SafeRegistryHandle Handle => throw new InvalidOperationException("Fixture handles cannot reach native APIs.");
    public bool FailReads { get; set; }
    void Reading() { Interlocked.Increment(ref Reads); if (FailReads) throw new UnauthorizedAccessException(); }
    public RegistryKey? OpenSubKey(string path)
    {
        Reading();
        var current = this;
        foreach (var part in path.Split('\\', StringSplitOptions.RemoveEmptyEntries))
        {
            if (!current._children.TryGetValue(part, out var child)) return null;
            current = child;
        }
        return current;
    }
    public RegistryKey CreateSubKey(string path)
    {
        var current = this;
        foreach (var part in path.Split('\\', StringSplitOptions.RemoveEmptyEntries))
        {
            if (!current._children.TryGetValue(part, out var child)) current._children[part] = child = new();
            current = child;
        }
        Interlocked.Increment(ref Version);
        return current;
    }
    public string[] GetSubKeyNames() { Reading(); return _children.Keys.ToArray(); }
    public string[] GetValueNames() { Reading(); return _values.Keys.ToArray(); }
    public object? GetValue(string? name) { Reading(); return _values.GetValueOrDefault(name ?? ""); }
    public void SetValue(string name, object value) { _values[name] = value; Interlocked.Increment(ref Version); }
    public void DeleteValue(string name, bool throwOnMissingValue = true) { _values.Remove(name); Interlocked.Increment(ref Version); }
    public void DeleteSubKeyTree(string path, bool throwOnMissingSubKey = true)
    {
        var slash = path.LastIndexOf('\\');
        var parent = slash < 0 ? this : OpenSubKey(path[..slash]);
        parent?._children.Remove(path[(slash + 1)..]);
        Interlocked.Increment(ref Version);
    }
    public void Dispose() { }
}

public static class Registry
{
    public static RegistryKey LocalMachine { get; } = new();
    public static RegistryKey CurrentUser { get; } = new();
    public static RegistryKey ClassesRoot { get; } = CurrentUser.CreateSubKey(@"Software\Classes");
}
