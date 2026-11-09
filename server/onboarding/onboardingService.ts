import type { Caller } from "../access/accessGuard.js";
import type { AuditLog } from "../audit/auditLog.js";
import { HttpError } from "../errors.js";
import { resolveManagementKey } from "../keys/envKeys.js";
import type { EnvironmentClient } from "../kontent/environmentClient.js";
import { KontentApiError } from "../kontent/kontentHttp.js";
import type { ProjectService } from "../projects/projectService.js";

export type CloneResult = Readonly<{ environmentId: string; name: string }>;

export type OnboardingService = Readonly<{
  /** Clones a client environment (for example to create a dev environment). Audited. */
  cloneEnvironment: (
    caller: Caller,
    sourceEnvironmentId: string,
    name: string,
    copyContent: boolean,
  ) => Promise<CloneResult>;
  /** Cloning progress of a new environment of a client project. */
  cloningState: (projectId: string, environmentId: string) => Promise<string>;
}>;

export type OnboardingServiceDeps = Readonly<{
  projects: Pick<ProjectService, "locate" | "overview">;
  env: () => Readonly<Record<string, string | undefined>>;
  environmentClient: (environmentId: string, apiKey: string) => EnvironmentClient;
  audit: AuditLog;
}>;

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const namePattern = /^[\p{L}\p{N} ._-]{1,50}$/u;

export const createOnboardingService = (deps: OnboardingServiceDeps): OnboardingService => ({
  cloneEnvironment: async (caller, rawSourceId, rawName, copyContent) => {
    const name = rawName.trim();
    if (!namePattern.test(name)) {
      throw new HttpError(
        400,
        "invalid_name",
        "Use a name of up to 50 letters, digits, spaces, dots, dashes or underscores.",
      );
    }
    const source = await deps.projects.locate(rawSourceId.trim().toLowerCase());
    if (source.isMasterProject) {
      throw new HttpError(
        403,
        "target_is_master",
        "This app never changes the master project. Clone master environments in Kontent.ai.",
      );
    }
    const key = resolveManagementKey(deps.env(), {
      environmentId: source.environmentId,
      projectId: source.projectId,
    });
    if (key === null) {
      throw new HttpError(409, "key_missing", "No Management API key for this environment.");
    }

    const event = await deps.audit.begin({
      actor: { userId: caller.userId, email: caller.email },
      action: "environment.clone",
      target: source.environmentId,
    });
    try {
      const environmentId = await deps
        .environmentClient(source.environmentId, key.value)
        .clone(name, { copyContent });
      await deps.audit.complete(event, "succeeded", {
        newEnvironmentId: environmentId,
        name,
        copyContent: copyContent ? "yes" : "no",
      });
      return { environmentId, name };
    } catch (error) {
      await deps.audit.complete(event, "failed", {
        error: error instanceof Error ? error.name : "UnknownError",
      });
      if (error instanceof KontentApiError && (error.status === 401 || error.status === 403)) {
        throw new HttpError(
          403,
          "clone_not_allowed",
          "The key cannot clone environments. It needs the Manage environments permission.",
        );
      }
      throw new HttpError(502, "clone_failed", "Cloning could not be started. Try again later.");
    }
  },

  cloningState: async (rawProjectId, rawEnvironmentId) => {
    const projectId = rawProjectId.trim().toLowerCase();
    const environmentId = rawEnvironmentId.trim().toLowerCase();
    if (!guid.test(projectId) || !guid.test(environmentId)) {
      throw new HttpError(400, "invalid_request", "Project and environment IDs must be GUIDs");
    }
    const project = (await deps.projects.overview()).projects.find(
      (p) => p.id.toLowerCase() === projectId,
    );
    if (project === undefined || project.isMasterProject) {
      throw new HttpError(404, "unknown_project", "This sub-project is not in the subscription");
    }
    // A new environment is not in the cached project list yet, so only the project key or
    // an environment key set in advance can be used.
    const key = resolveManagementKey(deps.env(), { environmentId, projectId });
    if (key === null) {
      throw new HttpError(
        409,
        "key_missing",
        "No key covers the new environment. Set the project-level key variable to follow progress.",
      );
    }
    try {
      return await deps.environmentClient(environmentId, key.value).cloningState();
    } catch (error) {
      if (error instanceof KontentApiError && (error.status === 401 || error.status === 403)) {
        throw new HttpError(
          403,
          "key_not_valid_here",
          "The key does not cover the new environment yet. Check progress in Kontent.ai.",
        );
      }
      throw new HttpError(502, "state_failed", "The cloning state could not be read.");
    }
  },
});
