// The key the window handles to open Search: Ctrl+K on Windows and Linux. On macOS the app menu's Search… item owns Cmd+K
// (Electron registers menu shortcuts there regardless), and Ctrl+K deletes to the end of a line in a text field, so the
// window handles neither.
export function opensSearch(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key'>, platform: string): boolean {
  return platform !== 'darwin' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k'
}
