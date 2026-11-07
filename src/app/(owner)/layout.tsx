import Link from "next/link";
import { Button } from "@/components/ui/button";
import { requirePlatformAdmin } from "@/services/bootstrap";

import { signOut } from "../(auth)/login/actions";

/**
 * The platform owner's area.
 *
 * Its own route group because it needs a different shell — there is no
 * organisation switcher, since the owner is not *in* an organisation — and
 * because "which screens are owner-only" should be a directory listing rather
 * than a grep for a permission check.
 *
 * `notFound()`, NOT `redirect("/")`. A redirect confirms the route exists to
 * somebody who should not know it does; a 404 tells them nothing.
 *
 * This gate is the second of three, and the least important. The first is
 * `proxy.ts`, which only stops the signed-out. The third is RLS, which is the
 * only one that matters: delete this file and a non-owner loading /admin would
 * see an empty list, not another tenant's data.
 */
export default async function OwnerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Deliberately NOT requireSession: a freshly seeded platform owner has no
  // membership yet, and that path would send them to /no-access — making the
  // product unopenable from a cold start.
  const owner = await requirePlatformAdmin();

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-ink-200 bg-marine-900">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-baseline gap-4">
            <Link
              href="/admin"
              className="font-code text-small uppercase tracking-widest text-marine-200"
            >
              Platform admin
            </Link>
            <Link href="/" className="text-small text-marine-200 hover:text-ink-950">
              Back to the board
            </Link>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-small text-marine-200">{owner.email}</span>
            <form action={signOut}>
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                className="text-marine-200 hover:bg-marine-700 hover:text-ink-950"
              >
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>

      {children}
    </div>
  );
}
