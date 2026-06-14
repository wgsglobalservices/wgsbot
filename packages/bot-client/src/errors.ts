export class BotClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly code: string
  ) {
    super(message);
    this.name = "BotClientError";
  }
}

export function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
