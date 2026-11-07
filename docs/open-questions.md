# Open questions — Shipment Oversight

Answered 2026-11-03 and moved into [scope.md](scope.md): the core job, who uses
it, which business it serves, where data lives, whether a map is needed, the
geography, how cargo value is handled, and the map stack.

**The map stack was changed after the plan was approved.** Leaflet +
OpenStreetMap's standard tiles was the original choice, on the grounds that it
is free and needs no key. True, but incomplete: the OSM Foundation's Tile Usage
Policy does not permit commercial-scale use of `tile.openstreetmap.org`, and
this product is being sold. Most free raster alternatives restrict their free
tier to non-commercial projects too. Settled on **MapLibre GL + OpenFreeMap**
vector tiles — still free, still no key, still no card, no commercial
restriction, self-hostable, and styleable to this project's own colours.
Reasoning in full in [AGENTS.md](../AGENTS.md).

Still open:

## 1. Province on gazetteer places

`public.sa_places` has no `province` column. Wikidata's administrative
hierarchy for South African settlements resolves to *municipalities*, and the
SPARQL that walks up to a province times out at this scale. Rather than ship a
column that is null for most rows — or infer a province from a bounding box and
present the guess as fact — it waits for a source that can fill it.

It matters more than it sounds. Seven place names in the gazetteer are
genuinely duplicated across the country (Middelburg, Heidelberg, Richmond,
Worcester, Stellenbosch, Mooi River, Touws River), and without a province an
operator picking from a type-ahead cannot tell them apart.

- [ ] Accept a second data source for provinces (a shapefile, or a slower
      batched Wikidata query run offline)
- [ ] Disambiguate in the UI by nearest large city instead
- [ ] Leave it until a customer complains

## 2. Real operational stages

The checkpoint kinds in the schema are drawn from standard road-freight
practice, not from an operation the owner runs. They are a reasonable starting
set and they are forward-extensible, but they should be checked against a real
operation before the first customer:

- [ ] What stages does a load actually pass through, in the operation you expect
      to sell into?
- [ ] Who logs each one, and how do they know?
- [ ] What is the document trail — waybill, delivery note, proof of delivery?

## 3. Silence threshold default

The schema holds `default_silence_threshold_days` per organisation, defaulting
to 2. Is two days the right default for South African domestic road freight, or
should it be one?

## 4. First customer

Is there a specific logistics business this is being built for, or is it
speculative? It changes whether the stages above get verified before or after
the build.
