"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { supabaseServer } from "@/services/supabase/server";

/**
 * Sign in and sign out.
 *
 * There is deliberately no `signUp` action. Access to this platform is granted
 * by the platform owner, not taken by whoever finds the URL — see README.md.
 * Adding a sign-up here would not merely add a screen, it would undo the
 * product's access model.
 */

export interface LoginState {
  error: string | null;
}

export async function signIn(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  if (!email || !password) {
    return { error: "Enter your email address and password." };
  }

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // Deliberately not echoing Supabase's message. "Invalid login credentials"
    // is already the right amount of information; anything more specific tells
    // an attacker which half they got right.
    return { error: "That email address and password do not match." };
  }

  // The whole layout tree is per-user. Without this, Next's Router Cache can
  // serve the signed-out shell to a signed-in user after the redirect.
  revalidatePath("/", "layout");

  // Only ever redirect within this app: an open redirect here would let a
  // phishing link bounce a freshly authenticated user to an attacker's page.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function signOut() {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
