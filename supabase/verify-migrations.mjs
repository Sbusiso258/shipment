#!/usr/bin/env node
//
// Applies every migration to a throwaway Postgres and exercises the
// constraints and triggers they define.
//
//   npm run verify:migrations
//
// WHY PGLITE RATHER THAN A LOCAL POSTGRES SERVER
// ----------------------------------------------
// The sibling project personal-performance-os runs this against a real local
// Postgres over psql. That needs a running server, a port and a password, and
// the moment any of those is missing the verification silently stops being run
// — which is the failure mode that matters, because a check nobody runs is
// worse than no check at all.
//
// PGlite is real Postgres compiled to WebAssembly, running in this process. No
// server, no port, no credentials, nothing to install beyond a dev dependency,
// and it works the same on a laptop as in CI. The database is created fresh in
// memory on every run and thrown away at the end, so there is no state to
// corrupt and no cleanup to forget.
//
// WHAT THIS CANNOT DO
// -------------------
// It cannot prove row-level security. The role running it owns the tables, and
// a table owner bypasses its own RLS — so every policy here is inert. That is
// not a limitation of PGlite; it would be equally true against a real server.
// `npm run verify:rls` covers RLS against a live Supabase project using the
// anon key, which is the only way to see a policy actually refuse something.
//
// A missing table fails loudly the first time a page loads.
// A missing policy fails silently, and only in the direction that leaks.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";

const DIR = import.meta.dirname;
const MIGRATIONS = path.join(DIR, "migrations");

const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

/**
 * PGlite surfaces `raise notice` through this callback. The behaviour file
 * prints one line per assertion, and those lines are the actual output of this
 * command — without them a pass is indistinguishable from a file that ran no
 * checks.
 */
function onNotice(notice) {
  const message = (notice?.message ?? "").trimEnd();
  if (message) console.log(`${DIM}${message}${RESET}`);
}

/**
 * Prints every assertion the behaviour file recorded, and returns the count.
 *
 * The count is part of the output on purpose. A green run that asserted four
 * things and a green run that asserted forty look identical otherwise, and the
 * day someone's edit makes the file stop executing halfway, the number is the
 * only thing that says so.
 */
async function printLog(db) {
  let rows = [];
  try {
    const result = await db.query(
      "select label, detail from verification.log order by seq"
    );
    rows = result.rows;
  } catch {
    // The schema may not exist if the file failed before creating it.
    return 0;
  }

  for (const { label, detail } of rows) {
    const suffix = detail ? ` ${DIM}(${detail})${RESET}` : "";
    console.log(`  ${GREEN}ok${RESET} ${label}${suffix}`);
  }
  return rows.length;
}

async function main() {
  const db = new PGlite({ onNotice });
  await db.waitReady;

  const version = await db.query("select version() as v");
  console.log(`${DIM}${version.rows[0].v.split(",")[0]} (in-process)${RESET}\n`);

  // 1. Supabase stand-ins: the auth schema and the roles the grants target.
  console.log("Applying Supabase stubs");
  await db.exec(await readFile(path.join(DIR, "verify-stubs.sql"), "utf8"));

  // 2. Every migration, in filename order. Numbered and forward-only, so
  //    lexical order is application order — that is the whole point of the
  //    NNNN_ prefix.
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();

  if (files.length === 0) {
    console.error(`${RED}No migrations found in ${MIGRATIONS}${RESET}`);
    process.exit(1);
  }

  console.log("\nApplying migrations");
  for (const file of files) {
    process.stdout.write(`  ${file} `);
    try {
      await db.exec(await readFile(path.join(MIGRATIONS, file), "utf8"));
      console.log(`${GREEN}ok${RESET}`);
    } catch (error) {
      console.log(`${RED}FAILED${RESET}`);
      console.error(`\n${RED}${error.message}${RESET}\n`);
      process.exit(1);
    }
  }

  // 3. The assertions. These are what make this more than a syntax check.
  //
  // `verify-behaviour.sql` first — it defines the assertion helpers and the
  // shared fixtures — then every `verify-behaviour-N-*.sql` in filename order.
  //
  // They share one database and build on each other's rows, so ORDER MATTERS.
  // The numeric prefix makes it explicit: the files were briefly ordered by
  // accident of their names, and "provisioning" sorting before "shipments"
  // meant a fixture was used before it existed.
  const behaviourFiles = [
    "verify-behaviour.sql",
    ...(await readdir(DIR)).filter((f) => /^verify-behaviour-.+\.sql$/.test(f)).sort(),
  ];

  console.log("\nExercising constraints and triggers");
  try {
    for (const file of behaviourFiles) {
      await db.exec(await readFile(path.join(DIR, file), "utf8"));
    }
  } catch (error) {
    // Print whatever passed before the failure: knowing how far it got is
    // most of the diagnosis.
    await printLog(db);
    console.error(`\n${RED}${error.message}${RESET}\n`);
    process.exit(1);
  }

  const passed = await printLog(db);

  await db.close();
  console.log(`\n${GREEN}Schema verified — ${passed} checks passed.${RESET}`);
  console.log(
    `${DIM}RLS is NOT covered by this command — run \`npm run verify:rls\` for that.${RESET}`
  );
}

main().catch((error) => {
  console.error(`\n${RED}${error?.stack ?? error}${RESET}\n`);
  process.exit(1);
});
