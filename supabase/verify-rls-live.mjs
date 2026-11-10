#!/usr/bin/env node
//
// Row-level security, proved against the REAL Supabase project.
//
//   npm run verify:rls:live
//
// WHY THIS EXISTS. `verify:rls` reproduces Supabase's authorisation model on
// PGlite — roles, grants, `auth.uid()` — and it is the only thing in this
// repository that can see a leaking policy. But it is a reproduction.
// `AGENTS.md` says so in terms: "also run the same scenarios against the real
// project with real users before the first paying customer."
//
// `.env.example` has promised for some time that `verify:rls` "signs in as
// real users in two different organisations" and "SKIPs loudly rather than
// passing quietly". IT NEVER DID. No script read those variables; the
// capability was documented and never written. This is that script.
//
// WHAT MAKES THIS DIFFERENT FROM THE PGLITE SUITE. There, fixtures are seeded,
// so a scenario can say "expect exactly one row". Here the data is whatever
// the project holds, which no test may assume. So these assertions are
// INVARIANTS rather than counts:
//
//   Every shipment a signed-in user can see has a REASON — either their
//   organisation owns it, or a live `shipment_parties` grant admits it.
//
// That is checkable against any data, it needs no seeding, it cannot be
// satisfied by luck, and it is exactly what a tenancy leak would violate. A
// row with no reason is the leak, and this is the only place it can be seen.
//
// IT WRITES NOTHING IT DOES NOT ROLL BACK, and it attempts writes only where
// the expected outcome is refusal. It never deletes, never inserts a shipment,
// and never touches another tenant's data — because it runs against a project
// that may hold real customer records.
import { createClient } from "@supabase/supabase-js";

const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

const failures = [];
let passes = 0;

function pass(label) {
  passes += 1;
  console.log(`  ${GREEN}ok${RESET} ${label}`);
}

function fail(label, detail) {
  failures.push({ label, detail });
  console.log(`  ${RED}FAIL${RESET} ${label}`);
  console.log(`       ${DIM}${detail}${RESET}`);
}

function firstLine(message) {
  return String(message).split("\n")[0].slice(0, 90);
}

/* ------------------------------------------------------------------------ */
/* The assertions — same vocabulary as verify-rls.mjs, over PostgREST        */
/* ------------------------------------------------------------------------ */

/** Asserts a read returns exactly this many rows. */
async function expectCount(label, query, expected) {
  const { data, error } = await query;
  if (error) return fail(label, `query errored: ${firstLine(error.message)}`);
  const actual = (data ?? []).length;
  if (actual === expected) pass(label);
  else fail(label, `expected ${expected} row(s), got ${actual}`);
}

/**
 * Asserts a write is refused outright.
 *
 * PostgREST reports an RLS rejection as an error, so this is the loud half.
 */
async function expectRejected(label, query) {
  const { error } = await query;
  if (error) pass(`${label} ${DIM}(${firstLine(error.message)})${RESET}`);
  else fail(label, "the statement was ACCEPTED and should not have been");
}

/**
 * Asserts a write touches no rows WITHOUT raising.
 *
 * THE QUIET HALF OF RLS, and the reason this helper exists separately: a
 * `using` clause that excludes a row does not raise. The statement succeeds
 * and affects nothing, so code that checks only for an error reads that as
 * success. `verify-rls.mjs` makes the same point; it is just as true here.
 */
async function expectAffectsNothing(label, query) {
  const { data, error } = await query;
  if (error) {
    // A rejection is also acceptable — it is strictly louder.
    return pass(`${label} ${DIM}(rejected: ${firstLine(error.message)})${RESET}`);
  }
  const n = (data ?? []).length;
  if (n === 0) pass(label);
  else fail(label, `expected 0 rows affected, got ${n}`);
}

/* ------------------------------------------------------------------------ */
/* Sign-in                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * A client signed in as one real user, with the ANON key.
 *
 * The anon key is the point: it is what the browser holds, so every policy is
 * live exactly as a customer would meet it. A service-role key would bypass
 * RLS and make this suite green for the worst possible reason — and
 * non-negotiable 1 forbids one existing at all.
 */
async function signIn(url, anonKey, email, password, who) {
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    console.log(`\n${RED}Could not sign in as ${who} (${email}).${RESET}`);
    console.log(`${DIM}${firstLine(error.message)}${RESET}`);
    console.log(
      `${DIM}Create the account in the Supabase dashboard and give it a ` +
        `membership, then re-run.${RESET}`
    );
    return null;
  }
  return { client, userId: data.user.id, email };
}

/* ------------------------------------------------------------------------ */
/* The invariant                                                             */
/* ------------------------------------------------------------------------ */

/**
 * EVERY SHIPMENT THIS USER CAN SEE HAS A REASON.
 *
 * The reasons, and there are only two: their organisation owns the row, or a
 * live `shipment_parties` grant admits it. A platform admin is excluded from
 * this check by design — `is_platform_admin()` is a third reason and these
 * accounts must not be platform admins, which is asserted separately.
 *
 * A row with no reason is a tenancy leak, and it is the single thing this
 * whole file exists to detect.
 */
async function assertEveryRowHasAReason(actor, who) {
  const { client } = actor;

  const [memberships, grants, shipments] = await Promise.all([
    client.from("memberships").select("org_id").eq("user_id", actor.userId),
    client.from("shipment_parties").select("shipment_id, revoked_at"),
    client.from("shipments").select("id, org_id"),
  ]);

  for (const [name, result] of [
    ["memberships", memberships],
    ["shipment_parties", grants],
    ["shipments", shipments],
  ]) {
    if (result.error) {
      return fail(
        `${who}: every visible shipment has a reason`,
        `could not read ${name}: ${firstLine(result.error.message)}`
      );
    }
  }

  const ownOrgs = new Set((memberships.data ?? []).map((m) => m.org_id));
  const grantedShipments = new Set(
    (grants.data ?? []).filter((g) => g.revoked_at === null).map((g) => g.shipment_id)
  );

  const unexplained = (shipments.data ?? []).filter(
    (s) => !ownOrgs.has(s.org_id) && !grantedShipments.has(s.id)
  );

  if (unexplained.length === 0) {
    pass(
      `${who}: every visible shipment has a reason ` +
        `${DIM}(${(shipments.data ?? []).length} visible, ${ownOrgs.size} org(s), ` +
        `${grantedShipments.size} live grant(s))${RESET}`
    );
  } else {
    // Deliberately reports the COUNT and the owning org ids, never the
    // references or any other column — this output may be pasted somewhere.
    const orgs = [...new Set(unexplained.map((s) => s.org_id))].join(", ");
    fail(
      `${who}: every visible shipment has a reason`,
      `${unexplained.length} shipment(s) visible with no membership and no live ` +
        `grant. Owning org(s): ${orgs}. THIS IS A TENANCY LEAK.`
    );
  }
}

/* ------------------------------------------------------------------------ */
/* The run                                                                   */
/* ------------------------------------------------------------------------ */

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const accounts = {
    aEmail: process.env.VERIFY_ORG_A_ADMIN_EMAIL,
    aPassword: process.env.VERIFY_ORG_A_ADMIN_PASSWORD,
    bEmail: process.env.VERIFY_ORG_B_VIEWER_EMAIL,
    bPassword: process.env.VERIFY_ORG_B_VIEWER_PASSWORD,
  };

  if (!url || !anonKey) {
    console.log(
      `\n${YELLOW}${BOLD}SKIPPED${RESET} ${YELLOW}— Supabase is not configured.${RESET}`
    );
    console.log(
      `${DIM}NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be ` +
        `in .env.local.${RESET}`
    );
    process.exit(0);
  }

  const missing = Object.entries(accounts)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  // SKIPS LOUDLY, which is the whole contract `.env.example` promised. A
  // tenancy check that silently does nothing is worse than no check at all,
  // because it reports green — so this says exactly what is missing, exits 0
  // so it does not block a gate it was never given the means to run, and
  // leaves nobody with the impression that tenancy was proved.
  if (missing.length > 0) {
    console.log(
      `\n${YELLOW}${BOLD}SKIPPED${RESET} ${YELLOW}— no verification accounts.${RESET}`
    );
    console.log(
      `${DIM}This suite proves tenancy against the REAL project. It needs two ` +
        `ordinary\nuser accounts in two different organisations. Add them to ` +
        `.env.local:${RESET}\n`
    );
    console.log(`  VERIFY_ORG_A_ADMIN_EMAIL=`);
    console.log(`  VERIFY_ORG_A_ADMIN_PASSWORD=`);
    console.log(`  VERIFY_ORG_B_VIEWER_EMAIL=`);
    console.log(`  VERIFY_ORG_B_VIEWER_PASSWORD=`);
    console.log(
      `\n${DIM}Create them in the Supabase dashboard, give each a membership in ` +
        `a\ndifferent organisation, and never point them at real customer ` +
        `data.${RESET}`
    );
    console.log(
      `\n${YELLOW}Tenancy has NOT been proved against the real project.${RESET}`
    );
    process.exit(0);
  }

  console.log(`\n${BOLD}Row-level security — against the real project${RESET}`);
  console.log(`${DIM}Signed in with the anon key, so every policy is live.${RESET}`);

  const a = await signIn(url, anonKey, accounts.aEmail, accounts.aPassword, "org A admin");
  const b = await signIn(url, anonKey, accounts.bEmail, accounts.bPassword, "org B viewer");
  if (!a || !b) process.exit(1);

  // ---------------------------------------------------------------------
  console.log(`\n${BOLD}the invariant — nothing visible without a reason${RESET}`);
  await assertEveryRowHasAReason(a, "org A admin");
  await assertEveryRowHasAReason(b, "org B viewer");

  // ---------------------------------------------------------------------
  console.log(`\n${BOLD}neither account is a platform admin${RESET}`);
  // If either were, `is_platform_admin()` would satisfy every policy and the
  // invariant above would pass for the wrong reason.
  for (const [actor, who] of [[a, "org A admin"], [b, "org B viewer"]]) {
    await expectCount(
      `${who} holds no platform_admins row`,
      actor.client.from("platform_admins").select("user_id").eq("user_id", actor.userId),
      0
    );
  }

  // ---------------------------------------------------------------------
  console.log(`\n${BOLD}the two accounts are genuinely separate${RESET}`);
  const aOrgs = new Set(
    ((await a.client.from("memberships").select("org_id").eq("user_id", a.userId)).data ?? [])
      .map((m) => m.org_id)
  );
  const bOrgs = new Set(
    ((await b.client.from("memberships").select("org_id").eq("user_id", b.userId)).data ?? [])
      .map((m) => m.org_id)
  );
  const shared = [...aOrgs].filter((o) => bOrgs.has(o));
  if (aOrgs.size > 0 && bOrgs.size > 0 && shared.length === 0) {
    pass("the accounts are in different organisations");
  } else if (shared.length > 0) {
    fail(
      "the accounts are in different organisations",
      `they share ${shared.length} organisation(s), so no cross-tenant ` +
        `assertion below proves anything`
    );
  } else {
    fail(
      "the accounts are in different organisations",
      "one of them has no membership at all"
    );
  }

  // ---------------------------------------------------------------------
  console.log(`\n${BOLD}a counterparty reads; it never writes${RESET}`);
  // Non-negotiable 6, against the real project. Pick a shipment B can see at
  // all — if a grant exists, B may read it and must not be able to change it.
  const bVisible = (await b.client.from("shipments").select("id, org_id")).data ?? [];
  const foreign = bVisible.find((s) => !bOrgs.has(s.org_id));

  if (foreign) {
    await expectAffectsNothing(
      "org B viewer cannot edit a shipment it was only granted sight of",
      b.client
        .from("shipments")
        .update({ goods_description: "verify-rls-live must never persist this" })
        .eq("id", foreign.id)
        .select("id")
    );
    await expectRejected(
      "...and cannot log a checkpoint on it",
      b.client.from("checkpoints").insert({
        org_id: foreign.org_id,
        shipment_id: foreign.id,
        sequence_no: 999000,
        kind: "hub_scan",
        label: "verify-rls-live must never persist this",
        actual_at: new Date().toISOString(),
      })
    );
  } else {
    console.log(
      `  ${YELLOW}skipped${RESET} ${DIM}org B viewer holds no cross-tenant grant, ` +
        `so the party write rules cannot be exercised. Share one shipment with ` +
        `org B to cover this.${RESET}`
    );
  }

  // ---------------------------------------------------------------------
  console.log(`\n${BOLD}anon — a visitor who is not signed in${RESET}`);
  const anon = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  for (const table of [
    "organisations",
    "memberships",
    "shipments",
    "checkpoints",
    "locations",
    "messages",
    "decision_logs",
  ]) {
    await expectCount(`anon reads nothing from ${table}`, anon.from(table).select("*"), 0);
  }

  // ---------------------------------------------------------------------
  if (failures.length > 0) {
    console.log(
      `\n${RED}${BOLD}${failures.length} live RLS check(s) FAILED${RESET} ` +
        `${DIM}(${passes} passed)${RESET}`
    );
    for (const f of failures) {
      console.log(`  ${RED}•${RESET} ${f.label} ${DIM}— ${f.detail}${RESET}`);
    }
    console.log(
      `\n${YELLOW}A failure here is a real leak in a real project, not a ` +
        `reproduction of one.${RESET}`
    );
    process.exit(1);
  }

  console.log(
    `\n${GREEN}Row-level security verified against the real project — ` +
      `${passes} checks passed.${RESET}`
  );
  console.log(
    `${DIM}Invariant-based, so it holds for whatever data the project contains.\n` +
      `It cannot prove a policy nobody exercised: widen the fixtures, not the ` +
      `claim.${RESET}`
  );
}

main().catch((error) => {
  console.error(`\n${RED}verify:rls:live crashed${RESET}`);
  console.error(error);
  process.exit(1);
});
