using System.Diagnostics;
using System.Globalization;
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
    readonly RequestQueue<FocusWork> _queue = new(MaxQueue);
    readonly AutoResetEvent _wake = new(false);
    readonly Emitter _emitter;
    readonly Dictionary<(int Pid, long Created), AppInfo> _identities = new();
    readonly Dictionary<string, string?> _packageNames = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<string, string?> _exeNames = new(StringComparer.OrdinalIgnoreCase);
    // Packaged browsers declare http/https in their manifest instead of a registry command.
    readonly Dictionary<string, bool> _webPackages = new(StringComparer.OrdinalIgnoreCase);
    HashSet<string> _browserExes = new(StringComparer.OrdinalIgnoreCase);
    bool _browsersLoaded, _browserRegistryComplete;
    Func<bool>? _registrationChanges;
    Action? _refreshWatches;
    Action<RegistryKey, string>? _watchCapabilities;
    Func<string, string?> _effectiveCommand = EffectiveCommand;
    long _busySinceMs;
    long _generation;
    (AppInfo App, WindowInfo Window)? _last;

    public Resolver(Emitter emitter)
    {
        _emitter = emitter;
        new Thread(() =>
        {
            try
            {
                var changes = new AssociationChanges();
                _registrationChanges = changes.Poll;
                _refreshWatches = changes.Refresh;
                _watchCapabilities = changes.Watch;
                LoadBrowsers();
            }
            catch
            {
                Diag.Write("browser_registry_watch_failed");
                _registrationChanges = () => throw new InvalidOperationException();
            }
            Loop();
        }) { IsBackground = true, Name = "daylens.capture.resolver" }.Start();
    }

    public long StallMs
    {
        get { var since = Interlocked.Read(ref _busySinceMs); return since == 0 ? 0 : Environment.TickCount64 - since; }
    }

    public long Generation => Interlocked.Read(ref _generation);

    /// Every request is kept in order; when the queue is full the oldest is dropped and reported as a loss.
    public void Submit(FocusWork w)
    {
        if (_queue.Push(w, w.Time.WallMs)) _wake.Set();
    }

    /// Called by the hook thread when this thread is stuck: queued work is abandoned, counted as lost,
    /// and the hook thread reports focus without identity meanwhile.
    public void Abandon()
    {
        lock (_gate)
        {
            Interlocked.Increment(ref _generation);
            _last = null;
        }
        _queue.Clear();
    }

    void Loop()
    {
        while (true)
        {
            _wake.WaitOne();
            _queue.Drain(Handle, ReportLoss);
        }
    }

    void Handle(FocusWork w)
    {
        // Work from before an abandon was not reported, so it counts as lost too, including the one that was stuck.
        if (w.Generation != Generation) { _queue.CountLost(w.Time.WallMs); return; }
        Interlocked.Exchange(ref _busySinceMs, Environment.TickCount64);
        AppInfo app;
        try { app = Identify(w.Hwnd, w.Pid); }
        catch { app = AppInfo.Unknown(w.Pid, IdentityState.AccessDenied); Diag.Write("identify_failed"); }
        Interlocked.Exchange(ref _busySinceMs, 0);
        lock (_gate)
        {
            if (w.Generation != Generation) { _queue.CountLost(w.Time.WallMs); return; }
            var changed = _last is not { } l || l.App != app || l.Window != w.Window;
            if (!changed && !w.Force && w.Trigger != FocusTrigger.AppChanged) return;
            _last = (app, w.Window);
        }
        var source = w.Trigger == FocusTrigger.Reconcile ? "reconcile" : "win_event";
        try { _emitter.Emit("focus", source, w.Time, Obs.Focus(w.Trigger, app, w.Window), Emitter.Priority.Normal); }
        catch { Diag.Write("emit_failed"); }
    }

    void ReportLoss(QueueLoss l)
    {
        Diag.Write("resolver_queue_loss", l.Count.ToString(CultureInfo.InvariantCulture));
        try { _emitter.Emit("loss", "helper", Clock.Now(), Obs.Loss(l.Count, l.FromWallMs, l.ToWallMs), Emitter.Priority.Critical); }
        catch { Diag.Write("emit_failed"); }
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
            AppInfo app;
            if (p.Created != 0 && _identities.TryGetValue((pid, p.Created), out var cached)) app = cached;
            else
            {
                app = Describe(p.Handle, pid, p.Path!, p.Created);
                if (_identities.Count > 512) _identities.Clear();
                if (p.Created != 0) _identities[(pid, p.Created)] = app;
            }
            // URL associations can change while the same process and its verified identity stay alive.
            var registered = IsRegisteredBrowser(p.Path!);
            var packageWeb = app.Store?.Package is { } package && _webPackages.GetValueOrDefault(package);
            return app with { RegisteredBrowser = registered || packageWeb };
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

    AppInfo Describe(nint h, int pid, string path, long created)
    {
        string? aumid = null, package = null;
        var buf = stackalloc char[512];
        uint len = 512;
        if (Native.GetApplicationUserModelId(h, ref len, buf) == 0 && len > 1) aumid = new string(buf, 0, (int)len - 1);
        len = 512;
        if (Native.GetPackageFullName(h, ref len, buf) == 0 && len > 1) package = new string(buf, 0, (int)len - 1);
        if (aumid is not null)
        {
            var name = package is null ? null : PackageDisplayName(aumid, package);
            bool? web = package is not null && _webPackages.TryGetValue(package, out var w) ? w : null;
            return new AppInfo(aumid, name ?? ExeName(path), path, pid, web == true, IdentityState.Ok, new StoreIdentity(aumid, package), Engines.ForPackage(web, _engineCache.Get(pid, created, path)), SignerOf(path), VersionOf(path));
        }
        return new AppInfo(path, ExeName(path), path, pid, false, IdentityState.Ok, null, _engineCache.Get(pid, created, path), SignerOf(path), VersionOf(path));
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

    // Keyed on the executable's current file, so an update that changes what the app is is never answered from cache.
    readonly Dictionary<FileStamp, string?> _signers = new();
    readonly Dictionary<FileStamp, VersionInfo?> _versions = new();

    VersionInfo? VersionOf(string exePath)
    {
        var stamp = FileStamp.Of(exePath);
        if (stamp is { } s && _versions.TryGetValue(s, out var cached)) return cached;
        VersionInfo? info = null;
        try
        {
            var v = FileVersionInfo.GetVersionInfo(exePath);
            info = new VersionInfo(string.IsNullOrWhiteSpace(v.OriginalFilename) ? null : v.OriginalFilename.Trim(),
                                   string.IsNullOrWhiteSpace(v.ProductName) ? null : v.ProductName.Trim());
        }
        catch { Diag.Write("version_info_failed"); }
        if (_versions.Count > 512) _versions.Clear();
        if (stamp is { } key) _versions[key] = info;
        return info;
    }

    // The Authenticode publisher, only once WinVerifyTrust accepts the file's signature (no network, no revocation fetch).
    string? SignerOf(string exePath)
    {
        var stamp = FileStamp.Of(exePath);
        if (stamp is { } s && _signers.TryGetValue(s, out var cached)) return cached;
        string? publisher = null;
        try
        {
            if (SignatureVerifies(exePath))
            {
#pragma warning disable SYSLIB0057 // Reads the signer certificate only; trust was established by WinVerifyTrust above.
                using var cert = System.Security.Cryptography.X509Certificates.X509Certificate.CreateFromSignedFile(exePath);
#pragma warning restore SYSLIB0057
                publisher = Signers.PublisherFromSubject(cert.Subject);
            }
        }
        catch { Diag.Write("signer_read_failed"); }
        if (_signers.Count > 512) _signers.Clear();
        if (stamp is { } key) _signers[key] = publisher;
        return publisher;
    }

    static bool SignatureVerifies(string path)
    {
        var pathPtr = System.Runtime.InteropServices.Marshal.StringToHGlobalUni(path);
        var file = new Native.WINTRUST_FILE_INFO { cbStruct = (uint)sizeof(Native.WINTRUST_FILE_INFO), pcwszFilePath = pathPtr };
        var filePtr = System.Runtime.InteropServices.Marshal.AllocHGlobal(sizeof(Native.WINTRUST_FILE_INFO));
        try
        {
            System.Runtime.InteropServices.Marshal.StructureToPtr(file, filePtr, false);
            var data = new Native.WINTRUST_DATA
            {
                cbStruct = (uint)sizeof(Native.WINTRUST_DATA),
                dwUIChoice = Native.WTD_UI_NONE,
                fdwRevocationChecks = Native.WTD_REVOKE_NONE,
                dwUnionChoice = Native.WTD_CHOICE_FILE,
                pFile = filePtr,
                dwStateAction = Native.WTD_STATEACTION_VERIFY,
                dwProvFlags = Native.WTD_REVOCATION_CHECK_NONE | Native.WTD_CACHE_ONLY_URL_RETRIEVAL,
            };
            var action = Native.WINTRUST_ACTION_GENERIC_VERIFY_V2;
            var result = Native.WinVerifyTrust(-1, ref action, ref data);
            data.dwStateAction = Native.WTD_STATEACTION_CLOSE;
            Native.WinVerifyTrust(-1, ref action, ref data);
            return result == 0;
        }
        finally
        {
            System.Runtime.InteropServices.Marshal.FreeHGlobal(filePtr);
            System.Runtime.InteropServices.Marshal.FreeHGlobal(pathPtr);
        }
    }

    readonly EngineCache _engineCache = new(dir =>
    {
        var listing = Engines.Scan(dir);
        if (listing is null) Diag.Write("engine_scan_uncertain");
        return listing;
    });

    bool IsRegisteredBrowser(string exePath)
    {
        try
        {
            var changed = _registrationChanges?.Invoke() ?? true;
            // An incomplete read withholds titles until a later read completes, even with no registration change.
            if (!_browsersLoaded || !_browserRegistryComplete || changed)
            {
                LoadBrowsers();
                if (_registrationChanges?.Invoke() == true) { _browsersLoaded = false; return true; }
            }
            return !_browserRegistryComplete || _browserExes.Contains(Browsers.ExecutableKey(exePath));
        }
        catch { Diag.Write("browser_registry_failed"); return true; }
    }

    void LoadBrowsers()
    {
        _browsersLoaded = false;
        _refreshWatches?.Invoke();
        var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        _browserRegistryComplete = true;
        void Read(Action action)
        {
            try { action(); }
            catch { _browserRegistryComplete = false; Diag.Write("browser_registry_failed"); }
        }
        void AddCommand(string? command)
        {
            if (command is null) return;
            var targets = Browsers.CommandTargets(Environment.ExpandEnvironmentVariables(command)).ToArray();
            if (targets.Length == 0) { Diag.Write("browser_command_unusable"); return; }
            foreach (var target in targets) found.Add(Browsers.ExecutableKey(target));
        }
        void ProgId(string id)
        {
            using var command = Registry.ClassesRoot.OpenSubKey($@"{id}\shell\open\command");
            AddCommand(command?.GetValue(null) as string);
        }
        foreach (var root in new[] { Registry.LocalMachine, Registry.CurrentUser })
        {
            Read(() =>
            {
                using var smi = root.OpenSubKey(@"SOFTWARE\Clients\StartMenuInternet");
                foreach (var name in smi?.GetSubKeyNames() ?? []) Read(() =>
                {
                    using var cmd = smi!.OpenSubKey($@"{name}\shell\open\command");
                    AddCommand(cmd?.GetValue(null) as string);
                });
            });
            Read(() =>
            {
                using var apps = root.OpenSubKey(@"SOFTWARE\RegisteredApplications");
                foreach (var name in apps?.GetValueNames() ?? []) Read(() =>
                {
                    if (apps!.GetValue(name) is not string capPath) return;
                    _watchCapabilities?.Invoke(root, capPath);
                    using var urls = root.OpenSubKey($@"{capPath}\URLAssociations");
                    foreach (var scheme in new[] { "http", "https" })
                        if (urls?.GetValue(scheme) is string id) Read(() => ProgId(id));
                });
            });
            foreach (var scheme in new[] { "http", "https" })
            {
                var association = $@"SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\{scheme}";
                Read(() =>
                {
                    using var choice = root.OpenSubKey(association + @"\UserChoice");
                    if (choice?.GetValue("ProgId") is string id) ProgId(id);
                });
                foreach (var location in new[] { $@"SOFTWARE\Classes\{scheme}\OpenWithProgids", association + @"\OpenWithProgids" }) Read(() =>
                {
                    using var progIds = root.OpenSubKey(location);
                    foreach (var id in progIds?.GetValueNames() ?? []) Read(() => ProgId(id));
                });
            }
        }
        foreach (var scheme in new[] { "http", "https" }) Read(() => AddCommand(_effectiveCommand?.Invoke(scheme)));
        _browserExes = found;
        _browsersLoaded = true;
    }

    static string? EffectiveCommand(string scheme)
    {
        uint length = 0;
        var result = Native.AssocQueryString(0x1000, 1, scheme, null, null, ref length);
        if (result == unchecked((int)0x80070483)) return null;
        if (length == 0) throw new InvalidDataException();
        var chars = new char[checked((int)length)];
        fixed (char* buffer = chars)
        {
            if (Native.AssocQueryString(0x1000, 1, scheme, null, buffer, ref length) != 0) throw new InvalidDataException();
        }
        return new string(chars).TrimEnd('\0');
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
