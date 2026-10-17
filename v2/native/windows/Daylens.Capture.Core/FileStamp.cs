namespace Daylens.Capture.Core;

/// Identity of a file's current contents. A cached verdict keyed on it cannot outlive an app update.
public readonly record struct FileStamp(string Path, long Length, long LastWriteUtcTicks)
{
    public static FileStamp? Of(string path)
    {
        try
        {
            var f = new FileInfo(path);
            if (!f.Exists) return null;
            return new FileStamp(f.FullName.ToLowerInvariant(), f.Length, f.LastWriteTimeUtc.Ticks);
        }
        catch
        {
            return null;
        }
    }
}
