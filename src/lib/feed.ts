import type { Announcement, JourneyCheckpoint, Shipment } from "@/types/domain";

/**
 * The activity stream.
 *
 * Pure: real rows in, sentences out. The database supplies events; this
 * decides what each one is called, which category it belongs to and how it
 * reads — the same division as everywhere else in `src/lib`. A trigger that
 * wrote narrated rows would make the database the narrator, which is a
 * different and weaker claim than "the database counts".
 *
 * Every event here is derived from something that actually happened and is
 * already stored. Nothing is inferred, and a shipment put `on_hold` does NOT
 * appear, because the schema records no timestamp for it — inventing one to
 * fill the gap is exactly the fabrication this product refuses.
 */

export type FeedCategory = "system" | "alert" | "company" | "message" | "task";

export interface FeedEvent {
  /** Stable across renders: source and row, never an array index. */
  id: string;
  category: FeedCategory;
  title: string;
  detail: string;
  occurredAt: string;
  shipmentId: string | null;
  shipmentReference: string | null;
}

export interface FeedSources {
  shipments: Shipment[];
  /** Recent checkpoints across the shipments the reader may see. */
  checkpoints: JourneyCheckpoint[];
  /** Company notices. Internal only — a party organisation never sees these. */
  announcements?: Announcement[];
  /**
   * The instant the page was rendered at. Used to drop expired notices.
   * Passed in rather than read, like every other clock in `src/lib`.
   */
  now?: Date;
}

function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
}

/**
 * Builds the stream from what is stored.
 *
 * `limit` caps the result, not each source: taking N from each and merging
 * would quietly drop a recent checkpoint whenever lifecycle events were busy.
 */
export function buildFeed(sources: FeedSources, limit = 25): FeedEvent[] {
  const references = new Map(
    sources.shipments.map((shipment) => [shipment.id, shipment.reference])
  );

  const events: FeedEvent[] = [];

  for (const announcement of sources.announcements ?? []) {
    // Retracted notices are gone from the stream but remain in the table —
    // that something was withdrawn is part of the record.
    if (announcement.retractedAt) continue;

    // Expiry is judged HERE, against the `now` the caller supplied, rather
    // than in the database. "Has this expired" is a judgement against a
    // clock, and clocks are arguments in this layer. Without a `now` the
    // notice is kept: silently hiding something because a caller forgot to
    // pass the time would be worse than showing it a little too long.
    if (
      announcement.expiresAt &&
      sources.now &&
      new Date(announcement.expiresAt).getTime() <= sources.now.getTime()
    ) {
      continue;
    }

    events.push({
      id: `announcement:${announcement.id}`,
      category: "company",
      title: announcement.title,
      detail: announcement.body,
      occurredAt: announcement.publishedAt,
      shipmentId: null,
      shipmentReference: null,
    });
  }

  for (const checkpoint of sources.checkpoints) {
    // A checkpoint with no actual time has not happened yet. It belongs on
    // the journey spine as "pending", not in a stream of things that did.
    if (!checkpoint.actualAt) continue;

    const reference = references.get(checkpoint.shipmentId) ?? null;
    const where = checkpoint.placeName ? ` at ${checkpoint.placeName}` : "";

    if (checkpoint.exceptionKind) {
      events.push({
        id: `checkpoint:${checkpoint.id}`,
        category: "alert",
        title: sentenceCase(checkpoint.exceptionKind),
        // The operator's note is deliberately NOT included. It can contain
        // internal commentary, and a party organisation reading this stream
        // would have it put in front of them rather than having to open the
        // journey. It stays on the spine, where the context is.
        detail: `${reference ?? "A shipment"} — ${checkpoint.label}${where}`,
        occurredAt: checkpoint.actualAt,
        shipmentId: checkpoint.shipmentId,
        shipmentReference: reference,
      });
      continue;
    }

    events.push({
      id: `checkpoint:${checkpoint.id}`,
      category: "system",
      title: "Shipment update",
      detail: `${reference ?? "A shipment"} — ${checkpoint.label}${where}`,
      occurredAt: checkpoint.actualAt,
      shipmentId: checkpoint.shipmentId,
      shipmentReference: reference,
    });
  }

  // Lifecycle events come from stored instants, not from a transition log:
  // `status` holds current state only, so these three columns are the only
  // honest record that the transitions happened.
  for (const shipment of sources.shipments) {
    if (shipment.dispatchedAt) {
      events.push({
        id: `shipment:dispatched:${shipment.id}`,
        category: "system",
        title: "Dispatched",
        detail: `${shipment.reference} left on its journey`,
        occurredAt: shipment.dispatchedAt,
        shipmentId: shipment.id,
        shipmentReference: shipment.reference,
      });
    }

    if (shipment.deliveredAt) {
      events.push({
        id: `shipment:delivered:${shipment.id}`,
        category: "system",
        title: "Delivery confirmed",
        detail: `${shipment.reference} delivered`,
        occurredAt: shipment.deliveredAt,
        shipmentId: shipment.id,
        shipmentReference: shipment.reference,
      });
    }

    if (shipment.cancelledAt) {
      events.push({
        id: `shipment:cancelled:${shipment.id}`,
        category: "alert",
        title: "Cancelled",
        detail: `${shipment.reference} was cancelled`,
        occurredAt: shipment.cancelledAt,
        shipmentId: shipment.id,
        shipmentReference: shipment.reference,
      });
    }
  }

  return events
    .sort((a, b) => {
      const byTime = b.occurredAt.localeCompare(a.occurredAt);
      // Ties are real: a dispatch and its first checkpoint can share an
      // instant. Breaking on id keeps the order stable between renders
      // instead of letting it depend on how the rows arrived.
      return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
    })
    .slice(0, limit);
}
