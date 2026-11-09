import { z } from "zod";
import { ValidationError } from "../server/errors.js";
import { json, readJson, withAccess } from "../server/http.js";
import { getRuntime } from "../server/runtime.js";
import { itemsSchema } from "../server/sync/selection.js";

const bodySchema = z.object({ projectId: z.string().trim().min(1), items: itemsSchema });

/**
 * GET /api/exclusions?projectId=...: the items a client project keeps out of syncs.
 * PUT /api/exclusions { projectId, items }: replaces them. Audited.
 */
const handler = withAccess(
  { guard: () => getRuntime().guard },
  { methods: ["GET", "PUT"] },
  async (request, caller) => {
    const { exclusions } = getRuntime();
    if (request.method === "PUT") {
      const { projectId, items } = await readJson(request, bodySchema);
      return json(200, await exclusions.set(caller, projectId, items));
    }
    const projectId = new URL(request.url).searchParams.get("projectId");
    if (projectId === null) {
      throw new ValidationError("projectId is required");
    }
    return json(200, await exclusions.get(projectId));
  },
);

export default { fetch: handler };
