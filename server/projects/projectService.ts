import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import { type KeyStatus, managementKeyStatus, resolveManagementKey } from "../keys/envKeys.js";
import { KontentApiError } from "../kontent/kontentHttp.js";
import type { ManagementClient } from "../kontent/managementClient.js";
import type { SubscriptionClient, SubscriptionProject } from "../kontent/subscriptionClient.js";

export type EnvironmentView = Readonly<{
  id: string;
  name: string;
  isMaster: boolean;
  key: KeyStatus;
}>;

export type ProjectView = Readonly<{
  id: string;
  name: string;
  isActive: boolean;
  /** The project that contains the master environment. None of its environments can be a sync target. */
  isMasterProject: boolean;
  environments: ReadonlyArray<EnvironmentView>;
}>;

export type ProjectOverview = Readonly<{
  projects: ReadonlyArray<ProjectView>;
  /** False when the master environment is not in this subscription: a configuration error. */
  masterFound: boolean;
}>;

export type ConnectionResult =
  | Readonly<{
      status: "ok";
      projectName: string;
      environmentName: string;
      isProduction: boolean | null;
      keySource: "environment" | "project";
    }>
  | Readonly<{ status: "key_missing"; variableName: string }>
  | Readonly<{
      status: "key_rejected" | "no_content_model_access" | "wrong_environment" | "error";
      variableName: string;
      message: string;
    }>;

export class UnknownEnvironmentError extends HttpError {
  override readonly name = "UnknownEnvironmentError";

  constructor() {
    super(404, "unknown_environment", "This environment is not in the subscription");
  }
}

export type LocatedEnvironment = Readonly<{
  environmentId: string;
  environmentName: string;
  projectId: string;
  projectName: string;
  /** True for every environment of the project that contains the master environment. */
  isMasterProject: boolean;
}>;

export type ProjectService = Readonly<{
  overview: () => Promise<ProjectOverview>;
  /** Finds an environment in the subscription. Throws UnknownEnvironmentError otherwise. */
  locate: (environmentId: string) => Promise<LocatedEnvironment>;
  testConnection: (environmentId: string) => Promise<ConnectionResult>;
}>;

export type ProjectServiceDeps = Readonly<{
  config: Pick<AppConfig, "masterEnvironmentId">;
  subscription: Pick<SubscriptionClient, "listProjects">;
  env: () => Readonly<Record<string, string | undefined>>;
  managementClient: (environmentId: string, apiKey: string) => ManagementClient;
  now?: () => number;
}>;

const cacheTtlMs = 60_000;

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

export const createProjectService = (deps: ProjectServiceDeps): ProjectService => {
  const now = deps.now ?? Date.now;
  const master = deps.config.masterEnvironmentId;
  let cache: { expires: number; projects: Promise<ReadonlyArray<SubscriptionProject>> } | undefined;

  const subscriptionProjects = async () => {
    if (cache === undefined || cache.expires <= now()) {
      const projects = deps.subscription.listProjects();
      cache = { expires: now() + cacheTtlMs, projects };
      // Do not keep a failed listing for a minute.
      projects.catch(() => {
        cache = undefined;
      });
    }
    return await cache.projects;
  };

  const findEnvironment = (projects: ReadonlyArray<SubscriptionProject>, environmentId: string) => {
    for (const project of projects) {
      const environment = project.environments.find(
        (env) => env.id.toLowerCase() === environmentId,
      );
      if (environment !== undefined) {
        return { project, environment };
      }
    }
    return null;
  };

  return {
    locate: async (rawEnvironmentId) => {
      const environmentId = rawEnvironmentId.trim().toLowerCase();
      const found = findEnvironment(await subscriptionProjects(), environmentId);
      if (found === null) {
        throw new UnknownEnvironmentError();
      }
      return {
        environmentId,
        environmentName: found.environment.name,
        projectId: found.project.id,
        projectName: found.project.name,
        isMasterProject: found.project.environments.some((e) => e.id.toLowerCase() === master),
      };
    },

    overview: async () => {
      const env = deps.env();
      const projects = await subscriptionProjects();
      const views = projects.map((project): ProjectView => {
        const isMasterProject = project.environments.some((e) => e.id.toLowerCase() === master);
        return {
          id: project.id,
          name: project.name,
          isActive: project.is_active,
          isMasterProject,
          environments: project.environments
            .map((environment) => ({
              id: environment.id,
              name: environment.name,
              isMaster: environment.id.toLowerCase() === master,
              key: managementKeyStatus(env, {
                environmentId: environment.id,
                projectId: project.id,
              }),
            }))
            .sort(byName),
        };
      });
      // Master project first, then active projects, then by name.
      views.sort(
        (a, b) =>
          Number(b.isMasterProject) - Number(a.isMasterProject) ||
          Number(b.isActive) - Number(a.isActive) ||
          byName(a, b),
      );
      return { projects: views, masterFound: views.some((p) => p.isMasterProject) };
    },

    testConnection: async (rawEnvironmentId) => {
      const environmentId = rawEnvironmentId.trim().toLowerCase();
      // Only environments in this subscription can be tested, so the endpoint cannot be
      // used to probe arbitrary environment IDs.
      const found = findEnvironment(await subscriptionProjects(), environmentId);
      if (found === null) {
        throw new UnknownEnvironmentError();
      }

      const key = resolveManagementKey(deps.env(), {
        environmentId,
        projectId: found.project.id,
      });
      if (key === null) {
        return {
          status: "key_missing",
          variableName: managementKeyStatus({}, { environmentId }).variableName,
        };
      }

      const client = deps.managementClient(environmentId, key.value);
      const failure = (
        status: "key_rejected" | "no_content_model_access" | "wrong_environment" | "error",
        message: string,
      ): ConnectionResult => ({ status, variableName: key.variableName, message });

      let info: Awaited<ReturnType<ManagementClient["getEnvironmentInfo"]>>;
      try {
        info = await client.getEnvironmentInfo();
      } catch (error) {
        if (error instanceof KontentApiError && (error.status === 401 || error.status === 403)) {
          return failure(
            "key_rejected",
            "The key was rejected for this environment. It may be expired, revoked, or limited to other environments.",
          );
        }
        return failure("error", "The Management API could not be reached. Try again later.");
      }

      if (info.id.toLowerCase() !== environmentId) {
        return failure(
          "wrong_environment",
          "The API returned a different environment than requested.",
        );
      }

      try {
        await client.checkContentModelAccess();
      } catch (error) {
        if (error instanceof KontentApiError && (error.status === 401 || error.status === 403)) {
          return failure(
            "no_content_model_access",
            "The key works but cannot read the content model. Give it the Manage content model permission.",
          );
        }
        return failure("error", "The Management API could not be reached. Try again later.");
      }

      return {
        status: "ok",
        projectName: info.name,
        environmentName: info.environment,
        isProduction: info.is_production ?? null,
        keySource: key.source,
      };
    },
  };
};
