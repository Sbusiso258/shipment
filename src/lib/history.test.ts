import { describe, expect, it } from "vitest";

import { changedFields, describeAction, describeActor, isCorrection } from "./history";
import type { DecisionLogEntry } from "@/types/domain";

const entry = (over: Partial<DecisionLogEntry> = {}): DecisionLogEntry => ({
  id: "d1",
  orgId: "o1",
  actorId: "u1",
  action: "shipment_updated",
  subjectTable: "shipments",
  subjectId: "s1",
  shipmentId: "s1",
  changed: null,
  reason: null,
  createdAt: "2026-11-06T08:00:00.000Z",
  ...over,
});

describe("describeAction", () => {
  it("reads as a sentence, not as an enum value", () => {
    expect(describeAction("operator_withdrawn")).toBe("Took an operator off the load");
    expect(describeAction("operator_withdrawn")).not.toContain("_");
  });

  it("has a phrase for every action the migration defines", () => {
    // Guards the one failure this map has: a new enum value in a later
    // migration rendering as a blank line in the history panel.
    const actions: DecisionLogEntry["action"][] = [
      "shipment_created",
      "shipment_updated",
      "shipment_dispatched",
      "shipment_delivered",
      "shipment_cancelled",
      "shipment_held",
      "shipment_resumed",
      "operator_assigned",
      "operator_withdrawn",
      "party_granted",
      "party_revoked",
      "checkpoint_recorded",
      "checkpoint_confirmed",
      "exception_reported",
    ];
    for (const action of actions) {
      expect(describeAction(action), action).not.toBe("");
      expect(describeAction(action), action).not.toContain("_");
    }
  });
});

describe("isCorrection", () => {
  it("marks the lines somebody reviewing a dispute is looking for", () => {
    expect(isCorrection("shipment_updated")).toBe(true);
    expect(isCorrection("operator_withdrawn")).toBe(true);
    expect(isCorrection("party_revoked")).toBe(true);
  });

  it("does not mark ordinary progress", () => {
    expect(isCorrection("shipment_dispatched")).toBe(false);
    expect(isCorrection("checkpoint_confirmed")).toBe(false);
    expect(isCorrection("shipment_created")).toBe(false);
  });
});

describe("changedFields", () => {
  it("names the column in the words the form uses", () => {
    const fields = changedFields(
      entry({ changed: { promised_delivery_date: { from: "2026-11-05", to: "2026-11-09" } } })
    );
    expect(fields).toEqual([
      { field: "Promised by", from: "2026-11-05", to: "2026-11-09" },
    ]);
  });

  // NULL CARRIES MEANING IN THIS SCHEMA. `cargo_value` null is NOT DISCLOSED
  // and `promised_delivery_date` null is no promise made, so rendering either
  // as a blank would turn "nobody said" into "it was cleared" — the same
  // mistake as writing 0 for an undisclosed value.
  it("says 'not set' rather than printing nothing for a null", () => {
    const fields = changedFields(
      entry({ changed: { cargo_value: { from: null, to: 125000 } } })
    );
    expect(fields[0]).toEqual({ field: "Cargo value", from: "not set", to: "125000" });
  });

  it("distinguishes a null from an empty string", () => {
    const fields = changedFields(entry({ changed: { notes: { from: "", to: null } } }));
    expect(fields[0].from).toBe("blank");
    expect(fields[0].to).toBe("not set");
  });

  it("reports an id column as changed without printing two uuids", () => {
    const fields = changedFields(
      entry({
        changed: {
          driver_id: {
            from: "8f1c9e2a-0000-0000-0000-000000000001",
            to: "8f1c9e2a-0000-0000-0000-000000000002",
          },
        },
      })
    );
    expect(fields[0].field).toBe("Driver");
    expect(fields[0].from).toBe("");
    expect(fields[0].to).toBe("");
  });

  // 0012 wrote the endpoints as `"route": "changed"` — a bare string, not a
  // `{ from, to }`. Those rows are in the trail permanently, because the trail
  // cannot be rewritten, and reading `.from` off a string rendered them as
  // "Route: not set → not set" — the opposite of what happened.
  it("renders a legacy value that is not a from/to pair as just 'changed'", () => {
    const fields = changedFields(
      entry({ changed: { route: "changed" } as unknown as NonNullable<DecisionLogEntry["changed"]> })
    );
    expect(fields[0]).toEqual({ field: "Route", from: "", to: "" });
  });

  it("drops the columns that cannot meaningfully change", () => {
    const fields = changedFields(
      entry({
        changed: {
          org_id: { from: "o1", to: "o2" },
          created_by: { from: "u1", to: "u2" },
          reference: { from: "A", to: "B" },
        },
      })
    );
    expect(fields.map((f) => f.field)).toEqual(["Reference"]);
  });

  // The trigger records only the columns that moved, so a trail line for a
  // lifecycle action carries no `changed` at all.
  it("is empty when nothing was recorded as changed", () => {
    expect(changedFields(entry({ changed: null }))).toEqual([]);
    expect(changedFields(entry({ action: "shipment_dispatched" }))).toEqual([]);
  });
});

describe("describeActor", () => {
  const names = { u1: "Thandi Mokoena", u2: "Pieter van Wyk" };

  it("names somebody the viewer is allowed to see", () => {
    expect(describeActor("u2", names, "u1")).toBe("Pieter van Wyk");
  });

  it("says 'You' for the viewer's own actions", () => {
    expect(describeActor("u1", names, "u1")).toBe("You");
  });

  // A null actor is ORDINARY — a migration, the SQL editor, a batch job — and
  // saying so is true. Attributing it to a person would put a false line in
  // an audit trail, which is worse than a missing one.
  it("does not invent an actor for a change made outside a session", () => {
    expect(describeActor(null, names, "u1")).toBe("Outside the app");
  });

  it("still credits somebody who has since left the organisation", () => {
    expect(describeActor("u9", names, "u1")).toBe("A former member");
  });
});
