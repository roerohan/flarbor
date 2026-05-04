import type { VerifyError, VerifyErrorCode } from "./types.js";

export function createVerifyError(
  code: VerifyErrorCode,
  message: string,
  details?: unknown,
): VerifyError {
  return details === undefined ? { code, message } : { code, message, details };
}

export class VerifyFailure extends Error {
  readonly error: VerifyError;

  constructor(error: VerifyError) {
    super(error.message);
    this.name = "VerifyFailure";
    this.error = error;
  }
}

export function throwVerifyError(code: VerifyErrorCode, message: string, details?: unknown): never {
  throw new VerifyFailure(createVerifyError(code, message, details));
}

export function errorFromUnknown(
  error: unknown,
  code: VerifyErrorCode,
  fallback: string,
): VerifyError {
  if (error instanceof VerifyFailure) return error.error;
  if (error instanceof Error) return createVerifyError(code, error.message);
  return createVerifyError(code, fallback, String(error));
}
