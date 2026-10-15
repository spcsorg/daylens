using System.Diagnostics;
using System.Runtime.Versioning;
using Daylens.Capture.Core;
using Microsoft.Win32;

namespace Daylens.Capture.Windows;

internal readonly record struct FocusWork(FocusTrigger Trigger, nint Hwnd, int Pid, WindowInfo Window, EventTime Time, bool Force, long Generation);

/// Resolves process identity off the hook thread. Calls here can block; the hook thread watches
/// how long, reports titles as stalled, and the helper exits (to be restarted) if it never returns.
[SupportedOSPlatform("windows")]
internal sealed unsafe class Resolver
{
    const int MaxQueue = 256;
    readonly object _gate = new();
    readonly Queue<FocusWork> _queue = new();
    readonly Emitter _emitter;
    readonly Dictionary<(int Pid, long Created), AppInfo> _identities = new();
    readonly Dictionary<string, string?> _packageNames = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<string, string?> _exeNames = new(StringComparer.OrdinalIgnoreCase);
    HashSet<string> _browserExes = new(StringComparer.OrdinalIgnoreCase);
    long _browsersLoadedMs;
    long _busySinceMs;
    long _generation;
    (AppInfo App, WindowInfo Window)? _last;

    public Resolver(Emitter emitter)
    {
        _emitter = emitter;
        new Thread(Loop) { IsBackground = true, Name = "daylens.capture.resolver" }.Start();
    }

    public long StallMs
    {
        get { var since = Interlocked.Read(ref _busySinceMs); return since == 0 ? 0 : Environment.TickCount64 - since; }
    }

    public long Generation => Interlocked.Read(ref _generation);

    public void Submit(FocusWork w)
    {
        lock (_gate)
        {
            if (_queue.Count >= MaxQueue) { _queue.Dequeue(); Diag.Write("resolver_queue_full"); }
            _queue.Enqueue(w);
            Monitor.Pulse(_gate);
        }
    }

    /// Called by the hook thread when this thread is stuck: queued work is abandoned and reported without identity.
    public void Abandon()
    {
        Interlocked.Increment(ref _generation);
        lock (_gate) _queue.Clear();
        _last = null;
    }

    void Loop()
    {
        while (true)
        {
            FocusWork w;
            lock (_gate)
            {
                while (_queue.Count == 0) Monitor.Wait(_gate);
                w = _queue.Dequeue();
            }
            if (w.Generation != Generation) continue;
            Interlocked.Exchange(ref _busySinceMs, Environment.TickCount64);
            AppInfo app;
            try { app = Identify(w.Hwnd, w.Pid); }
            catch { app = AppInfo.Unknown(w.Pid, IdentityState.AccessDenied); Diag.Write("identify_failed"); }
            Interlocked.Exchange(ref _busySinceMs, 0);
            if (w.Generation != Generation) continue;
            var changed = _last is not { } l || l.App != app || l.Window != w.Window;
            if (!changed && !w.Force && w.Trigger != FocusTrigger.AppChanged) continue;
            _last = (app, w.Window);
            var source = w.Trigger == FocusTrigger.Reconcile ? "reconcile" : "win_event";
            _emitter.Emit("focus", source, w.Time, Obs.Focus(w.Trigger, app, w.Window), Emitter.Priority.Normal);
        }
    }

    AppInfo Identify(nint hwnd, int pid)
    {
        if (hwnd == 0 || pid == 0) return AppInfo.NoneInFront;
        var (state, path, created) = QueryProcess(pid);
        if (state != IdentityState.Ok) return AppInfo.Unknown(pid, state);
        if (StoreApps.IsFrameHost(path))
        {
            var content = StoreApps.SelectContentWindow(pid, Children(hwnd));
            if (content is { } c)
            {
                pid = c.Pid;
                (state, path, created) = QueryProcess(pid);
                if (state != IdentityState.Ok) return AppInfo.Unknown(pid, state);
            }
        }
        if (_identities.TryGetValue((pid, created), out var cached)) return cached;
        var app = Describe(pid, path!);
        if (_identities.Count > 512) _identities.Clear();
        _identities[(pid, created)] = app;
        return app;
    }

    static (IdentityState, string?, long) QueryProcess(int pid)
    {
        var h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
        if (h == 0)
        {
            var err = System.Runtime.InteropServices.Marshal.GetLastPInvokeError();
            return (err == 87 ? IdentityState.Gone : IdentityState.AccessDenied, null, 0);
        }
        try
        {
            var buf = stackalloc char[1024];
            uint size = 1024;
            if (!Native.QueryFullProcessImageName(h, 0, buf, ref size)) return (IdentityState.AccessDenied, null, 0);
            Native.GetProcessTimes(h, out var created, out _, out _, out _);
            return (IdentityState.Ok, new string(buf, 0, (int)size), created);
        }
        finally { Native.CloseHandle(h); }
    }

    AppInfo Describe(int pid, string path)
    {
        var h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
        string? aumid = null, package = null;
        if (h != 0)
        {
            try
            {
                var buf = stackalloc char[512];
                uint len = 512;
                if (Native.GetApplicationUserModelId(h, ref len, buf) == 0 && len > 1) aumid = new string(buf, 0, (int)len - 1);
                len = 512;
                if (Native.GetPackageFullName(h, ref len, buf) == 0 && len > 1) package = new string(buf, 0, (int)len - 1);
            }
            finally { Native.CloseHandle(h); }
        }
        var browser = IsRegisteredBrowser(path);
        if (aumid is not null)
        {
            var name = package is null ? null : PackageDisplayName(aumid, package);
            return new AppInfo(aumid, name ?? ExeName(path), path, pid, browser, IdentityState.Ok, new StoreIdentity(aumid, package));
        }
        return new AppInfo(path, ExeName(path), path, pid, browser, IdentityState.Ok, null);
    }

    string? ExeName(string path)
    {
        if (_exeNames.TryGetValue(path, out var cached)) return cached;
        string? name = null;
        try
        {
            var v = FileVersionInfo.GetVersionInfo(path);
            name = !string.IsNullOrWhiteSpace(v.FileDescription) ? v.FileDescription.Trim() : !string.IsNullOrWhiteSpace(v.ProductName) ? v.ProductName.Trim() : null;
        }
        catch { Diag.Write("version_info_failed"); }
        name ??= Path.GetFileNameWithoutExtension(path);
        if (_exeNames.Count > 512) _exeNames.Clear();
        _exeNames[path] = name;
        return name;
    }

    string? PackageDisplayName(string aumid, string packageFullName)
    {
        var key = aumid + "|" + packageFullName;
        if (_packageNames.TryGetValue(key, out var cached)) return cached;
        string? name = null;
        try
        {
            var appId = StoreApps.ParseAumid(aumid)?.AppId;
            uint len = 1024;
            var buf = stackalloc char[1024];
            if (appId is not null && Native.GetPackagePathByFullName(packageFullName, ref len, buf) == 0)
            {
                var manifest = Path.Combine(new string(buf, 0, (int)len - 1), "AppxManifest.xml");
                var raw = StoreApps.ManifestDisplayName(File.ReadAllText(manifest), appId);
                if (raw is not null)
                {
                    var indirect = StoreApps.IndirectString(raw, packageFullName, packageFullName.Split('_')[0]);
                    if (indirect is null) name = raw;
                    else
                    {
                        var outBuf = stackalloc char[512];
                        if (Native.SHLoadIndirectString(indirect, outBuf, 512, 0) == 0)
                        {
                            var s = new string(outBuf);
                            if (StoreApps.IsResolved(s)) name = s;
                        }
                    }
                }
            }
        }
        catch { Diag.Write("package_name_failed"); }
        _packageNames[key] = name;
        return name;
    }

    bool IsRegisteredBrowser(string exePath)
    {
        if (Environment.TickCount64 - _browsersLoadedMs > 3_600_000 || _browsersLoadedMs == 0) LoadBrowsers();
        return _browserExes.Contains(exePath);
    }

    // Apps registered for both http and https under RegisteredApplications, plus the StartMenuInternet list.
    void LoadBrowsers()
    {
        _browsersLoadedMs = Environment.TickCount64;
        var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var root in new[] { Registry.LocalMachine, Registry.CurrentUser })
        {
            try
            {
                using (var smi = root.OpenSubKey(@"SOFTWARE\Clients\StartMenuInternet"))
                    if (smi is not null)
                        foreach (var name in smi.GetSubKeyNames())
                        {
                            using var cmd = smi.OpenSubKey($@"{name}\shell\open\command");
                            if (Browsers.CommandExe(cmd?.GetValue(null) as string) is { } exe) found.Add(exe);
                        }
                using var apps = root.OpenSubKey(@"SOFTWARE\RegisteredApplications");
                if (apps is null) continue;
                foreach (var app in apps.GetValueNames())
                {
                    if (apps.GetValue(app) is not string capPath) continue;
                    using var urls = root.OpenSubKey($@"{capPath}\URLAssociations");
                    if (urls?.GetValue("http") is not string progId || urls.GetValue("https") is null) continue;
                    using var cmd = Registry.ClassesRoot.OpenSubKey($@"{progId}\shell\open\command");
                    if (Browsers.CommandExe(cmd?.GetValue(null) as string) is { } exe) found.Add(exe);
                }
            }
            catch { Diag.Write("browser_registry_failed"); }
        }
        _browserExes = found;
    }

    static readonly List<ChildWindow> ChildBuffer = new();

    static List<ChildWindow> Children(nint parent)
    {
        ChildBuffer.Clear();
        Native.EnumChildWindows(parent, (nint)(delegate* unmanaged<nint, nint, int>)&OnChild, 0);
        return [.. ChildBuffer];
    }

    [System.Runtime.InteropServices.UnmanagedCallersOnly]
    static int OnChild(nint hwnd, nint _)
    {
        Native.GetWindowThreadProcessId(hwnd, out var pid);
        var buf = stackalloc char[128];
        var n = Native.GetClassName(hwnd, buf, 128);
        ChildBuffer.Add(new ChildWindow(hwnd, (int)pid, n > 0 ? new string(buf, 0, n) : ""));
        return ChildBuffer.Count < 64 ? 1 : 0;
    }
}
