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
    // Packaged browsers declare http/https in their manifest instead of a registry command.
    readonly Dictionary<string, bool> _webPackages = new(StringComparer.OrdinalIgnoreCase);
    HashSet<string> _browserExes = new(StringComparer.OrdinalIgnoreCase);
    long _browsersLoadedMs;
    long _busySinceMs;
    long _generation;
    (AppInfo App, WindowInfo Window)? _last;

    public Resolver(Emitter emitter)
    {
        _emitter = emitter;
        new Thread(() =>
        {
            // Warm the browser list before the first lookup so it never counts against a stall.
            try { LoadBrowsers(); } catch { Diag.Write("browser_registry_failed"); }
            Loop();
        }) { IsBackground = true, Name = "daylens.capture.resolver" }.Start();
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
        lock (_gate)
        {
            Interlocked.Increment(ref _generation);
            _queue.Clear();
            _last = null;
        }
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
            lock (_gate)
            {
                if (w.Generation != Generation) continue;
                var changed = _last is not { } l || l.App != app || l.Window != w.Window;
                if (!changed && !w.Force && w.Trigger != FocusTrigger.AppChanged) continue;
                _last = (app, w.Window);
            }
            var source = w.Trigger == FocusTrigger.Reconcile ? "reconcile" : "win_event";
            try { _emitter.Emit("focus", source, w.Time, Obs.Focus(w.Trigger, app, w.Window), Emitter.Priority.Normal); }
            catch { Diag.Write("emit_failed"); }
        }
    }

    AppInfo Identify(nint hwnd, int pid)
    {
        if (hwnd == 0 || pid == 0) return AppInfo.NoneInFront;
        var p = OpenProcess(pid);
        if (p.State != IdentityState.Ok) return AppInfo.Unknown(pid, p.State);
        try
        {
            var host = StoreApps.ResolveHost(p.Path, pid, () => Children(hwnd));
            if (host.Kind == HostKind.Unresolved) return host.UnresolvedApp();
            if (host.Kind == HostKind.Content)
            {
                Native.CloseHandle(p.Handle);
                pid = host.Pid;
                p = OpenProcess(pid);
                if (p.State != IdentityState.Ok) return AppInfo.Unknown(pid, p.State);
            }
            // A creation time of 0 means it could not be read; then a reused pid could hit a stale entry.
            if (p.Created != 0 && _identities.TryGetValue((pid, p.Created), out var cached)) return cached;
            var app = Describe(p.Handle, pid, p.Path!);
            if (_identities.Count > 512) _identities.Clear();
            if (p.Created != 0) _identities[(pid, p.Created)] = app;
            return app;
        }
        finally { if (p.Handle != 0) Native.CloseHandle(p.Handle); }
    }

    readonly record struct OpenedProcess(IdentityState State, nint Handle, string? Path, long Created);

    // One handle per lookup, so every query describes the same process even if the pid is reused meanwhile.
    static OpenedProcess OpenProcess(int pid)
    {
        var h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
        if (h == 0)
        {
            var err = System.Runtime.InteropServices.Marshal.GetLastPInvokeError();
            return new(err == 87 ? IdentityState.Gone : IdentityState.AccessDenied, 0, null, 0);
        }
        var buf = stackalloc char[4096];
        uint size = 4096;
        if (!Native.QueryFullProcessImageName(h, 0, buf, ref size))
        {
            // ERROR_GEN_FAILURE: the process is exiting.
            var gone = System.Runtime.InteropServices.Marshal.GetLastPInvokeError() == 31;
            Native.CloseHandle(h);
            return new(gone ? IdentityState.Gone : IdentityState.AccessDenied, 0, null, 0);
        }
        var created = Native.GetProcessTimes(h, out var c, out _, out _, out _) ? c : 0;
        return new(IdentityState.Ok, h, new string(buf, 0, (int)size), created);
    }

    AppInfo Describe(nint h, int pid, string path)
    {
        string? aumid = null, package = null;
        var buf = stackalloc char[512];
        uint len = 512;
        if (Native.GetApplicationUserModelId(h, ref len, buf) == 0 && len > 1) aumid = new string(buf, 0, (int)len - 1);
        len = 512;
        if (Native.GetPackageFullName(h, ref len, buf) == 0 && len > 1) package = new string(buf, 0, (int)len - 1);
        var browser = IsRegisteredBrowser(path);
        if (aumid is not null)
        {
            var name = package is null ? null : PackageDisplayName(aumid, package);
            browser |= package is not null && _webPackages.TryGetValue(package, out var web) && web;
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
                var xml = File.ReadAllText(manifest);
                _webPackages[packageFullName] = StoreApps.ManifestDeclaresWebProtocols(xml);
                var raw = StoreApps.ManifestDisplayName(xml, appId);
                if (raw is not null)
                {
                    var indirect = StoreApps.IndirectString(raw, packageFullName, packageFullName.Split('_')[0]);
                    if (indirect is null) name = raw;
                    else
                    {
                        var outBuf = stackalloc char[512];
                        outBuf[0] = '\0';
                        if (Native.SHLoadIndirectString(indirect, outBuf, 512, 0) == 0)
                        {
                            outBuf[511] = '\0';
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
            foreach (var exe in Each(() => StartMenuInternet(root))) found.Add(exe);
            foreach (var exe in Each(() => UrlHandlers(root))) found.Add(exe);
        }
        _browserExes = found;
    }

    // One bad registry entry must not hide the others.
    static IEnumerable<string> Each(Func<IEnumerable<string?>> source)
    {
        var list = new List<string>();
        try
        {
            foreach (var s in source())
                if (s is not null) list.Add(s);
        }
        catch { Diag.Write("browser_registry_failed"); }
        return list;
    }

    static IEnumerable<string?> StartMenuInternet(RegistryKey root)
    {
        using var smi = root.OpenSubKey(@"SOFTWARE\Clients\StartMenuInternet");
        if (smi is null) yield break;
        foreach (var name in smi.GetSubKeyNames())
        {
            string? exe = null;
            try
            {
                using var cmd = smi.OpenSubKey($@"{name}\shell\open\command");
                exe = Browsers.CommandExe(cmd?.GetValue(null) as string);
            }
            catch { Diag.Write("browser_registry_entry_failed"); }
            yield return exe;
        }
    }

    static IEnumerable<string?> UrlHandlers(RegistryKey root)
    {
        using var apps = root.OpenSubKey(@"SOFTWARE\RegisteredApplications");
        if (apps is null) yield break;
        foreach (var app in apps.GetValueNames())
        {
            string? exe = null;
            try
            {
                if (apps.GetValue(app) is string capPath)
                {
                    using var urls = root.OpenSubKey($@"{capPath}\URLAssociations");
                    if (urls?.GetValue("http") is string progId && urls.GetValue("https") is not null)
                    {
                        using var cmd = Registry.ClassesRoot.OpenSubKey($@"{progId}\shell\open\command");
                        exe = Browsers.CommandExe(cmd?.GetValue(null) as string);
                    }
                }
            }
            catch { Diag.Write("browser_registry_entry_failed"); }
            yield return exe;
        }
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
