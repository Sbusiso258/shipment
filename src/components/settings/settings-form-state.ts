/**
 * Shared state shape for the settings form.
 *
 * Outside the `"use server"` module for the same reason as every other one:
 * each export from such a file becomes a callable server endpoint.
 */
export interface SettingsFormState {
  ok: boolean;
  error: string | null;
}

export const EMPTY_FORM_STATE: SettingsFormState = { ok: false, error: null };
