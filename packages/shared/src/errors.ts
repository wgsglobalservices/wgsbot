import { ZodError } from "zod";

export type ErrorResponse = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function toErrorResponse(error: unknown): { status: number; body: ErrorResponse } {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, details: error.details } }
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "Invalid request data", details: error.flatten() } }
    };
  }
  // Never echo internal error details (SQL text, stack fragments, provider
  // responses) to clients; callers log the original error.
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: "Unexpected error" } }
  };
}
