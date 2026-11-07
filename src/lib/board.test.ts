import { describe, expect, it } from "vitest";

import type { Shipment } from "@/types/domain";
import type { JourneyClock, ShipmentVerdict } from "@/lib/journey";

import {
  boardSummary,
  countByVerdict,
  filterRows,
  formatMoney,
  needsAttention,
  sortByTrouble,
  stagesLabel,
  type BoardRow,
  valueAtRisk,
} from "./board";

const NOW = new Date("2026-11-03T13:00:00Z"); // 15:00 SAST
const clock: JourneyClock = {
  now: NOW,
  timeZone: "Africa/Johannesburg",
  silenceThresholdDays: 2,
};

function row(
  reference: string,
  verdict: ShipmentVerdict,
  overrides: Partial<Shipment> = {}
): BoardRow {
  const shipment: Shipment = {
    id: reference,
    orgId: "o1",
    reference,
    direction: "outbound",
    mode: "road",
    status: "in_transit",
    originLocationId: "l1",
    destinationLocationId: "l2",
    carrierName: null,
    vehicleRegistration: null,
    driverId: null,
    vehicleId: null,
    driverName: null,
    goodsDescription: null,
    cargoValue: null,
    currency: "ZAR",
    weightKg: null,
    plannedDispatchAt: null,
    plannedDeliveryAt: null,
    promisedDeliveryDate: null,
    dispatchedAt: "2026-11-02T06:00:00Z",
    deliveredAt: null,
    cancelledAt: null,
    silenceThresholdDays: null,
    lastEventAt: "2026-11-03T06:00:00Z",
    checkpointCount: 0,
    clearedCheckpointCount: 0,
    notes: null,
    createdAt: "2026-11-01T06:00:00Z",
    ...overrides,
  };

  return {
    shipment,
    verdict,
    currentLabel: null,
    originName: "Johannesburg",
    destinationName: "Durban",
    originPoint: null,
    destinationPoint: null,
  };
}

describe("needsAttention", () => {
  it("covers the four states somebody has to act on", () => {
    expect(needsAttention("exception")).toBe(true);
    expect(needsAttention("late")).toBe(true);
    expect(needsAttention("at_risk")).toBe(true);
    expect(needsAttention("silent")).toBe(true);
  });

  it("excludes history and healthy shipments", () => {
    // A delivery that was late is a performance fact, not a task. It must not
    // inflate the "needs attention" count or the value at risk, or the board
    // grows a backlog that can never be cleared.
    expect(needsAttention("delivered_late")).toBe(false);
    expect(needsAttention("delivered")).toBe(false);
    expect(needsAttention("cancelled")).toBe(false);
    expect(needsAttention("on_track")).toBe(false);
  });
});

describe("sortByTrouble", () => {
  it("puts what needs acting on above what does not", () => {
    const rows = [
      row("D", "delivered"),
      row("C", "on_track"),
      row("B", "late", { promisedDeliveryDate: "2026-11-02" }),
      row("A", "exception"),
    ];
    expect(sortByTrouble(rows, clock).map((r) => r.shipment.reference)).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
  });

  it("sorts history below healthy shipments", () => {
    // delivered_late outranks delivered as a LABEL, but neither needs doing
    // anything about today.
    const rows = [
      row("LATE-DELIVERED", "delivered_late"),
      row("FINE", "on_track"),
    ];
    expect(sortByTrouble(rows, clock)[0].shipment.reference).toBe("FINE");
  });

  it("puts the longest-running problem first within one verdict", () => {
    const rows = [
      row("ONE-DAY", "late", { promisedDeliveryDate: "2026-11-02" }),
      row("FIVE-DAYS", "late", { promisedDeliveryDate: "2026-10-29" }),
    ];
    expect(sortByTrouble(rows, clock)[0].shipment.reference).toBe("FIVE-DAYS");
  });

  it("is stable for genuinely equal rows", () => {
    // Without a deterministic last resort the board reshuffles between
    // refreshes for no reason, which makes it feel broken.
    const rows = [row("ZULU", "on_track"), row("ALPHA", "on_track")];
    expect(sortByTrouble(rows, clock).map((r) => r.shipment.reference)).toEqual([
      "ALPHA",
      "ZULU",
    ]);
  });

  it("does not mutate the input", () => {
    const rows = [row("B", "on_track"), row("A", "late")];
    const before = rows.map((r) => r.shipment.reference);
    sortByTrouble(rows, clock);
    expect(rows.map((r) => r.shipment.reference)).toEqual(before);
  });
});

describe("valueAtRisk", () => {
  it("sums only the shipments that need attention", () => {
    const rows = [
      row("A", "late", { cargoValue: 100_000, promisedDeliveryDate: "2026-11-02" }),
      row("B", "on_track", { cargoValue: 900_000 }),
    ];
    expect(valueAtRisk(rows).amount).toBe(100_000);
  });

  it("counts an undisclosed value separately instead of treating it as zero", () => {
    // Null means NOT DISCLOSED. Folding it in as 0 would understate the one
    // number the board exists to headline, and silently.
    const rows = [
      row("A", "late", { cargoValue: 250_000 }),
      row("B", "late", { cargoValue: null }),
      row("C", "exception", { cargoValue: null }),
    ];
    const value = valueAtRisk(rows);
    expect(value.amount).toBe(250_000);
    expect(value.disclosedCount).toBe(1);
    expect(value.undisclosedCount).toBe(2);
  });

  it("flags a mixed-currency total as meaningless rather than printing it", () => {
    const rows = [
      row("A", "late", { cargoValue: 100, currency: "ZAR" }),
      row("B", "late", { cargoValue: 100, currency: "USD" }),
    ];
    expect(valueAtRisk(rows).mixedCurrency).toBe(true);
  });

  it("is zero, not NaN, when nothing is wrong", () => {
    const value = valueAtRisk([row("A", "on_track", { cargoValue: 5_000 })]);
    expect(value.amount).toBe(0);
    expect(value.mixedCurrency).toBe(false);
  });
});

describe("countByVerdict", () => {
  it("reports zero for verdicts that are absent", () => {
    const counts = countByVerdict([row("A", "late")]);
    expect(counts.late).toBe(1);
    expect(counts.exception).toBe(0);
    expect(counts.on_track).toBe(0);
  });
});

describe("boardSummary", () => {
  it("counts only actionable shipments as needing attention", () => {
    const rows = [
      row("A", "exception"),
      row("B", "late"),
      row("C", "on_track"),
      row("D", "delivered"),
    ];
    expect(boardSummary(rows, clock).attentionCount).toBe(2);
  });

  it("handles an empty board", () => {
    const summary = boardSummary([], clock);
    expect(summary.attentionCount).toBe(0);
    expect(summary.rows).toEqual([]);
    expect(summary.value.amount).toBe(0);
  });
});

describe("formatMoney", () => {
  it("formats rands in South African convention", () => {
    // Non-breaking spaces in the output, hence the normalisation.
    expect(formatMoney(1_240_000, "ZAR").replace(/ /g, " ")).toBe("R 1 240 000");
  });
});

describe("filterRows", () => {
  const rows = [
    row("HL-1024", "on_track"),
    row("HL-1021", "exception"),
    row("ZZ-0001", "delivered"),
  ];

  it("returns everything when nothing is asked for", () => {
    expect(filterRows(rows, {})).toHaveLength(3);
  });

  it("matches a partial reference, ignoring case", () => {
    expect(filterRows(rows, { query: "hl-10" })).toHaveLength(2);
    expect(filterRows(rows, { query: "ZZ" })).toHaveLength(1);
  });

  it("matches an endpoint name too", () => {
    // Somebody looking for "the Durban one" should find it. Every fixture
    // row runs Johannesburg to Durban.
    expect(filterRows(rows, { query: "durban" })).toHaveLength(3);
    expect(filterRows(rows, { query: "cape town" })).toHaveLength(0);
  });

  it("filters by verdict", () => {
    expect(filterRows(rows, { verdict: "exception" })).toHaveLength(1);
  });

  it("applies both together", () => {
    expect(filterRows(rows, { query: "HL", verdict: "exception" })).toHaveLength(1);
    expect(filterRows(rows, { query: "ZZ", verdict: "exception" })).toHaveLength(0);
  });

  it("ignores surrounding space in the query", () => {
    expect(filterRows(rows, { query: "  hl-1024  " })).toHaveLength(1);
  });
});

describe("stagesLabel", () => {
  it("counts confirmed against planned", () => {
    expect(
      stagesLabel(
        row("A", "on_track", { checkpointCount: 5, clearedCheckpointCount: 3 })
          .shipment
      )
    ).toBe("3 of 5 stages");
  });

  it("does not call a shipment with no route 0% complete", () => {
    // "0 of 0" would imply somebody had planned a route and nothing had
    // happened. Nobody has planned one.
    expect(stagesLabel(row("A", "on_track", { checkpointCount: 0 }).shipment)).toBe(
      "No stages planned"
    );
  });
});
