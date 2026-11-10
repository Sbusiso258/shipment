import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AssignmentPanel } from "@/components/journey/assignment-panel";
import { CheckpointComposer } from "@/components/journey/checkpoint-composer";
import { HistoryPanel } from "@/components/journey/history-panel";
import { JourneyHeader } from "@/components/journey/journey-header";
import { ShipmentJourney } from "@/components/journey/shipment-journey";
import { PartyPanel } from "@/components/parties/party-panel";
import { LifecycleControls } from "@/components/shipments/lifecycle-controls";
import { Button } from "@/components/ui/button";
import { journeySummary, type JourneyClock } from "@/lib/journey";
import {
  canAssignShipments,
  canEditShipments,
  canLogCheckpoints,
  canManageParties,
} from "@/lib/roles";
import { listAssignments, type Assignee } from "@/services/assignments";
import { orNoticed } from "@/services/fail";
import { requireSession } from "@/services/bootstrap";
import { loadPlaces } from "@/services/checkpoints";
import { loadShipmentHistory } from "@/services/history";
import { listParties } from "@/services/parties";
import { listMembers } from "@/services/provisioning";
import { loadJourney } from "@/services/shipments";

import {
  assignOperator,
  confirmStage,
  grantPartyAction,
  lifecycleAction,
  recordStage,
  removeAssignment,
  revokePartyAction,
  setPartyMessagingAction,
} from "./actions";

/** In Next 16 `params` is a Promise and must be awaited. */
type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const journey = await loadJourney(id);
  return { title: journey?.shipment.reference ?? "Shipment" };
}

export default async function ShipmentPage({ params }: Params) {
  const { id } = await params;
  const session = await requireSession();
  const journey = await loadJourney(id);

  // RLS returns nothing rather than refusing, so a shipment this user may not
  // see is indistinguishable from one that does not exist — and that is
  // correct. A 403 would confirm a shipment exists to someone who may not
  // know that.
  if (!journey) notFound();

  const clock: JourneyClock = {
    now: new Date(),
    timeZone: session.activeOrg.timezone,
    silenceThresholdDays:
      journey.shipment.silenceThresholdDays ??
      session.activeOrg.defaultSilenceThresholdDays,
  };

  const summary = journeySummary(journey.shipment, journey.checkpoints, clock);

  const mayLog = canLogCheckpoints(session.activeRole);

  // The gazetteer is only needed by the composer, so a viewer never pays for
  // it. RLS would allow the read; there is simply no reason to make it.
  const places = mayLog ? await loadPlaces() : [];

  // The shipment id is bound HERE, on the server. A server action is a public
  // endpoint, so an id travelling through the form would be an id the client
  // could change — binding it means the action can only ever write to the
  // shipment whose page rendered it.
  const record = recordStage.bind(null, journey.shipment.id);
  const confirm = confirmStage.bind(null, journey.shipment.id);

  // Only an admin gets the assignment panel, and not because hiding it
  // secures anything — RLS refuses the write regardless. It is that
  // `org_members` refuses a non-admin outright, so nobody else can turn the
  // user ids on an assignment row into people. A panel of bare uuids would be
  // worse than no panel.
  const mayAssign = canAssignShipments(session.activeRole);

  // THE JOURNEY IS THE POINT OF THIS PAGE. The two admin panels below it are
  // not, and `shipment_assignments` arrives in a migration a live project may
  // not have yet — so a database that is behind used to take the whole screen
  // down over a side panel.
  //
  // The failure is still shown, loudly, in the place it belongs: a notice on
  // the panels naming the migration. What it no longer does is hide the
  // shipment somebody came here to look at.
  //
  // `orNoticed` now lives in `@/services/fail` beside `SchemaBehindError`, so
  // the other pages that let a side query take them down can use it too.
  const [assignmentsResult, membersResult] = mayAssign
    ? await Promise.all([
        orNoticed(listAssignments(journey.shipment.id), [] as Awaited<
          ReturnType<typeof listAssignments>
        >),
        orNoticed(listMembers(session.activeOrg.id), [] as Awaited<
          ReturnType<typeof listMembers>
        >),
      ])
    : [
        { value: [], notice: null },
        { value: [], notice: null },
      ];

  const assignments = assignmentsResult.value;
  const members = membersResult.value;

  const byUser = new Map(members.map((m) => [m.userId, m]));

  // An assignment whose member row has gone — somebody removed from the
  // organisation — is dropped rather than rendered as an unknown id. They
  // cannot see the shipment either way: `is_assigned_to_shipment` re-checks
  // membership for exactly this case.
  const assignees: Assignee[] = assignments.flatMap((row) => {
    const member = byUser.get(row.userId);
    if (!member) return [];
    return [
      {
        assignmentId: row.id,
        userId: row.userId,
        fullName: member.fullName,
        email: member.email,
        role: member.role,
        assignedAt: row.createdAt,
      },
    ];
  });

  const assigned = new Set(assignments.map((row) => row.userId));
  const candidates = members.filter((m) => m.role !== "admin" && !assigned.has(m.userId));

  const assign = assignOperator.bind(null, journey.shipment.id);
  const unassign = removeAssignment.bind(null, journey.shipment.id);
  const lifecycle = lifecycleAction.bind(null, journey.shipment.id);

  const mayEdit = canEditShipments(session.activeRole);
  const mayShare = canManageParties(session.activeRole);

  // Only an admin pays for this read; it is their panel.
  const partiesResult = mayShare
    ? await orNoticed(
        listParties(journey.shipment.id),
        [] as Awaited<ReturnType<typeof listParties>>
      )
    : { value: [], notice: null };

  const parties = partiesResult.value;

  // THE TRAIL IS NOT AN ADMIN PANEL. An operator looking at a disputed
  // delivery needs to see what was changed on the load they are carrying as
  // much as an admin does, and `decision_logs_select_member` already narrows
  // it to the loads they can see — so there is no role check here, only the
  // policy. A party organisation gets nothing, which is the policy too.
  const historyResult = await orNoticed(
    loadShipmentHistory(journey.shipment.id),
    [] as Awaited<ReturnType<typeof loadShipmentHistory>>
  );

  // One missing migration is one fact, not three.
  const schemaNotice =
    assignmentsResult.notice ??
    membersResult.notice ??
    partiesResult.notice ??
    historyResult.notice;

  // Names for the trail. `members` is only loaded for somebody who may
  // assign, so for everybody else this is empty and `describeActor` says "a
  // former member" rather than inventing one — the honest answer when the
  // viewer is not allowed to list who is in the organisation.
  //
  // A member with no name recorded falls back to their email rather than to
  // "a former member", which would be false about somebody still in the
  // organisation.
  const actorNames: Record<string, string> = Object.fromEntries(
    members.flatMap((member) => {
      const name = member.fullName ?? member.email;
      return name ? [[member.userId, name] as const] : [];
    })
  );

  const share = grantPartyAction.bind(null, journey.shipment.id);
  const unshare = revokePartyAction.bind(null, journey.shipment.id);
  const messaging = setPartyMessagingAction.bind(null, journey.shipment.id);

  const pending = journey.checkpoints
    .filter((cp) => cp.actualAt === null)
    .sort((a, b) => a.sequenceNo - b.sequenceNo);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="text-small text-ink-600 hover:text-ink-950">
          ← Back to the board
        </Link>

        {mayEdit ? (
          <Button asChild variant="secondary" size="sm">
            <Link href={`/shipments/${journey.shipment.id}/edit`}>Edit</Link>
          </Button>
        ) : null}
      </div>

      <JourneyHeader
        shipment={journey.shipment}
        summary={summary}
        origin={journey.origin}
        destination={journey.destination}
        timeZone={clock.timeZone}
      />

      {/* Lifecycle lives here rather than in the edit form: dispatching is an
          EVENT that happened, not a correction to a record. */}
      {mayEdit ? (
        <LifecycleControls
          shipment={journey.shipment}
          action={lifecycle}
          mayCancel={canManageParties(session.activeRole)}
        />
      ) : null}

      <ShipmentJourney
        checkpoints={journey.checkpoints}
        states={Object.fromEntries(summary.states)}
        timeZone={clock.timeZone}
        mapStyleUrl={process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? null}
      />

      {/* Said once, above both panels, because one missing migration is one
          fact and not two. */}
      {schemaNotice ? (
        <section
          role="alert"
          className="rounded-panel border border-late/30 bg-late-bg p-panel"
        >
          <h2 className="text-small font-medium text-late">
            Sharing and assignment are unavailable
          </h2>
          <p className="mt-1 whitespace-pre-wrap font-code text-micro text-late">
            {schemaNotice}
          </p>
          <p className="mt-2 text-small text-ink-600">
            Everything else on this page is live. The journey, the stages and
            the board all work.
          </p>
        </section>
      ) : null}

      {mayShare && !schemaNotice ? (
        <PartyPanel
          grants={parties}
          grantAction={share}
          revokeAction={unshare}
          messagingAction={messaging}
        />
      ) : null}

      {mayAssign && !schemaNotice ? (
        <AssignmentPanel
          assignees={assignees}
          candidates={candidates}
          assignAction={assign}
          removeAction={unassign}
        />
      ) : null}

      <HistoryPanel
        entries={historyResult.value}
        actorNames={actorNames}
        viewerId={session.userId}
        notice={historyResult.notice}
        timeZone={clock.timeZone}
      />

      {/* A viewer is shown no composer at all. Not because hiding it secures
          anything — RLS refuses the write regardless — but because offering
          someone a form that always fails is a lie. */}
      {mayLog ? (
        <CheckpointComposer
          pending={pending}
          places={places}
          recordAction={record}
          confirmAction={confirm}
          timeZone={clock.timeZone}
        />
      ) : null}
    </main>
  );
}
