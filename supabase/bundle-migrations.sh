#!/usr/bin/env bash
#
# Regenerates supabase/apply-all.sql — every migration, in order, wrapped in
# one transaction, for pasting into the Supabase SQL editor on a fresh project.
#
#   bash supabase/bundle-migrations.sh
#
# The files in supabase/migrations/ remain the source of truth and the
# forward-only record. This is a convenience for the first install only: once
# a schema is live, a change is a NEW numbered migration applied on its own,
# never a re-run of this bundle.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/apply-all.sql"

# A single transaction is only safe while nothing needs to run outside one.
# CREATE INDEX CONCURRENTLY and ALTER TYPE ... ADD VALUE both do, and both are
# plausible future additions — so this refuses rather than producing a bundle
# that fails halfway through somebody's production database.
if grep -niE "concurrently|alter type .* add value" "$DIR"/migrations/*.sql; then
  echo >&2
  echo >&2 "REFUSING: the statements above cannot run inside a transaction."
  echo >&2 "Apply that migration on its own, and exclude it from the bundle."
  exit 1
fi

{
  cat <<'HEADER'
-- apply-all.sql — every migration, in order, as one transaction.
--
-- GENERATED. Do not edit: edit the migrations and regenerate with
--   bash supabase/bundle-migrations.sh
--
-- Wrapped in BEGIN/COMMIT so it either all applies or none of it does.
-- Applying five files by hand means five chances to paste one out of order,
-- or to stop after three and leave a half-built schema that neither works nor
-- fails cleanly.

begin;

HEADER

  for file in "$DIR"/migrations/*.sql; do
    printf '\n-- ============================================================\n'
    printf -- '-- %s\n' "$(basename "$file")"
    printf -- '-- ============================================================\n'
    cat "$file"
  done

  printf '\ncommit;\n'
} > "$OUT"

echo "Wrote $OUT ($(wc -l < "$OUT") lines)"
