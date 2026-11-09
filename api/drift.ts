import { z } from "zod";
import { json, readJson, withAccess } from "../server/http.js";
import { getRuntime } from "../server/runtime.js";

const bodySchema = z.object({ environmentId: z.string().trim().min(1) });

/**
 * GET /api/drift: the latest drift check of every client environment.
 * POST /api/drift { environmentId }: checks one environment against the master now.
 * Read-only in Kontent.ai.
 */
const handler = withAccess(
  { guard: () => getRuntime().guard },
  { methods: ["GET", "POST"] },
  async (request, caller) => {
    const { drift } = getRuntime();
    if (request.method === "POST") {
      const { environmentId } = await readJson(request, bodySchema);
      return json(200, await drift.check(caller, environmentId));
    }
    return json(200, { summaries: await drift.list() });
  },
);

export default { fetch: handler };
