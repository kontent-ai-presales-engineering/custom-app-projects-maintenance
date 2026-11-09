import { isAuditCursor } from "../server/audit/auditLog.js";
import { presentAudit } from "../server/audit/auditView.js";
import { ValidationError } from "../server/errors.js";
import { json, withAccess } from "../server/http.js";
import { getRuntime } from "../server/runtime.js";

const defaultLimit = 50;
const maxLimit = 200;

/**
 * GET /api/audit?limit=50&before=<cursor>: audit entries, most recent first, with the
 * target's project and environment names. Read-only.
 */
const handler = withAccess(
  { guard: () => getRuntime().guard },
  { methods: ["GET"] },
  async (request) => {
    const params = new URL(request.url).searchParams;
    const limit = Number(params.get("limit") ?? defaultLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
      throw new ValidationError(`limit must be a whole number from 1 to ${maxLimit}`);
    }
    const before = params.get("before") ?? undefined;
    if (before !== undefined && !isAuditCursor(before)) {
      throw new ValidationError("Invalid cursor");
    }

    const { audit, projects } = getRuntime();
    const [page, overview] = await Promise.all([
      audit.listPage({ limit, before }),
      // Names are a convenience: the log still loads when the Subscription API is unavailable.
      projects
        .overview()
        .catch(() => null),
    ]);
    return json(200, {
      entries: presentAudit(page.events, overview, new Date()),
      nextCursor: page.nextCursor,
    });
  },
);

export default { fetch: handler };
