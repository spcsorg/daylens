using System.Runtime.InteropServices;

namespace Daylens.Capture.Windows;

internal static unsafe partial class Native
{
    public const uint WINEVENT_OUTOFCONTEXT = 0x0000, WINEVENT_SKIPOWNPROCESS = 0x0002;
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    public const int ERROR_INSUFFICIENT_BUFFER = 122, APPMODEL_ERROR_NO_APPLICATION = 15703, APPMODEL_ERROR_NO_PACKAGE = 15700;
    public const uint WM_DESTROY = 0x0002, WM_CLOSE = 0x0010, WM_TIMER = 0x0113, WM_POWERBROADCAST = 0x0218, WM_TIMECHANGE = 0x001E;
    public const uint WM_WTSSESSION_CHANGE = 0x02B1, WM_APP = 0x8000;
    public const uint NOTIFY_FOR_THIS_SESSION = 0;
    public const uint DEVICE_NOTIFY_WINDOW_HANDLE = 0;
    public const uint WS_EX_TOOLWINDOW = 0x80;
    public const int WTSSessionInfoEx = 25;

    public delegate void WinEventProc(nint hook, uint ev, nint hwnd, int idObject, int idChild, uint thread, uint msEventTime);
    public delegate nint WndProc(nint hwnd, uint msg, nint wParam, nint lParam);
    public delegate int EnumWindowsProc(nint hwnd, nint lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public nint hwnd; public uint message; public nint wParam; public nint lParam; public uint time; public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WNDCLASSEXW
    {
        public uint cbSize; public uint style; public nint lpfnWndProc; public int cbClsExtra; public int cbWndExtra;
        public nint hInstance; public nint hIcon; public nint hCursor; public nint hbrBackground; public nint lpszMenuName; public nint lpszClassName; public nint hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POWERBROADCAST_SETTING { public Guid PowerSetting; public uint DataLength; public uint Data; }

    [LibraryImport("user32.dll")] public static partial nint SetWinEventHook(uint min, uint max, nint hmod, nint proc, uint pid, uint thread, uint flags);
    [LibraryImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool UnhookWinEvent(nint hook);
    [LibraryImport("user32.dll")] public static partial nint GetForegroundWindow();
    [LibraryImport("user32.dll")] public static partial uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [LibraryImport("user32.dll", EntryPoint = "GetWindowTextLengthW", SetLastError = true)] public static partial int GetWindowTextLength(nint hwnd);
    [LibraryImport("user32.dll", EntryPoint = "GetWindowTextW", SetLastError = true)] public static partial int GetWindowText(nint hwnd, char* buf, int max);
    [LibraryImport("user32.dll", EntryPoint = "GetClassNameW")] public static partial int GetClassName(nint hwnd, char* buf, int max);
    [LibraryImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool EnumChildWindows(nint parent, nint proc, nint lParam);
    [LibraryImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool GetLastInputInfo(ref LASTINPUTINFO info);
    [LibraryImport("user32.dll", EntryPoint = "GetMessageW")] public static partial int GetMessage(out MSG msg, nint hwnd, uint min, uint max);
    [LibraryImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool TranslateMessage(in MSG msg);
    [LibraryImport("user32.dll", EntryPoint = "DispatchMessageW")] public static partial nint DispatchMessage(in MSG msg);
    [LibraryImport("user32.dll", EntryPoint = "PostMessageW")] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool PostMessage(nint hwnd, uint msg, nint w, nint l);
    [LibraryImport("user32.dll", EntryPoint = "DefWindowProcW")] public static partial nint DefWindowProc(nint hwnd, uint msg, nint w, nint l);
    [LibraryImport("user32.dll", EntryPoint = "RegisterClassExW")] public static partial ushort RegisterClassEx(in WNDCLASSEXW wc);
    [LibraryImport("user32.dll", EntryPoint = "CreateWindowExW", StringMarshalling = StringMarshalling.Utf16)]
    public static partial nint CreateWindowEx(uint exStyle, string cls, string name, uint style, int x, int y, int w, int h, nint parent, nint menu, nint inst, nint param);
    [LibraryImport("user32.dll")] public static partial nuint SetTimer(nint hwnd, nuint id, uint ms, nint proc);
    [LibraryImport("user32.dll")] public static partial nuint SetCoalescableTimer(nint hwnd, nuint id, uint ms, nint proc, uint tolerance);
    [LibraryImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool KillTimer(nint hwnd, nuint id);
    [LibraryImport("user32.dll")] public static partial void PostQuitMessage(int code);
    [LibraryImport("user32.dll")] public static partial nint RegisterSuspendResumeNotification(nint recipient, uint flags);
    [LibraryImport("user32.dll")] public static partial nint RegisterPowerSettingNotification(nint recipient, in Guid setting, uint flags);
    [LibraryImport("wtsapi32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool WTSRegisterSessionNotification(nint hwnd, uint flags);
    [LibraryImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW")] [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool WTSQuerySessionInformation(nint server, int session, int infoClass, out nint buffer, out uint bytes);
    [LibraryImport("wtsapi32.dll")] public static partial void WTSFreeMemory(nint mem);

    [LibraryImport("kernel32.dll", SetLastError = true)] public static partial nint OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
    [LibraryImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool CloseHandle(nint h);
    [LibraryImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool QueryFullProcessImageName(nint process, uint flags, char* buf, ref uint size);
    [LibraryImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool GetProcessTimes(nint process, out long creation, out long exit, out long kernel, out long user);
    [LibraryImport("kernel32.dll")] public static partial int GetApplicationUserModelId(nint process, ref uint length, char* buf);
    [LibraryImport("kernel32.dll")] public static partial int GetPackageFullName(nint process, ref uint length, char* buf);
    [LibraryImport("kernel32.dll", StringMarshalling = StringMarshalling.Utf16)] public static partial int GetPackagePathByFullName(string fullName, ref uint length, char* buf);
    [LibraryImport("kernel32.dll")] public static partial void QueryInterruptTimePrecise(out ulong time);
    [LibraryImport("kernel32.dll")] public static partial void GetSystemTimePreciseAsFileTime(out long fileTime);
    [LibraryImport("kernel32.dll")] public static partial uint GetTickCount();
    [LibraryImport("kernel32.dll")] public static partial nint GetModuleHandleW(nint name);

    [LibraryImport("shlwapi.dll", EntryPoint = "SHLoadIndirectString", StringMarshalling = StringMarshalling.Utf16)]
    public static partial int SHLoadIndirectString(string source, char* outBuf, uint cch, nint reserved);
}
