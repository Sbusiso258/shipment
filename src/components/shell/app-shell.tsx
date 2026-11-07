import { BrandMark } from "@/components/shell/brand-mark";
import { DensityControl } from "@/components/shell/density-control";
import { HeaderToggle } from "@/components/shell/header-toggle";
import { LiveClock } from "@/components/shell/live-clock";
import type { NavLink } from "@/components/shell/main-nav";
import { Sidebar } from "@/components/shell/sidebar";
import { StatusCluster } from "@/components/shell/status-cluster";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { UserMenu } from "@/components/shell/user-menu";
import { Button } from "@/components/ui/button";
import type { BoardSummary } from "@/lib/board";
import { navigationFor } from "@/lib/navigation";
import type { Session } from "@/services/bootstrap";

import { signOut } from "@/app/(auth)/login/actions";

/**
 * The mission-control shell.
 *
 * A Server Component. The client islands are the controls that genuinely
 * need to be — the sidebar (it reads the current route), the clock, the
 * theme, density and header toggles, and the user menu. Everything else,
 * including the status cluster, renders on the server from data the page
 * already has.
 *
 * TWO COLLAPSES, ONE MECHANISM. The header collapses to zero height via
 * `[data-header="hidden"]` and the sidebar narrows to an icon rail via
 * `[data-nav="rail"]`. Both are one attribute on `<html>`, set before paint;
 * no prop is threaded anywhere and nothing below needs to know either exists.
 * Neither unmounts — a collapsed header or sidebar still holds the control
 * that brings it back.
 *
 * BELOW `lg` THERE IS NO SIDEBAR. Its links go into the user menu, which
 * already carries the horizontal nav below `md` and the density and theme
 * controls below `lg`. One narrow-screen surface, not two.
 */
export function AppShell({
  session,
  summary,
  serverNowMs,
  children,
}: {
  session: Session;
  /** The same summary the page renders — the status cluster is derived, not decorative. */
  summary: BoardSummary;
  serverNowMs: number;
  children: React.ReactNode;
}) {
  const timeZone = session.activeOrg.timezone;

  // Plain data only: this is a Server Component and `Sidebar` is a client
  // one, so an icon crosses as a NAME. Sending the component itself is the
  // runtime error "Functions cannot be passed directly to Client Components",
  // which the build cannot see.
  const links = navigationFor(session.activeRole, session.isPlatformAdmin);

  // The same destinations, flattened for the narrow-screen menu.
  const menuLinks: NavLink[] = links.map(({ href, label }) => ({ href, label }));

  return (
    <div className="relative flex min-h-dvh lg:h-dvh lg:overflow-hidden">
      <Sidebar links={links} className="hidden lg:flex" />

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          className={[
            "sticky top-0 z-10 h-header shrink-0 overflow-hidden border-b border-ink-200 bg-paper",
            "transition-[height] duration-[--dur-ui] ease-[--ease-out-soft]",
          ].join(" ")}
        >
          <div className="flex h-header w-full items-center gap-3 px-4">
            {/* The brand sits in the header only while the sidebar is not
                there to hold it. */}
            <BrandMark className="min-w-0 shrink lg:hidden" />

            <StatusCluster summary={summary} className="hidden md:flex" />

            <div className="ml-auto flex items-center gap-3">
              {/* No "New shipment" here. Recording a load starts from the
                  Shipments screen, which is where somebody already is when
                  they decide to add one — and the header stops competing
                  with the sidebar for the same job. */}
              <LiveClock
                serverNowMs={serverNowMs}
                timeZone={timeZone}
                className="hidden text-right lg:flex"
              />

              <DensityControl className="hidden xl:flex" />
              <ThemeToggle className="hidden lg:inline-flex" />

              <UserMenu
                name={session.email}
                email={session.email}
                role={session.activeRole}
                organisation={session.activeOrg.name}
                links={menuLinks}
              >
                <form action={signOut}>
                  <Button type="submit" variant="danger" size="sm" className="w-full">
                    Log out
                  </Button>
                </form>
              </UserMenu>
            </div>
          </div>
        </header>

        <HeaderToggle />

        {/*
          THE SCROLLER LIVES HERE, not on each page, and that was a real bug
          rather than a tidiness preference. The shell is `lg:h-dvh
          lg:overflow-hidden`, so a page whose content is taller than the
          viewport was simply CUT OFF at desktop width with no scrollbar —
          the bottom of the team list, the new-shipment form and the journey
          view were all unreachable. Six pages had it; the two that did not
          had remembered to add their own.

          A page should not have to remember. `min-h-0` is the half everybody
          forgets: without it a flex child refuses to shrink below its content
          and `overflow-y-auto` never engages.
        */}
        <div className="flex min-h-0 flex-1 flex-col lg:overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
