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
  /** A master release ID: use that frozen version of the master instead of the live one. */
  release: z
    .string()
    .regex(/^[0-9]{15}-[0-9a-f]{8}$/)
    .optional(),
});

/**
 * POST /api/rollout-plan { environmentId, entities? }: what a sync would do in one
 * environment of a rollout, with its fingerprint and stage. Read-only.
 */
const handler = withAccess(
  { guard: () => getRuntime().guard },
  { methods: ["POST"] },
  async (request) => {
    const { environmentId, entities, release } = await readJson(request, bodySchema);
    return json(200, await getRuntime().rollout.plan(environmentId, entities, release));
  },
);

export default { fetch: handler };
