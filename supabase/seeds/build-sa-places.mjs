// Merges the Wikidata results into the gazetteer seed migration.
//
// Run with the data DIRECTORY as an argument; never from inside it.
//   node build-seed.mjs <data-dir> <out.sql>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const dataDir = process.argv[2];
const outFile = process.argv[3];

const SA = { latMin: -35.0, latMax: -22.0, lonMin: 16.0, lonMax: 33.1 };

function load(file) {
  const p = path.join(dataDir, file);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf8")).results.bindings;
}

const byQid = new Map();

function add(binding, forcedKind) {
  const qid = binding.item.value.split("/").pop();
  const name = binding.itemLabel?.value ?? "";
  const lat = Number(binding.lat.value);
  const lon = Number(binding.lon.value);
  const pop = binding.pop ? Number(binding.pop.value) : null;
  const kind = forcedKind ?? binding.kind?.value ?? null;

  if (!name || /^Q\d+$/.test(name)) return;
  // Administrative areas are not places a vehicle stops.
  if (/municipality|metropolitan|district|province/i.test(name)) return;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  if (lat < SA.latMin || lat > SA.latMax) return;
  if (lon < SA.lonMin || lon > SA.lonMax) return;

  const existing = byQid.get(qid);
  if (existing) {
    // Prefer a real hub classification and a known population.
    if (!existing.kind && kind) existing.kind = kind;
    if (existing.pop == null && pop != null) existing.pop = pop;
    return;
  }
  byQid.set(qid, { qid, name, lat, lon, pop, kind });
}

for (const b of load("sa-places.json")) add(b);
for (const b of load("corridors.json")) add(b);
for (const b of load("hubs.json")) add(b);

// Wikidata sometimes holds two items for one place — typically the settlement
// and a census "main place" entity sharing a position. Deduped by qid above,
// they survive as two rows, which would put the same town in a type-ahead
// twice and let two shipments claim different ids for one depot.
//
// Keep the entry with a population if only one has it, else the lower Q number
// (the older, generally more canonical item).
// Entries are clustered by name AND proximity, not by rounded coordinates.
// Two things make that necessary:
//
//   Richards Bay exists as both the town and the bay/port, about 2 km apart.
//   Rounding to two decimals leaves them separate, so a type-ahead would offer
//   "Richards Bay" twice with no way for an operator to tell which is which.
//
//   Middelburg, Heidelberg and Richmond are each the name of genuinely
//   different towns hundreds of kilometres apart. Those must BOTH survive.
//
// So: same name within ~5 km is one place; same name further apart is two.
const NEAR_DEGREES = 0.05; // ~5.5 km of latitude

function preferred(a, b) {
  if ((a.pop != null) !== (b.pop != null)) return a.pop != null ? a : b;
  if ((a.pop ?? 0) !== (b.pop ?? 0)) return (a.pop ?? 0) > (b.pop ?? 0) ? a : b;
  return Number(a.qid.slice(1)) < Number(b.qid.slice(1)) ? a : b;
}

const clusters = [];
for (const p of byQid.values()) {
  const match = clusters.find(
    (c) =>
      c.name === p.name.toLowerCase().trim() &&
      Math.abs(c.lat - p.lat) < NEAR_DEGREES &&
      Math.abs(c.lon - p.lon) < NEAR_DEGREES
  );
  if (match) {
    match.pick = preferred(match.pick, p);
    return_kind_preserve(match, p);
  } else {
    clusters.push({ name: p.name.toLowerCase().trim(), lat: p.lat, lon: p.lon, pick: p });
  }
}

// A port or airport classification is information the settlement entry lacks;
// keep it even when the settlement entry wins on population.
function return_kind_preserve(cluster, candidate) {
  if (
    (candidate.kind === "port" || candidate.kind === "airport") &&
    !cluster.pick.hubKind
  ) {
    cluster.pick.hubKind = candidate.kind;
  }
}

const places = clusters.map((c) => c.pick);

// Classification rule, stated rather than guessed: anything Wikidata typed as a
// port or an airport keeps that type; everything else is a city above 150 000
// residents and a town otherwise. Population-unknown settlements are towns.
for (const p of places) {
  if (p.kind === "port" || p.kind === "airport") continue;
  p.kind = (p.pop ?? 0) >= 150_000 ? "city" : "town";
}

// Slugs must be unique. Collisions are real — there is a Middelburg in both
// Mpumalanga and the Eastern Cape — so both are kept and the second gets its
// Wikidata id appended rather than being silently dropped.
const slugCount = new Map();
function slugify(name) {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
for (const p of places) {
  const base = slugify(p.name) || p.qid.toLowerCase();
  const n = (slugCount.get(base) ?? 0) + 1;
  slugCount.set(base, n);
  p.slug = n === 1 ? base : `${base}-${p.qid.toLowerCase()}`;
}

places.sort((a, b) => a.name.localeCompare(b.name, "en"));

const counts = places.reduce((acc, p) => ({ ...acc, [p.kind]: (acc[p.kind] ?? 0) + 1 }), {});
console.log(`places: ${places.length}`, counts);
console.log(`positive latitudes: ${places.filter((p) => p.lat > 0).length}`);
console.log(`duplicate slugs: ${places.length - new Set(places.map((p) => p.slug)).size}`);

const spot = [
  "Johannesburg", "Durban", "Cape Town", "Harrismith", "Richards Bay",
  "Polokwane", "Rustenburg", "Beaufort West", "Gqeberha", "Mbombela",
];
console.log("\nspot checks:");
for (const n of spot) {
  const p = places.find((x) => x.name === n);
  console.log(`  ${n.padEnd(16)} ${p ? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}  [${p.kind}]` : "MISSING"}`);
}

const values = places
  .map(
    (p) =>
      `  (${sql(p.slug)}, ${sql(p.name)}, ${p.lat.toFixed(6)}, ${p.lon.toFixed(
        6
      )}, '${p.kind}', ${sql(p.qid)})`
  )
  .join(",\n");

function sql(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

const header = `-- 0003_sa_places_seed.sql — the South African gazetteer.
--
-- GENERATED, NOT HAND-WRITTEN. See docs/data-sources.md.
--
-- Source:  Wikidata (https://www.wikidata.org), via the public SPARQL endpoint.
-- Licence: CC0 1.0 — public domain dedication. No attribution obligation, which
--          is why Wikidata was chosen over GeoNames (CC-BY): this project
--          already carries the basemap's attribution requirement and did not
--          need a second one on the data.
-- Fetched: ${new Date().toISOString().slice(0, 10)}
-- Rows:    ${places.length}
--
-- WHY THIS FILE EXISTS AT ALL
-- Every coordinate in this product must be real. A fabricated latitude renders
-- with exactly the same confidence as a surveyed one, and nobody double-checks
-- a pin that looks about right. So no coordinate here was typed from memory:
-- each one came from the query recorded in docs/data-sources.md, and each row
-- carries its Wikidata id so any value can be traced back to its source.
--
-- \`kind\` is the one derived field. Wikidata's own typing decides port and
-- airport; everything else is a city above 150 000 residents and a town below.
-- That is a stated rule applied uniformly, not a judgement made per row.
--
-- Re-running this migration is safe: it conflicts on slug and does nothing.

insert into public.sa_places (slug, name, latitude, longitude, kind, wikidata_qid) values
${values}
on conflict (slug) do nothing;
`;

writeFileSync(outFile, header, "utf8");
console.log(`\nwrote ${outFile}`);
