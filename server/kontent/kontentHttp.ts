export const kontentApiBaseUrl = "https://manage.kontent.ai/v2";

const maxRetries = 3;
const defaultRetryAfterSeconds = 2;

export class KontentApiError extends Error {
  override readonly name = "KontentApiError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type HttpOptions = Readonly<{
  apiKey: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}>;

const defaultSleep = async (ms: number) => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/**
 * Returns a function that sends GET requests only, with the API key as bearer token.
 * 429 responses are retried up to three times, honouring Retry-After.
 */
export const createGetter = (options: HttpOptions) => {
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? defaultSleep;

  return async (url: string, headers: Record<string, string> = {}): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchFn(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          accept: "application/json",
          ...headers,
        },
      });
      if (response.status !== 429 || attempt >= maxRetries) {
        return response;
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(
        (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : defaultRetryAfterSeconds) *
          1000,
      );
    }
  };
};
