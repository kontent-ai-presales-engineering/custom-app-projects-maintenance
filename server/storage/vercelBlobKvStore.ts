import { del, get, list, put } from "@vercel/blob";
import { compareKeys, type KvStore } from "./kvStore.js";

/**
 * KvStore on Vercel Blob with private access. Reads bypass the CDN cache so a value
 * written by one request is seen by the next. Credentials come from the Blob store
 * connected to the Vercel project (BLOB_READ_WRITE_TOKEN).
 */
export const createVercelBlobKvStore = (namespace: string): KvStore => {
  const path = (key: string) => `${namespace}/${key}`;

  return {
    getJson: async (key) => {
      const result = await get(path(key), { access: "private", useCache: false });
      if (result?.statusCode !== 200) {
        return null;
      }
      return JSON.parse(await new Response(result.stream).text()) as unknown;
    },

    setJson: async (key, value) => {
      await put(path(key), JSON.stringify(value), {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
      });
    },

    delete: async (key) => {
      await del(path(key));
    },

    listKeys: async (prefix) => {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ prefix: path(prefix), cursor });
        keys.push(...page.blobs.map((blob) => blob.pathname.slice(namespace.length + 1)));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor !== undefined);
      return keys.sort(compareKeys);
    },
  };
};
