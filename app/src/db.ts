// Tiny IndexedDB wrapper. The webview's IndexedDB is the local database on
// every platform, so the apps work fully offline.

type StoreName = 'records' | 'outbox' | 'meta' | 'files';

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('nextly', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('records', { keyPath: 'id' });
      db.createObjectStore('outbox');
      db.createObjectStore('meta');
      db.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  }));
}

export const getAll = <T>(store: StoreName) => run<T[]>(store, 'readonly', (s) => s.getAll());
export const keys = (store: StoreName) => run<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys());
export const get = <T>(store: StoreName, key: string) => run<T | undefined>(store, 'readonly', (s) => s.get(key));
export const put = (store: StoreName, value: unknown, key?: string) =>
  run<IDBValidKey>(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store: StoreName, key: string) => run<undefined>(store, 'readwrite', (s) => s.delete(key));

export interface StoredFile {
  bytes: ArrayBuffer;
  mime: string;
  name: string;
  uploaded: boolean;
}
