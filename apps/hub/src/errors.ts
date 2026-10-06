/** Error with an http status; routes map it 1:1 (see `fail()` helpers). Services throw these instead of plain Errors when the status matters. */
export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
  }
}

export const forbidden = (msg: string) => new HttpError(403, msg);
export const notFound = (msg = "not found") => new HttpError(404, msg);
export const badRequest = (msg: string) => new HttpError(400, msg);

/** status of a thrown error, 400 when it carries none */
export function errorStatus(err: unknown): 400 | 401 | 403 | 404 | 409 | 429 {
  const s = (err as { status?: number })?.status;
  return s === 401 || s === 403 || s === 404 || s === 409 || s === 429 ? s : 400;
}
