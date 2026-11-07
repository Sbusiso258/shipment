-- 0007_collaboration.sql — announcements, messages and tasks.
--
-- THIS MIGRATION ADDS THE FIRST WRITE PATH FOR A PARTY ORGANISATION, and that
-- deserves to be read carefully rather than skimmed.
--
-- Non-negotiable #6 says: "Any policy that grants a party insert, update or
-- delete ON A SHIPMENT IT DOES NOT OWN is a bug." Read precisely, that governs
-- the oversight record — shipments, checkpoints, locations, shipment_parties —
-- and NOT ONE POLICY ON THOSE FOUR TABLES CHANGES HERE. A message is
-- correspondence *about* a journey, not a claim about the journey. A consignee
-- still cannot say "it was delivered"; they can only ask.
--
-- Four risks come with that, each answered structurally rather than by care:
--
--   A forged sender — a party inserting a message that appears to come from
--   the carrier's own staff, inside the carrier's own interface. This is a
--   TRUST leak rather than a data leak, and it is the worst thing here.
--   Answered by requiring sender_user_id = auth.uid() and membership of
--   sender_org_id.
--
--   A party broadcasting into the owner's internal stream. Made structurally
--   impossible: a message with a counterparty MUST name a shipment.
--
--   Revocation ceasing to bite. The insert policy carries the same
--   `revoked_at is null` clause the read path does.
--
--   Every existing grant becoming a message channel the moment this applies.
--   Answered by `messaging_enabled`, defaulting to FALSE. The headline
--   feature is therefore off until an admin turns it on per grant — which is
--   right, because the alternative silently widens every grant already in the
--   database.
--
-- ONE MORE RULE, and it is the subtle one: NOTHING HERE MAY TOUCH
-- `shipments.last_event_at`. If a message updated it, a chatty consignee
-- would silence the owner's own "silent shipment" alarm — a party suppressing
-- the carrier's alerting by talking. There is no trigger from `messages` to
-- `shipments`, and `verify:rls` asserts the value is unchanged after a party
-- writes.
--
-- Forward-only. Never edit a migration that has been applied.


-- ===========================================================================
-- Per-grant messaging
-- ===========================================================================

alter table public.shipment_parties
  add column messaging_enabled boolean not null default false;

comment on column public.shipment_parties.messaging_enabled is
  'Whether this party may send messages about the shipment. Defaults to false '
  'so applying this migration does not retroactively open every existing grant.';


-- ===========================================================================
-- announcements — the "Company" notices
-- ===========================================================================

create table public.announcements (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (id) on delete cascade,

  title text not null check (length(btrim(title)) between 1 and 160),
  body  text not null check (length(btrim(body)) between 1 and 4000),

  pinned       boolean not null default false,
  published_at timestamptz not null default now(),
  expires_at   timestamptz,

  retracted_at timestamptz,
  retracted_by uuid references auth.users (id) on delete set null,

  posted_by  uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint announcements_expires_after_publish
    check (expires_at is null or expires_at > published_at),
  -- Half a retraction is worse than none: it records that something was
  -- withdrawn without recording who did it.
  constraint announcements_retraction_paired
    check ((retracted_at is null) = (retracted_by is null))
);

create index announcements_org_recent_idx
  on public.announcements (org_id, published_at desc);
create index announcements_org_live_idx
  on public.announcements (org_id, published_at desc)
  where retracted_at is null;

create trigger announcements_set_updated_at
  before update on public.announcements
  for each row execute function public.set_updated_at();

-- NOTE: expiry is NOT evaluated here. The row carries `expires_at` and
-- `retracted_at` raw, and src/lib drops expired notices against the server's
-- captured `now`. "Has this expired" is a judgement against a clock, and in
-- this codebase judgements live in the pure layer where the clock is an
-- argument. Same reasoning as `lateness()`.


-- ===========================================================================
-- messages
-- ===========================================================================

create table public.messages (
  id uuid primary key default gen_random_uuid(),

  -- Always the OWNING tenant — the organisation that hosts the conversation.
  -- Never nullable, so every policy on this table is one hop.
  org_id uuid not null,

  -- Null means an internal, organisation-wide message. That is what the
  -- dashboard's broadcast composer sends, and it is why this is nullable
  -- rather than there being a second table.
  shipment_id uuid,

  -- Null means internal. Set means a two-party channel between the owner and
  -- exactly one counterparty.
  --
  -- This column is why a THIRD party organisation on the same shipment cannot
  -- read the conversation. A design with a plain `visibility = 'shared'` flag
  -- would hand a broker the consignee's messages, and would look correct.
  counterparty_org_id uuid references public.organisations (id) on delete cascade,

  sender_org_id  uuid not null references public.organisations (id),
  sender_user_id uuid not null references auth.users (id),

  body text not null check (length(btrim(body)) between 1 and 4000),

  -- Correspondence is retracted, never erased.
  retracted_at timestamptz,
  retracted_by uuid references auth.users (id) on delete set null,

  created_at timestamptz not null default now(),

  constraint messages_counterparty_needs_shipment
    check (counterparty_org_id is null or shipment_id is not null),
  constraint messages_counterparty_not_owner
    check (counterparty_org_id is null or counterparty_org_id <> org_id),
  constraint messages_sender_is_a_participant
    check (sender_org_id = org_id or sender_org_id = counterparty_org_id),
  constraint messages_retraction_paired
    check ((retracted_at is null) = (retracted_by is null)),

  -- Proves the message's tenant agrees with its shipment's.
  --
  -- CAREFUL: Postgres foreign keys are MATCH SIMPLE, so a row with a null
  -- `shipment_id` satisfies this trivially. That is the behaviour we want for
  -- org-wide messages — but it means their tenancy rests on the insert policy
  -- and the `sender_org_id = org_id` constraint alone, not on this FK. That
  -- gap is asserted in verify-behaviour rather than assumed.
  constraint messages_shipment_fkey
    foreign key (shipment_id, org_id)
    references public.shipments (id, org_id) on delete cascade
);

create index messages_org_recent_idx on public.messages (org_id, created_at desc);
create index messages_shipment_idx
  on public.messages (shipment_id, created_at desc)
  where shipment_id is not null;
-- The index the entire party-side inbox depends on.
create index messages_counterparty_idx
  on public.messages (counterparty_org_id, created_at desc)
  where counterparty_org_id is not null;


-- ===========================================================================
-- message_reads — unread counts
-- ===========================================================================
-- Deliberately carries no org_id. Non-negotiable #5 binds OWNABLE ENTITIES; a
-- read receipt is owned by a person, like `profiles` and `platform_admins`,
-- which also carry none.

create table public.message_reads (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  read_at    timestamptz not null default now(),

  primary key (message_id, user_id)
);


-- ===========================================================================
-- tasks
-- ===========================================================================

create type public.task_status   as enum ('open', 'in_progress', 'blocked', 'done', 'cancelled');
create type public.task_priority as enum ('low', 'normal', 'high', 'urgent');

create table public.tasks (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null,

  -- Nullable: "chase the Durban POD" and "renew the fleet insurance" are both
  -- real work, and forcing the second to invent a shipment would be worse
  -- than a nullable column with a composite FK proving agreement.
  shipment_id uuid,

  title  text not null check (length(btrim(title)) between 1 and 160),
  detail text check (detail is null or length(btrim(detail)) between 1 and 2000),

  status   public.task_status not null default 'open',
  priority public.task_priority not null default 'normal',

  -- `timestamptz`, not `date`. Non-negotiable #9: promised_delivery_date is
  -- the ONLY date column, because it is a commercial promise made in days.
  -- A task is due at a time.
  due_at timestamptz,

  assigned_to uuid references auth.users (id) on delete set null,
  assigned_by uuid not null references auth.users (id),

  completed_at timestamptz,
  completed_by uuid references auth.users (id) on delete set null,

  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tasks_shipment_fkey
    foreign key (shipment_id, org_id)
    references public.shipments (id, org_id) on delete cascade,

  constraint tasks_done_has_completion
    check ((status = 'done') = (completed_at is not null)),

  -- A completer implies a completion time, but NOT the reverse.
  --
  -- The obvious `(completed_at is null) = (completed_by is null)` is wrong
  -- here, and the verification caught it: `auth.uid()` is null when a task is
  -- completed outside a user session — an admin running SQL directly, or a
  -- future batch job — and the trigger would then stamp the time, fail to
  -- stamp the person, and the write would be rejected with a constraint name
  -- instead of anything useful. "Completed, completer unknown" is a real and
  -- honest state; "completed by someone, at no particular time" is not.
  constraint tasks_completer_implies_completion
    check (completed_by is null or completed_at is not null)
);

create index tasks_org_due_idx
  on public.tasks (org_id, due_at)
  where status in ('open', 'in_progress', 'blocked');
create index tasks_assignee_idx
  on public.tasks (assigned_to, status)
  where assigned_to is not null;
create index tasks_shipment_idx
  on public.tasks (shipment_id)
  where shipment_id is not null;

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();


-- ===========================================================================
-- Task triggers — one function per table, per the rule in 0004
-- ===========================================================================

-- An assignee must be a member of the task's organisation.
--
-- THIS CLOSES A GENUINE CROSS-TENANT PATH. Without it an admin could assign a
-- task to an arbitrary uuid, and the day anything grants visibility to an
-- assignee, that becomes a window into another tenant.
--
-- `security definer` is justified on the house rule's own terms rather than
-- for convenience: `memberships`' SELECT policy is self-or-admin, so an
-- OPERATOR creating a task would see no membership rows at all and the check
-- would reject every legitimate assignment. It is a visibility problem.
create or replace function public.tasks_guard_assignee()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.assigned_to is not null
     and not exists (
       select 1 from public.memberships m
       where m.user_id = new.assigned_to
         and m.org_id = new.org_id
     )
  then
    raise exception 'Cannot assign a task to someone outside the organisation'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$fn$;

create trigger tasks_guard_assignee
  before insert or update on public.tasks
  for each row execute function public.tasks_guard_assignee();


-- Completion is stamped by the database, not supplied by the caller — the
-- same discipline as `checkpoints_stamp_recorded()` and for the same reason:
-- the caller is not a reliable witness to when the system was told.
create or replace function public.tasks_stamp_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.status = 'done' then
    if tg_op = 'INSERT' or old.status <> 'done' then
      new.completed_at := now();
      new.completed_by := coalesce((select auth.uid()), new.completed_by);
    else
      -- Already done: keep the original stamp, ignore the caller.
      new.completed_at := old.completed_at;
      new.completed_by := old.completed_by;
    end if;
  else
    -- Moved off done — a task reopened must not look finished.
    new.completed_at := null;
    new.completed_by := null;
  end if;

  return new;
end;
$fn$;

create trigger tasks_stamp_completion
  before insert or update on public.tasks
  for each row execute function public.tasks_stamp_completion();


-- ===========================================================================
-- Row Level Security
-- ===========================================================================
-- Every policy scoped `to authenticated`. See the note in 0001.

alter table public.announcements enable row level security;
alter table public.messages      enable row level security;
alter table public.message_reads enable row level security;
alter table public.tasks         enable row level security;

-- --- announcements ---------------------------------------------------------
-- Internal only: not parties, and deliberately NOT the platform admin either.
-- An internal staff notice is internal.
create policy announcements_select_member on public.announcements
  for select to authenticated using (public.is_org_member(org_id));
create policy announcements_insert_admin on public.announcements
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
    and posted_by = (select auth.uid())
  );
create policy announcements_update_admin on public.announcements
  for update to authenticated using (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  )
  with check (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  );
-- No delete: notices are retracted.

revoke update on public.announcements from authenticated;
grant update (title, body, pinned, expires_at, retracted_at, retracted_by)
  on public.announcements to authenticated;

-- --- messages --------------------------------------------------------------
-- NOTE the absence of any `is_platform_admin()` branch, on every policy here.
-- The platform owner runs the platform; they have no business reading their
-- customers' correspondence. verify-behaviour asserts this stays true, because
-- "for consistency with every other table" is a very easy thing to add.
--
-- NO NEW security definer FUNCTION, deliberately. A policy on `messages`
-- reading `shipment_parties` does not recurse — that table's own SELECT policy
-- admits the row to both sides of a grant — so a plain `exists` works as the
-- querying role and is RLS-filtered on the way. This migration therefore adds
-- no RLS-bypassing code at all.
create policy messages_select on public.messages
  for select to authenticated using (
    public.is_org_member(org_id)
    or (
      counterparty_org_id is not null
      and public.is_org_member(counterparty_org_id)
      and public.can_view_shipment(shipment_id)
    )
  );

create policy messages_insert on public.messages
  for insert to authenticated with check (
    -- You are who you say you are. This is the forged-sender defence.
    sender_user_id = (select auth.uid())
    and public.is_org_member(sender_org_id)
    and (
      -- The owning organisation's own staff.
      (
        sender_org_id = org_id
        and case
              when shipment_id is null
                then public.has_org_role(org_id, array['admin']::public.membership_role[])
              else public.is_org_member(org_id)
            end
        and (
          counterparty_org_id is null
          or exists (
            select 1 from public.shipment_parties p
            where p.shipment_id = messages.shipment_id
              and p.org_id = messages.org_id
              and p.party_org_id = messages.counterparty_org_id
              and p.revoked_at is null
          )
        )
      )
      -- Or a live, messaging-enabled party, writing as itself.
      or exists (
        select 1 from public.shipment_parties p
        where p.shipment_id = messages.shipment_id
          and p.org_id = messages.org_id
          and p.party_org_id = messages.counterparty_org_id
          and p.party_org_id = messages.sender_org_id
          and p.messaging_enabled
          and p.revoked_at is null
      )
    )
  );

create policy messages_update_sender on public.messages
  for update to authenticated using (sender_user_id = (select auth.uid()))
  with check (sender_user_id = (select auth.uid()));
-- No delete.

-- Column privileges make the body immutable and the tenant unmovable, which
-- `with check` alone cannot: `sender_user_id = auth.uid()` stays true after a
-- sender rewrites their own message into another organisation.
revoke update on public.messages from authenticated;
grant update (retracted_at, retracted_by) on public.messages to authenticated;

-- --- message_reads ---------------------------------------------------------
create policy message_reads_select_own on public.message_reads
  for select to authenticated using (user_id = (select auth.uid()));
create policy message_reads_insert_own on public.message_reads
  for insert to authenticated with check (
    user_id = (select auth.uid())
    -- RLS-filtered, so you can only mark read a message you can read.
    and exists (select 1 from public.messages m where m.id = message_id)
  );
create policy message_reads_update_own on public.message_reads
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy message_reads_delete_own on public.message_reads
  for delete to authenticated using (user_id = (select auth.uid()));

-- --- tasks -----------------------------------------------------------------
-- There is deliberately NO `or assigned_to = (select auth.uid())` branch on
-- select. The assignee is always a member — `tasks_guard_assignee` guarantees
-- it — so the branch would be redundant, and a redundant entitlement path is
-- how two paths drift apart.
create policy tasks_select_member on public.tasks
  for select to authenticated using (public.is_org_member(org_id));
create policy tasks_insert_staff on public.tasks
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
    and created_by = (select auth.uid())
  );
create policy tasks_update_staff_or_assignee on public.tasks
  for update to authenticated using (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
    or assigned_to = (select auth.uid())
  )
  with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
    or assigned_to = (select auth.uid())
  );
-- No delete: status 'cancelled', as with invitations and party grants.

revoke update on public.tasks from authenticated;
grant update (title, detail, status, priority, due_at, assigned_to,
              completed_at, completed_by)
  on public.tasks to authenticated;
