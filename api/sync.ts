import { z } from "zod";
import { json, readJson, withAccess } from "../server/http.js";
import { getRuntime } from "../server/runtime.js";
import { selectableEntities } from "../server/sync/dataOps.js";
import { itemsSchema } from "../server/sync/selection.js";

const bodySchema = z.object({
  environmentId: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  entities: z
    .array(z.enum(selectableEntities))
    .min(1)
    .transform((entities) => [...new Set(entities)]),
  diffHash: z.string().regex(/^[0-9a-f]{64}$/),
  confirmProjectName: z.string(),
  confirmDestructive: z.boolean(),
  /** Restore this backup of the environment instead of syncing from the master. */
  restoreFrom: z
    .string()
    .regex(/^[0-9]{15}-[0-9a-f]{8}$/)
    .optional(),
  /** The item selection of the confirmed diff, if any. */
  items: itemsSchema.optional(),
  /** A master release ID: use that frozen version of the master instead of the live one. */
  release: z
    .string()
    .regex(/^[0-9]{15}-[0-9a-f]{8}$/)
    .optional(),
});

/**
 * POST /api/sync: applies a confirmed diff to one client environment. The diff is
 * recomputed and must match the confirmed hash; a backup is made first.
 */
const handler = withAccess(
  { guard: () => getRuntime().guard },
  { methods: ["POST"] },
  async (request, caller) => {
    const body = await readJson(request, bodySchema);
    const outcome = await getRuntime().sync.sync(caller, body);
    return json(outcome.status === "validation_failed" ? 409 : 200, outcome);
  },
);

export default { fetch: handler };
