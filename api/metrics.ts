import { z } from "zod";
import { json, readJson, withAccess } from "../server/http.js";
import { getRuntime } from "../server/runtime.js";

const bodySchema = z.object({ environmentId: z.string().trim().min(1) });

/**
 * GET /api/metrics: stored content counts per environment and user counts per project.
 * POST /api/metrics { environmentId }: counts content items and types of one environment now.
 * Read-only in Kontent.ai.
 */
const handler = withAccess(
  { guard: () => getRuntime().guard },
  { methods: ["GET", "POST"] },
  async (request, caller) => {
    const { metrics } = getRuntime();
    if (request.method === "POST") {
      const { environmentId } = await readJson(request, bodySchema);
      return json(200, await metrics.refresh(caller, environmentId));
    }
    return json(200, await metrics.overview());
  },
);

export default { fetch: handler };
