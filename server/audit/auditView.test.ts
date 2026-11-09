import { describe, expect, it } from "vitest";
import type { ProjectOverview } from "../projects/projectService.js";
import { clientEnvId } from "../testing/fixtures.js";
import type { AuditEvent } from "./auditLog.js";
import { presentAudit } from "./auditView.js";

const event = (overrides: Partial<AuditEvent>): AuditEvent => ({
  id: "e1",
  at: "2026-11-09T10:00:00.000Z",
  actor: { userId: "u1", email: "ada@example.com" },
  action: "sync.run",
  target: clientEnvId,
  outcome: "succeeded",
  completedAt: "2026-11-09T10:01:00.000Z",
  details: null,
  ...overrides,
});

const overview: ProjectOverview = {
  masterFound: true,
  projects: [
    {
      id: "p1",
      name: "Client A",
      isActive: true,
      isMasterProject: false,
      environments: [
        {
          id: clientEnvId.toUpperCase(),
          name: "Production",
          isMaster: false,
          key: { configured: true, source: "environment", variableName: "X" },
        },
      ],
    },
  ],
};

describe("presentAudit", () => {
  const now = new Date("2026-11-09T10:10:00.000Z");

  it("adds the target's project and environment names", () => {
    const [entry] = presentAudit([event({})], overview, now);

    expect(entry?.targetName).toEqual({ projectName: "Client A", environmentName: "Production" });
    expect(entry?.status).toBe("succeeded");
  });

  it("leaves names empty for unknown targets or when the overview is unavailable", () => {
    expect(presentAudit([event({ target: "other" })], overview, now)[0]?.targetName).toBeNull();
    expect(presentAudit([event({})], null, now)[0]?.targetName).toBeNull();
  });

  it("marks entries pending for more than 15 minutes as incomplete", () => {
    const recent = event({ outcome: "pending", completedAt: null });
    const old = event({ outcome: "pending", completedAt: null, at: "2026-11-09T09:30:00.000Z" });

    expect(presentAudit([recent, old], overview, now).map((e) => e.status)).toEqual([
      "pending",
      "incomplete",
    ]);
  });
});
