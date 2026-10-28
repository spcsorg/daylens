// The key that opens Search: Cmd+K on macOS, Ctrl+K elsewhere. On a Mac, Ctrl+K deletes to the end of a line in a text
// field, so it is left alone there.
export function opensSearch(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key'>, platform: string): boolean {
  const mod = platform === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k'
}
