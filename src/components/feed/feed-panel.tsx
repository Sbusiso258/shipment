"use client";

import * as Tabs from "@radix-ui/react-tabs";
import {
  AlertTriangle,
  CheckSquare,
  Megaphone,
  MessageSquare,
  Radio,
  Truck,
} from "lucide-react";

import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { formatSince } from "@/lib/duration";
import type { FeedCategory, FeedEvent } from "@/lib/feed";
import { cn } from "@/lib/utils";
import type { Message, Task } from "@/types/domain";

import { MessagesTab } from "./messages-tab";
import type { PanelFormState } from "./panel-form-state";
import { PanelComposer } from "./panel-composer";
import { TasksTab } from "./tasks-tab";

/**
 * The right-hand panel: activity, messages and tasks.
 *
 * One composer at the foot, doing a different job per tab — which is what the
 * single input in the design implies, and what an operator expects of a box
 * in that position.
 */

const CATEGORY: Record<
  FeedCategory,
  { icon: typeof Truck; pill: string; tone: string; chip: string }
> = {
  system: { icon: Truck, pill: "System", tone: "text-marine-200", chip: "bg-marine-100" },
  alert: {
    icon: AlertTriangle,
    pill: "Exception",
    tone: "text-exception",
    chip: "bg-exception-bg",
  },
  company: { icon: Megaphone, pill: "Company", tone: "text-silent", chip: "bg-silent-bg" },
  message: {
    icon: MessageSquare,
    pill: "Message",
    tone: "text-delivered",
    chip: "bg-delivered-bg",
  },
  task: { icon: CheckSquare, pill: "Task", tone: "text-ontime", chip: "bg-ontime-bg" },
};

function FeedEventCard({ event, nowMs }: { event: FeedEvent; nowMs: number }) {
  const { icon: Icon, pill, tone, chip } = CATEGORY[event.category];

  return (
    <li className="flex gap-3 rounded-panel border border-ink-200 bg-paper-raised p-3">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-control", chip)}>
        <Icon aria-hidden className={cn("size-4", tone)} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-small font-medium text-ink-950">{event.title}</p>
          <time className="shrink-0 font-code text-micro text-ink-400">
            {formatSince(new Date(event.occurredAt), new Date(nowMs))}
          </time>
        </div>
        <p className="mt-0.5 text-small text-ink-600">{event.detail}</p>
        <span className={cn("mt-1.5 inline-block rounded-control px-1.5 py-0.5 text-micro", chip, tone)}>
          {pill}
        </span>
      </div>
    </li>
  );
}

const TAB_TRIGGER = cn(
  "flex flex-1 items-center justify-center gap-1.5 border-b-2 border-transparent px-2 py-3",
  "text-small text-ink-600 transition-colors",
  "hover:text-ink-950",
  "data-[state=active]:border-marine-500 data-[state=active]:text-ink-950"
);

const PANE = "flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden";
// min-h-0 is load-bearing: without it the content sets the track height and
// the inner overflow never engages.
const SCROLLER = "min-h-0 flex-1 overflow-y-auto p-3";

export interface PanelActions {
  announce: (prev: PanelFormState, form: FormData) => Promise<PanelFormState>;
  createTask: (prev: PanelFormState, form: FormData) => Promise<PanelFormState>;
  toggleTask: (prev: PanelFormState, form: FormData) => Promise<PanelFormState>;
}

export function FeedPanel({
  events,
  messages,
  tasks,
  actions,
  ownOrgId,
  organisationName,
  timeZone,
  nowMs,
  canAnnounce,
  canWrite,
}: {
  events: FeedEvent[];
  messages: Message[];
  tasks: Task[];
  actions: PanelActions;
  ownOrgId: string;
  organisationName: string;
  timeZone: string;
  nowMs: number;
  /** Admins only. */
  canAnnounce: boolean;
  /** Admins and operators. */
  canWrite: boolean;
}) {
  const feedScroller = useAutoScroll<HTMLDivElement>({
    // Only worth doing when there is enough to scroll; the hook itself also
    // does nothing when the content fits.
    enabled: events.length > 4,
  });

  return (
    <Tabs.Root
      defaultValue="feed"
      className="flex min-h-0 flex-1 flex-col rounded-panel border border-ink-200 bg-paper shadow-panel"
    >
      <Tabs.List className="flex shrink-0 border-b border-ink-200">
        <Tabs.Trigger value="feed" className={TAB_TRIGGER}>
          <Radio aria-hidden className="size-4" />
          Live feed
        </Tabs.Trigger>
        <Tabs.Trigger value="messages" className={TAB_TRIGGER}>
          <MessageSquare aria-hidden className="size-4" />
          Messages
        </Tabs.Trigger>
        <Tabs.Trigger value="tasks" className={TAB_TRIGGER}>
          <CheckSquare aria-hidden className="size-4" />
          Tasks
        </Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="feed" className={PANE} forceMount>
        {/* Drifts downwards on its own, and stops the instant anyone hovers,
            focuses or scrolls it — a moving list cannot be read or clicked.
            Also still under prefers-reduced-motion. */}
        <div ref={feedScroller} className={SCROLLER}>
          {events.length === 0 ? (
            <p className="px-4 py-12 text-center text-small text-ink-400">
              Nothing recorded yet. Checkpoints, status changes and company
              notices appear here as they happen.
            </p>
          ) : (
            <ol className="flex flex-col gap-list">
              {events.map((event) => (
                <FeedEventCard key={event.id} event={event} nowMs={nowMs} />
              ))}
            </ol>
          )}
        </div>

        <PanelComposer
          action={actions.announce}
          placeholder={`Announce to everyone at ${organisationName}…`}
          disabledReason={
            canAnnounce ? null : "Only an admin can post a company notice."
          }
        />
      </Tabs.Content>

      <Tabs.Content value="messages" className={PANE} forceMount>
        <div className={SCROLLER}>
          <MessagesTab messages={messages} ownOrgId={ownOrgId} nowMs={nowMs} />
        </div>
      </Tabs.Content>

      <Tabs.Content value="tasks" className={PANE} forceMount>
        <div className={SCROLLER}>
          <TasksTab tasks={tasks} timeZone={timeZone} onToggle={actions.toggleTask} />
        </div>

        <PanelComposer
          action={actions.createTask}
          placeholder="Add a task…"
          disabledReason={canWrite ? null : "Your role cannot create tasks."}
        />
      </Tabs.Content>
    </Tabs.Root>
  );
}
