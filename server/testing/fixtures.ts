import type { SubscriptionUser } from "../kontent/subscriptionClient.js";

export const masterEnvId = "11111111-1111-1111-1111-111111111111";
export const clientEnvId = "22222222-2222-2222-2222-222222222222";
export const clientProjectId = "33333333-3333-3333-3333-333333333333";
export const accessSecret = "s".repeat(40);
export const userId = "user-1";

export const validEnv = (overrides: Record<string, string | undefined> = {}) => ({
  KONTENT_SUBSCRIPTION_ID: "subscription-id",
  KONTENT_SUBSCRIPTION_API_KEY: "subscription-key",
  KONTENT_MASTER_ENVIRONMENT_ID: masterEnvId,
  APP_ACCESS_SECRET: accessSecret,
  ...overrides,
});

type Role =
  SubscriptionUser["projects"][number]["environments"][number]["collection_groups"][number]["roles"][number];

export const projectManager: Role = {
  id: "role-pm",
  name: "Project manager",
  codename: "project-manager",
};
export const contributor: Role = { id: "role-contrib", name: "Contributor", codename: null };

export const subscriptionUser = (
  options: Readonly<{ roles?: ReadonlyArray<Role>; active?: boolean; environmentId?: string }> = {},
): SubscriptionUser => ({
  id: userId,
  email: "ada@example.com",
  first_name: "Ada",
  last_name: "Lovelace",
  projects: [
    {
      id: "master-project",
      name: "Master",
      environments: [
        {
          id: options.environmentId ?? masterEnvId,
          name: "Production",
          is_user_active: options.active ?? true,
          collection_groups: [{ roles: [...(options.roles ?? [projectManager])] }],
        },
      ],
    },
  ],
});
