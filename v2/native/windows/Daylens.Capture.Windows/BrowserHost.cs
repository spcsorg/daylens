// Native messaging host mode: started by a browser for the Daylens extension, it forwards tab reports to the
// capture service as protocol lines over a per-user named pipe and relays status back. It captures nothing itself.

using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.Versioning;
using System.Security.Principal;
using Daylens.Capture.Core;

namespace Daylens.Capture.Windows;

[SupportedOSPlatform("windows")]
internal static unsafe class BrowserHost
{
    /// The service may not be running; check again this often. Also on every message from the extension.
    const int RetryMs = 30_000;

    public static int? TryRun(string[] args)
    {
        var launch = HostLaunch.Detect(args);
        if (launch is null) return null;
        if (!HostLaunch.Allowed.Contains(launch.ExtensionId))
        {
            Diag.Write("browser_host_refused", "extension");
            return 1;
        }
        var host = new Host(launch.ExtensionId, BrowserIdentity(), PipeName());
        return host.Run();
    }

    static string PipeName()
    {
        var env = Environment.GetEnvironmentVariable("DAYLENS_V2_BROWSER_SOCKET");
        if (!string.IsNullOrEmpty(env)) return env.StartsWith(@"\\.\pipe\", StringComparison.OrdinalIgnoreCase) ? env[9..] : env;
        return $"daylens-v2-browser-{Environment.UserName}";
    }

    static AppInfo BrowserIdentity()
    {
        var snapshot = Snapshot();
        var pid = LaunchChain.BrowserPid(Environment.ProcessId, p => snapshot.TryGetValue(p, out var e) ? e : null);
        return pid is int browser ? Identify(browser) : AppInfo.Unknown(null, IdentityState.Unresolved);
    }

    internal static AppInfo Identify(int browser)
    {
        var h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)browser);
        if (h == 0) return AppInfo.Unknown(browser, IdentityState.AccessDenied);
        try
        {
            var path = ImagePath(h);
            if (path is null) return AppInfo.Unknown(browser, IdentityState.Gone);
            string? aumid = null, package = null;
            var buf = stackalloc char[512];
            uint len = 512;
            if (Native.GetApplicationUserModelId(h, ref len, buf) == 0 && len > 1) aumid = new string(buf, 0, (int)len - 1);
            len = 512;
            if (Native.GetPackageFullName(h, ref len, buf) == 0 && len > 1) package = new string(buf, 0, (int)len - 1);
            string? name = null;
            try { name = FileVersionInfo.GetVersionInfo(path).FileDescription?.Trim(); } catch { Diag.Write("version_info_failed"); }
            if (string.IsNullOrEmpty(name)) name = Path.GetFileNameWithoutExtension(path);
            // registered_browser is not read for tab lines; this host does not look it up.
            return new AppInfo(aumid ?? path, name, path, browser, false, IdentityState.Ok, aumid is null ? null : new StoreIdentity(aumid, package));
        }
        finally { Native.CloseHandle(h); }
    }

    internal static Dictionary<int, ProcessEntry> Snapshot()
    {
        var map = new Dictionary<int, ProcessEntry>();
        var snap = Native.CreateToolhelp32Snapshot(Native.TH32CS_SNAPPROCESS, 0);
        if (snap == -1 || snap == 0) return map;
        try
        {
            var e = new Native.PROCESSENTRY32W { dwSize = (uint)sizeof(Native.PROCESSENTRY32W) };
            for (var ok = Native.Process32First(snap, ref e); ok; ok = Native.Process32Next(snap, ref e))
            {
                var pid = (int)e.th32ProcessID;
                var image = new string(e.szExeFile);
                map[pid] = new ProcessEntry(pid, (int)e.th32ParentProcessID, image, CreationTime(pid));
            }
        }
        finally { Native.CloseHandle(snap); }
        return map;
    }

    static long CreationTime(int pid)
    {
        var h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
        if (h == 0) return long.MaxValue;
        try { return Native.GetProcessTimes(h, out var c, out _, out _, out _) ? c : long.MaxValue; }
        finally { Native.CloseHandle(h); }
    }

    static string? ImagePath(nint h)
    {
        var buf = stackalloc char[4096];
        uint size = 4096;
        return Native.QueryFullProcessImageName(h, 0, buf, ref size) ? new string(buf, 0, (int)size) : null;
    }

    internal static bool SameUser(int pid)
    {
        var h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
        if (h == 0) return false;
        try
        {
            if (!Native.OpenProcessToken(h, Native.TOKEN_QUERY, out var token)) return false;
            try
            {
                using var them = new WindowsIdentity(token);
                using var us = WindowsIdentity.GetCurrent();
                return them.User is not null && them.User == us.User;
            }
            finally { Native.CloseHandle(token); }
        }
        finally { Native.CloseHandle(h); }
    }

    sealed class Host
    {
        readonly string _extensionId;
        readonly AppInfo _browser;
        readonly string _pipeName;
        readonly object _gate = new();
        readonly object _stdoutGate = new();
        readonly Stream _stdout = Console.OpenStandardOutput();
        readonly Emitter _emitter;
        NamedPipeClientStream? _pipe;
        Timer? _retry;

        public Host(string extensionId, AppInfo browser, string pipeName)
        {
            _extensionId = extensionId;
            _browser = browser;
            _pipeName = pipeName;
            _emitter = new Emitter(Guid.NewGuid().ToString(), Clock.BootId(), "windows", WritePipe, capacity: 256, reserve: 0);
        }

        public int Run()
        {
            Diag.Write("browser_host_started", Names.Of(_browser.IdentityState));
            if (!Connect()) Reply(HostReply.NotRunning());
            _retry = new Timer(_ => { if (!Connected) Connect(); }, null, RetryMs, RetryMs);
            var stdin = Console.OpenStandardInput();
            var reader = new FrameReader();
            var chunk = new byte[16 * 1024];
            while (true)
            {
                int n;
                try { n = stdin.Read(chunk, 0, chunk.Length); } catch (IOException) { n = 0; }
                if (n <= 0) return 0; // the browser closed the port
                foreach (var item in reader.Feed(chunk.AsSpan(0, n)))
                {
                    if (item.Message is null) { Diag.Write("browser_host_dropped", "too_long"); continue; }
                    var m = ExtensionMessage.Parse(item.Message);
                    if (m is null) { Diag.Write("browser_host_dropped", "bad_message"); continue; }
                    Handle(m);
                }
            }
        }

        bool Connected { get { lock (_gate) return _pipe is not null; } }

        void Handle(ExtensionMessage m)
        {
            switch (m)
            {
                case ExtensionMessage.Open:
                    Reply(HostReply.Opened(OpenDaylens()));
                    break;
                case ExtensionMessage.TabMsg t:
                    if (!Connected) Connect();
                    _emitter.Emit("tab", "browser_ext", Clock.Now(), TabObs.Tab(t.Report, _browser, _extensionId), Emitter.Priority.Normal);
                    break;
                default:
                    if (!Connected && !Connect()) { Reply(HostReply.NotRunning()); break; }
                    if (HostReply.Control(m) is { } line) WritePipe(line);
                    break;
            }
        }

        bool Connect()
        {
            lock (_gate)
            {
                if (_pipe is not null) return true;
                var p = new NamedPipeClientStream(".", _pipeName, PipeDirection.InOut, PipeOptions.None);
                try { p.Connect(50); }
                catch (Exception e) when (e is TimeoutException or IOException or UnauthorizedAccessException) { p.Dispose(); return false; }
                // A pipe name can be taken by anyone; only a listener running as this user gets browsing data.
                if (!Native.GetNamedPipeServerProcessId(p.SafePipeHandle.DangerousGetHandle(), out var server) || !SameUser((int)server))
                {
                    Diag.Write("browser_host_refused", "server");
                    p.Dispose();
                    return false;
                }
                _pipe = p;
                new Thread(() => ReadService(p)) { IsBackground = true, Name = "daylens.browser.service" }.Start();
            }
            Diag.Write("browser_host_connected");
            // Daylens has no state from us yet; ask the extension for the present.
            Reply(HostReply.Snapshot());
            return true;
        }

        void Disconnect(NamedPipeClientStream p)
        {
            lock (_gate)
            {
                if (!ReferenceEquals(_pipe, p)) return;
                _pipe = null;
            }
            p.Dispose();
            Diag.Write("browser_host_disconnected");
            Reply(HostReply.NotRunning());
        }

        void WritePipe(byte[] line)
        {
            NamedPipeClientStream? p;
            lock (_gate) p = _pipe;
            if (p is null) return;
            try { p.Write(line); p.Flush(); }
            catch (Exception e) when (e is IOException or ObjectDisposedException) { Disconnect(p); }
        }

        void ReadService(NamedPipeClientStream p)
        {
            var pending = new List<byte>();
            var chunk = new byte[4096];
            while (true)
            {
                int n;
                try { n = p.Read(chunk, 0, chunk.Length); }
                catch (Exception e) when (e is IOException or ObjectDisposedException) { n = 0; }
                if (n <= 0) { Disconnect(p); return; }
                for (var i = 0; i < n; i++)
                {
                    if (chunk[i] != (byte)'\n') { pending.Add(chunk[i]); continue; }
                    if (HostReply.FromService(pending.ToArray()) is { } reply) Reply(reply);
                    pending.Clear();
                }
                if (pending.Count > 16 * 1024) pending.Clear();
            }
        }

        void Reply(byte[] json)
        {
            if (NativeFrame.Encode(json) is not { } frame) return;
            lock (_stdoutGate)
            {
                try { _stdout.Write(frame); _stdout.Flush(); }
                catch (IOException) { Environment.Exit(0); }
            }
        }

        /// Opens the Daylens app installed alongside this helper. A dev build has none.
        static bool OpenDaylens()
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            for (var i = 0; i < 5 && dir is not null; i++, dir = dir.Parent)
            {
                var exe = Path.Combine(dir.FullName, "Daylens.exe");
                if (!File.Exists(exe)) continue;
                try { return Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true }) is not null; }
                catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException) { return false; }
            }
            return false;
        }
    }
}
