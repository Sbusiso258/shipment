"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { DensityControl } from "@/components/shell/density-control";
import { MainNav, type NavLink } from "@/components/shell/main-nav";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { cn } from "@/lib/utils";
import type { MembershipRole } from "@/types/domain";

const ROLE_LABEL: Record<MembershipRole, string> = {
  admin: "Admin",
  operator: "Operator",
  viewer: "Viewer",
};

/** `John Doe` → `JD`; an email falls back to its first letter. */
function initials(name: string | null, email: string | null): string {
  const source = name?.trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
  }
  return (email?.[0] ?? "?").toUpperCase();
}

/**
 * Who is signed in, and the controls that do not earn permanent header space.
 *
 * On a narrow screen the density control and theme toggle move in here rather
 * than being dropped — a preference you cannot reach on a phone is a
 * preference the phone user does not have.
 */
export function UserMenu({
  name,
  email,
  role,
  organisation,
  links,
  children,
}: {
  name: string | null;
  email: string | null;
  role: MembershipRole;
  organisation: string;
  /** The same links as the header nav. On a phone this is the only way to
      reach them, so they move in here rather than being dropped. */
  links: NavLink[];
  /** The sign-out form, rendered by the server. */
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-control p-1 transition-colors hover:bg-ink-100"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-marine-700 text-micro font-semibold text-marine-on">
          {initials(name, email)}
        </span>
        <span className="hidden flex-col text-left leading-tight sm:flex">
          <span className="text-small text-ink-950">{name ?? email ?? "Signed in"}</span>
          {/* The role, not a job title. "Transporter" describes the company;
              this line is about what this person may do. */}
          <span className="text-micro text-ink-400">{ROLE_LABEL[role]}</span>
        </span>
        <ChevronDown aria-hidden className="size-3.5 text-ink-400" />
      </button>

      {open ? (
        <>
          {/* Catches the click that dismisses the menu. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default"
          />

          <div
            role="menu"
            className={cn(
              "absolute right-0 top-full z-40 mt-1 w-64 rounded-panel border border-ink-200",
              "bg-paper p-3 shadow-raised"
            )}
          >
            <p className="text-small text-ink-950">{name ?? "Signed in"}</p>
            <p className="truncate text-micro text-ink-400">{email}</p>
            <p className="mt-1 text-micro text-ink-600">
              {organisation} · {ROLE_LABEL[role]}
            </p>

            {/* The sidebar appears at `lg`, so below that this menu is the
                only way to the other screens. */}
            <div className="mt-3 border-t border-ink-100 pt-3 lg:hidden">
              <MainNav links={links} className="flex-col items-stretch gap-0.5" />
            </div>

            {/* `xl`, not `lg`: the header only shows the density control
                from `xl` up, so hiding it here at `lg` left a window where it
                could not be reached at all. */}
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-ink-100 pt-3 xl:hidden">
              <span className="text-micro text-ink-600">Density</span>
              <DensityControl />
            </div>

            <div className="mt-2 flex items-center justify-between gap-2 lg:hidden">
              <span className="text-micro text-ink-600">Theme</span>
              <ThemeToggle />
            </div>

            <div className="mt-3 border-t border-ink-100 pt-3">{children}</div>
          </div>
        </>
      ) : null}
    </div>
  );
}
