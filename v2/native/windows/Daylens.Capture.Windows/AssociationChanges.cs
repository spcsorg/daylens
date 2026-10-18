using System.Runtime.Versioning;
using Microsoft.Win32;

namespace Daylens.Capture.Windows;

[SupportedOSPlatform("windows")]
internal sealed class AssociationChanges
{
    readonly List<(RegistryKey Key, AutoResetEvent Signal)> _watches = [];
    readonly HashSet<(RegistryKey Root, string Path)> _paths = [];

    public void Refresh()
    {
        foreach (var (key, signal) in _watches) { key.Dispose(); signal.Dispose(); }
        _watches.Clear();
        _paths.Clear();
        foreach (var root in new[] { Registry.LocalMachine, Registry.CurrentUser })
            foreach (var path in new[] { @"SOFTWARE\RegisteredApplications", @"SOFTWARE\Clients\StartMenuInternet", @"SOFTWARE\Classes", @"SOFTWARE\Microsoft\Windows\Shell\Associations" }) Watch(root, path);
    }

    public void Watch(RegistryKey root, string path)
    {
        if (!_paths.Add((root, path.ToUpperInvariant()))) return;
        RegistryKey? key;
        while ((key = root.OpenSubKey(path)) is null)
        {
            // A missing key is watched through its nearest existing parent so its creation is still seen.
            var slash = path.LastIndexOf('\\');
            if (path.Length == 0) throw new IOException();
            path = slash < 0 ? "" : path[..slash];
        }
        var signal = new AutoResetEvent(false);
        _watches.Add((key, signal));
        if (Native.RegNotifyChangeKeyValue(key.Handle.DangerousGetHandle(), true, 0x1000000F, signal.SafeWaitHandle.DangerousGetHandle(), true) != 0) throw new IOException();
    }

    public bool Poll()
    {
        var changed = false;
        foreach (var (_, signal) in _watches) changed |= signal.WaitOne(0);
        return changed;
    }
}
