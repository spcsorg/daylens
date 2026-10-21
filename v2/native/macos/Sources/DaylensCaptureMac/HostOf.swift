// --host-of <pid>...: one JSON line per pid naming the app that process runs in. The responsible-process call is a
// private API looked up at run time; without it, or with --no-responsibility, the parent chain is used.
import AppKit
import CaptureCore
import Foundation

private func parentPid(_ pid: Int32) -> Int32? {
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.stride
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
  guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
  return info.kp_eproc.e_ppid
}

// An app the user sees: a running application with a bundle and a regular or accessory activation policy.
private func runningApp(_ pid: Int32) -> NSRunningApplication? {
  guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated, app.bundleURL != nil, app.activationPolicy != .prohibited else { return nil }
  return app
}

func hostOf(_ pid: Int32, useResponsibility: Bool) -> (HostBasis, NSRunningApplication?) {
  if useResponsibility, let fn = responsibleFn {
    let r = fn(pid)
    if r > 1, r != pid, let app = runningApp(r) { return (.responsible, app) }
  }
  // The agent process is never its own host, even when it ships as an app bundle.
  if let up = parentPid(pid), let app = hostAncestor(of: up, parent: parentPid, app: runningApp) { return (.parent, app) }
  return (.none, nil)
}

func runHostOfIfAsked() {
  let args = CommandLine.arguments
  guard let i = args.firstIndex(of: "--host-of") else { return }
  let useResponsibility = !args.contains("--no-responsibility")
  for p in args[(i + 1)...] {
    guard let pid = Int32(p) else { continue }
    let (basis, app) = hostOf(pid, useResponsibility: useResponsibility)
    let identity: JSON = app.map { a in
      JSON.object([("app_id", .str(a.bundleIdentifier ?? a.executableURL?.path)), ("name", .str(a.localizedName)), ("path", .str(a.bundleURL?.path)), ("pid", .int(Int64(a.processIdentifier)))])
    } ?? .null
    print(JSON.object([("pid", .int(Int64(pid))), ("basis", .string(basis.rawValue)), ("app", identity)]).serialized())
  }
  exit(0)
}
