import { z } from "zod";
import { json, readJson, withAccess } from "../server/http.js";
import { getRuntime } from "../server/runtime.js";
import { defaultEntities, selectableEntities } from "../server/sync/dataOps.js";

const bodySchema = z.object({
  environmentId: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  entities: z
    .array(z.enum(selectableEntities))
    .min(1)
    .optional()
    .transform((entities) => [...new Set(entities ?? defaultEntities)]),
});

/**
 * POST /api/diff { environmentId, entities? }: compares the master with one client
 * environment. Read-only: nothing is written to Kontent.ai.
 */
const handler = withAccess(
  { guard: () => getRuntime().guard },
  { methods: ["POST"] },
  async (request) => {
    const { environmentId, entities } = await readJson(request, bodySchema);
    return json(200, await getRuntime().diff.diff(environmentId, entities));
  },
);

export default { fetch: handler };
