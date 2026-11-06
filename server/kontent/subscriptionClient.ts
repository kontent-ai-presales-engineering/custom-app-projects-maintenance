import { z } from "zod";

import { createGetter, KontentApiError, kontentApiBaseUrl } from "./kontentHttp.js";

export { KontentApiError };

const roleSchema = z.object({
  id: z.string(),
  name: z.string(),
  codename: z.string().nullish(),
});

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      environments: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          is_user_active: z.boolean(),
          collection_groups: z.array(z.object({ roles: z.array(roleSchema) })),
        }),
      ),
    }),
  ),
});

export type SubscriptionUser = z.infer<typeof userSchema>;

const projectsPageSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      is_active: z.boolean(),
      environments: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
  pagination: z.object({ continuation_token: z.string().nullable() }).nullish(),
});

export type SubscriptionProject = z.infer<typeof projectsPageSchema>["projects"][number];

/**
 * Read-only Subscription API client. It has no way to send anything but GET: the
 * key can also activate and deactivate users, so write calls are impossible by design.
 */
export type SubscriptionClient = Readonly<{
  /** Returns null when the user does not exist in the subscription. */
  getUser: (userId: string) => Promise<SubscriptionUser | null>;
  listProjects: () => Promise<ReadonlyArray<SubscriptionProject>>;
}>;

export type SubscriptionClientOptions = Readonly<{
  subscriptionId: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}>;

export const createSubscriptionClient = (
  options: SubscriptionClientOptions,
): SubscriptionClient => {
  const root = `${kontentApiBaseUrl}/subscriptions/${encodeURIComponent(options.subscriptionId)}`;
  const getUrl = createGetter(options);
  const get = async (path: string, headers: Record<string, string> = {}) =>
    await getUrl(`${root}${path}`, headers);

  const fail = (response: Response, what: string) =>
    new KontentApiError(
      response.status,
      `Subscription API ${what} failed with status ${response.status}`,
    );

  return {
    getUser: async (userId) => {
      const response = await get(`/users/${encodeURIComponent(userId)}`);
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw fail(response, "user lookup");
      }
      return userSchema.parse(await response.json());
    },

    listProjects: async () => {
      const projects: SubscriptionProject[] = [];
      let continuation: string | null = null;
      do {
        const response = await get(
          "/projects",
          continuation === null ? {} : { "x-continuation": continuation },
        );
        if (!response.ok) {
          throw fail(response, "project listing");
        }
        const page = projectsPageSchema.parse(await response.json());
        projects.push(...page.projects);
        continuation = page.pagination?.continuation_token ?? null;
      } while (continuation !== null);
      return projects;
    },
  };
};
