import type { MembershipRole } from "@/types/domain";

import { canInvite, canManageLocations } from "./roles";

/**
 * What goes in the sidebar, and who sees it.
 *
 * THE ICON IS A NAME, NOT A COMPONENT, and that is the whole reason this file
 * exists. `AppShell` is a Server Component and `Sidebar` is a client one;
 * only plain data crosses that boundary. Passing a Lucide icon — a function —
 * fails at RUNTIME with "Functions cannot be passed directly to Client
 * Components", which no type check, lint or build will catch, because the
 * type is perfectly valid and the rule is about serialisation.
 *
 * So the server picks a name and the client maps it to a component. The names
 * are a closed union, and `sidebar.tsx` has to have an entry for every one of
 * them — asserted in `navigation.test.ts`, so adding a destination and
 * forgetting its icon fails a test instead of a page.
 *
 * Pure, and in `lib` because which links a role sees is a judgement. It is
 * also COSMETIC, as `roles.ts` says of itself: hiding Operators stops
 * somebody walking into a 404; row-level security is what stops them
 * managing a team.
 */

export type NavIcon =
  | "dashboard"
  | "shipments"
  | "operators"
  | "drivers"
  | "vehicles"
  | "places"
  | "messages"
  | "reports"
  | "settings"
  | "admin";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
}

export function navigationFor(
  role: MembershipRole,
  isPlatformAdmin: boolean
): NavItem[] {
  const mayManageFleet = canManageLocations(role);
  const mayAdminister = canInvite(role);

  return [
    { href: "/", label: "Dashboard", icon: "dashboard" },
    { href: "/shipments", label: "Shipments", icon: "shipments" },
    ...(mayAdminister
      ? [{ href: "/operators", label: "Operators", icon: "operators" as const }]
      : []),
    ...(mayManageFleet
      ? [
          { href: "/drivers", label: "Drivers", icon: "drivers" as const },
          { href: "/vehicles", label: "Vehicles", icon: "vehicles" as const },
          { href: "/locations", label: "Places", icon: "places" as const },
        ]
      : []),
    { href: "/messages", label: "Messages", icon: "messages" },
    { href: "/reports", label: "Reports", icon: "reports" },
    ...(mayAdminister
      ? [{ href: "/settings", label: "Settings", icon: "settings" as const }]
      : []),
    ...(isPlatformAdmin
      ? [{ href: "/admin", label: "Admin", icon: "admin" as const }]
      : []),
  ];
}
