// A few small values kept across restarts in the extension's own IndexedDB, which needs no "storage" permission.

const DB = 'daylens'
const STORE = 'kv'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(req.result as T)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

export function get<T>(key: string): Promise<T | undefined> {
  return run<T | undefined>('readonly', (s) => s.get(key))
}

export function set(key: string, value: unknown): Promise<void> {
  return run<void>('readwrite', (s) => (value === undefined ? s.delete(key) : s.put(value, key)))
}
