import { z } from "zod";
import {
  createGetter,
  type HttpOptions,
  KontentApiError,
  kontentApiBaseUrl,
} from "./kontentHttp.js";

const environmentInfoSchema = z.object({
  id: z.string(),
  /** The project name. */
  name: z.string(),
  /** The environment name. */
  environment: z.string(),
  is_production: z.boolean().optional(),
});

export type EnvironmentInfo = z.infer<typeof environmentInfoSchema>;

/**
 * Management API client for one environment. Read-only for now: slices that write
 * (backup, sync) go through data-ops, not through this client.
 */
export type ManagementClient = Readonly<{
  getEnvironmentInfo: () => Promise<EnvironmentInfo>;
  /** Reads the first page of content types; succeeds only if the key may read the content model. */
  checkContentModelAccess: () => Promise<void>;
}>;

export type ManagementClientOptions = HttpOptions & Readonly<{ environmentId: string }>;

export const createManagementClient = (options: ManagementClientOptions): ManagementClient => {
  const root = `${kontentApiBaseUrl}/projects/${encodeURIComponent(options.environmentId)}`;
  const get = createGetter(options);

  const fail = (response: Response, what: string) =>
    new KontentApiError(
      response.status,
      `Management API ${what} failed with status ${response.status}`,
    );

  return {
    getEnvironmentInfo: async () => {
      const response = await get(root);
      if (!response.ok) {
        throw fail(response, "environment lookup");
      }
      return environmentInfoSchema.parse(await response.json());
    },

    checkContentModelAccess: async () => {
      const response = await get(`${root}/types`);
      if (!response.ok) {
        throw fail(response, "content type listing");
      }
    },
  };
};
