// Reading a record from the edges of a line too long to decode: the envelope fields sit before and after the bulk.

// The start of the JSON string that follows `marker` in `head`, decoded; null when the marker is absent.
export function stringAfter(head: string, marker: string, max = 512): string | null {
  const i = head.indexOf(marker)
  if (i === -1) return null
  let raw = head.slice(i + marker.length, i + marker.length + max)
  const end = raw.search(/(?<!\\)"/)
  if (end !== -1) raw = raw.slice(0, end)
  // Never cut inside an escape sequence.
  raw = raw.replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, '')
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return null
  }
}

// The top-level fields that follow the bulk of a record, rebuilt as an object from the line's tail.
// Fields are tried in order; a candidate that does not parse is a nested occurrence, not the top level.
export function fieldsFromTail(tail: string, keys: readonly string[]): Record<string, unknown> | null {
  for (let i = tail.indexOf(',"'); i !== -1; i = tail.indexOf(',"', i + 2)) {
    const rest = tail.slice(i + 1)
    if (!keys.some((k) => rest.startsWith(`"${k}":`))) continue
    try {
      const o = JSON.parse(`{${rest}`) as unknown
      if (o && typeof o === 'object') return o as Record<string, unknown>
    } catch {}
  }
  return null
}
