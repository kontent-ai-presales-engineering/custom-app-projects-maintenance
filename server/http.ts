import type { AccessGuard, Caller } from "./access/accessGuard.js";
import { HttpError } from "./errors.js";

const baseHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

export const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...baseHeaders, ...headers } });

const errorBody = (code: string, message: string) => ({ error: { code, message } });

export type AccessedHandler = (request: Request, caller: Caller) => Promise<Response>;

export type HandlerDeps = Readonly<{
  guard: () => AccessGuard;
  log?: (message: string, error: unknown) => void;
}>;

/**
 * Wraps an API handler: allows only the listed methods, runs the access check on
 * every request, and turns errors into JSON responses without leaking internals.
 */
export const withAccess =
  (
    deps: HandlerDeps,
    options: Readonly<{ methods: ReadonlyArray<string> }>,
    handler: AccessedHandler,
  ) =>
  async (request: Request): Promise<Response> => {
    if (!options.methods.includes(request.method)) {
      return json(405, errorBody("method_not_allowed", "Method not allowed"), {
        allow: options.methods.join(", "),
      });
    }

    try {
      const caller = await deps.guard().check(request);
      return await handler(request, caller);
    } catch (error) {
      if (error instanceof HttpError) {
        return json(error.status, errorBody(error.code, error.message));
      }
      (deps.log ?? defaultLog)("Unhandled error", error);
      return json(
        500,
        errorBody("internal_error", "Something went wrong. Check the function logs."),
      );
    }
  };

const defaultLog = (message: string, error: unknown) => {
  // Log the error type and message only. Never log request headers: they hold the access secret.
  console.error(message, error instanceof Error ? `${error.name}: ${error.message}` : "unknown");
};
