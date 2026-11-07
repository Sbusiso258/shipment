"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Boxes,
  ChevronsLeft,
  ChevronsRight,
  Cog,
  Gauge,
  IdCard,
  LayoutDashboard,
  MapPin,
  MessageSquare,
  Shield,
  Truck,
  Users,
  type LucideIcon,
} from "lucide-react";

import { BrandMark } from "@/components/shell/brand-mark";
import { useMounted } from "@/hooks/use-mounted";
import { useNavRail } from "@/hooks/use-nav-rail";
import type { NavIcon, NavItem } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/**
 * The navigation rail.
 *
 * A client component for one reason: the current route decides which link is
 * marked, and `usePathname` is how that is known. Everything else about the
 * shell stays on the server.
 *
 * WHICH LINKS APPEAR IS COSMETIC. `src/lib/roles.ts` says so about itself and
 * it is worth repeating here: hiding "Operators" from an operator stops them
 * walking into a 404; row-level security is what stops them managing a team.
 *
 * COLLAPSING NARROWS, NEVER UNMOUNTS. The width is `--sidebar-w`, which
 * `[data-nav="rail"]` shrinks to an icon strip — so the links keep their tab
 * order and the control that brings the labels back stays reachable. A
 * sidebar that disappears takes the way back with it.
 */

/**
 * Name to component, on the CLIENT side of the boundary.
 *
 * The server cannot send a Lucide icon: it is a function, and functions are
 * not serialisable across a Server-to-Client boundary. That fails at runtime
 * with "Functions cannot be passed directly to Client Components" — a rule no
 * type check or build can see, because `LucideIcon` is a perfectly valid
 * type. So the server names an icon and this table resolves it.
 *
 * `navigation.test.ts` asserts every `NavIcon` has an entry here, so adding a
 * destination and forgetting its icon fails a test rather than a page.
 */
export const NAV_ICONS: Record<NavIcon, LucideIcon> = {
  dashboard: LayoutDashboard,
  shipments: Boxes,
  operators: Users,
  drivers: IdCard,
  vehicles: Truck,
  places: MapPin,
  messages: MessageSquare,
  reports: BarChart3,
  settings: Cog,
  admin: Shield,
};

function isCurrent(pathname: string, href: string): boolean {
  // `/` would otherwise match every route.
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function Sidebar({
  links,
  className,
}: {
  links: NavItem[];
  className?: string;
}) {
  const pathname = usePathname();
  const { rail, toggle } = useNavRail();
  const mounted = useMounted();

  return (
    <aside
      className={cn(
        "flex w-sidebar shrink-0 flex-col gap-1 border-r border-ink-200 bg-paper p-2",
        "transition-[width] duration-[--dur-ui] ease-[--ease-out-soft]",
        className
      )}
    >
      {/* The brand moved out of the header when the sidebar arrived. It has
          to land somewhere: without this the app has no name on screen at
          desktop width at all. */}
      <Link
        href="/"
        className="mb-2 flex min-h-row shrink-0 items-center overflow-hidden rounded-control px-1"
      >
        <BrandMark />
      </Link>

      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col gap-0.5">
        {links.map((link) => {
          const current = isCurrent(pathname, link.href);
          const Icon = NAV_ICONS[link.icon];

          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={current ? "page" : undefined}
              // The accessible name has to survive the collapse. With labels
              // hidden the text is still in the DOM, just clipped — a
              // screen reader and a tooltip both still find it.
              title={link.label}
              className={cn(
                "relative flex items-center gap-3 rounded-control px-3 text-small transition-colors",
                "min-h-row shrink-0",
                current
                  ? "bg-marine-100 font-medium text-ink-950"
                  : "text-ink-600 hover:bg-ink-100 hover:text-ink-950"
              )}
            >
              <Icon
                aria-hidden
                className={cn(
                  "size-4 shrink-0",
                  current ? "text-marine-200" : "text-ink-400"
                )}
              />
              <span className="min-w-0 flex-1 truncate">{link.label}</span>

              {/* A bar on the left edge of the active row, which survives the
                  collapse where the background tint alone reads as noise. */}
              {current ? (
                <span
                  aria-hidden
                  className="absolute left-0 h-6 w-0.5 rounded-r bg-marine-500"
                />
              ) : null}
            </Link>
          );
        })}
      </nav>

      {/* Rendered only after mount: the server cannot know the stored
          preference, and a button whose label flips on hydration is worse
          than one that arrives a frame late. */}
      {mounted ? (
        <button
          type="button"
          onClick={toggle}
          aria-pressed={rail}
          className={cn(
            "flex min-h-row shrink-0 items-center gap-3 rounded-control px-3",
            "text-small text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-950"
          )}
        >
          {rail ? (
            <ChevronsRight aria-hidden className="size-4 shrink-0" />
          ) : (
            <ChevronsLeft aria-hidden className="size-4 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate text-left">
            {rail ? "Expand" : "Collapse"}
          </span>
        </button>
      ) : (
        <span aria-hidden className="flex min-h-row shrink-0 items-center px-3">
          <Gauge className="size-4 text-ink-200" />
        </span>
      )}
    </aside>
  );
}
