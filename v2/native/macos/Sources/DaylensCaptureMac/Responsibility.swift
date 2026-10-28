// macOS checks a process's privacy permissions against the process responsible for it, which for a spawned helper is
// whatever launched the service (node under launchd). The helper re-executes itself once, in place (same pid, same
// pipes), with that responsibility disclaimed, so window-title access is granted to this helper and to nothing else.
// Both calls are private libsystem API looked up at run time.
import Darwin
import Foundation

typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t
private typealias DisclaimFn = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32

private func lookup<T>(_ name: String) -> T? {
  guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else { return nil }
  return unsafeBitCast(sym, to: T.self)
}

let responsibleFn: ResponsibleFn? = lookup("responsibility_get_pid_responsible_for_pid")
private let disclaimFn: DisclaimFn? = lookup("responsibility_spawnattrs_setdisclaim")

// Set across the re-exec only, so a failed disclaim is reported once instead of re-executing forever.
private let reexecMarker = "DAYLENS_HELPER_REEXEC"

/// Returns only when this process is responsible for itself, or when it cannot become so (reported on stderr).
func takeResponsibility() {
  let reexeced = getenv(reexecMarker) != nil
  unsetenv(reexecMarker)
  guard let responsible = responsibleFn, let disclaim = disclaimFn else { return diag("responsibility", "unavailable") }
  if responsible(getpid()) == getpid() { return }
  if reexeced { return diag("responsibility", "not_taken") }
  var path = [CChar](repeating: 0, count: Int(MAXPATHLEN))
  var size = UInt32(path.count)
  guard _NSGetExecutablePath(&path, &size) == 0 else { return diag("responsibility", "no_path") }
  var attr: posix_spawnattr_t?
  guard posix_spawnattr_init(&attr) == 0 else { return diag("responsibility", "spawnattr_failed") }
  defer { posix_spawnattr_destroy(&attr) }
  guard posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC)) == 0, disclaim(&attr, 1) == 0 else { return diag("responsibility", "spawnattr_failed") }
  setenv(reexecMarker, "1", 1)
  let rc = posix_spawn(nil, path, nil, &attr, CommandLine.unsafeArgv, environ)
  unsetenv(reexecMarker)
  diag("responsibility", "reexec_failed_\(rc)")
}

/// --responsible-pid <pid>...: the pid macOS holds responsible for each process, one per line ("-" when unknown).
func runResponsiblePidIfAsked() {
  let args = CommandLine.arguments
  guard let i = args.firstIndex(of: "--responsible-pid") else { return }
  for p in args[(i + 1)...] {
    let r = Int32(p).flatMap { pid in responsibleFn.map { $0(pid) } }
    print("\(r.map(String.init) ?? "-")\t\(p)")
  }
  exit(0)
}
