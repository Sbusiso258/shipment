import { notFound, redirect } from "next/navigation";

import type { MembershipRole, Organisation } from "@/types/domain";

import { fail } from "./fail";
import { supabaseServer } from "./supabase/server";

/**
 * Who is asking, and on behalf of which organisation.
 *
 * Every server component and server action starts here. Note what this does
 * NOT do: it does not decide what the user may see. RLS does that. This
 * resolves identity so the UI can be shaped sensibly — hiding a button a
 * policy would refuse anyway.
 *
 * A hidden button is cosmetic. The enforcement is in the database.
 */

export interface Membership {
  orgId: string;
  role: MembershipRole;
  organisation: Organisation;
}

/**
 * Identity, with no organisation demanded.
 *
 * `Session` is this plus an ACTIVE organisation, and that difference is the
 * whole reason both exist — see `requireActor` below.
 */
export interface Actor {
  userId: string;
  email: string | null;
  memberships: Membership[];
  isPlatformAdmin: boolean;
}

export interface Session extends Actor {
  /** The organisation being viewed. */
  activeOrg: Organisation;
  activeRole: MembershipRole;
}

/**
 * PostgREST infers result types from a LITERAL select string. A constant built
 * by concatenation widens to `string`, inference collapses to
 * `GenericStringError`, and every result has to be cast through `unknown`.
 * So these stay literal, and the hand-written Row interface below is the real
 * contract with the database — keep the two in step.
 */
const MEMBERSHIP_COLUMNS =
  "org_id, role, organisations!inner(id, name, slug, timezone, is_subscriber, default_silence_threshold_days)";

interface MembershipRow {
  org_id: string;
  role: MembershipRole;
  organisations: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    is_subscriber: boolean;
    default_silence_threshold_days: number;
  };
}

export function mapOrganisation(row: MembershipRow["organisations"]): Organisation {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    defaultSilenceThresholdDays: row.default_silence_threshold_days,
    isSubscriber: row.is_subscriber,
  };
}

/**
 * The signed-in user, or a redirect to the login screen.
 *
 * `getUser()`, not `getSession()`: it revalidates the token against the auth
 * server, so a forged or stale cookie cannot pass.
 */
export async function requireUser() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");
  return { supabase, user };
}

/**
 * The platform owner, without requiring a membership.
 *
 * THE BOOTSTRAPPING CASE. `requireSession` sends a user with no organisation
 * to /no-access — correct for the app, fatal for the admin area: a freshly
 * seeded platform owner has no membership yet, and the whole point of /admin
 * is to create the first organisation. Routing them to "you are not in an
 * organisation" would make the product unopenable from a cold start.
 */
export async function requirePlatformAdmin(): Promise<{
  userId: string;
  email: string | null;
}> {
  const { supabase, user } = await requireUser();

  const { data } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  // notFound(), not redirect: a redirect confirms the route exists to
  // somebody who should not know that it does.
  if (!data) notFound();

  return { userId: user.id, email: user.email ?? null };
}

/**
 * Who is asking, WITHOUT requiring them to be in an organisation.
 *
 * THIS IS THE BOOTSTRAPPING PATH, and it exists because the obvious thing is
 * a trap. `requireSession` redirects a user with no membership to
 * `/no-access`, which is right for the app and fatal for the actions that
 * CREATE the first organisation — the owner has no membership at that moment,
 * by definition. `/admin`'s layout already avoids `requireSession` for exactly
 * this reason; its actions used to call it anyway, so the screen loaded and
 * every submission redirected into a dead end.
 *
 * Nobody hit it while the demo seed had put the owner in an organisation. The
 * first person to delete that organisation would have locked themselves out
 * of their own product.
 *
 * So: anything that may run before the first membership exists takes an
 * `Actor`. Anything that renders a board takes a `Session`.
 */
export async function requireActor(): Promise<Actor> {
  const { supabase, user } = await requireUser();

  const [{ data, error }, { data: adminRow }] = await Promise.all([
    // ORDERED, DELIBERATELY. This query had no `order by`, so `memberships[0]`
    // below was whatever Postgres happened to return — which picked an
    // arbitrary active organisation for a multi-org user. Harmless while
    // there was one shell; now that a membership decides which PRODUCT
    // somebody sees, an arbitrary first row decides it. Oldest membership
    // first: the organisation somebody joined first is the one they think of
    // as theirs.
    supabase
      .from("memberships")
      .select(MEMBERSHIP_COLUMNS)
      .eq("user_id", user.id)
      .order("created_at", { ascending: true }),
    supabase.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle(),
  ]);

  // THROUGH `fail()`. This threw a bare Error, so a missing column on
  // `memberships` or the embedded `organisations` could never be a
  // `SchemaBehindError` — and since `requireActor` runs on every route, that
  // is the one place where naming the migration to apply matters most.
  // `fail()` keeps the same rule about never interpolating a ROW.
  if (error) fail("load memberships", error);

  const rows = (data ?? []) as unknown as MembershipRow[];

  return {
    userId: user.id,
    email: user.email ?? null,
    memberships: rows.map((row) => ({
      orgId: row.org_id,
      role: row.role,
      organisation: mapOrganisation(row.organisations),
    })),
    isPlatformAdmin: Boolean(adminRow),
  };
}

/**
 * The full session, or a redirect.
 *
 * A signed-in user with no membership is sent to `/no-access` rather than an
 * empty dashboard. Access here is granted by the platform owner, so "you are
 * signed in but nobody has added you to an organisation yet" is an expected
 * state with a real explanation, not an error.
 */
export async function requireSession(preferredOrgId?: string): Promise<Session> {
  const actor = await requireActor();

  // NEVER FABRICATE A SESSION HERE.
  //
  // This line was replaced at one point by a block that returned a made-up
  // "Demo Logistics" organisation with `activeRole: "admin"` whenever somebody
  // had no membership. It did not leak data — the id was not a real
  // organisation, `my_org_ids()` returns nothing for such a user, and RLS
  // refused every query regardless — but it rendered the entire operations
  // shell as though the person were an admin, which is the shape of fault
  // non-negotiable 1 exists to forbid: authorization is a database property,
  // never a UI one.
  //
  // It also made `/no-access` unreachable, which is the screen that explains
  // this exact state. "You are signed in but nobody has added you to an
  // organisation yet" is expected here, because access is granted by the
  // platform owner — so it gets an explanation, not a fake dashboard.
  //
  // If a signed-in user with no membership needs somewhere to land during
  // development, the supported path is `DEV_AUTO_LOGIN` in `src/proxy.ts`
  // with a real account, or a real membership created from `/admin`.
  if (actor.memberships.length === 0) redirect("/no-access");

  const active =
    actor.memberships.find((m) => m.orgId === preferredOrgId) ?? actor.memberships[0];

  return {
    ...actor,
    activeOrg: active.organisation,
    activeRole: active.role,
  };
}
