/**
 * Shared state shape for the message composer.
 *
 * Outside the `"use server"` module, as every other one is: each export from
 * such a file becomes a callable server endpoint.
 */
export interface MessageFormState {
  ok: boolean;
  error: string | null;
}

export const EMPTY_FORM_STATE: MessageFormState = { ok: false, error: null };
