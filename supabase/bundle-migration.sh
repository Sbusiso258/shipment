#!/usr/bin/env bash
#
# Wraps ONE OR MORE migrations in a single transaction, for pasting into the
# Supabase SQL editor of a project that is already live.
#
#   bash supabase/bundle-migration.sh 0008          -> apply-0008.sql
#   bash supabase/bundle-migration.sh 0008 0009     -> apply-0008-0009.sql
#
# `bundle-migrations.sh` (plural) is the other half of this: every migration at
# once, for a FRESH project. Once a schema is live it must never be re-run —
# a change is a new numbered migration applied on its own, which is this.
#
# WHY A RANGE IS WORTH HAVING. Two pastes are two chances to paste the wrong
# thing, to miss an error that scrolled past, or to stop after the first. When
# a project is several migrations behind, one transaction that catches it all
# the way up is both safer and easier to check: it either all applies or none
# of it does, and there is one result to read instead of two.
#
# WHY THE TRANSACTION MATTERS MORE HERE than in the fresh-project bundle. On a
# fresh project a half-applied schema is annoying; you drop it and start again.
# On a live one it is a database that is neither the old shape nor the new one,
# with customers connected to it. 0008 drops policies before it creates their
# replacements, so a failure in the middle is a table with NO select policy at
# all — which fails closed rather than leaking, but takes the product down.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ $# -lt 1 ]; then
  echo >&2 "usage: bash supabase/bundle-migration.sh <number> [number...]"
  echo >&2 "   eg: bash supabase/bundle-migration.sh 0008 0009"
  exit 2
fi

# Sorted, so the transaction applies them in migration order however they were
# typed. Out-of-order DDL is the kind of thing that works on one database and
# not on another.
NUMBERS=$(printf '%s\n' "$@" | sort -u)

SOURCES=()
for number in $NUMBERS; do
  match=$(ls "$DIR"/migrations/"$number"_*.sql 2>/dev/null | head -1)
  if [ -z "$match" ]; then
    echo >&2 "No migration matching ${number}_*.sql"
    exit 1
  fi
  SOURCES+=("$match")
done

FIRST=$(printf '%s\n' $NUMBERS | head -1)
LAST=$(printf '%s\n' $NUMBERS | tail -1)
if [ "$FIRST" = "$LAST" ]; then
  LABEL="$FIRST"
else
  LABEL="$FIRST-$LAST"
fi

OUT="$DIR/apply-$LABEL.sql"

# Same refusal as the plural bundler: these cannot run inside a transaction,
# and a bundle that fails halfway through a live database is the thing this
# script exists to prevent.
if grep -niE "concurrently|alter type .* add value" "${SOURCES[@]}"; then
  echo >&2
  echo >&2 "REFUSING: the statements above cannot run inside a transaction."
  echo >&2 "Apply that migration on its own, statement by statement."
  exit 1
fi

{
  printf -- '-- apply-%s.sql — %s migration(s), as one transaction.\n' \
    "$LABEL" "$(printf '%s\n' $NUMBERS | wc -l | tr -d ' ')"
  printf -- '--\n'
  printf -- '-- GENERATED. Do not edit: edit the migrations and regenerate with\n'
  printf -- '--   bash supabase/bundle-migration.sh %s\n' "$*"
  printf -- '--\n'
  printf -- '-- Paste the WHOLE file into the Supabase SQL editor and run it once.\n'
  printf -- '-- It either all applies or none of it does.\n'
  printf -- '--\n'
  printf -- '-- Make sure nothing is selected in the editor first: it runs the\n'
  printf -- '-- SELECTION when there is one, and half a statement fails.\n'
  printf -- '--\n'
  printf -- '-- The last statement reports what landed. If no row comes back,\n'
  printf -- '-- it did not run.\n\n'
  printf 'begin;\n\n'

  for file in "${SOURCES[@]}"; do
    printf -- '\n-- ============================================================\n'
    printf -- '-- %s\n' "$(basename "$file")"
    printf -- '-- ============================================================\n'
    cat "$file"
  done

  printf '\ncommit;\n'

  # A VISIBLE RESULT, AFTER THE COMMIT.
  #
  # A successful run of pure DDL prints "Success. No rows returned", which
  # looks exactly like a run that did nothing at all — text was selected in
  # the editor, or the tab was pointed at a different project. Four attempts
  # at applying 0008 came back as a 404 from the API with no way to tell which
  # of those had happened.
  #
  # So the bundle ends by reporting what now exists. It sits outside the
  # transaction, so it cannot affect the apply, and it only reads.
  printf -- '\n\n-- ============================================================\n'
  printf -- '-- Did it work? This row is the answer.\n'
  printf -- '-- ============================================================\n'
  cat <<'CHECK'
-- EVERY MIGRATION IN THE RANGE GETS A COLUMN. This report used to stop at
-- 0009 while the bundle carried five migrations, so a paste that applied
-- part of the range would still return a reassuring row. A null in any
-- column below means that migration did not land.
select
  current_database()                             as database,
  to_regclass('public.shipment_assignments')     as table_0008,
  to_regproc('public.is_assigned_to_shipment')   as function_0008,
  to_regproc('public.find_organisation_by_slug') as function_0009,
  to_regclass('public.drivers')                  as table_0011,
  to_regclass('public.vehicles')                 as table_0011b,
  to_regclass('public.decision_logs')            as table_0012,
  to_regproc('public.write_decision_log')        as function_0012,

  -- 0010 left no new object behind, so it is reported by the behaviour it
  -- fixed: the guard now checks whether the parent organisation still
  -- exists before refusing a cascading delete.
  (select count(*) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'memberships_guard_last_admin'
     and p.prosrc like '%from public.organisations%')
                                                 as must_be_one_0010,

  -- 0008's narrowing is only real once this branch is gone from every
  -- shipment-data policy. Anything other than zero means an operator can
  -- still see loads they are not on.
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename in ('shipments', 'checkpoints')
      and cmd = 'SELECT'
      and qual like '%is_org_member%')           as must_be_zero,

  -- 0012's whole point: one policy on the trail, and it reads.
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'decision_logs'
      and cmd <> 'SELECT')                       as must_be_zero_0012;
CHECK
} > "$OUT"

echo "Wrote $OUT ($(wc -l < "$OUT") lines)"
