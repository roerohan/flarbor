import { errorFromUnknown, VerifyFailure } from "./errors.js";
import { normalizeRewards } from "./rewards.js";
import type { Verifier, VerifyConfig, VerifyOutput, VerifyResult } from "./types.js";

const EMPTY_LOGS = { stdout: "", stderr: "", outputTruncated: false } as const;

export function defineVerifier(verifier: Verifier): Verifier {
  return verifier;
}

export async function verify(config: VerifyConfig): Promise<VerifyResult> {
  const startedAt = Date.now();
  try {
    const output = await config.verifier.run(config.context);
    return verifiedResult(output, Date.now() - startedAt, "native");
  } catch (error) {
    const verifyError = errorFromUnknown(error, "VERIFIER_FAILED", "Verifier failed.");
    return {
      kind: "error",
      error: verifyError,
      artifacts: [],
      durationMs: Date.now() - startedAt,
      mode: "native",
    };
  }
}

export function verifiedResult(
  output: VerifyOutput,
  durationMs: number,
  mode: VerifyResult["mode"],
): VerifyResult {
  try {
    const normalized = normalizeRewards(output.rewards);
    return {
      kind: "verified",
      rewards: normalized,
      ...(output.details === undefined ? {} : { details: output.details }),
      logs: output.logs ?? EMPTY_LOGS,
      artifacts: output.artifacts ?? [],
      durationMs,
      mode,
    };
  } catch (error) {
    if (error instanceof VerifyFailure) {
      return {
        kind: "error",
        error: error.error,
        ...(output.details === undefined ? {} : { details: output.details }),
        logs: output.logs,
        artifacts: output.artifacts ?? [],
        durationMs,
        mode,
      };
    }
    return {
      kind: "error",
      error: errorFromUnknown(error, "REWARD_VALUE_INVALID", "Verifier returned invalid rewards."),
      ...(output.details === undefined ? {} : { details: output.details }),
      logs: output.logs,
      artifacts: output.artifacts ?? [],
      durationMs,
      mode,
    };
  }
}
