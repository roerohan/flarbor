import type { JobResult, TrialRecord } from "./types.js";

export type Event =
  | { type: "job_started"; jobId: string; at: string }
  | { type: "trial_started"; jobId: string; trialId: string; at: string }
  | { type: "trial_finished"; jobId: string; trialId: string; record: TrialRecord; at: string }
  | { type: "job_finished"; jobId: string; result: JobResult; at: string };

export type Hook = (event: Event) => void | Promise<void>;

export async function emit(hooks: readonly Hook[] | undefined, event: Event): Promise<void> {
  if (!hooks || hooks.length === 0) return;
  for (const hook of hooks) {
    await hook(event);
  }
}
