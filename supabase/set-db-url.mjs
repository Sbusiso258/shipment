#!/usr/bin/env node
//
// Put the Supabase connection string into `.env.local`, without you having to
// edit the file.
//
//   npm run db:url
//
// WHY THIS EXISTS. Hand-editing `.env.local` failed twice: the line was added
// and the value never arrived in it. That is not a comprehension problem, it
// is a fiddly step — the right file among four similar names, the right line,
// after the `=`, no quotes, and a password that is invisible once pasted.
// This asks once and writes it correctly.
//
// IT NEVER PRINTS THE STRING. Typing is hidden, the value is never echoed,
// never logged, and never passed as a command-line argument where the shell
// would keep it in history. The only thing this prints is the SHAPE of what
// it received.
//
// IT CHECKS THE TWO MISTAKES THAT COST AN HOUR EACH: port 6543, which cannot
// run a multi-statement migration, and a `[YOUR-PASSWORD]` placeholder left
// where the password should be.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

const ENV_FILE = path.join(process.cwd(), ".env.local");
const KEY = "SUPABASE_DB_URL";

/**
 * Read one line without echoing it.
 *
 * Falls back to plain stdin when there is no terminal, so the validation can
 * be exercised by piping a value in — which is the only way to test this
 * without a person at a keyboard.
 */
function askHidden(question) {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (buffer += chunk));
      process.stdin.on("end", () => resolve(buffer.split("\n")[0].trim()));
    });
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Mute the echo: everything typed after the prompt is invisible.
    let prompted = false;
    rl._writeToOutput = (text) => {
      if (!prompted) {
        rl.output.write(text);
        prompted = true;
      }
    };

    rl.question(question, (answer) => {
      rl.output.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Everything that would make the connection fail in a confusing way. */
function check(value) {
  if (!value) return "Nothing was entered.";

  if (/^\[.*\]$/.test(value) || value.includes("[YOUR-PASSWORD]")) {
    return (
      "That still has the [YOUR-PASSWORD] placeholder in it. Replace it — " +
      "brackets and all — with the database password."
    );
  }
  if (!/^postgres(ql)?:\/\//i.test(value)) {
    return "That does not look like a connection string. It starts postgresql://";
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return "That is not a valid URL. Copy it again from the dashboard.";
  }

  if (!url.password) {
    return "There is no password in that string. Replace [YOUR-PASSWORD] with it.";
  }
  if (url.port === "6543") {
    return (
      "That is the TRANSACTION pooler (port 6543). It cannot run a " +
      "multi-statement migration. Use the Session pooler, which is port 5432."
    );
  }
  return null;
}

async function main() {
  console.log(
    `${BOLD}Supabase connection string${RESET}\n` +
      `${DIM}Dashboard → Settings → Database → Connection string → Session pooler.\n` +
      `Replace [YOUR-PASSWORD] with your database password before pasting.\n` +
      `Nothing you type will be shown.${RESET}\n`
  );

  const value = await askHidden("Paste it here, then press Enter: ");

  const problem = check(value);
  if (problem) {
    console.error(`\n${RED}${problem}${RESET}`);
    console.error(`${DIM}Nothing was written. Run npm run db:url again.${RESET}`);
    process.exit(1);
  }

  const url = new URL(value);

  let contents = "";
  try {
    contents = await readFile(ENV_FILE, "utf8");
  } catch {
    console.error(`${RED}No .env.local in ${process.cwd()}${RESET}`);
    process.exit(1);
  }

  // Replace the line if it is there, append it if it is not. Two lines with
  // the same key is the kind of thing that works until it does not.
  //
  // LINE BY LINE, NOT A REGEX OVER THE WHOLE FILE. In JavaScript the `m` flag
  // makes `$` match before a lone `\r` as well as before `\n`, so a
  // whole-file replace on a CRLF file can leave the carriage return behind
  // and glue the key onto the end of the previous line. Nothing then parses
  // it as a variable — not Node, not this script's own reader — and the file
  // still looks correct in an editor. That happened once. This cannot do it.
  const line = `${KEY}=${value}`;
  const eol = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.split(/\r?\n/);

  const at = lines.findIndex((l) => new RegExp(`^\\s*${KEY}\\s*=`).test(l));
  if (at === -1) {
    while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
    lines.push(line, "");
  } else {
    lines[at] = line;
  }

  await writeFile(ENV_FILE, lines.join(eol), "utf8");

  // The SHAPE, never the value. Enough to see it went in right.
  console.log(`\n${GREEN}Saved to .env.local${RESET}`);
  console.log(`  ${DIM}host:${RESET} ${url.host}`);
  console.log(`  ${DIM}user:${RESET} ${url.username}`);
  console.log(`  ${DIM}password:${RESET} ${"•".repeat(Math.min(url.password.length, 24))}`);
  console.log(`  ${DIM}database:${RESET} ${url.pathname.replace(/^\//, "")}`);

  if (url.port !== "5432") {
    console.log(
      `\n${YELLOW}Note: port ${url.port}. A migration needs a session-mode ` +
        `connection, which is 5432.${RESET}`
    );
  }

  console.log(`\nNow run ${BOLD}npm run db:check${RESET}`);
}

await main();
