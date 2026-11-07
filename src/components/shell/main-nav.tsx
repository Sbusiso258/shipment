"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * The way to everything that is not the board.
 *
 * A client component for one reason only: the current route decides which
 * link is marked, and `usePathname` is the way to know it. Everything else
 * about the shell stays on the server.
 *
 * WHICH LINKS APPEAR IS COSMETIC, and the file that computes them says so
 * too. `src/lib/roles.ts` decides what to RENDER; row-level security decides
 * what may happen. Hiding "Team" from an operator keeps them from walking
 * into a 404 — it is not what stops them managing a team.
 */

export interface NavLink {
  href: string;
  label: string;
}

export function MainNav({
  links,
  className,
}: {
  links: NavLink[];
  className?: string;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className={cn("flex items-center gap-1", className)}>
      {links.map((link) => {
        // `/` would otherwise match everything.
        const current =
          link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);

        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "rounded-control px-2.5 py-1.5 text-small transition-colors",
              current
                ? "bg-ink-100 text-ink-950"
                : "text-ink-600 hover:bg-ink-100 hover:text-ink-950"
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
