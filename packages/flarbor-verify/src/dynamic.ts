import { errorFromUnknown } from "./errors.js";
import { verifiedResult } from "./verifier.js";
import type { DynamicVerifyConfig, VerifyResult } from "./types.js";

export async function verifyDynamic(config: DynamicVerifyConfig): Promise<VerifyResult> {
  const startedAt = Date.now();
  try {
    const output = await config.adapter.run(config.context);
    return verifiedResult(output, Date.now() - startedAt, "dynamic");
  } catch (error) {
    return {
      kind: "error",
      error: errorFromUnknown(error, "DYNAMIC_VERIFIER_FAILED", "Dynamic verifier failed."),
      artifacts: [],
      durationMs: Date.now() - startedAt,
      mode: "dynamic",
    };
  }
}
