#!/usr/bin/env node
//
// Run a SQL file against the LIVE Supabase project, over a direct Postgres
// connection.
//
//   npm run db:check                                  -- read-only diagnosis
//   npm run db:run supabase/apply-0008-0010.sql --confirm
//
// WHY THIS EXISTS. Applying a migration by pasting into the Supabase SQL
// editor failed five times in a row with no diagnosis available to either
// side: a run that does nothing prints the same "Success. No rows returned"
// as a run that worked, and the REST API cannot tell a missing table from a
// stale PostgREST cache. This connects to Postgres itself, so an error is an
// error, with its code, its position and the line that caused it.
//
// WHAT IT IS NOT. Not part of the app, not a service-role key, and not a way
// around row-level security — it is a `psql` substitute for the one job psql
// would do, on a machine that has no psql. Nothing in `src/` imports it.
//
// THE CONNECTION STRING IS THE DATABASE PASSWORD. It lives in `.env.local`,
// which is gitignored, it is never printed by this script, and it is never
// passed on a command line where it would reach the shell history.

import { readFile } from "node:fs/promises";
import path from "node:path";

import pg from "pg";

const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

const DIR = import.meta.dirname;

/**
 * Statements that change the database.
 *
 * Used for ONE purpose: refusing to touch production without `--confirm`.
 * It is a guard against a mistyped filename, not a security boundary —
 * anybody who can run this script can pass the flag.
 */
const CHANGES_THINGS =
  /^\s*(begin|create|alter|drop|grant|revoke|insert|update|delete|truncate|comment)\b/im;

/** Never let the password reach a log, an error or a terminal. */
function redact(text) {
  return String(text).replace(/postgres(?:ql)?:\/\/[^@\s]*@/gi, "postgresql://***@");
}

function explainConnection(error, host) {
  const code = error.code ?? "";

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return (
      `The host ${host} could not be resolved. Check the connection string ` +
      `in Settings → Database → Connection string.`
    );
  }
  if (code === "ETIMEDOUT" || code === "ECONNREFUSED") {
    return (
      `Nothing answered at ${host}. Supabase's DIRECT connection is IPv6-only ` +
      `on some plans — if this machine has no IPv6, use the Session pooler ` +
      `string instead (it is IPv4, and its port is 5432).`
    );
  }
  if (code === "28P01") {
    return "The password in the connection string was rejected.";
  }
  if (/self.signed|certificate/i.test(error.message)) {
    return (
      "TLS could not be verified. Append `?sslmode=no-verify` to the " +
      "connection string only if you understand what that turns off."
    );
  }
  return null;
}

/** A Postgres error, with everything it knows — not just its message. */
function reportSqlError(error, sql) {
  console.error(`\n${RED}${BOLD}The database refused it.${RESET}\n`);
  console.error(`  ${RED}${redact(error.message)}${RESET}`);

  for (const [label, value] of [
    ["code", error.code],
    ["detail", error.detail],
    ["hint", error.hint],
    ["constraint", error.constraint],
    ["table", error.table],
    ["where", error.where],
  ]) {
    if (value) console.error(`  ${DIM}${label}:${RESET} ${redact(value)}`);
  }

  // THE LINE THAT CAUSED IT. `position` is a 1-based character offset into
  // the statement, which is useless on its own and exactly what you need once
  // it is turned back into a line number.
  const position = Number(error.position);
  if (Number.isFinite(position) && position > 0) {
    const before = sql.slice(0, position);
    const line = before.split("\n").length;
    const column = position - before.lastIndexOf("\n");
    const lines = sql.split("\n");

    console.error(`\n  ${DIM}at line ${line}, column ${column}:${RESET}`);
    for (let i = Math.max(0, line - 3); i < Math.min(lines.length, line + 2); i += 1) {
      const marker = i === line - 1 ? `${RED}>${RESET}` : " ";
      console.error(`  ${marker} ${DIM}${String(i + 1).padStart(4)}${RESET} ${lines[i]}`);
    }
  }
}

function printRows(rows) {
  if (!rows || rows.length === 0) return;

  const columns = Object.keys(rows[0]);
  const width = (column) =>
    Math.max(column.length, ...rows.map((r) => String(r[column] ?? "null").length));

  const widths = Object.fromEntries(columns.map((c) => [c, width(c)]));
  const line = (cells) =>
    cells.map((cell, i) => String(cell).padEnd(widths[columns[i]])).join("  ");

  console.log(`  ${BOLD}${line(columns)}${RESET}`);
  console.log(`  ${DIM}${columns.map((c) => "-".repeat(widths[c])).join("  ")}${RESET}`);
  for (const row of rows) {
    console.log(`  ${line(columns.map((c) => row[c] ?? "null"))}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes("--confirm");
  const file = args.find((a) => !a.startsWith("--")) ?? path.join(DIR, "diagnose.sql");

  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error(`${RED}SUPABASE_DB_URL is not set.${RESET}

In the Supabase dashboard: ${BOLD}Settings → Database → Connection string${RESET}.
Choose ${BOLD}Session pooler${RESET} if this machine has no IPv6, otherwise ${BOLD}Direct connection${RESET}.
Copy the URI, replace [YOUR-PASSWORD] with your database password, and add it
to ${BOLD}.env.local${RESET} as one line:

  SUPABASE_DB_URL=postgresql://...

That file is gitignored. The string IS the database password — do not paste it
into a chat, a commit or a terminal command.`);
    process.exit(2);
  }

  const sql = await readFile(file, "utf8");
  const destructive = CHANGES_THINGS.test(sql);

  let host = "the database";
  try {
    host = new URL(url).host;
  } catch {
    console.error(`${RED}SUPABASE_DB_URL is not a valid connection string.${RESET}`);
    process.exit(2);
  }

  console.log(`${BOLD}${path.basename(file)}${RESET} ${DIM}→ ${host}${RESET}`);

  if (destructive && !confirmed) {
    console.error(
      `\n${YELLOW}This file changes the database, and this is production.${RESET}\n` +
        `Re-run with ${BOLD}--confirm${RESET} once you mean it.`
    );
    process.exit(3);
  }
  if (destructive) {
    console.log(`${YELLOW}Changing the live database.${RESET}`);
  }

  // One connection, not a pool: this runs one script and exits, and a pool
  // would keep the process alive afterwards.
  const client = new pg.Client({
    connectionString: url,
    // Supabase requires TLS. Certificates are publicly signed, so this
    // verifies rather than waving the check through.
    ssl: { rejectUnauthorized: true },
    // A migration can take a while; a silent timeout halfway through a
    // transaction is the worst possible outcome.
    statement_timeout: 120_000,
    connectionTimeoutMillis: 20_000,
  });

  try {
    await client.connect();
  } catch (error) {
    console.error(`\n${RED}Could not connect.${RESET}`);
    console.error(`  ${RED}${redact(error.message)}${RESET}`);
    const advice = explainConnection(error, host);
    if (advice) console.error(`\n  ${advice}`);
    process.exit(1);
  }

  try {
    // `query` with a multi-statement string uses the simple protocol, which
    // is what lets one call carry `begin; … commit;` plus the trailing
    // select — the same way the SQL editor runs a pasted file.
    const result = await client.query(sql);
    const results = Array.isArray(result) ? result : [result];

    console.log("");
    for (const part of results) {
      if (part.rows?.length) {
        printRows(part.rows);
        console.log("");
      }
    }

    const rowsBack = results.some((r) => r.rows?.length);
    if (!rowsBack) console.log(`  ${DIM}(no rows returned)${RESET}\n`);

    console.log(`${GREEN}Done.${RESET}`);
  } catch (error) {
    reportSqlError(error, sql);
    console.error(
      `\n${DIM}Nothing was left half-applied: the file is wrapped in one ` +
        `transaction, so a failure rolls all of it back.${RESET}`
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

await main();
