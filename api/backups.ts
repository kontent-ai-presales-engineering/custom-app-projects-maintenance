import { z } from "zod";
import { ValidationError } from "../server/errors.js";
import { json, readJson, withAccess } from "../server/http.js";
import { getRuntime } from "../server/runtime.js";

const bodySchema = z.object({ environmentId: z.string().trim().min(1) });

/**
 * GET /api/backups?environmentId=...: backups of one client environment, most recent first.
 * POST /api/backups { environmentId }: backs up the environment's content model now.
 */
const handler = withAccess(
  { guard: () => getRuntime().guard },
  { methods: ["GET", "POST"] },
  async (request, caller) => {
    const { backups } = getRuntime();
    if (request.method === "POST") {
      const { environmentId } = await readJson(request, bodySchema);
      return json(201, await backups.create(caller, environmentId, "manual"));
    }
    const environmentId = new URL(request.url).searchParams.get("environmentId");
    if (environmentId === null) {
      throw new ValidationError("environmentId is required");
    }
    return json(200, { backups: await backups.list(environmentId) });
  },
);

export default { fetch: handler };
