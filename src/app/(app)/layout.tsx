import { AppShell } from "@/components/shell/app-shell";
import { boardSummary } from "@/lib/board";
import type { JourneyClock } from "@/lib/journey";
import { requireSession } from "@/services/bootstrap";
import { loadOversight, requestNow } from "@/services/oversight";

/**
 * Everything under here is per-user and requires a membership.
 *
 * `requireSession` redirects to /login when signed out and to /no-access when
 * signed in with no organisation — which is a real, expected state on a
 * platform where access is granted by the owner rather than taken by signup.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();

  // Request-scoped, so the page below gets the identical instant. The clock
  // the header shows and the clock the board judges lateness against are then
  // the same number, which they must be.
  const serverNowMs = requestNow();

  const clock: JourneyClock = {
    now: new Date(serverNowMs),
    timeZone: session.activeOrg.timezone,
    silenceThresholdDays: session.activeOrg.defaultSilenceThresholdDays,
  };

  const { rows } = await loadOversight(
    serverNowMs,
    clock.timeZone,
    clock.silenceThresholdDays
  );

  return (
    <AppShell
      session={session}
      summary={boardSummary(rows, clock)}
      serverNowMs={serverNowMs}
    >
      {children}
    </AppShell>
  );
}
