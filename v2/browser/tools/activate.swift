// Brings one process to the front by pid, for live tests where two instances of the same app run side by side.
// Usage: activate <pid>
import AppKit

guard CommandLine.arguments.count == 2, let pid = pid_t(CommandLine.arguments[1]), let app = NSRunningApplication(processIdentifier: pid) else { exit(64) }
exit(app.activate(options: [.activateAllWindows]) ? 0 : 1)
