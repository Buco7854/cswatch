/** Side-effect-free error contract shared by HTTP policy and file validators. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
