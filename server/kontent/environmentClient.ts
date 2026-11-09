import { z } from "zod";
import { createGetter, KontentApiError, kontentApiBaseUrl } from "./kontentHttp.js";

/**
 * Environment management for onboarding: cloning an environment and checking progress.
 * Kept apart from the read-only ManagementClient because cloning creates an environment.
 */
export type EnvironmentClient = Readonly<{
  /** Starts cloning this environment. Returns the new environment's ID only. */
  clone: (name: string, options: Readonly<{ copyContent: boolean }>) => Promise<string>;
  /** "done" when finished; other values while cloning (the API does not document them all). */
  cloningState: () => Promise<string>;
}>;

export type EnvironmentClientOptions = Readonly<{
  environmentId: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}>;

const cloneResponseSchema = z.object({ id: z.string() });
const stateSchema = z.object({ cloning_state: z.string() });

export const createEnvironmentClient = (options: EnvironmentClientOptions): EnvironmentClient => {
  const fetchFn = options.fetchFn ?? fetch;
  const root = `${kontentApiBaseUrl}/projects/${encodeURIComponent(options.environmentId)}`;
  const get = createGetter({ apiKey: options.apiKey, fetchFn });

  return {
    clone: async (name, { copyContent }) => {
      const response = await fetchFn(`${root}/clone-environment`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          name,
          copy_data_options: {
            content_items_assets: copyContent,
            content_item_version_history: false,
          },
        }),
      });
      if (!response.ok) {
        throw new KontentApiError(
          response.status,
          `Management API environment cloning failed with status ${response.status}`,
        );
      }
      // The response also contains a Management API key. Only the ID is kept.
      return cloneResponseSchema.parse(await response.json()).id;
    },

    cloningState: async () => {
      const response = await get(`${root}/environment-cloning-state`);
      if (!response.ok) {
        throw new KontentApiError(
          response.status,
          `Management API cloning state failed with status ${response.status}`,
        );
      }
      return stateSchema.parse(await response.json()).cloning_state;
    },
  };
};
