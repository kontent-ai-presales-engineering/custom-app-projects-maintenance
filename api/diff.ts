import { z } from "zod";
import { json, readJson, withAccess } from "../server/http.js";
import { getRuntime } from "../server/runtime.js";
import { defaultEntities, selectableEntities } from "../server/sync/dataOps.js";
import { itemsSchema } from "../server/sync/selection.js";

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
  /** A backup ID of this environment: compare with the backup instead of the master. */
  restoreFrom: z
    .string()
    .regex(/^[0-9]{15}-[0-9a-f]{8}$/)
    .optional(),
  /** Restrict to these items (codenames) per entity. */
  items: itemsSchema.optional(),
  /** A master release ID: use that frozen version of the master instead of the live one. */
  release: z
    .string()
    .regex(/^[0-9]{15}-[0-9a-f]{8}$/)
    .optional(),
});

/**
 * POST /api/diff { environmentId, entities?, restoreFrom? }: compares one client environment
 * with the master, or with one of its own backups. Read-only: nothing is written to Kontent.ai.
 */
const handler = withAccess(
  { guard: () => getRuntime().guard },
  { methods: ["POST"] },
  async (request) => {
    const { environmentId, entities, restoreFrom, items, release } = await readJson(
      request,
      bodySchema,
    );
    return json(
      200,
      await getRuntime().diff.diff(environmentId, { entities, restoreFrom, items, release }),
    );
  },
);

export default { fetch: handler };
