import { describe, expect, it } from "vitest";

import { describeFailure, isSchemaBehind } from "./fail";

/**
 * The missing-table branch exists because of a real 500, not a hypothetical
 * one: `shipment_assignments` was in `supabase/migrations/` and not in the
 * live database, and the message named the table but not the fix.
 */
describe("describeFailure", () => {
  const MISSING = {
    code: "PGRST205",
    message:
      "Could not find the table 'public.shipment_assignments' in the schema cache",
  };

  it("names the table that is missing", () => {
    expect(describeFailure("load assignments", MISSING)).toContain(
      "public.shipment_assignments"
    );
  });

  it("says how to apply the migration", () => {
    const message = describeFailure("load assignments", MISSING);
    expect(message).toContain("bundle-migration.sh");
    expect(message).toContain("verify:upgrade");
  });

  it("also covers the case where it WAS applied and PostgREST has not noticed", () => {
    expect(describeFailure("load assignments", MISSING)).toContain(
      "notify pgrst, 'reload schema'"
    );
  });

  it("recognises the condition from the message alone, without a code", () => {
    const noCode = { message: "Could not find the table 'public.x' in the schema cache" };
    expect(describeFailure("load x", noCode)).toContain("bundle-migration.sh");
  });

  it("covers a missing FUNCTION, not only a missing table", () => {
    // PostgREST answers PGRST202 for a function it cannot find, with the same
    // "schema cache" wording. `find_organisation_by_slug` arrives in 0009, so
    // this is the shape an admin hits when they try to share a shipment
    // against a database that is behind.
    const missingFunction = {
      code: "PGRST202",
      message:
        "Could not find the function public.find_organisation_by_slug(target_slug) in the schema cache",
    };
    const message = describeFailure("look up that organisation", missingFunction);
    expect(message).toContain("find_organisation_by_slug");
    expect(message).toContain("bundle-migration.sh");
  });

  it("leaves every other failure exactly as it was", () => {
    expect(
      describeFailure("load shipments", { code: "42501", message: "permission denied" })
    ).toBe("Failed to load shipments: permission denied");
  });

  it("still accepts a bare message", () => {
    expect(describeFailure("load x", { message: "boom" })).toBe("Failed to load x: boom");
  });
});

/**
 * A MISSING COLUMN used to fall through to the bare branch above, so a page
 * reading a column from an unapplied migration said what broke and not what
 * to do about it. Found by loading /shipments/new against a project still on
 * 0007 after the code began reading `shipments.driver_id` from 0011 — which
 * is also the shape of the next such mistake, since a column gets read by
 * code shipped ahead of its migration far more often than a table does.
 */
describe("isSchemaBehind", () => {
  it("catches a missing column by code", () => {
    expect(
      isSchemaBehind({ code: "42703", message: "column shipments.driver_id does not exist" })
    ).toBe(true);
  });

  it("catches a missing column by message when the code is not forwarded", () => {
    expect(
      isSchemaBehind({ message: "column shipments.driver_id does not exist" })
    ).toBe(true);
  });

  it("catches a missing table either way", () => {
    expect(isSchemaBehind({ code: "42P01", message: "whatever" })).toBe(true);
    expect(
      isSchemaBehind({ message: 'relation "public.drivers" does not exist' })
    ).toBe(true);
  });

  it("still catches the stale PostgREST cache", () => {
    expect(
      isSchemaBehind({
        code: "PGRST205",
        message: "Could not find the table 'public.drivers' in the schema cache",
      })
    ).toBe(true);
  });

  // THE IMPORTANT NEGATIVE. "does not exist" is also how Postgres talks about
  // a missing ROW, a missing ROLE and a missing FUNCTION ARGUMENT. Telling
  // somebody to go and apply a migration because a shipment id was wrong
  // would send them to the SQL editor over a typo.
  it("does not treat a missing row as a migration problem", () => {
    expect(isSchemaBehind({ message: "shipment does not exist" })).toBe(false);
    expect(isSchemaBehind({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isSchemaBehind({ message: 'role "operator" does not exist' })).toBe(false);
  });
});
