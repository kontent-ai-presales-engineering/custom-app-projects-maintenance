import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { KvStore } from "../storage/kvStore.js";

/** Actions grow with each slice (backup, sync). */
export const auditActions = ["backup.create", "sync.run"] as const;

export type AuditAction = (typeof auditActions)[number];

/** The Kontent.ai user who triggered the action, as confirmed by the access check. */
export type Actor = Readonly<{ userId: string; email: string }>;

export type AuditOutcome = "pending" | "succeeded" | "failed";

/**
 * One audit entry. Entries never contain API keys or secrets: `target` is an environment ID,
 * `details` only holds counts or error categories.
 */
export type AuditEvent = Readonly<{
  id: string;
  at: string;
  actor: Actor;
  action: AuditAction;
  target: string | null;
  outcome: AuditOutcome;
  completedAt: string | null;
  details: Readonly<Record<string, string | number>> | null;
}>;

const eventSchema = z.object({
  id: z.string(),
  at: z.string(),
  actor: z.object({ userId: z.string(), email: z.string() }),
  action: z.enum(auditActions),
  target: z.string().nullable(),
  outcome: z.enum(["pending", "succeeded", "failed"]),
  completedAt: z.string().nullable(),
  details: z.record(z.string(), z.union([z.string(), z.number()])).nullable(),
});

export type AuditLog = Readonly<{
  /**
   * Records an action before it runs, with outcome "pending". If this write fails the
   * caller must not perform the action, so no change can happen without an entry.
   */
  begin: (entry: Pick<AuditEvent, "actor" | "action" | "target">) => Promise<AuditEvent>;
  complete: (
    event: AuditEvent,
    outcome: Exclude<AuditOutcome, "pending">,
    details?: AuditEvent["details"],
  ) => Promise<void>;
  /** Most recent first. */
  list: (limit: number) => Promise<ReadonlyArray<AuditEvent>>;
}>;

const prefix = "audit/";

export const createAuditLog = (kv: KvStore, now: () => Date = () => new Date()): AuditLog => {
  const keyFor = (event: AuditEvent) =>
    `${prefix}${String(Date.parse(event.at)).padStart(15, "0")}-${event.id}`;

  return {
    begin: async ({ actor, action, target }) => {
      const event: AuditEvent = {
        id: randomUUID(),
        at: now().toISOString(),
        actor: { userId: actor.userId, email: actor.email },
        action,
        target,
        outcome: "pending",
        completedAt: null,
        details: null,
      };
      await kv.setJson(keyFor(event), event);
      return event;
    },

    complete: async (event, outcome, details = null) => {
      await kv.setJson(keyFor(event), {
        ...event,
        outcome,
        completedAt: now().toISOString(),
        details,
      } satisfies AuditEvent);
    },

    list: async (limit) => {
      const keys = (await kv.listKeys(prefix)).toReversed().slice(0, limit);
      const events = await Promise.all(keys.map(async (key) => kv.getJson(key)));
      return events.flatMap((raw) => {
        const parsed = eventSchema.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      });
    },
  };
};
