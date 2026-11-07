import Link from "next/link";

import type { BoardSummary } from "@/lib/board";
import type { ShipmentVerdict } from "@/lib/journey";
import { cn } from "@/lib/utils";

/**
 * "All clear / Operations normal" — derived, never decorative.
 *
 * A green light that is always green is worse than no light: it teaches the
 * reader to ignore the one place they should be able to glance at. So this
 * reads the same `boardSummary` the page renders, and when something is
 * wrong it says what and how many, and links to it.
 */

const WORST_FIRST: { verdict: ShipmentVerdict; label: string; dot: string; text: string }[] = [
  { verdict: "exception", label: "exception", dot: "bg-exception", text: "text-exception" },
  { verdict: "late", label: "late", dot: "bg-late", text: "text-late" },
  { verdict: "at_risk", label: "at risk", dot: "bg-late", text: "text-late" },
  { verdict: "silent", label: "without updates", dot: "bg-silent", text: "text-silent" },
];

export function StatusCluster({
  summary,
  className,
}: {
  summary: BoardSummary;
  className?: string;
}) {
  const worst = WORST_FIRST.find((entry) => summary.counts[entry.verdict] > 0);

  if (!worst) {
    return (
      <span className={cn("flex items-center gap-2", className)}>
        <span className="relative flex size-2.5 items-center justify-center">
          <span className="absolute size-2.5 animate-ping rounded-full bg-ontime opacity-50" />
          <span className="size-2.5 rounded-full bg-ontime" />
        </span>
        <span className="flex flex-col leading-tight">
          <span className="text-small font-medium text-ontime">All clear</span>
          <span className="text-micro text-ink-400">Operations normal</span>
        </span>
      </span>
    );
  }

  const count = summary.counts[worst.verdict];

  return (
    <Link
      href={`/?show=${worst.verdict}`}
      className={cn(
        "flex items-center gap-2 rounded-control px-1.5 py-1 transition-colors hover:bg-ink-100",
        className
      )}
    >
      <span className="relative flex size-2.5 items-center justify-center">
        <span className={cn("absolute size-2.5 animate-ping rounded-full opacity-50", worst.dot)} />
        <span className={cn("size-2.5 rounded-full", worst.dot)} />
      </span>
      <span className="flex flex-col leading-tight">
        <span className={cn("text-small font-medium", worst.text)}>
          {summary.attentionCount} need
          {summary.attentionCount === 1 ? "s" : ""} attention
        </span>
        <span className="text-micro text-ink-400">
          {count} {worst.label}
        </span>
      </span>
    </Link>
  );
}
