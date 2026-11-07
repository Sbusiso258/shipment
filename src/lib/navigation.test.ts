import { describe, expect, it } from "vitest";

import { NAV_ICONS } from "@/components/shell/sidebar";
import type { MembershipRole } from "@/types/domain";

import { navigationFor, type NavIcon } from "./navigation";

/**
 * These exist because of a real runtime error, not a hypothetical one.
 *
 * `AppShell` is a Server Component and `Sidebar` is a client one. Passing a
 * Lucide icon across that boundary — a function — fails with "Functions
 * cannot be passed directly to Client Components". Nothing caught it:
 * `LucideIcon` is a valid type, so typecheck passed, lint passed, and the
 * production build compiled all twenty routes. It only appears when the page
 * actually renders.
 *
 * So the test is on the SHAPE of what crosses: names, never functions.
 */

const ROLES: MembershipRole[] = ["admin", "operator", "viewer"];

describe("navigationFor", () => {
  it("sends nothing but plain data across the boundary", () => {
    for (const role of ROLES) {
      for (const item of navigationFor(role, true)) {
        expect(typeof item.href).toBe("string");
        expect(typeof item.label).toBe("string");
        // The one that matters. A component here is the runtime error.
        expect(typeof item.icon).toBe("string");
      }
    }
  });

  it("has an icon component for every name it can produce", () => {
    const used = new Set<NavIcon>();
    for (const role of ROLES) {
      for (const flag of [true, false]) {
        for (const item of navigationFor(role, flag)) used.add(item.icon);
      }
    }

    for (const name of used) {
      expect(NAV_ICONS[name], `no icon registered for "${name}"`).toBeDefined();
    }
  });

  it("gives an admin the screens only an admin can open", () => {
    const hrefs = navigationFor("admin", false).map((i) => i.href);
    expect(hrefs).toContain("/operators");
    expect(hrefs).toContain("/settings");
    expect(hrefs).toContain("/drivers");
  });

  it("does not offer a viewer a screen that would 404 on them", () => {
    // Cosmetic, as roles.ts says of itself — this keeps somebody from walking
    // into a notFound(), and is not what stops them doing anything.
    const hrefs = navigationFor("viewer", false).map((i) => i.href);
    expect(hrefs).not.toContain("/operators");
    expect(hrefs).not.toContain("/settings");
    expect(hrefs).not.toContain("/drivers");
    expect(hrefs).toContain("/");
    expect(hrefs).toContain("/shipments");
  });

  it("gives an operator the fleet but not the team", () => {
    const hrefs = navigationFor("operator", false).map((i) => i.href);
    expect(hrefs).toContain("/drivers");
    expect(hrefs).toContain("/vehicles");
    expect(hrefs).not.toContain("/operators");
  });

  it("shows Admin only to the platform owner", () => {
    expect(navigationFor("admin", false).map((i) => i.href)).not.toContain("/admin");
    expect(navigationFor("admin", true).map((i) => i.href)).toContain("/admin");
  });
});
