import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock,
  PackageCheck,
  TriangleAlert,
  VolumeX,
} from "lucide-react";

import type { ShipmentVerdict } from "@/lib/journey";
import { verdictLabel } from "@/lib/verdicts";
import { cn } from "@/lib/utils";

/**
 * Exactly one badge per shipment, chosen by precedence in `journeySummary`.
 *
 * Every verdict carries an ICON AND A WORD, never colour alone. The core
 * signal of this product is the red/green axis, and roughly one man in twelve
 * has some red/green colour deficiency — a board that encodes "late" purely as
 * a colour is unreadable to them.
 */

// Icon and colour. The LABEL comes from `src/lib/verdicts.ts`, shared with
// the dashboard panel — the two used to keep separate copies and drifted.
const VERDICTS: Record<
  ShipmentVerdict,
  { icon: typeof Clock; className: string }
> = {
  cancelled: {
    icon: Ban,
    className: "bg-ink-100 text-ink-600",
  },
  delivered_late: {
    icon: PackageCheck,
    // Delivered, but the promise was broken. It keeps the late colour
    // deliberately: a late count that goes green on arrival cannot report on
    // performance, which is most of what the customer is buying.
    className: "bg-late-bg text-late",
  },
  delivered: {
    icon: CheckCircle2,
    className: "bg-delivered-bg text-delivered",
  },
  exception: {
    icon: TriangleAlert,
    className: "bg-exception-bg text-exception",
  },
  late: {
    icon: AlertTriangle,
    className: "bg-late-bg text-late",
  },
  at_risk: {
    icon: Clock,
    className: "bg-late-bg text-late",
  },
  silent: {
    icon: VolumeX,
    className: "bg-silent-bg text-silent",
  },
  on_track: {
    icon: CircleDashed,
    className: "bg-ontime-bg text-ontime",
  },
};

export function VerdictBadge({
  verdict,
  detail,
  className,
}: {
  verdict: ShipmentVerdict;
  /** e.g. "2 days" — appended so the badge says how bad, not just that it is bad. */
  detail?: string | null;
  className?: string;
}) {
  const { icon: Icon, className: tone } = VERDICTS[verdict];
  const label = verdictLabel(verdict);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-small font-medium",
        tone,
        className
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {label}
      {detail ? <span className="font-normal opacity-80">· {detail}</span> : null}
    </span>
  );
}
