#!/usr/bin/env node
//
// Proves that ONE migration applies to a database that is already live.
//
//   npm run verify:upgrade 0008
//
// WHY THIS IS A DIFFERENT QUESTION FROM `verify:migrations`. That command
// builds the whole schema from nothing and asserts what the DDL claims, which
// proves the migration is valid. It says nothing about whether the migration
// applies to a database that is already at the previous number AND ALREADY HAS
// ROWS IN IT — which is the only question that matters the moment a project is
// live, and the one that is asked at the worst possible time: in a SQL editor,
// pointed at production, by somebody pasting.
//
// So this applies every earlier migration, puts data in, and then runs
// `apply-NNNN.sql` byte for byte as it will be pasted. It then re-runs it, to
// show that a second paste is refused cleanly rather than leaving the database
// between two shapes.
//
// Like the other verifiers it runs on PGlite — real Postgres compiled to
// WebAssembly, in this process. No server, no port, no credentials, and
// nothing that can possibly touch the real project.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";

const DIR = import.meta.dirname;
const MIGRATIONS = path.join(DIR, "migrations");

const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

const requested = process.argv.slice(2);
if (requested.length === 0 || requested.some((n) => !/^\d{4}$/.test(n))) {
  console.error("usage: npm run verify:upgrade 0008 [0009 ...]");
  process.exit(2);
}

const numbers = [...new Set(requested)].sort();
const first = numbers[0];
const label = numbers.length === 1 ? first : `${first}-${numbers.at(-1)}`;

/**
 * Checks that hold for EVERY upgrade, whatever the migration does.
 *
 * Deliberately not specific to 0008: a per-migration assertion belongs in
 * `verify-behaviour-N-*.sql`, which runs on every change. What belongs here is
 * the handful of properties whose violation would mean the paste itself was
 * unsafe — data gone, RLS off, a table left with no way to read it.
 */
const INVARIANTS = [
  [
    "every table in public still has row-level security enabled",
    `select count(*)::int as n from pg_tables
      where schemaname = 'public' and not rowsecurity`,
    0,
  ],
  [
    // A table with rows and no SELECT policy fails closed rather than leaking,
    // so it is not a breach — it is the product going dark, which is worse to
    // discover from a customer than from here.
    "every table in public still has a way to read it",
    `select count(*)::int as n from pg_tables t
      where t.schemaname = 'public'
        and not exists (
          select 1 from pg_policies p
          where p.schemaname = 'public' and p.tablename = t.tablename
            and p.cmd in ('SELECT', 'ALL')
        )`,
    0,
  ],
  [
    "every UPDATE policy still carries both using and with check",
    `select count(*)::int as n from pg_policies
      where schemaname = 'public' and cmd = 'UPDATE'
        and (qual is null or with_check is null)`,
    0,
  ],
  [
    "the shipment recorded before the upgrade is still there",
    `select count(*)::int as n from public.shipments where reference = 'UPGRADE-0001'`,
    1,
  ],
  [
    "its checkpoint is still there",
    `select count(*)::int as n from public.checkpoints`,
    1,
  ],
];

/** Enough of a live database to notice a migration that loses data. */
const DATA = `
  insert into auth.users (id, email) values
    ('11111111-1111-1111-1111-111111111111', 'owner@upgrade.test'),
    ('33333333-3333-3333-3333-333333333333', 'operator@upgrade.test');

  insert into public.platform_admins (user_id)
  values ('11111111-1111-1111-1111-111111111111');

  insert into public.organisations (id, name, slug, is_subscriber, created_by)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'Upgrade Logistics',
          'upgrade-logistics', true, '11111111-1111-1111-1111-111111111111');

  insert into public.memberships (org_id, user_id, role) values
    ('aaaaaaaa-0000-0000-0000-000000000001',
     '11111111-1111-1111-1111-111111111111', 'admin'),
    ('aaaaaaaa-0000-0000-0000-000000000001',
     '33333333-3333-3333-3333-333333333333', 'operator');

  insert into public.locations (id, org_id, name, kind, sa_place_id)
  select 'cccccccc-0000-0000-0000-000000000001',
         'aaaaaaaa-0000-0000-0000-000000000001', 'Depot', 'depot', id
  from public.sa_places where slug = 'johannesburg';

  insert into public.locations (id, org_id, name, kind, sa_place_id)
  select 'cccccccc-0000-0000-0000-000000000002',
         'aaaaaaaa-0000-0000-0000-000000000001', 'Consignee', 'customer_site', id
  from public.sa_places where slug = 'durban';

  insert into public.shipments
    (org_id, reference, origin_location_id, destination_location_id, created_by)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'UPGRADE-0001',
          'cccccccc-0000-0000-0000-000000000001',
          'cccccccc-0000-0000-0000-000000000002',
          '11111111-1111-1111-1111-111111111111');

  insert into public.checkpoints
    (org_id, shipment_id, sequence_no, kind, label, actual_at)
  select 'aaaaaaaa-0000-0000-0000-000000000001', id, 100, 'pickup', 'Collected', now()
  from public.shipments where reference = 'UPGRADE-0001';
`;


/**
 * Everything about the schema that a migration could change, as one string.
 *
 * Tables, their RLS flag, every policy with both of its clauses, and every
 * function with its definer flag and pinned search_path. Comparing this
 * before and after a second paste answers the only question that matters —
 * "is the database the same?" — without caring whether the second attempt
 * errored or was simply idempotent.
 */
/** The first line of a multi-line Postgres error — the part worth printing. */
function firstLine(message) {
  // No regex literal here on purpose: this file is generated by a script,
  // and an escaped newline inside one is a syntax error that only shows up
  // at parse time.
  return String(message).split(String.fromCharCode(10))[0];
}

async function fingerprint(db) {
  const { rows } = await db.query(`
    select string_agg(line, E'\n' order by line) as f from (
      select 'table:' || tablename || ':' || rowsecurity::text as line
      from pg_tables where schemaname = 'public'
      union all
      select 'policy:' || tablename || ':' || policyname || ':' || cmd || ':'
             || coalesce(qual, '') || ':' || coalesce(with_check, '')
      from pg_policies where schemaname = 'public'
      union all
      select 'function:' || p.proname || ':' || p.prosecdef::text || ':'
             || coalesce(array_to_string(p.proconfig, ','), '')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
    ) parts
  `);
  return rows[0].f ?? "";
}

async function main() {
  const bundle = path.join(DIR, `apply-${label}.sql`);
  let paste;
  try {
    paste = await readFile(bundle, "utf8");
  } catch {
    console.error(
      `${RED}No ${path.basename(bundle)}. Generate it with:${RESET}\n` +
        `  bash supabase/bundle-migration.sh ${numbers.join(" ")}`
    );
    process.exit(1);
  }

  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  const earlier = files.filter((f) => f.slice(0, 4) < first);
  for (const number of numbers) {
    if (!files.some((f) => f.startsWith(`${number}_`))) {
      console.error(`${RED}No migration ${number}_*.sql${RESET}`);
      process.exit(1);
    }
  }
  if (earlier.length === 0) {
    console.error(
      `${RED}${first} is the first migration — there is no live state to upgrade from.${RESET}`
    );
    process.exit(1);
  }

  const db = new PGlite();
  await db.exec(await readFile(path.join(DIR, "verify-stubs.sql"), "utf8"));

  console.log(`${BOLD}Baseline — the schema as the live project has it${RESET}`);
  for (const file of earlier) {
    await db.exec(await readFile(path.join(MIGRATIONS, file), "utf8"));
    console.log(`  ${DIM}applied ${file}${RESET}`);
  }

  await db.exec(DATA);
  console.log(`  ${DIM}inserted an organisation, a shipment and a checkpoint${RESET}`);

  console.log(`
${BOLD}The paste — apply-${label}.sql, byte for byte${RESET}`);
  try {
    await db.exec(paste);
  } catch (error) {
    console.log(`  ${RED}REFUSED: ${String(error.message).split("\n")[0]}${RESET}`);
    console.log(
      `\n${RED}This paste would fail against the live project.${RESET}`
    );
    process.exit(1);
  }
  console.log(`  ${GREEN}applied${RESET}`);

  let failures = 0;
  for (const [label, sql, expected] of INVARIANTS) {
    const { rows } = await db.query(sql);
    const got = rows[0].n;
    if (got === expected) {
      console.log(`  ${GREEN}ok${RESET} ${label}`);
    } else {
      failures += 1;
      console.log(`  ${RED}FAIL${RESET} ${label} ${DIM}(expected ${expected}, got ${got})${RESET}`);
    }
  }

  // SOMEBODY WILL PASTE IT TWICE — the editor is slow, the tab gets reloaded,
  // it is not obvious the first one worked. What matters is not that the
  // second attempt ERRORS; it is that the schema is the same afterwards.
  //
  // Both outcomes are fine, and which one you get depends on what the
  // migration contains. A `create table` collides and the transaction rolls
  // back whole. A migration made only of `create or replace function` applies
  // again and changes nothing. Demanding an error would have failed 0009 for
  // being idempotent, which is a virtue.
  console.log(`
${BOLD}Pasting it a second time${RESET}`);

  const before = await fingerprint(db);

  let refused = false;
  try {
    await db.exec(paste);
  } catch (error) {
    refused = true;
    console.log(
      `  ${GREEN}ok${RESET} refused ${DIM}(${firstLine(error.message)})${RESET}`
    );
    // The failing statement is inside `begin; … commit;`, so the `commit` was
    // never reached and the session sits in an aborted transaction — every
    // subsequent query raises 25P02 until it is ended. The SQL editor does
    // this for you; here it has to be explicit, and it is also the thing
    // being asserted: the rollback is what leaves the schema untouched.
    await db.exec("rollback");
  }

  if (!refused) {
    console.log(`  ${DIM}applied again — so it had better be idempotent${RESET}`);
  }

  const after = await fingerprint(db);

  if (before === after) {
    console.log(
      `  ${GREEN}ok${RESET} the schema is identical either way — a double paste is harmless`
    );
  } else {
    failures += 1;
    console.log(`  ${RED}FAIL${RESET} the second paste CHANGED the schema`);
  }

  for (const [label, sql, expected] of INVARIANTS) {
    const { rows } = await db.query(sql);
    if (rows[0].n !== expected) {
      failures += 1;
      console.log(`  ${RED}FAIL${RESET} after the second paste: ${label}`);
    }
  }

  await db.close();

  if (failures > 0) {
    console.log(`\n${RED}${failures} problem(s). Do not paste this.${RESET}`);
    process.exit(1);
  }

  console.log(
    `
${GREEN}apply-${label}.sql is safe to paste into a project at ${earlier.at(-1).slice(0, 4)}.${RESET}`
  );
  console.log(
    `${DIM}Reproduces the schema, not the data. Take a backup anyway — this\n` +
      `cannot know what is actually in the live project.${RESET}`
  );
}

await main();
