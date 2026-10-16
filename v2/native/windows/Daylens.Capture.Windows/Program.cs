// Daylens V2 capture helper for Windows. Reports facts as protocol v1 lines on stdout; decides nothing.
// Spec: v2/protocol/PROTOCOL.md

using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Daylens.Capture.Core;

namespace Daylens.Capture.Windows;

[SupportedOSPlatform("windows")]
internal static unsafe class Program
{
    const string Version = "2.0.0-dev";
    const nuint TimerHeartbeat = 1, TimerIdle = 2, TimerReconcile = 3;
    const uint MsgShutdown = Native.WM_APP + 1, MsgSnapshot = Native.WM_APP + 2;
    const long ResolverStuckExitMs = 30_000;

    static Emitter _emitter = null!;
    static Resolver _resolver = null!;
    static IdleScheduler _idle = null!;
    static nint _hwnd, _fgHwnd, _nameHook;
    static int _fgPid, _heartbeatS, _idleThresholdS, _reconcileS;
    static bool _idleSuspended;
    static Stream _stdout = null!;

    static int Main(string[] args)
    {
        _heartbeatS = IntArg(args, "--heartbeat-s", 15, 3600);
        _idleThresholdS = IntArg(args, "--idle-threshold-s", 120, 86400);
        _reconcileS = IntArg(args, "--reconcile-s", 60, 86400);
        _stdout = Console.OpenStandardOutput();
        _emitter = new Emitter(Guid.NewGuid().ToString(), Clock.BootId(), "windows", WriteStdout);
        _resolver = new Resolver(_emitter);
        _idle = new IdleScheduler(_idleThresholdS);

        Emit("hello", "helper", Obs.Hello("daylens-capture-windows", Version, Environment.ProcessId, $"Windows {Environment.OSVersion.Version}", _heartbeatS, _idleThresholdS, _reconcileS));

        _hwnd = CreateMessageWindow();
        if (_hwnd == 0) { Diag.Write("create_window_failed"); return 2; }
        if (!Native.WTSRegisterSessionNotification(_hwnd, Native.NOTIFY_FOR_THIS_SESSION)) Diag.Write("wts_register_failed");
        // Required for suspend and resume notices on Modern Standby machines.
        if (Native.RegisterSuspendResumeNotification(_hwnd, Native.DEVICE_NOTIFY_WINDOW_HANDLE) == 0) Diag.Write("suspend_resume_register_failed");
        if (Native.RegisterPowerSettingNotification(_hwnd, Power.GUID_SESSION_DISPLAY_STATUS, Native.DEVICE_NOTIFY_WINDOW_HANDLE) == 0) Diag.Write("display_status_register_failed");

        var fgProc = (nint)(delegate* unmanaged<nint, uint, nint, int, int, uint, uint, void>)&OnWinEvent;
        if (Native.SetWinEventHook(WinEvents.EVENT_SYSTEM_FOREGROUND, WinEvents.EVENT_SYSTEM_FOREGROUND, 0, fgProc, 0, 0, Native.WINEVENT_OUTOFCONTEXT | Native.WINEVENT_SKIPOWNPROCESS) == 0)
            Diag.Write("foreground_hook_failed");

        Native.SetTimer(_hwnd, TimerHeartbeat, (uint)_heartbeatS * 1000, 0);
        Native.SetCoalescableTimer(_hwnd, TimerReconcile, (uint)_reconcileS * 1000, 0, (uint)Math.Max(1000, _reconcileS * 100));

        new Thread(ReadControl) { IsBackground = true, Name = "daylens.capture.stdin" }.Start();

        Snapshot();
        Diag.Write("started");
        while (Native.GetMessage(out var msg, 0, 0, 0) > 0)
        {
            Native.TranslateMessage(msg);
            Native.DispatchMessage(msg);
        }
        _emitter.Flush(TimeSpan.FromSeconds(1));
        return 0;
    }

    static int IntArg(string[] args, string name, int fallback, int max)
    {
        var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length && int.TryParse(args[i + 1], out var v) && v > 0 && v <= max ? v : fallback;
    }

    static void WriteStdout(byte[] line)
    {
        try
        {
            _stdout.Write(line);
            _stdout.Flush();
        }
        catch (IOException) { Environment.Exit(0); } // the reader is gone
    }

    static void Emit(string kind, string source, Action<System.Text.Json.Utf8JsonWriter> obs, EventTime? time = null) =>
        _emitter.Emit(kind, source, time ?? Clock.Now(), obs, kind is "focus" or "input" ? Emitter.Priority.Normal : Emitter.Priority.Critical);

    // --- focus ----------------------------------------------------------------

    static WindowInfo ReadTitle(nint hwnd)
    {
        if (hwnd == 0) return new WindowInfo(null, null, TitleState.Unavailable);
        var id = $"0x{hwnd:X}";
        Marshal.SetLastPInvokeError(0);
        var len = Native.GetWindowTextLength(hwnd);
        // Zero with an error set means the read failed (the window may be gone), not an empty title.
        if (len <= 0) return new WindowInfo(id, null, Marshal.GetLastPInvokeError() == 0 ? TitleState.Empty : TitleState.Unavailable);
        len = Math.Min(len, 4096);
        var buf = stackalloc char[len + 1];
        var n = Native.GetWindowText(hwnd, buf, len + 1);
        return n > 0 ? WindowInfo.Read(id, new string(buf, 0, n)) : new WindowInfo(id, null, TitleState.Empty);
    }

    static void Focus(FocusTrigger trigger, nint hwnd, EventTime time, bool force = false)
    {
        Native.GetWindowThreadProcessId(hwnd, out var pid);
        _fgHwnd = hwnd;
        if ((int)pid != _fgPid)
        {
            _fgPid = (int)pid;
            HookTitleChanges(_fgPid);
        }
        var window = ReadTitle(hwnd);
        // A stuck resolver must not hold back focus changes; report them without identity.
        if (_resolver.StallMs > 3000)
        {
            _resolver.Abandon();
            Emit("focus", "win_event", Obs.Focus(trigger, AppInfo.Unknown((int)pid, IdentityState.Timeout), window), time);
            return;
        }
        _resolver.Submit(new FocusWork(trigger, hwnd, (int)pid, window, time, force, _resolver.Generation));
    }

    // Title changes are hooked only for the foreground process, so other apps' events never reach us.
    static void HookTitleChanges(int pid)
    {
        if (_nameHook != 0) Native.UnhookWinEvent(_nameHook);
        _nameHook = 0;
        if (pid == 0) return;
        var proc = (nint)(delegate* unmanaged<nint, uint, nint, int, int, uint, uint, void>)&OnWinEvent;
        _nameHook = Native.SetWinEventHook(WinEvents.EVENT_OBJECT_NAMECHANGE, WinEvents.EVENT_OBJECT_NAMECHANGE, 0, proc, (uint)pid, 0, Native.WINEVENT_OUTOFCONTEXT | Native.WINEVENT_SKIPOWNPROCESS);
        if (_nameHook == 0) Diag.Write("name_hook_failed");
    }

    [UnmanagedCallersOnly]
    static void OnWinEvent(nint hook, uint ev, nint hwnd, int idObject, int idChild, uint thread, uint msEventTime)
    {
        try
        {
            // Filter first: the foreground process can raise many name changes for its own controls.
            var trigger = ev == WinEvents.EVENT_SYSTEM_FOREGROUND ? FocusTrigger.AppChanged
                : ev == WinEvents.EVENT_OBJECT_NAMECHANGE && WinEvents.IsForegroundTitleChange(hwnd, idObject, idChild, _fgHwnd) ? FocusTrigger.TitleChanged
                : (FocusTrigger?)null;
            if (trigger is null) return;
            var (wall, mono) = Win32Time.BackDate(Clock.WallMs(), Clock.MonoUs(), Native.GetTickCount(), msEventTime);
            Focus(trigger.Value, hwnd, Clock.At(wall, mono));
        }
        catch { Diag.Write("winevent_failed"); }
    }

    // --- idle -----------------------------------------------------------------

    static double SecondsSinceInput()
    {
        var info = new Native.LASTINPUTINFO { cbSize = (uint)sizeof(Native.LASTINPUTINFO) };
        if (!Native.GetLastInputInfo(ref info)) return 0;
        return Win32Time.TickDelta(Native.GetTickCount(), info.dwTime) / 1000.0;
    }

    static void CheckIdle(bool snapshot = false)
    {
        var since = SecondsSinceInput();
        var time = Clock.Now();
        var d = _idle.Evaluate(since);
        var report = d.Emit ?? (snapshot ? _idle.Idle : null);
        if (report is bool idle)
            Emit("input", "idle_timer", Obs.Input(idle, time.WallMs - (long)(since * 1000), _idleThresholdS, snapshot), time);
        if (!_idleSuspended)
            Native.SetCoalescableTimer(_hwnd, TimerIdle, (uint)(d.NextCheckS * 1000), 0, d.NextCheckS > 5 ? 1000u : 500u);
    }

    static bool _locked;
    static bool _displaySeen;

    static void SuspendIdle(bool suspend)
    {
        // Nobody types on a locked or sleeping machine; checks resume when it is back and unlocked.
        if (!suspend && _locked) return;
        if (suspend == _idleSuspended) return;
        _idleSuspended = suspend;
        if (suspend) Native.KillTimer(_hwnd, TimerIdle); else CheckIdle();
    }

    // --- session --------------------------------------------------------------

    static string SessionState()
    {
        if (!Native.WTSQuerySessionInformation(0, -1, Native.WTSSessionInfoEx, out var buf, out var bytes) || buf == 0) return "unknown";
        // WTSINFOEXW: Level (4 bytes), then the union aligned to 8 (it holds LARGE_INTEGERs):
        // SessionId at 8, SessionState at 12, SessionFlags at 16.
        try { return bytes >= 20 ? Sessions.FromSessionFlags(Marshal.ReadInt32(buf, 16)) : "unknown"; }
        finally { Native.WTSFreeMemory(buf); }
    }

    static void Snapshot()
    {
        Focus(FocusTrigger.Snapshot, Native.GetForegroundWindow(), Clock.Now(), force: true);
        CheckIdle(snapshot: true);
        var state = SessionState();
        _locked = state == "locked";
        Emit("session", "wts", Obs.Session(state, true));
    }

    // --- window and messages --------------------------------------------------

    static nint CreateMessageWindow()
    {
        var cls = Marshal.StringToHGlobalUni("DaylensCaptureHelper");
        var wc = new Native.WNDCLASSEXW
        {
            cbSize = (uint)sizeof(Native.WNDCLASSEXW),
            lpfnWndProc = (nint)(delegate* unmanaged<nint, uint, nint, nint, nint>)&WndProc,
            hInstance = Native.GetModuleHandleW(0),
            lpszClassName = cls,
        };
        if (Native.RegisterClassEx(wc) == 0) return 0;
        // A hidden top-level window, not HWND_MESSAGE: message-only windows do not receive broadcasts.
        return Native.CreateWindowEx(Native.WS_EX_TOOLWINDOW, "DaylensCaptureHelper", "", 0, 0, 0, 0, 0, 0, 0, wc.hInstance, 0);
    }

    [UnmanagedCallersOnly]
    static nint WndProc(nint hwnd, uint msg, nint wParam, nint lParam)
    {
        try
        {
            switch (msg)
            {
                case Native.WM_TIMER:
                    OnTimer((nuint)wParam);
                    return 0;
                case Native.WM_POWERBROADCAST:
                    OnPower((int)wParam, lParam);
                    return 1;
                case Native.WM_WTSSESSION_CHANGE:
                    OnSession((int)wParam);
                    return 0;
                case Native.WM_TIMECHANGE:
                    Emit("clock", "notification", Obs.Clock(Clock.RefreshTimeZone() ? "timezone_changed" : "time_changed"));
                    return 0;
                case MsgSnapshot:
                    Snapshot();
                    return 0;
                case MsgShutdown:
                    Emit("bye", "helper", Obs.Bye("shutdown"));
                    _emitter.Flush(TimeSpan.FromSeconds(1));
                    Native.PostQuitMessage(0);
                    return 0;
                case Native.WM_CLOSE:
                    // Restart Manager or a plain taskkill asks politely; the window and its timers must survive.
                    Diag.Write("close_ignored");
                    return 0;
                case Native.WM_QUERYENDSESSION:
                    return 1;
                case Native.WM_ENDSESSION:
                    if (wParam != 0)
                    {
                        Emit("bye", "helper", Obs.Bye("session_end"));
                        _emitter.Flush(TimeSpan.FromSeconds(1));
                    }
                    return 0;
                case Native.WM_DESTROY:
                    Native.PostQuitMessage(0);
                    return 0;
            }
        }
        catch { Diag.Write("wndproc_failed"); }
        return Native.DefWindowProc(hwnd, msg, wParam, lParam);
    }

    static void OnTimer(nuint id)
    {
        if (id == TimerHeartbeat)
        {
            var stall = _resolver.StallMs;
            if (stall > ResolverStuckExitMs)
            {
                // A blocked native call cannot be cancelled; restarting the helper frees it.
                Diag.Write("resolver_stuck_exit");
                Environment.Exit(70);
            }
            Emit("heartbeat", "helper", Obs.Heartbeat(Clock.AwakeUs(), stall > 3000 ? ChannelState.Stalled : ChannelState.Ok, stall, _emitter.Dropped));
        }
        else if (id == TimerIdle) CheckIdle();
        else if (id == TimerReconcile)
        {
            var fg = Native.GetForegroundWindow();
            Focus(fg != _fgHwnd ? FocusTrigger.AppChanged : FocusTrigger.Reconcile, fg, Clock.Now());
        }
    }

    static void OnPower(int pbt, nint lParam)
    {
        Guid? setting = null;
        uint? value = null;
        if (pbt == Power.PBT_POWERSETTINGCHANGE && lParam != 0)
        {
            var s = (Native.POWERBROADCAST_SETTING*)lParam;
            setting = s->PowerSetting;
            if (s->DataLength >= sizeof(uint)) value = s->Data;
        }
        var state = Power.Classify(pbt, setting, value);
        if (state is null) return;
        // Registering for display status delivers the current value at once; that is not a change.
        if (setting == Power.GUID_SESSION_DISPLAY_STATUS && !_displaySeen)
        {
            _displaySeen = true;
            return;
        }
        Emit("power", "power", Obs.Power(state));
        if (state == "sleep") SuspendIdle(true);
        else if (state == "resume")
        {
            _idle.Reset();
            SuspendIdle(false);
        }
    }

    static void OnSession(int wts)
    {
        var state = Sessions.Classify(wts);
        if (state is null) return;
        Emit("session", "wts", Obs.Session(state, false));
        if (state is "locked" or "console_disconnect" or "remote_disconnect")
        {
            _locked = state == "locked" || _locked;
            SuspendIdle(true);
        }
        else if (state is "unlocked" or "console_connect" or "remote_connect")
        {
            if (state == "unlocked") _locked = false;
            SuspendIdle(false);
            Focus(FocusTrigger.Reconcile, Native.GetForegroundWindow(), Clock.Now());
        }
    }

    // --- control --------------------------------------------------------------

    static volatile bool _shutdownRequested;

    static void ReadControl()
    {
        using var stdin = new StreamReader(Console.OpenStandardInput());
        string? line;
        while ((line = stdin.ReadLine()) is not null)
        {
            var op = line.Replace(" ", "");
            if (op.Contains("\"op\":\"shutdown\""))
            {
                _shutdownRequested = true;
                Native.PostMessage(_hwnd, MsgShutdown, 0, 0);
            }
            else if (op.Contains("\"op\":\"snapshot\"")) Native.PostMessage(_hwnd, MsgSnapshot, 0, 0);
        }
        // The capture service is gone. A requested shutdown gets a moment to write bye first.
        if (_shutdownRequested) Thread.Sleep(2000);
        Environment.Exit(0);
    }
}
