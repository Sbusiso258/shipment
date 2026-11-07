# Data sources

Every coordinate in this product is real and traceable. This file records where
each one came from and how to reproduce it.

The rule it exists to enforce, from [AGENTS.md](../AGENTS.md): **never invent a
coordinate.** A fabricated latitude renders with exactly the same confidence as
a surveyed one, and nobody re-checks a pin that looks about right. Every row in
the gazetteer carries its `wikidata_qid`, so any single value can be traced to
its source and checked.

---

## The South African gazetteer — `public.sa_places`

| | |
|---|---|
| Source | [Wikidata](https://www.wikidata.org), via the public SPARQL endpoint at `https://query.wikidata.org/sparql` |
| Licence | **CC0 1.0** — public domain dedication, no attribution obligation |
| Fetched | 2026-11-03 |
| Rows | 521 |
| Generated file | `supabase/migrations/0003_sa_places_seed.sql` |
| Generator | `supabase/seeds/build-sa-places.mjs` |

**Why Wikidata and not GeoNames.** GeoNames is CC-BY, which would attach a
second attribution obligation to this product on top of the basemap's. Wikidata
is CC0 and carries none. Both are good data; the licence decided it.

**Why not Google.** Google's terms forbid *storing* coordinates obtained from
their services. This schema stores them. That rules Google out independently of
the billing-account question, and it is worth remembering, because copying a
coordinate out of Google Maps is always the path of least resistance.

### The queries

Three queries, combined by the generator. They are deliberately bounded —
the obvious single query that walks `wdt:P131*` up to a province times out on
the public endpoint at this scale, which is also why there is no `province`
column yet.

**1. Settlements, by population.** Returns the largest places. Municipalities
are filtered out by the generator, because an administrative area is not
somewhere a vehicle stops.

```sparql
SELECT ?item ?itemLabel ?lat ?lon ?pop ?admLabel WHERE {
  ?item wdt:P31/wdt:P279* wd:Q486972 ;   # human settlement
        wdt:P17 wd:Q258 ;                # country: South Africa
        p:P625 ?st .
  ?st psv:P625 ?node .
  ?node wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lon .
  OPTIONAL { ?item wdt:P1082 ?pop }
  OPTIONAL { ?item wdt:P131 ?adm }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
ORDER BY DESC(?pop)
LIMIT 400
```

**2. Freight corridor towns, by name.** Population ordering alone misses the
towns that matter to road freight — Harrismith is the N3 midpoint and has
25 000 people. The names in `supabase/seeds/corridor-names.txt` are the N1, N2,
N3, N4 and N12 nodes, chosen by what a truck actually passes through. The
coordinates still come from Wikidata; only the *selection* is editorial.

```sparql
SELECT ?item ?itemLabel ?lat ?lon ?pop WHERE {
  VALUES ?nm { "Harrismith"@en "Richards Bay"@en ... }   # from corridor-names.txt
  ?item rdfs:label ?nm ;
        wdt:P17 wd:Q258 ;
        p:P625/psv:P625 ?node .
  ?node wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lon .
  OPTIONAL { ?item wdt:P1082 ?pop }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
LIMIT 600
```

> When building the `VALUES` list from a shell, quote it properly. An
> unquoted `for n in $NAMES` splits on whitespace, so every multi-word name
> — "Richards Bay", "Beaufort West", "Mooi River" — shatters into tokens that
> match nothing. It fails silently: the query succeeds and simply returns
> fewer rows.

**3. Ports and airports.**

```sparql
SELECT ?item ?itemLabel ?lat ?lon ?kind WHERE {
  VALUES (?class ?kind) { (wd:Q44782 "port") (wd:Q1248784 "airport") }
  ?item wdt:P31/wdt:P279* ?class ;
        wdt:P17 wd:Q258 ;
        p:P625/psv:P625 ?node .
  ?node wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lon .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
LIMIT 600
```

### What the generator decides

Only two things, and both are stated rules applied uniformly rather than
judgements made row by row:

- **`kind`** — Wikidata's own typing decides `port` and `airport`. Everything
  else is a `city` above 150 000 residents and a `town` below. Population
  unknown means `town`.
- **Deduplication** — same name within ~5 km is one place; same name further
  apart is two. Richards Bay exists as both a town and a bay about 2 km apart,
  and offering it twice in a type-ahead gives an operator no way to choose.
  Middelburg, Heidelberg and Richmond are each genuinely different towns
  hundreds of kilometres apart, and both of each must survive.

### Regenerating

```bash
# Fetch the three result sets into a directory of their own, then:
node supabase/seeds/build-sa-places.mjs <data-dir> supabase/migrations/0003_sa_places_seed.sql
npm run verify:migrations
```

`verify:migrations` asserts the result: no positive latitude, everything inside
the national bounding box, no place seeded twice at one position, every row
carrying a source id, and the ten freight-critical places present. A
transcription error puts a depot in Mozambique and nothing else would catch it.

---

## The basemap — MapLibre + OpenFreeMap

| | |
|---|---|
| Tiles | [OpenFreeMap](https://openfreemap.org) — OSM-derived vector tiles |
| Underlying data | OpenStreetMap contributors, **ODbL** |
| Attribution | **Required**, and rendered in the map control |
| Cost | Free, no API key, no billing account, no commercial restriction |

Attribution is a licence condition, not decoration. Do not hide it or restyle
it to nothing.

**Not `tile.openstreetmap.org`.** The OSM Foundation's Tile Usage Policy does
not permit commercial-scale use of their tile servers, and this product is
sold. Most free raster alternatives (Thunderforest, Stadia) likewise restrict
their free tier to non-commercial projects.

`NEXT_PUBLIC_MAP_STYLE_URL` is the upgrade seam: MapLibre consumes a style URL
and nothing in the map component knows where tiles come from.
