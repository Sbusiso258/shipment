# Going live on your Supabase project

Everything in this repository has been verified against a throwaway in-process
Postgres. **None of it has touched your real project.** These are the steps to
change that, and what to check at each one.

Do them in order. Each is reversible except step 3.

---

## 1. Put the keys in `.env.local` — DONE

Already written for project `sfbpknnmaiqtadziyely`, and verified: the app
reaches the auth server, the sign-in form renders instead of the setup notice,
and a failed sign-in returns the right message. The publishable
(`sb_publishable_…`) key format works with `@supabase/ssr`.

For reference, the values come from the dashboard → **Settings → API**.

```
NEXT_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<the anon / publishable key>
```

Paste them into the file yourself rather than into a chat window. The anon key
is safe to expose by design — it grants nothing on its own — but the habit is
worth keeping.

**Do not add a service-role key.** There is none in this project and there must
never be one: it bypasses row-level security entirely, so a single leak would
expose every organisation's shipments at once.

`.env.local` already contains `NEXT_PUBLIC_MAP_STYLE_URL`; leave it as it is.

**Check:** `npm run build && npm run start`, open http://localhost:3400 — the
setup notice should be replaced by a sign-in form.

---

## 2. Re-verify before you apply anything

```bash
npm run verify:migrations   # 114 checks
npm run verify:rls          #  74 checks
```

Both must pass. They run in-process and touch nothing remote.

---

## 3. Apply the migrations — the irreversible step, and THE NEXT THING TO DO

The project is currently empty: every table returns
`PGRST205 Could not find the table`. Nothing works until this is done.

Open the dashboard → **SQL Editor**, and paste the whole of:

```
supabase/apply-all.sql
```

It is all five migrations in order, wrapped in `begin; … commit;`, so it either
all applies or none of it does. Pasting five files by hand is five chances to
get the order wrong or stop halfway and leave a half-built schema that neither
works nor fails cleanly.

Regenerate it with `bash supabase/bundle-migrations.sh` after any migration
change. That script refuses to bundle anything that cannot run in a
transaction (`CREATE INDEX CONCURRENTLY`, `ALTER TYPE … ADD VALUE`), which a
future migration may well need — those get applied on their own.

The individual files in `supabase/migrations/` remain the source of truth and
the forward-only record.

**Migrations are forward-only.** Once applied, a file is frozen: a mistake is
corrected by a new `0006_…`, never by editing one of these. That is why this
step is last.

**Check:** the Table Editor shows the tables, and `sa_places` has 521 rows.
Reloading http://localhost:3400 should then get past the database entirely —
you will still need an account, which is step 4.

---

## 4. Make yourself the platform owner

Create your own user: **Authentication → Users → Add user**.

Then, in the SQL editor:

```sql
insert into public.platform_admins (user_id, note)
select id, 'founder' from auth.users where email = 'you@example.com';
```

This has to be done by hand, and that is deliberate. `platform_admins` has a
SELECT policy and **no write policy at all**, so no path through the
application can add a platform admin. The most privileged table in the system
is unreachable from the product, which makes privilege escalation
unrepresentable rather than merely unlikely.

---

## 5. Create an organisation and invite someone — in the app

Sign in and go to **`/admin`**. It is reachable even though you have no
membership yet: the owner area checks `platform_admins` directly, because
sending a freshly seeded owner to "you are not in an organisation" would make
the product unopenable from a cold start.

From there:

1. Create an organisation. A **subscriber** records its own shipments; a
   **counterparty** only ever views shipments shared with it.
2. Open it and invite yourself as an `admin`.
3. Add that user in the dashboard under **Authentication → Users**. A database
   trigger turns the matching invitation into a membership on first sign-in.

Step 3 is the manual half, and it is the price of having no service-role key:
creating users programmatically would need one, and one leaked service-role key
exposes every organisation at once. The invite screen says so on the page.

**Invited someone who already has an account?** The signup trigger fires once
and cannot help them. They click **Check for an invitation** on `/no-access`,
which claims any invitation addressed to their own verified email.

---

## 6. Prove the tenancy boundary against the real thing

`verify:rls` reproduces Supabase's roles, grants and `auth.uid()` faithfully,
but it is a model, not Supabase. Before a paying customer, run the same
scenarios for real:

1. Create a second organisation and a user in it.
2. Create a shipment in the first, and grant the second organisation
   visibility as a party.
3. Sign in as each, in two different browser profiles, side by side.
4. Confirm the party sees that one shipment, cannot edit anything, and cannot
   see the owner's other depots.
5. Revoke the grant and reload — access should disappear immediately.

That last one is the promise the product makes. It is worth watching happen.

---

## What is still missing

- **Owner provisioning screens** do not exist, hence the SQL in steps 4 and 5.
  Everything else — the board, the journey view, recording stages — is built.
- **The stages themselves are unverified against a real operation.** The
  checkpoint kinds come from standard road-freight practice, not from a
  business you run. They are forward-extensible, but worth checking against a
  real operator before the first customer. See
  [open-questions.md](open-questions.md).
