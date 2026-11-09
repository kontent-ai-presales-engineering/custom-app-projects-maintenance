import { z } from "zod";
import { ValidationError } from "../server/errors.js";
import { json, readJson, withAccess } from "../server/http.js";
import { getRuntime } from "../server/runtime.js";

const bodySchema = z.object({
  sourceEnvironmentId: z.string().trim().min(1),
  name: z.string().max(100),
  copyContent: z.boolean().default(false),
});

/**
 * POST /api/clone-environment { sourceEnvironmentId, name, copyContent? }: clones a client
 * environment (onboarding). Audited.
 * GET /api/clone-environment?projectId=&environmentId=: cloning progress.
 */
const handler = withAccess(
  { guard: () => getRuntime().guard },
  { methods: ["GET", "POST"] },
  async (request, caller) => {
    const { onboarding } = getRuntime();
    if (request.method === "POST") {
      const { sourceEnvironmentId, name, copyContent } = await readJson(request, bodySchema);
      return json(
        202,
        await onboarding.cloneEnvironment(caller, sourceEnvironmentId, name, copyContent),
      );
    }
    const params = new URL(request.url).searchParams;
    const projectId = params.get("projectId");
    const environmentId = params.get("environmentId");
    if (projectId === null || environmentId === null) {
      throw new ValidationError("projectId and environmentId are required");
    }
    return json(200, { state: await onboarding.cloningState(projectId, environmentId) });
  },
);

export default { fetch: handler };
