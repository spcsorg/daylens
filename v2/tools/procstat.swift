// Samples CPU, memory, wakeups and energy for a process and all its descendants via proc_pid_rusage.
// Usage: procstat --root <pid> [--interval-s 10]   (one JSON line per process per sample, until the root exits)
import Darwin
import Foundation

func arg(_ name: String) -> String? {
  let a = CommandLine.arguments
  guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
  return a[i + 1]
}

guard let root = arg("--root").flatMap({ pid_t($0) }) else {
  FileHandle.standardError.write("usage: procstat --root <pid> [--interval-s 10]\n".data(using: .utf8)!)
  exit(64)
}
let summary = CommandLine.arguments.contains("--summary")
let interval = Double(arg("--interval-s") ?? "10") ?? 10

var timebase = mach_timebase_info_data_t()
mach_timebase_info(&timebase)
func absToNs(_ t: UInt64) -> UInt64 { t * UInt64(timebase.numer) / UInt64(timebase.denom) }

func descendants(of pid: pid_t) -> [pid_t] {
  var out: [pid_t] = [pid]
  var buf = [pid_t](repeating: 0, count: 256)
  let n = proc_listchildpids(pid, &buf, Int32(buf.count * MemoryLayout<pid_t>.size))
  if n > 0 { for c in buf.prefix(Int(n)) where c > 0 { out += descendants(of: c) } }
  return out
}

func name(_ pid: pid_t) -> String {
  var buf = [CChar](repeating: 0, count: 256)
  proc_name(pid, &buf, UInt32(buf.count))
  return String(cString: buf)
}

var combinedPeak: UInt64 = 0
var parentAtPeak: UInt64 = 0
var childAtPeak: UInt64 = 0
var samples = 0
var samplesWithChild = 0
let started = Date()
var nextSample = started
var lastSample = started
var maxGapMs = 0.0
while kill(root, 0) == 0 {
  var parentRSS: UInt64 = 0
  var childRSS: UInt64 = 0
  let sampled = Date()
  if samples > 0 { maxGapMs = max(maxGapMs, sampled.timeIntervalSince(lastSample) * 1000) }
  lastSample = sampled
  let now = Int64(sampled.timeIntervalSince1970 * 1000)
  for pid in descendants(of: root) {
    var info = rusage_info_v6()
    let ok = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V6, $0) }
    }
    guard ok == 0 else { continue }
    if summary {
      if pid == root { parentRSS = info.ri_resident_size }
      else { childRSS += info.ri_resident_size }
      continue
    }
    let line = """
    {"t_ms":\(now),"pid":\(pid),"name":"\(name(pid))","cpu_ns":\(absToNs(info.ri_user_time + info.ri_system_time)),\
    "footprint":\(info.ri_phys_footprint),"peak_footprint":\(info.ri_lifetime_max_phys_footprint),"rss":\(info.ri_resident_size),\
    "idle_wkups":\(info.ri_pkg_idle_wkups),"int_wkups":\(info.ri_interrupt_wkups),"energy_nj":\(info.ri_energy_nj),\
    "disk_write":\(info.ri_diskio_byteswritten),"start_abs":\(info.ri_proc_start_abstime)}
    """
    print(line)
  }
  if summary {
    samples += 1
    if samples == 1 { print("{\"ready\":true}"); fflush(stdout) }
    if childRSS > 0 { samplesWithChild += 1 }
    if parentRSS + childRSS > combinedPeak {
      combinedPeak = parentRSS + childRSS
      parentAtPeak = parentRSS
      childAtPeak = childRSS
    }
  }
  fflush(stdout)
  nextSample = nextSample.addingTimeInterval(interval)
  let delay = nextSample.timeIntervalSinceNow
  if delay > 0 { Thread.sleep(forTimeInterval: delay) }
  else { nextSample = Date() }
}

if summary {
  print("{\"combined_peak_mb\":\(Double(combinedPeak) / 1e6),\"parent_at_peak_mb\":\(Double(parentAtPeak) / 1e6),\"child_at_peak_mb\":\(Double(childAtPeak) / 1e6),\"samples_with_child\":\(samplesWithChild),\"samples\":\(samples),\"max_sample_gap_ms\":\(maxGapMs),\"mean_sample_interval_ms\":\(Date().timeIntervalSince(started) * 1000 / Double(max(1, samples)))}")
}
