/**
 * Shared state shape for the team controls.
 *
 * Outside the `"use server"` module for the same reason as
 * `checkpoint-form-state.ts`: every export from one of those becomes a
 * callable server endpoint, so Next refuses anything that is not an async
 * function.
 */
export interface TeamFormState {
  ok: boolean;
  error: string | null;
}

export const EMPTY_FORM_STATE: TeamFormState = { ok: false, error: null };
