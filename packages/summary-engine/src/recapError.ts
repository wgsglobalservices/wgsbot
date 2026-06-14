export class RecapError extends Error {
  retryable: boolean;
  diagnostics?: string;

  constructor(message: string, retryable: boolean, diagnostics?: string) {
    super(message);
    this.name = "RecapError";
    this.retryable = retryable;
    this.diagnostics = diagnostics;
  }
}
