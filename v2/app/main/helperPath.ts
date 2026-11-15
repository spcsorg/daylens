import path from 'node:path'

/** The native capture helper for this platform, or null where there is none yet (Linux). */
export function helperPath(platform: NodeJS.Platform, packaged: boolean, v2: string, resources: string): string | null {
  if (platform === 'darwin') {
    // Packaged, the helper ships as its own app bundle, so System Settings lists it by name and icon.
    return packaged ? path.join(resources, '..', 'Helpers', 'Daylens.app', 'Contents', 'MacOS', 'daylens-capture-macos') : path.join(v2, 'native', 'macos', '.build', 'release', 'daylens-capture-macos')
  }
  if (platform === 'win32') return packaged ? path.join(resources, 'daylens-capture-windows.exe') : path.join(v2, 'native', 'windows', 'publish', 'daylens-capture-windows.exe')
  return null
}
