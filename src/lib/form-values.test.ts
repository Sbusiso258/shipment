import { describe, expect, it } from "vitest";

import { submittedValues } from "./form-values";

function formOf(entries: [string, string | File][]): FormData {
  const form = new FormData();
  for (const [key, value] of entries) form.append(key, value);
  return form;
}

describe("submittedValues", () => {
  it("keeps the text fields, keyed by name", () => {
    expect(
      submittedValues(
        formOf([
          ["name", "Durban Depot"],
          ["city", "Durban"],
        ])
      )
    ).toEqual({ name: "Durban Depot", city: "Durban" });
  });

  it("keeps a field the person deliberately cleared", () => {
    // An empty string is a value: it means "I removed what was there". Dropping
    // it would silently restore the old content on the next render.
    expect(submittedValues(formOf([["notes", ""]]))).toEqual({ notes: "" });
  });

  // React posts its own hidden inputs with every form action. They are
  // regenerated per render, so feeding them back is meaningless — and they
  // would be noise in anything that logs or diffs this.
  it("drops React's action machinery", () => {
    const values = submittedValues(
      formOf([
        ["$ACTION_REF_1", ""],
        ["$ACTION_KEY", "k123"],
        ["name", "Kept"],
      ])
    );
    expect(values).toEqual({ name: "Kept" });
  });

  // A browser will not let JavaScript set a file input's value, so there is
  // nothing useful to restore. Carrying "[object File]" back would put a lie
  // in the box.
  it("drops file entries rather than stringifying them", () => {
    const values = submittedValues(
      formOf([
        ["document", new File(["x"], "waybill.pdf")],
        ["reference", "N3-0042"],
      ])
    );
    expect(values).toEqual({ reference: "N3-0042" });
  });

  it("is empty for an empty submission", () => {
    expect(submittedValues(new FormData())).toEqual({});
  });

  // Repeated names are how the stage builder posts its rows. Those rows are
  // controlled React state and are restored from there, so last-wins is
  // acceptable here — but it is pinned so the behaviour is a decision rather
  // than an accident if anything ever relies on it.
  it("takes the last value when a name repeats", () => {
    expect(
      submittedValues(
        formOf([
          ["stageLabel", "Collection"],
          ["stageLabel", "Delivery"],
        ])
      )
    ).toEqual({ stageLabel: "Delivery" });
  });
});
