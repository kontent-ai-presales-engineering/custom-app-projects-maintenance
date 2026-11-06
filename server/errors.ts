/** Errors whose message is safe to return to the client. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ForbiddenError extends HttpError {
  override readonly name = "ForbiddenError";

  constructor(message: string) {
    super(403, "forbidden", message);
  }
}

export class ValidationError extends HttpError {
  override readonly name = "ValidationError";

  constructor(message: string) {
    super(400, "invalid_request", message);
  }
}
