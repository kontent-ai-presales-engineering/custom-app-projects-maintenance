import { ValidationError } from "../server/errors.js";
import { withAccess } from "../server/http.js";
import { getRuntime } from "../server/runtime.js";

/**
 * GET /api/backup-download?environmentId=...&backupId=...: one backup as a JSON file
 * (metadata plus the data-ops snapshot files).
 */
const handler = withAccess(
  { guard: () => getRuntime().guard },
  { methods: ["GET"] },
  async (request) => {
    const params = new URL(request.url).searchParams;
    const environmentId = params.get("environmentId");
    const backupId = params.get("backupId");
    if (environmentId === null || backupId === null) {
      throw new ValidationError("environmentId and backupId are required");
    }
    const backup = await getRuntime().backups.get(environmentId, backupId);
    return new Response(JSON.stringify(backup, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="model-backup-${backup.metadata.environmentId}-${backup.metadata.id}.json"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
);

export default { fetch: handler };
