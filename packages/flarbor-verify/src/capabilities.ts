import { createVerifyError, VerifyFailure } from "./errors.js";
import type { VerifyCapabilities, VerifyExec } from "./types.js";

export function createNoExec(): VerifyExec {
  return {
    async run() {
      throw new VerifyFailure(
        createVerifyError(
          "EXEC_UNAVAILABLE",
          "Command execution is unavailable in this verifier context.",
        ),
      );
    },
  };
}

export function requireExec(capabilities: VerifyCapabilities): VerifyExec {
  if (capabilities.exec) return capabilities.exec;
  throw new VerifyFailure(
    createVerifyError(
      "EXEC_UNAVAILABLE",
      "This verifier check requires command execution, but no exec capability was configured.",
    ),
  );
}
