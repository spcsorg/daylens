import Darwin
import Foundation

/// Identity of a file's current contents. A cached verdict keyed on it cannot outlive an app update.
public struct FileStamp: Hashable {
  public var device: UInt64
  public var inode: UInt64
  public var size: Int64
  public var mtimeNs: Int64

  public static func of(_ path: String) -> FileStamp? {
    var st = stat()
    guard stat(path, &st) == 0 else { return nil }
    return FileStamp(device: UInt64(st.st_dev), inode: UInt64(st.st_ino), size: Int64(st.st_size),
                     mtimeNs: Int64(st.st_mtimespec.tv_sec) * 1_000_000_000 + Int64(st.st_mtimespec.tv_nsec))
  }
}

/// Info.plist and the main executable: an update that changes what an app is changes at least one of them.
public struct BundleStamp: Hashable {
  public var path: String
  public var infoPlist: FileStamp
  public var executable: FileStamp?

  public static func of(_ url: URL) -> BundleStamp? {
    let plist = url.appendingPathComponent("Contents/Info.plist")
    guard let info = FileStamp.of(plist.path) else { return nil }
    let name = (NSDictionary(contentsOf: plist) as? [String: Any])?["CFBundleExecutable"] as? String
    let exe = name.flatMap { FileStamp.of(url.appendingPathComponent("Contents/MacOS/\($0)").path) }
    return BundleStamp(path: url.path, infoPlist: info, executable: exe)
  }
}

/// A process is its PID plus its start time, so a reused PID is a different process.
public struct ProcessKey: Hashable {
  public var pid: Int32
  public var startSec: UInt64
  public var startUsec: UInt64

  public static func of(_ pid: Int32) -> ProcessKey? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
    return ProcessKey(pid: pid, startSec: info.pbi_start_tvsec, startUsec: info.pbi_start_tvusec)
  }
}
