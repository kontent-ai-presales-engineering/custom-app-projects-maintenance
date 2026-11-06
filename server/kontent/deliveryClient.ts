import { z } from "zod";
import { KontentApiError } from "./kontentHttp.js";

const deliveryBaseUrl = "https://deliver.kontent.ai";
const maxRetries = 3;

const feedPageSchema = z.object({
  items: z.array(
    z.object({
      elements: z.record(z.string(), z.object({ type: z.string(), value: z.unknown() })),
    }),
  ),
});

export type PublishedItem = z.infer<typeof feedPageSchema>["items"][number];

/**
 * Delivery API client for published content counts. Read-only by nature. A key is
 * only needed when secure access is enabled for the environment.
 */
export type DeliveryClient = Readonly<{
  /**
   * All published items of a type in one language (no language fallbacks), with only
   * the requested elements.
   */
  publishedItems: (
    typeCodename: string,
    languageCodename: string,
    elementCodenames: ReadonlyArray<string>,
  ) => Promise<ReadonlyArray<PublishedItem>>;
}>;

export type DeliveryClientOptions = Readonly<{
  environmentId: string;
  apiKey?: string | undefined;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}>;

export const createDeliveryClient = (options: DeliveryClientOptions): DeliveryClient => {
  const fetchFn = options.fetchFn ?? fetch;
  const sleep =
    options.sleep ??
    (async (ms: number) => {
      await new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    });

  const get = async (url: string, headers: Record<string, string>) => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchFn(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
          ...headers,
        },
      });
      if (response.status !== 429 || attempt >= maxRetries) {
        return response;
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2) * 1000);
    }
  };

  return {
    publishedItems: async (typeCodename, languageCodename, elementCodenames) => {
      const query = new URLSearchParams({
        "system.type": typeCodename,
        language: languageCodename,
        // Without this, items not translated into the language come back in a fallback language.
        "system.language": languageCodename,
      });
      if (elementCodenames.length > 0) {
        query.set("elements", elementCodenames.join(","));
      }
      const url = `${deliveryBaseUrl}/${encodeURIComponent(options.environmentId)}/items-feed?${query.toString()}`;
      const items: PublishedItem[] = [];
      let continuation: string | null = null;
      do {
        const response = await get(
          url,
          continuation === null ? {} : { "x-continuation": continuation },
        );
        if (!response.ok) {
          throw new KontentApiError(
            response.status,
            `Delivery API items feed failed with status ${response.status}`,
          );
        }
        items.push(...feedPageSchema.parse(await response.json()).items);
        continuation = response.headers.get("x-continuation");
      } while (continuation !== null && continuation !== "");
      return items;
    },
  };
};
