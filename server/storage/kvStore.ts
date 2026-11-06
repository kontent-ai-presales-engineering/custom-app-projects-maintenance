/**
 * Minimal JSON key-value storage. Vercel Blob in production, in memory in tests.
 * Keeping this interface small makes the storage backend swappable.
 */
export type KvStore = Readonly<{
  getJson: (key: string) => Promise<unknown>;
  setJson: (key: string, value: unknown) => Promise<void>;
  /** Writes only if the key does not exist yet, atomically. Returns false when it already existed. */
  createIfAbsent: (key: string, value: unknown) => Promise<boolean>;
  delete: (key: string) => Promise<void>;
  /** Keys starting with the prefix, sorted ascending. */
  listKeys: (prefix: string) => Promise<ReadonlyArray<string>>;
}>;

/** Plain code-point order, so zero-padded keys sort chronologically. */
export const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const createInMemoryKvStore = (): KvStore & { readonly raw: Map<string, string> } => {
  const raw = new Map<string, string>();

  return {
    raw,
    getJson: async (key) => {
      const value = await Promise.resolve(raw.get(key));
      return value === undefined ? null : (JSON.parse(value) as unknown);
    },
    setJson: async (key, value) => {
      await Promise.resolve();
      raw.set(key, JSON.stringify(value));
    },
    createIfAbsent: async (key, value) => {
      await Promise.resolve();
      if (raw.has(key)) {
        return false;
      }
      raw.set(key, JSON.stringify(value));
      return true;
    },
    delete: async (key) => {
      await Promise.resolve();
      raw.delete(key);
    },
    listKeys: async (prefix) =>
      Promise.resolve([...raw.keys()].filter((key) => key.startsWith(prefix)).sort(compareKeys)),
  };
};
