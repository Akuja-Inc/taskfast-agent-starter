// A failed cleanup is not an ordinary opening failure. The host must not open
// another owner after this error, even when the attempt was already cancelled.
export class CleanupError extends Error {
  constructor(cause: unknown) {
    super("agent cleanup failed; restart the host after checking ownership", { cause });
    this.name = "CleanupError";
  }
}
