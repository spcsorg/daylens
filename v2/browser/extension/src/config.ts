// Store builds use the local connection only on Windows, where the Store package cannot register a native host.
// The dev build sets this to true so the local connection can be tested on any platform.
export const LOCAL_EVERYWHERE = false
