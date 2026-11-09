import type { ProjectOverview } from "../projects/projectService.js";
import type { AuditEvent } from "./auditLog.js";

export type AuditEntryView = AuditEvent &
  Readonly<{
    /** Project and environment names of the target, when it is still in the subscription. */
    targetName: Readonly<{ projectName: string; environmentName: string }> | null;
    /**
     * "incomplete": still pending long after it started, so the function most likely
     * stopped (for example a timeout) before it could record the outcome.
     */
    status: "succeeded" | "failed" | "pending" | "incomplete";
  }>;

/** Longer than any function may run, so a pending entry this old cannot still be running. */
const incompleteAfterMs = 15 * 60 * 1000;

export const presentAudit = (
  events: ReadonlyArray<AuditEvent>,
  overview: ProjectOverview | null,
  now: Date,
): ReadonlyArray<AuditEntryView> => {
  const names = new Map<string, { projectName: string; environmentName: string }>();
  for (const project of overview?.projects ?? []) {
    for (const environment of project.environments) {
      names.set(environment.id.toLowerCase(), {
        projectName: project.name,
        environmentName: environment.name,
      });
    }
  }

  return events.map((event) => ({
    ...event,
    targetName: event.target === null ? null : (names.get(event.target.toLowerCase()) ?? null),
    status:
      event.outcome === "pending" && now.getTime() - Date.parse(event.at) > incompleteAfterMs
        ? "incomplete"
        : event.outcome,
  }));
};
