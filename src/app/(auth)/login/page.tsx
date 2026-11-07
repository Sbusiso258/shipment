import type { Metadata } from "next";

import { SetupNotice } from "@/components/shell/setup-notice";
import { isSupabaseConfigured } from "@/services/supabase/env";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

/**
 * In Next 16 `searchParams` is a Promise and must be awaited.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const configured = isSupabaseConfigured();
  const devLoginFailed = error === "dev_login_failed";

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-16">
      <div className="flex flex-col gap-2">
        <p className="font-code text-micro uppercase tracking-widest text-marine-500">
          Shipment Oversight
        </p>
        <h1 className="text-title font-semibold text-ink-950">Sign in</h1>
      </div>

      {/* Auto-login is on but could not sign in. Almost always one of three
          things, and saying which saves a confusing ten minutes. */}
      {devLoginFailed ? (
        <div
          role="alert"
          className="rounded-panel border border-late/30 bg-late-bg p-4 text-small text-late"
        >
          <p className="font-medium">Development auto-login failed.</p>
          <p className="mt-2">
            <code className="font-code">DEV_AUTO_LOGIN=1</code> is set, but
            signing in did not work. Usually one of:
          </p>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
            <li>the migrations have not been applied to this project yet</li>
            <li>
              no user exists for{" "}
              <code className="font-code">DEV_AUTO_LOGIN_EMAIL</code>
            </li>
            <li>
              the password in{" "}
              <code className="font-code">DEV_AUTO_LOGIN_PASSWORD</code> does
              not match
            </li>
          </ul>
          <p className="mt-2">You can still sign in by hand below.</p>
        </div>
      ) : null}

      {configured ? (
        <>
          <div className="rounded-panel border border-ink-200 bg-paper p-5 shadow-panel">
            <LoginForm next={next ?? "/"} />
          </div>
          <p className="text-small text-ink-600">
            Accounts are created by the platform owner. If you have not been
            given access yet, there is nothing here to sign up for.
          </p>
        </>
      ) : (
        <SetupNotice />
      )}
    </main>
  );
}
