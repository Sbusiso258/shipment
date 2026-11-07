#!/usr/bin/env node
//
// Proves that row-level security actually refuses things.
//
//   npm run verify:rls
//
// THIS IS THE MOST IMPORTANT SCRIPT IN THIS REPOSITORY.
//
// A missing table fails loudly the first time a page loads. A missing policy
// fails silently, and only in the direction that leaks — one logistics
// business quietly reading another's shipments, with nothing in any log to say
// so. Nothing else in the project can catch that.
//
// WHY THIS CAN RUN LOCALLY
// ------------------------
// `verify:migrations` cannot prove RLS, because the role running it owns the
// tables and an owner bypasses its own row-level security. That is a fact
// about the ROLE, not about the database — so the fix is to stop being the
// owner. Postgres applies policies to any role that is not the table owner, so
// `set role authenticated` plus a jwt claim makes every policy in the schema
// live, in-process, with no server and no credentials.
//
// `supabase/verify-stubs.sql` reproduces Supabase's default privileges so that
// `authenticated` holds the same table grants it holds in production. Without
// that, queries would fail on privileges before reaching a policy and this
// suite would be green for the wrong reason.
//
// WHAT THIS STILL DOES NOT PROVE
// ------------------------------
// This is a faithful reproduction of Supabase's authorisation model, not
// Supabase itself. `auth.uid()` here reads the same GUC the real one reads, and
// the roles and grants match, but a divergence between this environment and a
// real project could in principle let a policy pass here and leak there.
//
// So: run this on every change, because it is free and it will catch almost
// everything. Before the first paying customer, also run the same assertions
// against the real project with real users and the anon key. The scenarios
// below are written as data so that second harness can reuse them.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";

const DIR = import.meta.dirname;
const MIGRATIONS = path.join(DIR, "migrations");

const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

// Fixture identities. Fixed uuids so a failure message is readable.
const OWNER = "11111111-1111-1111-1111-111111111111";
const A_ADMIN = "22222222-2222-2222-2222-222222222222";
const A_OPERATOR = "33333333-3333-3333-3333-333333333333";
const B_ADMIN = "44444444-4444-4444-4444-444444444444";
const B_VIEWER = "55555555-5555-5555-5555-555555555555";
const OUTSIDER = "66666666-6666-6666-6666-666666666666";

let passed = 0;
const failures = [];

function pass(label) {
  passed += 1;
  console.log(`  ${GREEN}ok${RESET} ${label}`);
}

function fail(label, detail) {
  failures.push({ label, detail });
  console.log(`  ${RED}FAIL${RESET} ${label}`);
  if (detail) console.log(`       ${DIM}${detail}${RESET}`);
}

/**
 * Become a signed-in user: set the claim auth.uid() reads, then drop to the
 * `authenticated` role so policies apply.
 *
 * `reset role` first, because a session already in `authenticated` cannot
 * always set the GUC, and because leaking a role between scenarios would make
 * a later assertion pass for the wrong reason.
 */
async function asUser(db, userId) {
  await db.exec("reset role;");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await db.exec("set role authenticated;");
}

async function asAnon(db) {
  await db.exec("reset role;");
  await db.query("select set_config('request.jwt.claim.sub', '', false)");
  await db.exec("set role anon;");
}

async function asOwner(db) {
  await db.exec("reset role;");
  await db.query("select set_config('request.jwt.claim.sub', '', false)");
}

/** Asserts a query returns exactly `expected` rows. */
async function expectCount(db, label, sql, params, expected) {
  try {
    const { rows } = await db.query(sql, params);
    const actual = Number(rows[0]?.n ?? rows.length);
    if (actual === expected) pass(label);
    else fail(label, `expected ${expected} row(s), got ${actual}`);
  } catch (error) {
    fail(label, `query errored: ${error.message}`);
  }
}

/** Asserts a statement is refused outright (a policy or privilege rejection). */
async function expectRejected(db, label, sql, params) {
  try {
    await db.query(sql, params);
    fail(label, "the statement was ACCEPTED and should not have been");
  } catch (error) {
    pass(`${label} ${DIM}(${firstLine(error.message)})${RESET}`);
  }
}

/**
 * Asserts a write touches no rows WITHOUT raising.
 *
 * This is the quiet half of RLS and it deserves its own assertion. A `using`
 * clause that excludes a row does not raise — the statement succeeds and
 * affects nothing. Code that checks only for an error treats that as success.
 */
async function expectAffectsNothing(db, label, sql, params) {
  try {
    const result = await db.query(sql, params);
    const n = result.affectedRows ?? 0;
    if (n === 0) pass(label);
    else fail(label, `expected 0 rows affected, got ${n}`);
  } catch (error) {
    // A rejection is also an acceptable outcome here — it is strictly louder.
    pass(`${label} ${DIM}(rejected: ${firstLine(error.message)})${RESET}`);
  }
}

function firstLine(message) {
  return String(message).split("\n")[0].slice(0, 90);
}

async function seed(db) {
  await asOwner(db);
  await db.exec(`
    insert into auth.users (id, email) values
      ('${OWNER}',      'owner@verify.test'),
      ('${A_ADMIN}',    'a-admin@verify.test'),
      ('${A_OPERATOR}', 'a-operator@verify.test'),
      ('${B_ADMIN}',    'b-admin@verify.test'),
      ('${B_VIEWER}',   'b-viewer@verify.test'),
      ('${OUTSIDER}',   'outsider@verify.test'),
      ('${D_ADMIN}',    'd-admin@verify.test');

    insert into public.platform_admins (user_id, note)
    values ('${OWNER}', 'rls verification fixture');

    insert into public.organisations (id, name, slug, is_subscriber, created_by) values
      ('aaaaaaaa-0000-0000-0000-000000000001', 'Alpha Freight', 'alpha-freight', true,  '${OWNER}'),
      ('bbbbbbbb-0000-0000-0000-000000000002', 'Bravo Logistics', 'bravo-logistics', true, '${OWNER}'),
      -- Shares nothing with anyone, ever. Alpha and Bravo are counterparties
      -- on a shipment, so each can legitimately read the other's NAME — which
      -- means neither can be used to test tenant isolation. This third org is
      -- the control.
      ('${ORG_UNRELATED}', 'Delta Transport', 'delta-transport', true, '${OWNER}'),
      -- A STRANGER, AND IT STAYS ONE. Delta is granted a shipment partway
      -- through the suite, so by the end it is a legitimate counterparty and
      -- cannot answer "does the table still hide somebody we share nothing
      -- with". This organisation is never party to anything, never has a
      -- member, and exists only to be the control for that question and the
      -- target of the 0009 slug lookup.
      ('${ORG_STRANGER}', 'Echo Cartage', 'echo-cartage', true, '${OWNER}');

    insert into public.memberships (org_id, user_id, role) values
      ('aaaaaaaa-0000-0000-0000-000000000001', '${A_ADMIN}',    'admin'),
      ('aaaaaaaa-0000-0000-0000-000000000001', '${A_OPERATOR}', 'operator'),
      ('bbbbbbbb-0000-0000-0000-000000000002', '${B_ADMIN}',    'admin'),
      ('bbbbbbbb-0000-0000-0000-000000000002', '${B_VIEWER}',   'viewer');

    insert into public.locations (id, org_id, name, kind, sa_place_id)
    select 'cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
           'Alpha Johannesburg Depot', 'depot', id
    from public.sa_places where slug = 'johannesburg';

    insert into public.locations (id, org_id, name, kind, sa_place_id)
    select 'dddddddd-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002',
           'Bravo Durban Yard', 'yard', id
    from public.sa_places where slug = 'durban';

    -- Alpha's destination for the shared shipment...
    insert into public.locations (id, org_id, name, kind, sa_place_id)
    select '${A_DEST}', 'aaaaaaaa-0000-0000-0000-000000000001',
           'Alpha Durban Depot', 'depot', id
    from public.sa_places where slug = 'durban';

    -- ...and a depot that is NOT on any shared shipment. A party must never
    -- see this one: a competitor's full depot network is exactly what an
    -- over-broad location policy would hand over.
    insert into public.locations (id, org_id, name, kind, sa_place_id)
    select '${A_SECRET}', 'aaaaaaaa-0000-0000-0000-000000000001',
           'Alpha Confidential Depot', 'depot', id
    from public.sa_places where slug = 'bloemfontein';

    insert into public.shipments
      (id, org_id, reference, origin_location_id, destination_location_id, created_by)
    values ('${SHIPMENT}', 'aaaaaaaa-0000-0000-0000-000000000001', 'ALPHA-SHARED',
            'cccccccc-0000-0000-0000-000000000001', '${A_DEST}', '${OWNER}');

    -- A second shipment, never shared. The party must not see it.
    insert into public.shipments
      (id, org_id, reference, origin_location_id, destination_location_id, created_by)
    values ('${SHIPMENT_PRIVATE}', 'aaaaaaaa-0000-0000-0000-000000000001', 'ALPHA-PRIVATE',
            'cccccccc-0000-0000-0000-000000000001', '${A_SECRET}', '${OWNER}');

    insert into public.checkpoints
      (org_id, shipment_id, sequence_no, kind, label, planned_at, actual_at)
    values
      ('aaaaaaaa-0000-0000-0000-000000000001', '${SHIPMENT}', 100, 'pickup',
       'Collected in Johannesburg', now() - interval '2 days', now() - interval '2 days'),
      ('aaaaaaaa-0000-0000-0000-000000000001', '${SHIPMENT}', 200, 'delivery',
       'Delivery in Durban', now() + interval '1 day', null);

    insert into public.checkpoints
      (org_id, shipment_id, sequence_no, kind, label, planned_at)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '${SHIPMENT_PRIVATE}', 100, 'pickup',
            'Private pickup', now());

    -- Bravo is the consignee on the first shipment, and nothing else.
    insert into public.shipment_parties
      (org_id, shipment_id, party_org_id, party_role, granted_by, messaging_enabled)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '${SHIPMENT}',
            'bbbbbbbb-0000-0000-0000-000000000002', 'consignee', '${OWNER}', true);

    -- Alpha's operator is on the shared shipment and NOT on the private one.
    -- This single row is what the whole of 0008 turns on: without it the
    -- operator sees nothing at all, and with it they see exactly one load.
    insert into public.shipment_assignments (org_id, shipment_id, user_id, assigned_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '${SHIPMENT}',
            '${A_OPERATOR}', '${A_ADMIN}');

    -- Delta has a member now. Without one, isolation from it could only ever
    -- be tested from Alpha's side, and the messaging scenarios below need
    -- somebody in a third organisation to prove a conversation is private to
    -- its two participants.
    insert into public.memberships (org_id, user_id, role)
    values ('${ORG_UNRELATED}', '${D_ADMIN}', 'admin');
  `);
}

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "bbbbbbbb-0000-0000-0000-000000000002";
const A_DEST = "eeeeeeee-0000-0000-0000-000000000003";
const A_SECRET = "eeeeeeee-0000-0000-0000-000000000004";
const SHIPMENT = "ffffffff-0000-0000-0000-000000000005";
const SHIPMENT_PRIVATE = "ffffffff-0000-0000-0000-000000000006";
const ORG_UNRELATED = "99999999-0000-0000-0000-000000000009";
const ORG_STRANGER = "99999999-0000-0000-0000-00000000000a";
const D_ADMIN = "aaaaaaaa-1111-1111-1111-111111111111";

async function run(db) {
  // =========================================================================
  console.log(`\n${BOLD}anon — a visitor who is not signed in${RESET}`);
  // =========================================================================
  await asAnon(db);

  for (const table of [
    "organisations",
    "memberships",
    "invitations",
    "profiles",
    "platform_admins",
  ]) {
    await expectCount(
      db,
      `anon reads nothing from ${table}`,
      `select count(*)::int as n from public.${table}`,
      [],
      0
    );
  }

  await expectRejected(
    db,
    "anon cannot create an organisation",
    `insert into public.organisations (name, slug, created_by) values ('Rogue', 'rogue', $1)`,
    [OWNER]
  );

  await expectRejected(
    db,
    "anon cannot make itself a platform admin",
    `insert into public.platform_admins (user_id) values ($1)`,
    [OUTSIDER]
  );

  // These bypass RLS by design, so they must not be reachable by a visitor.
  // Supabase grants EXECUTE on new functions to anon by default, so
  // `revoke ... from public` alone does NOT achieve this.
  for (const fn of ["is_platform_admin()", "my_org_ids()"]) {
    await expectRejected(
      db,
      `anon cannot execute ${fn}`,
      `select public.${fn}`,
      []
    );
  }

  // =========================================================================
  console.log(`\n${BOLD}outsider — signed in, no membership anywhere${RESET}`);
  // =========================================================================
  await asUser(db, OUTSIDER);

  await expectCount(
    db,
    "an outsider sees no organisations",
    "select count(*)::int as n from public.organisations",
    [],
    0
  );
  await expectCount(
    db,
    "an outsider sees no memberships",
    "select count(*)::int as n from public.memberships",
    [],
    0
  );
  await expectRejected(
    db,
    "an outsider cannot add themselves to an organisation",
    `insert into public.memberships (org_id, user_id, role) values ($1, $2, 'admin')`,
    [ORG_A, OUTSIDER]
  );
  await expectCount(
    db,
    "an outsider sees only their own profile",
    "select count(*)::int as n from public.profiles",
    [],
    1
  );

  // =========================================================================
  console.log(`\n${BOLD}Alpha admin — tenancy boundary${RESET}`);
  // =========================================================================
  await asUser(db, A_ADMIN);

  // Two, not one: Alpha and Bravo are counterparties on a shipment, so each
  // can read the other's NAME. That is the grant working, not a leak — and it
  // is why isolation is tested against Delta, which shares nothing.
  await expectCount(
    db,
    "an admin sees their own organisation and the counterparty they shared with",
    "select count(*)::int as n from public.organisations",
    [],
    2
  );
  await expectCount(
    db,
    "an admin cannot read an organisation they share nothing with",
    "select count(*)::int as n from public.organisations where id = $1",
    [ORG_UNRELATED],
    0
  );
  await expectCount(
    db,
    "an admin sees every membership of their own org",
    "select count(*)::int as n from public.memberships where org_id = $1",
    [ORG_A],
    2
  );
  await expectCount(
    db,
    "an admin cannot read the other tenant's memberships",
    "select count(*)::int as n from public.memberships where org_id = $1",
    [ORG_B],
    0
  );

  // THE QUIETEST MULTI-TENANT LEAK: a row targeted legitimately, then
  // rewritten into another tenant. Caught only by `with check`.
  await expectRejected(
    db,
    "an admin cannot move a membership into another organisation",
    `update public.memberships set org_id = $1 where org_id = $2 and user_id = $3`,
    [ORG_B, ORG_A, A_OPERATOR]
  );

  await expectRejected(
    db,
    "an admin cannot create an organisation",
    `insert into public.organisations (name, slug, created_by) values ('Sneaky', 'sneaky', $1)`,
    [A_ADMIN]
  );
  await expectRejected(
    db,
    "an admin cannot suspend their own organisation",
    `update public.organisations set status = 'suspended' where id = $1`,
    [ORG_A]
  );
  await expectRejected(
    db,
    "an admin cannot promote their org to subscriber",
    `update public.organisations set is_subscriber = true where id = $1`,
    [ORG_A]
  );
  await expectRejected(
    db,
    "an admin cannot invite into another organisation",
    `insert into public.invitations (org_id, email, role, invited_by)
     values ($1, 'x@verify.test', 'admin', $2)`,
    [ORG_B, A_ADMIN]
  );
  await expectRejected(
    db,
    "an admin cannot grant themselves platform admin",
    `insert into public.platform_admins (user_id) values ($1)`,
    [A_ADMIN]
  );

  // The permitted path must still work, or the suite is only proving that
  // everything is broken.
  await expectCount(
    db,
    "an admin CAN rename their own organisation",
    `update public.organisations set name = 'Alpha Freight SA' where id = $1 returning 1 as n`,
    [ORG_A],
    1
  );
  await expectCount(
    db,
    "an admin CAN invite into their own organisation",
    `insert into public.invitations (org_id, email, role, invited_by)
     values ($1, 'newcomer@verify.test', 'operator', $2) returning 1 as n`,
    [ORG_A, A_ADMIN],
    1
  );

  // =========================================================================
  console.log(`\n${BOLD}Alpha operator — privilege within a tenant${RESET}`);
  // =========================================================================
  await asUser(db, A_OPERATOR);

  await expectCount(
    db,
    "an operator sees their organisation and its counterparty",
    "select count(*)::int as n from public.organisations",
    [],
    2
  );
  await expectCount(
    db,
    "an operator sees only their own membership row",
    "select count(*)::int as n from public.memberships",
    [],
    1
  );
  await expectCount(
    db,
    "an operator cannot read the org's invitations",
    "select count(*)::int as n from public.invitations",
    [],
    0
  );
  await expectRejected(
    db,
    "an operator cannot add a member",
    `insert into public.memberships (org_id, user_id, role) values ($1, $2, 'viewer')`,
    [ORG_A, OUTSIDER]
  );
  await expectRejected(
    db,
    "an operator cannot invite anyone",
    `insert into public.invitations (org_id, email, role, invited_by)
     values ($1, 'nope@verify.test', 'admin', $2)`,
    [ORG_A, A_OPERATOR]
  );

  // A `using` failure does not raise — the update simply matches no rows.
  // Asserting 0 rows affected is the only way to see this.
  await expectAffectsNothing(
    db,
    "an operator cannot promote themselves to admin",
    `update public.memberships set role = 'admin' where user_id = $1`,
    [A_OPERATOR]
  );

  await asUser(db, A_OPERATOR);
  await expectCount(
    db,
    "...and the operator is still an operator",
    `select count(*)::int as n from public.memberships where user_id = $1 and role = 'operator'`,
    [A_OPERATOR],
    1
  );

  // =========================================================================
  console.log(`\n${BOLD}Bravo viewer — the read-only party${RESET}`);
  // =========================================================================
  await asUser(db, B_VIEWER);

  await expectCount(
    db,
    "a viewer sees their own organisation and the one whose shipment they watch",
    "select count(*)::int as n from public.organisations",
    [],
    2
  );
  await expectCount(
    db,
    "a viewer cannot see an organisation they share nothing with",
    "select count(*)::int as n from public.organisations where id = $1",
    [ORG_UNRELATED],
    0
  );
  // A viewer holds the column privilege on `name` — that grant is role-wide,
  // not per-member — so what stops them is the UPDATE policy's `using` clause.
  // That does not raise. The statement succeeds, silently matching no rows.
  // Asserting only "it threw" would report a false failure here; asserting
  // only "0 rows" would miss a write that happened. So: both.
  await expectAffectsNothing(
    db,
    "a viewer's rename of their own organisation touches no rows",
    `update public.organisations set name = 'Renamed By Viewer' where id = $1`,
    [ORG_B]
  );

  await asUser(db, B_VIEWER);
  await expectCount(
    db,
    "...and the organisation name is unchanged",
    `select count(*)::int as n from public.organisations
     where id = $1 and name = 'Bravo Logistics'`,
    [ORG_B],
    1
  );
  await expectRejected(
    db,
    "a viewer cannot add members",
    `insert into public.memberships (org_id, user_id, role) values ($1, $2, 'viewer')`,
    [ORG_B, OUTSIDER]
  );

  // =========================================================================
  console.log(`\n${BOLD}locations and the shared gazetteer${RESET}`);
  // =========================================================================

  // The gazetteer is shared reference data: every signed-in user reads it,
  // nobody writes it. If a tenant could move a town, every other tenant's
  // route map would move with it.
  await asUser(db, A_OPERATOR);
  await expectCount(
    db,
    "a signed-in user can read the gazetteer",
    "select count(*)::int as n from public.sa_places where slug = 'johannesburg'",
    [],
    1
  );
  // `sa_places` has a SELECT policy and no write policy at all, so an UPDATE
  // matches no rows and raises nothing. The write silently evaporates — which
  // is the correct outcome, and is invisible to any check that only looks for
  // an error. Assert the town is still where it was.
  await expectAffectsNothing(
    db,
    "a tenant's attempt to move a town touches no rows",
    `update public.sa_places set latitude = -1.0 where slug = 'johannesburg'`,
    []
  );
  await asUser(db, A_OPERATOR);
  await expectCount(
    db,
    "...and Johannesburg is still in Gauteng",
    `select count(*)::int as n from public.sa_places
     where slug = 'johannesburg' and latitude between -26.3 and -26.1`,
    [],
    1
  );
  await expectRejected(
    db,
    "a tenant cannot add a place to the shared gazetteer",
    `insert into public.sa_places (slug, name, latitude, longitude, kind)
     values ('invented', 'Invented Town', -26.0, 28.0, 'town')`,
    []
  );

  await asAnon(db);
  await expectCount(
    db,
    "anon cannot read the gazetteer",
    "select count(*)::int as n from public.sa_places",
    [],
    0
  );
  await expectCount(
    db,
    "anon cannot read locations",
    "select count(*)::int as n from public.locations",
    [],
    0
  );

  // A depot's name and position is commercially sensitive — it reveals where a
  // competitor stores goods. The view must leak no more than the table.
  await asUser(db, A_ADMIN);
  await expectCount(
    db,
    "an admin sees all three of their own organisation's locations",
    "select count(*)::int as n from public.locations",
    [],
    3
  );
  await expectCount(
    db,
    "an admin cannot read the other tenant's depot",
    "select count(*)::int as n from public.locations where org_id = $1",
    [ORG_B],
    0
  );
  await expectCount(
    db,
    "location_points leaks no more than locations does",
    "select count(*)::int as n from public.location_points",
    [],
    3
  );
  await expectRejected(
    db,
    "an admin cannot create a location in another organisation",
    `insert into public.locations (org_id, name) values ($1, 'Planted Depot')`,
    [ORG_B]
  );

  // The positive path. A suite that only proves everything is forbidden would
  // pass just as well against a database nobody can write to at all.
  await asUser(db, A_OPERATOR);
  await expectCount(
    db,
    "an operator CAN log a checkpoint on their own shipment",
    `insert into public.checkpoints
       (org_id, shipment_id, sequence_no, kind, label, actual_at)
     values ($1, $2, 900, 'hub_scan', 'Operator scan', now()) returning 1 as n`,
    [ORG_A, SHIPMENT],
    1
  );
  await expectCount(
    db,
    "...and that scan updated the shipment's cleared count",
    `select count(*)::int as n from public.shipments
     where id = $1 and cleared_checkpoint_count > 0`,
    [SHIPMENT],
    1
  );

  await expectCount(
    db,
    "an operator CAN create a location",
    `insert into public.locations (org_id, name, kind)
     values ($1, 'Alpha Overflow Yard', 'yard') returning 1 as n`,
    [ORG_A],
    1
  );

  await asUser(db, B_VIEWER);
  await expectRejected(
    db,
    "a viewer cannot create a location",
    `insert into public.locations (org_id, name) values ($1, 'Viewer Depot')`,
    [ORG_B]
  );
  await expectCount(
    db,
    // Their own yard, plus the two endpoints of the shipment they watch —
    // and NOT Alpha's confidential depot, which is asserted separately below.
    "a viewer sees their own yard plus the two endpoints they watch",
    "select count(*)::int as n from public.locations",
    [],
    3
  );

  // =========================================================================
  console.log(`\n${BOLD}the party asymmetry — Bravo watching Alpha's shipment${RESET}`);
  // =========================================================================
  // This is the product. Everything here is the difference between a tool one
  // company uses alone and a platform its counterparties can watch.
  await asUser(db, B_VIEWER);

  await expectCount(
    db,
    "a party sees the shipment it was granted",
    "select count(*)::int as n from public.shipments where id = $1",
    [SHIPMENT],
    1
  );
  await expectCount(
    db,
    "a party sees NO other shipment of that organisation",
    "select count(*)::int as n from public.shipments where id = $1",
    [SHIPMENT_PRIVATE],
    0
  );
  await expectCount(
    db,
    "a party sees exactly one shipment in total",
    "select count(*)::int as n from public.shipments",
    [],
    1
  );
  // Three, not the two seeded: the operator section above logged a scan on
  // this shipment. A party sees every checkpoint of a shipment it watches —
  // the grant is per shipment, not per stage.
  await expectCount(
    db,
    "a party sees ALL of the granted shipment's checkpoints",
    "select count(*)::int as n from public.checkpoints where shipment_id = $1",
    [SHIPMENT],
    3
  );
  await expectCount(
    db,
    "a party sees no checkpoints of the unshared shipment",
    "select count(*)::int as n from public.checkpoints where shipment_id = $1",
    [SHIPMENT_PRIVATE],
    0
  );

  // A journey with unnamed endpoints is not a journey, so the endpoints must
  // be readable...
  await expectCount(
    db,
    "a party can read the granted shipment's two endpoints",
    "select count(*)::int as n from public.locations where id in ($1, $2)",
    ["cccccccc-0000-0000-0000-000000000001", A_DEST],
    2
  );
  // ...but a depot that is not on a shared shipment is a competitor's network.
  await expectCount(
    db,
    "a party CANNOT read a depot that is not on a shared shipment",
    "select count(*)::int as n from public.locations where id = $1",
    [A_SECRET],
    0
  );
  await expectCount(
    db,
    "a party can read the owning organisation's name",
    "select count(*)::int as n from public.organisations where id = $1",
    [ORG_A],
    1
  );

  // READ, NEVER WRITE. Every one of these must be refused.
  await expectRejected(
    db,
    "a party cannot log a checkpoint on a shipment it only watches",
    `insert into public.checkpoints (org_id, shipment_id, sequence_no, kind, label, actual_at)
     values ($1, $2, 300, 'delivery', 'Marked delivered by the consignee', now())`,
    [ORG_A, SHIPMENT]
  );
  await expectAffectsNothing(
    db,
    "a party's edit of a watched checkpoint touches no rows",
    `update public.checkpoints set actual_at = now() where shipment_id = $1 and sequence_no = 200`,
    [SHIPMENT]
  );
  await asUser(db, B_VIEWER);
  await expectCount(
    db,
    "...and that checkpoint is still pending",
    `select count(*)::int as n from public.checkpoints
     where shipment_id = $1 and sequence_no = 200 and actual_at is null`,
    [SHIPMENT],
    1
  );
  await expectAffectsNothing(
    db,
    "a party's edit of the watched shipment touches no rows",
    `update public.shipments set reference = 'HIJACKED' where id = $1`,
    [SHIPMENT]
  );
  await expectRejected(
    db,
    "a party cannot grant anyone else access to a shipment it watches",
    `insert into public.shipment_parties (org_id, shipment_id, party_org_id, party_role, granted_by)
     values ($1, $2, $3, 'broker', $4)`,
    [ORG_A, SHIPMENT, ORG_B, B_VIEWER]
  );

  // Even Bravo's own admin — an admin in their own org — is only a viewer here.
  await asUser(db, B_ADMIN);
  await expectAffectsNothing(
    db,
    "even the party org's admin cannot edit the watched shipment",
    `update public.shipments set reference = 'HIJACKED' where id = $1`,
    [SHIPMENT]
  );

  // =========================================================================
  console.log(`\n${BOLD}collaboration — the party write exception${RESET}`);
  // =========================================================================
  // PLACED BEFORE THE REVOCATION BLOCK ON PURPOSE. Everything after that block
  // sees a revoked grant, so a party-side assertion down there would read zero
  // rows because the grant is gone rather than because a policy refused —
  // green for entirely the wrong reason.

  // Captured BEFORE the party writes anything. The guarantee is that a
  // message does not CHANGE this value — not that it is old, which it is not:
  // an operator logged a scan earlier in this run and legitimately set it.
  await asOwner(db);
  const silenceBefore = (
    await db.query("select last_event_at from public.shipments where id = $1", [SHIPMENT])
  ).rows[0]?.last_event_at ?? null;

  // The positive case first: a suite that only proves things are forbidden
  // passes just as well against a feature that does not work at all.
  await asUser(db, B_VIEWER);
  await expectCount(
    db,
    "a party CAN message the carrier about a shipment it watches",
    `insert into public.messages
       (org_id, shipment_id, counterparty_org_id, sender_org_id, sender_user_id, body)
     values ($1, $2, $3, $3, $4, 'Please confirm the delivery ETA.') returning 1 as n`,
    [ORG_A, SHIPMENT, ORG_B, B_VIEWER],
    1
  );

  // The forged-sender case: a party's message appearing to come from the
  // carrier's own staff, inside the carrier's interface. A trust leak rather
  // than a data leak, and the worst thing this feature could do.
  await expectRejected(
    db,
    "a party cannot send a message as the carrier",
    `insert into public.messages
       (org_id, shipment_id, counterparty_org_id, sender_org_id, sender_user_id, body)
     values ($1, $2, $3, $1, $4, 'Delivered, no issues.')`,
    [ORG_A, SHIPMENT, ORG_B, B_VIEWER]
  );

  await expectRejected(
    db,
    "a party cannot send a message as another user",
    `insert into public.messages
       (org_id, shipment_id, counterparty_org_id, sender_org_id, sender_user_id, body)
     values ($1, $2, $3, $3, $4, 'Sent as my colleague.')`,
    [ORG_A, SHIPMENT, ORG_B, B_ADMIN]
  );

  await expectRejected(
    db,
    "a party cannot broadcast into the carrier's internal stream",
    `insert into public.messages (org_id, sender_org_id, sender_user_id, body)
     values ($1, $2, $3, 'Everyone please read this.')`,
    [ORG_A, ORG_B, B_VIEWER]
  );

  await expectRejected(
    db,
    "a party cannot message about a shipment it was never granted",
    `insert into public.messages
       (org_id, shipment_id, counterparty_org_id, sender_org_id, sender_user_id, body)
     values ($1, $2, $3, $3, $4, 'What about this one?')`,
    [ORG_A, SHIPMENT_PRIVATE, ORG_B, B_VIEWER]
  );

  // The oversight record stays read-only. Messaging must not have widened the
  // asymmetry that is the product.
  await expectRejected(
    db,
    "a party still cannot log a checkpoint",
    `insert into public.checkpoints (org_id, shipment_id, sequence_no, kind, label, actual_at)
     values ($1, $2, 950, 'delivery', 'Marked delivered by the consignee', now())`,
    [ORG_A, SHIPMENT]
  );

  // THE QUIET ONE. If a message touched last_event_at, a chatty consignee
  // would silence the carrier's own "no updates" alarm simply by talking.
  await asOwner(db);
  await expectCount(
    db,
    "a party's message does not reset the carrier's silence alarm",
    `select count(*)::int as n from public.shipments
     where id = $1 and last_event_at is not distinct from $2::timestamptz`,
    [SHIPMENT, silenceBefore],
    1
  );
  await asUser(db, A_ADMIN);

  await expectCount(
    db,
    "the carrier CAN reply to the party",
    `insert into public.messages
       (org_id, shipment_id, counterparty_org_id, sender_org_id, sender_user_id, body)
     values ($1, $2, $3, $1, $4, 'On the N3, arriving tomorrow.') returning 1 as n`,
    [ORG_A, SHIPMENT, ORG_B, A_ADMIN],
    1
  );

  // A THIRD organisation on the same shipment must not read the exchange.
  // This is the case a plain "shared" visibility flag fails silently.
  await expectCount(
    db,
    "the carrier can grant a third organisation visibility",
    `insert into public.shipment_parties
       (org_id, shipment_id, party_org_id, party_role, granted_by)
     values ($1, $2, $3, 'broker', $4) returning 1 as n`,
    [ORG_A, SHIPMENT, ORG_UNRELATED, A_ADMIN],
    1
  );

  await asUser(db, D_ADMIN);
  await expectCount(
    db,
    "a broker on the shipment sees it",
    "select count(*)::int as n from public.shipments where id = $1",
    [SHIPMENT],
    1
  );
  await expectCount(
    db,
    "...but CANNOT read the carrier's conversation with the consignee",
    "select count(*)::int as n from public.messages",
    [],
    0
  );
  await expectRejected(
    db,
    "a party without messaging enabled cannot send",
    `insert into public.messages
       (org_id, shipment_id, counterparty_org_id, sender_org_id, sender_user_id, body)
     values ($1, $2, $3, $3, $4, 'Can I join in?')`,
    [ORG_A, SHIPMENT, ORG_UNRELATED, D_ADMIN]
  );

  // Announcements and tasks are internal. A party sees neither.
  await asUser(db, B_VIEWER);
  await expectCount(
    db,
    "a party sees no announcements",
    "select count(*)::int as n from public.announcements",
    [],
    0
  );
  await expectCount(
    db,
    "a party sees no tasks",
    "select count(*)::int as n from public.tasks",
    [],
    0
  );

  await asUser(db, A_OPERATOR);
  await expectRejected(
    db,
    "an operator cannot post a company announcement",
    `insert into public.announcements (org_id, title, body, posted_by)
     values ($1, 'Unauthorised notice', 'Body', $2)`,
    [ORG_A, A_OPERATOR]
  );
  await expectCount(
    db,
    "an operator CAN create a task",
    `insert into public.tasks (org_id, title, assigned_by, created_by)
     values ($1, 'Check the Durban POD', $2, $2) returning 1 as n`,
    [ORG_A, A_OPERATOR],
    1
  );
  await expectRejected(
    db,
    "an operator cannot assign a task outside the organisation",
    `insert into public.tasks (org_id, title, assigned_to, assigned_by, created_by)
     values ($1, 'Not their problem', $2, $3, $3)`,
    [ORG_A, B_VIEWER, A_OPERATOR]
  );

  // The platform owner runs the platform; they have no business reading their
  // customers' correspondence.
  await asUser(db, OWNER);
  await expectCount(
    db,
    "even the platform owner cannot read customer messages",
    "select count(*)::int as n from public.messages",
    [],
    0
  );
  await expectCount(
    db,
    "even the platform owner cannot read a customer's announcements",
    "select count(*)::int as n from public.announcements",
    [],
    0
  );

  await asAnon(db);
  for (const table of ["announcements", "messages", "message_reads", "tasks"]) {
    await expectCount(
      db,
      `anon reads nothing from ${table}`,
      `select count(*)::int as n from public.${table}`,
      [],
      0
    );
  }

  // =========================================================================
  console.log(
    `
${BOLD}the fleet — drivers and vehicles${RESET}`
  );
  // =========================================================================
  // 0011 turned two text fields into tables. They hold a person's phone
  // number and licence, so who can read them matters more than who could
  // read a string on a shipment.
  await asUser(db, A_OPERATOR);

  await expectCount(
    db,
    "an operator CAN add a driver",
    `insert into public.drivers (org_id, full_name, phone)
     values ($1, 'Lerato Dube', '+27 82 000 0000') returning 1 as n`,
    [ORG_A],
    1
  );
  await expectCount(
    db,
    "an operator CAN add a vehicle",
    `insert into public.vehicles (org_id, registration, vehicle_type)
     values ($1, 'ND 987-654', 'rigid') returning 1 as n`,
    [ORG_A],
    1
  );
  await expectRejected(
    db,
    "an operator cannot add a driver to another organisation",
    `insert into public.drivers (org_id, full_name) values ($1, 'Planted')`,
    [ORG_B]
  );

  await asUser(db, A_ADMIN);
  await expectCount(
    db,
    "an admin sees their organisation's fleet",
    "select count(*)::int as n from public.drivers",
    [],
    1
  );

  // THE ONE THAT MATTERS. A consignee watching a load has no business
  // holding the carrier's staff list, their phone numbers or their licences.
  // The shipment carries `driver_name` for display; this table is the
  // employer's record.
  await asUser(db, B_VIEWER);
  await expectCount(
    db,
    "a party organisation sees NONE of the carrier's drivers",
    "select count(*)::int as n from public.drivers",
    [],
    0
  );
  await expectCount(
    db,
    "...and none of its vehicles",
    "select count(*)::int as n from public.vehicles",
    [],
    0
  );
  await expectRejected(
    db,
    "a viewer cannot add a driver to their own organisation either",
    `insert into public.drivers (org_id, full_name) values ($1, 'Viewer Driver')`,
    [ORG_B]
  );

  await asUser(db, OUTSIDER);
  await expectCount(
    db,
    "somebody in no organisation sees no fleet at all",
    "select count(*)::int as n from public.drivers",
    [],
    0
  );

  await asAnon(db);
  for (const table of ["drivers", "vehicles"]) {
    await expectCount(
      db,
      `anon reads nothing from ${table}`,
      `select count(*)::int as n from public.${table}`,
      [],
      0
    );
  }

  // Archive, not delete — and the archived row stays readable to its own
  // organisation, because the shipments it drove still name it.
  await asUser(db, A_ADMIN);
  await expectCount(
    db,
    "an admin can archive a driver",
    `update public.drivers set archived_at = now()
     where org_id = $1 and full_name = 'Lerato Dube' returning 1 as n`,
    [ORG_A],
    1
  );
  await expectCount(
    db,
    "...and the row is still theirs to read",
    "select count(*)::int as n from public.drivers where archived_at is not null",
    [],
    1
  );

  // =========================================================================
  console.log(`
${BOLD}counterparty lookup — the first grant${RESET}`);
  // =========================================================================
  // 0009 exists because granting a NEW customer visibility was impossible:
  // you need the organisation's id to make the grant, and the grant is what
  // would let you read the id. The function breaks that circle, and these
  // scenarios are what keep it from becoming a tenant directory.
  await asUser(db, A_ADMIN);

  await expectCount(
    db,
    "an admin can resolve an exact counterparty slug",
    "select count(*)::int as n from public.find_organisation_by_slug('echo-cartage')",
    [],
    1
  );
  await expectCount(
    db,
    "...and gets nothing for a slug that does not exist",
    "select count(*)::int as n from public.find_organisation_by_slug('no-such-company')",
    [],
    0
  );
  // Exact match only. Prefix matching would turn this into the directory the
  // policy in 0005 deliberately refuses to be.
  await expectCount(
    db,
    "a partial slug matches nothing — this is a lookup, not a search",
    "select count(*)::int as n from public.find_organisation_by_slug('echo')",
    [],
    0
  );
  await expectCount(
    db,
    "the lookup returns a name and a slug, and no other column",
    `select count(*)::int as n from public.find_organisation_by_slug('echo-cartage')
     where name = 'Echo Cartage' and slug = 'echo-cartage'`,
    [],
    1
  );
  // The organisation it just resolved is still NOT readable through the
  // table. The lookup is a narrow exception, not a widening of the policy.
  await expectCount(
    db,
    "...while the organisations table still hides that tenant",
    "select count(*)::int as n from public.organisations where id = $1",
    [ORG_STRANGER],
    0
  );

  await asUser(db, A_OPERATOR);
  await expectRejected(
    db,
    "an operator cannot look up a counterparty at all",
    "select * from public.find_organisation_by_slug('echo-cartage')",
    []
  );

  await asUser(db, B_VIEWER);
  await expectRejected(
    db,
    "a viewer cannot either",
    "select * from public.find_organisation_by_slug('echo-cartage')",
    []
  );

  await asAnon(db);
  await expectRejected(
    db,
    "anon cannot execute the lookup",
    "select * from public.find_organisation_by_slug('echo-cartage')",
    []
  );

  // =========================================================================
  console.log(`\n${BOLD}assignment — the operator sees one load, not the book${RESET}`);
  // =========================================================================
  // 0008 is the only migration that TAKES access away, and it can be wrong in
  // two directions. Too wide and an operator still sees the whole business;
  // too narrow and they cannot log the checkpoint they were hired to log.
  // Both directions are asserted here, and nowhere else in the repository.
  await asUser(db, A_OPERATOR);

  await expectCount(
    db,
    "an operator sees the shipment they are assigned to",
    "select count(*)::int as n from public.shipments where id = $1",
    [SHIPMENT],
    1
  );
  await expectCount(
    db,
    "an operator does NOT see an unassigned shipment in their own organisation",
    "select count(*)::int as n from public.shipments where id = $1",
    [SHIPMENT_PRIVATE],
    0
  );
  await expectCount(
    db,
    "an operator sees exactly one shipment in total",
    "select count(*)::int as n from public.shipments",
    [],
    1
  );
  await expectCount(
    db,
    "an operator sees no checkpoint of an unassigned shipment",
    "select count(*)::int as n from public.checkpoints where shipment_id = $1",
    [SHIPMENT_PRIVATE],
    0
  );

  // The other direction. An operator who cannot name their own depots cannot
  // log a pickup, so `locations` is deliberately NOT narrowed.
  await expectCount(
    db,
    "an operator still reads their organisation's locations",
    "select count(*)::int as n from public.locations where org_id = $1",
    [ORG_A],
    // Three seeded, plus the overflow yard the operator created earlier.
    4
  );
  await expectCount(
    db,
    "an operator still reads the shared gazetteer",
    "select count(*)::int as n from public.sa_places where slug = 'durban'",
    [],
    1
  );

  // An invisible edit is worse than a visible read. A narrowing that stops at
  // SELECT would leave exactly that.
  await expectAffectsNothing(
    db,
    "an operator cannot edit an unassigned shipment",
    `update public.shipments set goods_description = 'tampered' where id = $1`,
    [SHIPMENT_PRIVATE]
  );
  await expectRejected(
    db,
    "an operator cannot log a checkpoint on an unassigned shipment",
    `insert into public.checkpoints (org_id, shipment_id, sequence_no, kind, label, actual_at)
     values ($1, $2, 950, 'hub_scan', 'Planted scan', now())`,
    [ORG_A, SHIPMENT_PRIVATE]
  );

  // Assignment is granted, never taken. An operator who could assign
  // themselves would make the whole restriction voluntary.
  await expectRejected(
    db,
    "an operator cannot assign themselves to a shipment",
    `insert into public.shipment_assignments (org_id, shipment_id, user_id, assigned_by)
     values ($1, $2, $3, $3)`,
    [ORG_A, SHIPMENT_PRIVATE, A_OPERATOR]
  );
  await expectCount(
    db,
    "an operator sees who else is on their own load",
    "select count(*)::int as n from public.shipment_assignments where shipment_id = $1",
    [SHIPMENT],
    1
  );
  await expectCount(
    db,
    "an operator sees no assignment on a shipment they are not on",
    "select count(*)::int as n from public.shipment_assignments where shipment_id = $1",
    [SHIPMENT_PRIVATE],
    0
  );

  // The admin keeps the whole operation, which is the other half of the rule.
  await asUser(db, A_ADMIN);
  await expectCount(
    db,
    "an admin sees every shipment their organisation owns, assigned or not",
    "select count(*)::int as n from public.shipments",
    [],
    2
  );
  await expectCount(
    db,
    "an admin CAN edit an unassigned shipment",
    `update public.shipments set goods_description = 'Admin edit'
     where id = $1 returning 1 as n`,
    [SHIPMENT_PRIVATE],
    1
  );

  // A party's view is unchanged by any of this: a grant is a grant.
  await asUser(db, B_VIEWER);
  await expectCount(
    db,
    "a party still sees only the shipment it was granted",
    "select count(*)::int as n from public.shipments",
    [],
    1
  );
  await expectCount(
    db,
    "a party cannot see who inside the carrier is working the load",
    "select count(*)::int as n from public.shipment_assignments",
    [],
    0
  );

  // UNASSIGNMENT MUST BITE ON THE NEXT QUERY, for the same reason revocation
  // must: a product that says "access removed" and means "in an hour" is
  // selling a promise it does not keep.
  await asUser(db, A_ADMIN);

  // A SECOND PERSON ON THE LOAD FIRST. 0012 added
  // `shipment_assignments_guard_coverage`, which refuses to let an ACTIVE
  // shipment lose its last operator — going quiet with nobody watching is the
  // exact failure this product exists to prevent. So the withdrawal below is
  // only legal once somebody else is on it, and the admin puts themselves on.
  //
  // That the guard bites here is the point: this block passed before 0012 and
  // now needs setting up properly, which is a guard doing its job rather than
  // a test needing a workaround.
  await expectCount(
    db,
    "an admin can put a second person on a load",
    `insert into public.shipment_assignments (org_id, shipment_id, user_id, assigned_by)
     values ($1, $2, $3, $3) returning 1 as n`,
    [ORG_A, SHIPMENT, A_ADMIN],
    1
  );
  await expectCount(
    db,
    "an admin can take an operator off a shipment",
    `update public.shipment_assignments set unassigned_at = now()
     where shipment_id = $1 and user_id = $2 returning 1 as n`,
    [SHIPMENT, A_OPERATOR],
    1
  );
  await expectRejected(
    db,
    "...but not the last one left on it",
    `update public.shipment_assignments set unassigned_at = now()
     where shipment_id = $1 and user_id = $2`,
    [SHIPMENT, A_ADMIN]
  );

  await asUser(db, A_OPERATOR);
  await expectCount(
    db,
    "unassignment removes the operator's access on the very next query",
    "select count(*)::int as n from public.shipments",
    [],
    0
  );
  await expectRejected(
    db,
    "...and they can no longer log a checkpoint on it either",
    `insert into public.checkpoints (org_id, shipment_id, sequence_no, kind, label, actual_at)
     values ($1, $2, 960, 'hub_scan', 'After unassignment', now())`,
    [ORG_A, SHIPMENT]
  );

  // Put them back: the scenarios after this one read the board as a member of
  // Alpha, and an operator with no shipments would make them vacuously true.
  await asUser(db, A_ADMIN);
  await expectCount(
    db,
    "an admin can put an operator back on, as a second spell",
    `insert into public.shipment_assignments (org_id, shipment_id, user_id, assigned_by)
     values ($1, $2, $3, $4) returning 1 as n`,
    [ORG_A, SHIPMENT, A_OPERATOR, A_ADMIN],
    1
  );


  // =========================================================================
  console.log(`\n${BOLD}the audit trail — readable, never writable${RESET}`);
  // =========================================================================
  // Every scenario above this line has been writing `decision_logs` as a side
  // effect, so by now the table is full of real lines made by real policy
  // changes rather than by fixtures written to please the test.
  //
  // Two separate claims here, and only this suite can check either one. That
  // the trail is SCOPED — an audit log is a second copy of the operation, so
  // a leak here leaks everything at once, including the loads whose rows the
  // reader was never allowed to see. And that it is APPEND-ONLY from the
  // application: the triggers write it, nobody edits it, not even an admin.

  await asUser(db, A_ADMIN);
  await expectCount(
    db,
    "an admin can read their own organisation's history",
    `select (count(*) > 0)::int as n from public.decision_logs
     where org_id = $1`,
    [ORG_A],
    1
  );

  // The trail is a second copy of the operation, so it gets the same boundary.
  await asUser(db, B_ADMIN);
  await expectCount(
    db,
    "another tenant's admin sees none of it",
    "select count(*)::int as n from public.decision_logs where org_id = $1",
    [ORG_A],
    0
  );
  // AND IT NARROWS WITH THE SHIPMENTS. This is the part that would be easy to
  // get wrong: scoping the trail by `is_org_member(org_id)` alone would hand
  // every operator the history of every load in the business — the whole of
  // 0008 undone through a table nobody thinks of as shipment data.
  await asUser(db, A_OPERATOR);
  await expectCount(
    db,
    "an operator reads the history of the load they are on",
    `select (count(*) > 0)::int as n from public.decision_logs
     where shipment_id = $1`,
    [SHIPMENT],
    1
  );
  await expectCount(
    db,
    "...and none of the history of a load they are not on",
    "select count(*)::int as n from public.decision_logs where shipment_id = $1",
    [SHIPMENT_PRIVATE],
    0
  );

  // APPEND-ONLY, FROM EVERY ROLE. There is no insert, update or delete policy
  // on this table at all, which is why an admin is the interesting case: the
  // person most able to want a line gone is the one who must not be able to
  // remove it.
  await asUser(db, A_ADMIN);
  await expectRejected(
    db,
    "an admin cannot forge a line in the trail",
    `insert into public.decision_logs
       (org_id, action, subject_table, subject_id, shipment_id)
     values ($1, 'shipment_delivered', 'shipments', $2, $2)`,
    [ORG_A, SHIPMENT]
  );
  await expectAffectsNothing(
    db,
    "an admin cannot rewrite a line in the trail",
    `update public.decision_logs set reason = 'Looked fine to me'
     where org_id = $1`,
    [ORG_A]
  );
  await expectAffectsNothing(
    db,
    "an admin cannot delete a line from the trail",
    "delete from public.decision_logs where org_id = $1",
    [ORG_A]
  );

  // The writer is reachable only from inside the triggers. Were `execute`
  // left on `authenticated`, the whole append-only property would be
  // decoration: anybody could call the definer function and stamp the trail
  // with any action, against any shipment, in any organisation.
  await expectRejected(
    db,
    "...nor reach the writer directly to do it",
    `select public.write_decision_log(
       $1, 'shipment_delivered'::public.decision_action, 'shipments', $2, $2,
       null::jsonb, null::text)`,
    [ORG_A, SHIPMENT]
  );

  await asAnon(db);
  await expectCount(
    db,
    "anon sees no history at all",
    "select count(*)::int as n from public.decision_logs",
    [],
    0
  );
  await asUser(db, OUTSIDER);
  await expectCount(
    db,
    "a signed-in outsider sees no history at all",
    "select count(*)::int as n from public.decision_logs",
    [],
    0
  );

  // REVOCATION MUST BITE IMMEDIATELY. A visibility product whose "access
  // removed" takes an hour to take effect is selling a promise it does not
  // keep — this is the reason the schema uses a security-definer predicate
  // rather than org ids baked into a JWT.
  await asUser(db, A_ADMIN);
  await expectCount(
    db,
    "the owner can revoke a grant",
    `update public.shipment_parties set revoked_at = now(), revoked_by = $1
     where shipment_id = $2 and party_org_id = $3 returning 1 as n`,
    [A_ADMIN, SHIPMENT, ORG_B],
    1
  );

  await asUser(db, B_VIEWER);
  await expectCount(
    db,
    "revocation removes the party's access on the very next query",
    "select count(*)::int as n from public.shipments where id = $1",
    [SHIPMENT],
    0
  );
  await expectCount(
    db,
    "revocation removes the checkpoints too",
    "select count(*)::int as n from public.checkpoints where shipment_id = $1",
    [SHIPMENT],
    0
  );
  await expectCount(
    db,
    "revocation removes the endpoints too",
    "select count(*)::int as n from public.locations where org_id = $1",
    [ORG_A],
    0
  );
  await expectCount(
    db,
    "revocation removes the conversation",
    "select count(*)::int as n from public.messages",
    [],
    0
  );
  await expectRejected(
    db,
    "revocation closes the write channel on the very next statement",
    `insert into public.messages
       (org_id, shipment_id, counterparty_org_id, sender_org_id, sender_user_id, body)
     values ($1, $2, $3, $3, $4, 'Still there?')`,
    [ORG_A, SHIPMENT, ORG_B, B_VIEWER]
  );

  // An outsider was never party to anything.
  await asUser(db, OUTSIDER);
  await expectCount(
    db,
    "an outsider sees no shipments at all",
    "select count(*)::int as n from public.shipments",
    [],
    0
  );
  await asAnon(db);
  await expectCount(
    db,
    "anon sees no shipments at all",
    "select count(*)::int as n from public.shipments",
    [],
    0
  );
  await expectCount(
    db,
    "anon sees no checkpoints at all",
    "select count(*)::int as n from public.checkpoints",
    [],
    0
  );

  // =========================================================================
  console.log(`\n${BOLD}platform owner${RESET}`);
  // =========================================================================
  await asUser(db, OWNER);

  await expectCount(
    db,
    "the platform owner sees every organisation",
    "select count(*)::int as n from public.organisations",
    [],
    4
  );
  await expectCount(
    db,
    "the platform owner CAN provision an organisation",
    `insert into public.organisations (name, slug, created_by)
     values ('Charlie Carriers', 'charlie-carriers', $1) returning 1 as n`,
    [OWNER],
    1
  );

  // Even the owner cannot write this table from the application. There is no
  // write policy on it at all, deliberately.
  await expectRejected(
    db,
    "even the platform owner cannot add a platform admin through the app",
    `insert into public.platform_admins (user_id) values ($1)`,
    [A_ADMIN]
  );

  // =========================================================================
  // Deleting a tenant. `organisations_delete_platform` has existed since 0001
  // and was UNUSABLE until 0010: the cascade into `memberships` tripped
  // `memberships_guard_last_admin`, which asked whether the organisation
  // would be left without an admin while the organisation itself was being
  // deleted. Every tenant has an admin, so every delete failed.
  await expectCount(
    db,
    "the platform owner can create a disposable organisation",
    `insert into public.organisations (name, slug, is_subscriber, created_by)
     values ('Disposable Freight', 'disposable-freight', true, $1)
     returning 1 as n`,
    [OWNER],
    1
  );
  await expectCount(
    db,
    "...put somebody in it as its admin",
    `insert into public.memberships (org_id, user_id, role)
     select id, $1, 'admin' from public.organisations
     where slug = 'disposable-freight' returning 1 as n`,
    [OUTSIDER],
    1
  );
  await expectCount(
    db,
    "...and delete it, admin and all",
    `delete from public.organisations where slug = 'disposable-freight'
     returning 1 as n`,
    [],
    1
  );
  await expectCount(
    db,
    "...which took the membership with it",
    "select count(*)::int as n from public.memberships where user_id = $1",
    [OUTSIDER],
    0
  );

  // The rule the guard exists for is untouched: an organisation that STAYS
  // cannot lose its last admin.
  await asUser(db, A_ADMIN);
  await expectRejected(
    db,
    "an admin still cannot remove themselves as the last admin",
    `delete from public.memberships where org_id = $1 and user_id = $2`,
    [ORG_A, A_ADMIN]
  );


  await asOwner(db);
}

async function main() {
  const db = new PGlite();
  await db.waitReady;

  console.log(`${DIM}Reproducing the Supabase authorisation model in-process${RESET}`);
  await db.exec(await readFile(path.join(DIR, "verify-stubs.sql"), "utf8"));

  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    await db.exec(await readFile(path.join(MIGRATIONS, file), "utf8"));
  }
  console.log(`${DIM}${files.length} migration(s) applied${RESET}`);

  await seed(db);

  await run(db);

  await db.close();

  console.log("");
  if (failures.length > 0) {
    console.log(`${RED}${BOLD}${failures.length} RLS check(s) FAILED${RESET} ${DIM}(${passed} passed)${RESET}`);
    for (const { label, detail } of failures) {
      console.log(`  ${RED}•${RESET} ${label}${detail ? ` ${DIM}— ${detail}${RESET}` : ""}`);
    }
    console.log(
      `\n${YELLOW}A failure here is a data leak between tenants, or a privilege a role should not hold.${RESET}`
    );
    process.exit(1);
  }

  console.log(`${GREEN}Row-level security verified — ${passed} checks passed.${RESET}`);
  console.log(
    `${DIM}Reproduces Supabase's roles, grants and auth.uid(). Re-run against the real\nproject with real users before the first paying customer.${RESET}`
  );
}

main().catch((error) => {
  console.error(`\n${RED}${error?.stack ?? error}${RESET}\n`);
  process.exit(1);
});
