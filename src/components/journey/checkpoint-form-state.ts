/**
 * Shared state shape for the checkpoint forms.
 *
 * This lives outside the `"use server"` module on purpose: every export from
 * such a file becomes a callable server endpoint, so Next refuses anything
 * that is not an async function. A constant object there fails the build with
 * "A 'use server' file can only export async functions, found object."
 */
export interface CheckpointFormState {
  ok: boolean;
  error: string | null;
}

export const EMPTY_FORM_STATE: CheckpointFormState = { ok: false, error: null };
