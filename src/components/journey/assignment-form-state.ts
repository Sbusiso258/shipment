/**
 * Shared state shape for the assignment controls.
 *
 * Outside the `"use server"` module for the same reason as
 * `checkpoint-form-state.ts`: every export from such a file becomes a callable
 * server endpoint, so Next refuses anything that is not an async function.
 */
export interface AssignmentFormState {
  ok: boolean;
  error: string | null;
}

export const EMPTY_FORM_STATE: AssignmentFormState = { ok: false, error: null };
