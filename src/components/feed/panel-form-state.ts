/**
 * Shared state shape for the dashboard panel's forms.
 *
 * Lives outside the `"use server"` module: every export from such a file
 * becomes a callable server endpoint, so Next refuses anything that is not an
 * async function. A constant object there fails the build.
 */
export interface PanelFormState {
  ok: boolean;
  error: string | null;
}

export const EMPTY_PANEL_STATE: PanelFormState = { ok: false, error: null };
