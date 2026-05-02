/**
 * Runtime type guard for TrialResult shapes.
 *
 * Checks the structural fields that all TrialResults must have.
 * Used by dispatch functions to validate agent responses.
 */
export function isTrialResult(value: unknown): value is TrialResultShape {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.success === "boolean" &&
    typeof v.branch === "string" &&
    typeof v.commitSha === "string" &&
    Array.isArray(v.filesChanged)
  );
}

/** Minimal TrialResult shape for the type guard. */
export interface TrialResultShape {
  success: boolean;
  branch: string;
  commitSha: string;
  filesChanged: string[];
}
