# Capital Control

Administration system for a money-lending business: clients, loans, payments,
partial payments, renewals, settlements, portfolio, cash, income, expenses,
reports and history.

Not a dashboard template. Every figure it shows is derived from a recorded
financial movement, inside a transaction, on a real database.

**Free software**, under the GNU Affero General Public License v3. Run it for
your own business and you owe nobody anything — see [License](#license).

---

## Table of contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Environment variables](#environment-variables)
- [Database](#database)
- [Running it](#running-it)
- [Production](#production)
- [Backups](#backups)
- [Project structure](#project-structure)
- [The financial rules](#the-financial-rules)
- [Verification](#verification)
- [License](#license)

---

## Requirements

| | |
|---|---|
| Node.js | 24 or newer |
| PostgreSQL | 17 or newer |
| Disk | ~1 GB for the app; the database grows slowly |

PostgreSQL should be created with the `es-CO` ICU locale so that `ORDER BY`
sorts names the way a Colombian reader expects (`Ñungo` after `Nieto`, not after
`Zapata`).

---

## Installation

```bash
git clone <repository-url> capital-control
cd capital-control
cp .env.example .env
npm ci
```

`.env` must exist **before** `npm ci`: installing generates the database client,
and that reads `DATABASE_URL`. The template ships with a working placeholder, so
the install succeeds before you have a real database.

Then edit `.env` — see the next section — and continue with
[Database](#database).

### With Docker

If you would rather not install PostgreSQL by hand:

```bash
cp .env.example .env          # set POSTGRES_PASSWORD and AUTH_SECRET
docker compose up -d
docker compose exec app npm run db:deploy
docker compose exec app npm run db:seed
```

The app is then on `http://localhost:3000`.

One deployment can serve one business or several. Every tenant-scoped table
carries an `organizationId` and is under Row-Level Security, so the database
itself keeps one lender's rows away from another.

---

## Environment variables

Copy `.env.example` to `.env`. Never commit `.env`.

| Variable | Required | What it is |
|---|:---:|---|
| `DATABASE_URL` | yes | PostgreSQL connection string. Pooled, on a managed database |
| `DIRECT_URL` | no | Unpooled connection, used only by migrations and the seed |
| `AUTH_SECRET` | yes | Signs session cookies. **Generate a fresh one per deployment** |
| `AUTH_URL` | yes | Public base URL, e.g. `https://prestamos.minegocio.co` |
| `SEED_ADMIN_EMAIL` | first run | Login for the bootstrap administrator |
| `SEED_ADMIN_PASSWORD` | first run | Its password. Change it after the first login |
| `SEED_ADMIN_NAME` | no | Display name |
| `SEED_ORG_NAME` | first run | Business name shown in the interface |
| `SEED_ORG_SLUG` | first run | Internal identifier, lowercase, no spaces |
| `SEED_DEMO_DATA` | no | `true` loads example clients and loans. **Never in production** |

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`AUTH_SECRET` is the key to every open session. If it leaks, replace it — every
user simply logs in again.

---

## Database

### Creating it

```sql
CREATE DATABASE capital_control
  WITH ENCODING 'UTF8'
       LOCALE_PROVIDER icu
       ICU_LOCALE 'es-CO'
       TEMPLATE template0;
```

### Migrations

The schema is versioned in `prisma/migrations/`. Apply it:

```bash
npm run db:deploy      # production: applies pending migrations only
npm run db:migrate     # development: creates a new migration from schema changes
```

### Seed

```bash
npm run db:seed
```

Creates the organization, the administrator, the default expense and income
categories, the payment methods and the cash account. It is idempotent: running
it twice does not duplicate anything.

With `SEED_DEMO_DATA=true` it also loads ten clients with a year of loan and
payment history — useful to see the system populated before committing to it.

### Other commands

```bash
npm run db:studio      # browse the data
npm run db:generate    # regenerate the Prisma client after editing the schema
npm run db:reset       # DROPS EVERYTHING, re-migrates and reseeds. Development only
```

---

## Running it

```bash
npm run dev            # http://localhost:3000
```

Sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.

After five failed attempts an account locks for fifteen minutes. That is
deliberate and it is recorded in the audit log.

### Locked out, or lost the password

There is no reset email and no security question. This is private software that
sends nothing to anybody and depends on no mail service — the cost of that
choice is that recovery happens from the server:

```bash
npm run user:password -- --list                  # who exists
npm run user:password -- someone@example.com     # new password, printed once
npm run user:password -- someone@example.com --password "one you choose"
npm run user:password -- someone@example.com --unlock   # just clear the lockout
```

Shell access is the credential here: whoever owns an installation has it, and
somebody on the internet does not. Changing a password closes that user's open
sessions and clears any lockout at the same time — being locked out is usually
why you are running it.

### Portable PostgreSQL (Windows, no administrator rights)

If you cannot install PostgreSQL as a service:

```bash
npm run db:start       # starts the portable cluster
npm run db:status
npm run db:psql
npm run db:stop
```

It looks for the cluster next to the repository, or wherever `PGSQL_HOME`
points.

---

## Production

```bash
npm run build
npm start
```

Before exposing it to the internet:

1. **Serve it over HTTPS.** Session cookies are `Secure`; without TLS nobody can
   log in.
2. **Set a real `AUTH_URL`.**
3. **Set `SEED_DEMO_DATA=false`.**
4. **Change the seeded administrator password.**
5. **Schedule the backups** — see [`docs/BACKUP.md`](docs/BACKUP.md).

For a step-by-step VPS deployment with automatic TLS, see
[`docs/DEPLOY.md`](docs/DEPLOY.md).

To publish it on a link that works from anywhere — a managed PostgreSQL and a
serverless host, no machine of your own to keep running — see
[`docs/PUBLICAR-EN-LINEA.md`](docs/PUBLICAR-EN-LINEA.md) (Spanish). That setup
needs a second connection string: the application uses the pooled `DATABASE_URL`
and the CLI uses the unpooled `DIRECT_URL`, because a pooler in transaction mode
cannot run schema changes.

To run it on a single computer and reach it from phones on the same WiFi — no
server, no monthly cost — see [`docs/INSTALAR-EN-PC.md`](docs/INSTALAR-EN-PC.md),
written in Spanish for somebody who does not program. That setup needs
`ALLOW_INSECURE_COOKIES="true"`, because a local network has no certificate and
a `Secure` cookie would simply be discarded. Never set it on anything reachable
from the internet.

The app is installable as a PWA: on a phone, "Add to home screen" gives the
collector a full-screen app with no address bar.

Offline, it shows a page that says there is no connection and **no figures at
all**. A cached balance is a wrong balance, and a payment taken against one
corrupts the ledger.

---

## Backups

```bash
npm run backup                                    # create
npm run backup:list                               # list
npm run backup:restore -- <file>.dump --force     # restore (replaces everything)
```

Read [`docs/BACKUP.md`](docs/BACKUP.md) before you need it. The short version:
a backup that lives only on the machine running the system is not a backup.

---

## Project structure

```
src/
  core/         Financial engine. No framework, no database, no I/O.
    money/      Money value object over decimal.js. Refuses floats.
    time/       CalendarDate: a business date, never a timestamp.
    loans/      Interest, accrual, state, renewal, settlement.
    payments/   Allocation of a payment across its destinations.
    cash/       Ledger projection, operating result, equity.
    metrics/    Ratios and growth indicators.

    billing/    Subscription dates: paid through when, cut off when.

  services/     Use cases. Each takes a transaction and writes rows.
  server/       Server-only queries and Server Actions, per module.
  app/          Routes (App Router). One folder per screen.
  components/   Shared interface pieces.
  infra/db/     Prisma client and the Decimal ↔ Money boundary.

prisma/schema/  36 tables, 33 enums, zero float columns, 33 under RLS.
scripts/        Integration verification, backups, local database.
docs/           Backup, restore and migration.
```

The dependency direction never inverts: `core` knows nothing about Prisma or
Next.js, which is why its 272 tests run in under four seconds and why the
financial rules can be read without a database in front of you.

---

## The financial rules

These are decisions, not implementation details. Anyone operating or selling
this system should know them.

### Money is never a float

Every amount is `NUMERIC(18,2)` in the database and a `Money` object backed by
`decimal.js` in the code. `Money` refuses a JavaScript `number` at both the type
level and at runtime. It never rounds implicitly: rounding is an explicit
operation with a stated mode.

`0.1 + 0.2 !== 0.3` is a curiosity in a tutorial and a lawsuit in a loan book.

### Recovered capital is not profit

When a client pays $300,000 and $200,000 of it is interest and $100,000 is
principal, the business earned $200,000 and got $100,000 of its own money back.
Each half is written as a separate cash movement with a different financial
class, and the profit report reads only the classes that are actually income.

This is enforced structurally: `FinancialClass` is an enum, and a movement of
class `PRINCIPAL` cannot be counted as income anywhere in the system.

### Interest accrues when a period falls due, never before

A period materializes exactly when today reaches its due date. Projections of
future interest are computed on demand and **never written**, so the books never
contain a charge that has not yet occurred.

### Changing the configuration never rewrites the past

Each loan freezes its rules — rate, method, periodicity, allocation strategy,
rounding — at the moment it is created. Each period freezes the principal basis
and rate it was computed with. Changing a default in Settings affects the *next*
loan, and no existing balance moves.

### Nothing financial is deleted

A mistake is corrected with a **reversal**: the original entry stays, flagged,
and a compensating entry undoes its effect. Both sides remain visible in
`/historial` forever. Reversals require a written reason, cannot be applied
twice, and are restricted to administrators.

### A loan's state is two facts, not one

`lifecycle` (active / paid / cancelled) and `compliance` (up to date / due soon
/ overdue) are separate columns. That is what makes "overdue and still active"
and "settled while it was overdue" both expressible without inventing a state
that means two things.

A loan becomes `PAID` at exactly zero — never at "close enough".

### One lender can never see another's data

Every tenant-scoped table carries an `organizationId`, every query filters by
it — and PostgreSQL enforces it underneath, through Row-Level Security. A
statement declares which organization it belongs to before it runs, and the
policies do the rest.

That redundancy is the point. The application's filters are the first line; the
database is what still holds when one query forgets. A missing filter produces
an **empty screen** — a bug somebody reports — instead of another lender's
clients on someone's page.

Absence of context denies rather than permits: a query that never declared a
tenant returns nothing at all. The declaration is transaction-local, so it
cannot outlive a request and be inherited by whoever picks up that pooled
connection next.

`npm run verify:tenancy` proves it. From inside one organization it runs
queries with **no filter at all** — raw SQL and lookups by exact id included —
against a second organization's data, and every one comes back empty.

### Archiving is the only "delete", and it deletes nothing

A client who has ever moved money is never removed. Archiving takes them out of
the day-to-day lists and leaves every loan, payment, receipt and cash movement
exactly where it is, still counted in every historical report. Their file stays
readable and they can be brought back.

It refuses while the client still owes: the message names the loans and the
outstanding capital. Hiding a debtor is not tidying up, it is losing a debt —
the balance would keep counting in the portfolio while the person who owes it is
nowhere in the interface.

### The platform operator is not an administrator

`ADMIN` is the role every customer's own administrator holds, so it can never
gate anything that crosses organizations. Operating the platform — seeing which
businesses exist, suspending one that has not paid — is a separate flag that
**cannot be granted from the interface at all**:

```bash
npm run platform:owner -- --list
npm run platform:owner -- vos@tunegocio.co
npm run platform:owner -- vos@tunegocio.co --revoke
```

Shell access to the server is the only way to obtain it. Whoever sells the
software has that; their customers do not. If a screen could grant it, a stolen
administrator session would be one click from becoming a stolen everything.

That screen is deliberately starved: names, status, dates and counts. No
balance, no client, no peso. `verify:platform` asserts it — it inspects the
fields the query actually returns and fails if any of them looks like an
amount.

**Suspension is a lock, never a deletion.** Every client, loan, payment and
movement stays exactly where it is, and reactivating restores the business
untouched. The check counts every financial row before and after and refuses a
suspension that changed any of them. A lender who lost their records over a
late subscription would be entitled to sue, and would be right.

The reason is recorded in the customer's own history, where they can read it
and argue with it.

### Charging for the platform never touches the lender's books

Subscriptions live in their own tables and their own engine. Suspending a
customer who has not paid sets a status the data access layer already re-reads
on every request — nothing of theirs is deleted, and `verify:billing` counts
every client, loan, payment and movement before and after to prove it.

Recording a payment reactivates them in the same transaction, because a
customer who has paid should not have to wait for somebody to remember.

When a payment arrives late, the new period is measured from where the last one
ended rather than from the day the money arrived — so being late buys nothing
and the billing day never drifts. That is the same rule already chosen for loan
renewals, and it is a stored setting per subscription, not a constant.

**No payment gateway is integrated.** The money can arrive by transfer, cash or
a processor, and none of that changes what has to be recorded. A gateway, when
there is one worth choosing, becomes another caller of the same service.

```bash
npm run billing:enforce -- --dry-run   # what it would cut off
npm run billing:enforce                # do it
```

Run the dry run first, every time you change the grace days.

### Every balance is derived, never cached

Outstanding principal, pending interest, portfolio, cash and profit are computed
from the recorded movements each time they are asked for. A past date can be
reconstructed from the ledger alone:

```
principalOutstanding(D) = Σ(principal out) − Σ(principal in) − Σ(write-offs)
```

This is checked by `npm run verify` against the live balances.

### Rates are configurable, and the system does not judge them

The system never assumes an entered rate is legal or illegal. It stores what you
tell it and shows it transparently, stating the period it refers to.

Optionally, you can set a threshold in Settings above which the interface shows
an administrative reminder to review the rate. It is **a visual note and nothing
else**: it does not modify any contract, does not alter any balance, and does not
consult any external source.

### The clock is the business's, not the server's

"Today" is resolved in the organization's configured time zone. A collection due
on the 24th is due on the 24th in Bogotá regardless of where the server sits.

---

## Verification

```bash
npm run db:test   # builds a throwaway database seeded with demo data
npm test          # 272 unit tests of the financial engine
npm run typecheck
npm run verify    # everything above, plus fourteen integration checks
```

`db:test` is a prerequisite and only has to be run once. The integration checks
need data to work on, and they get their own database for it — rolling back a
transaction is not a reason to point them at a live business.

The integration scripts post real payments, renewals, settlements and reversals
against the real database and then **roll every transaction back**. They exist to
prove the wiring — that allocations are written, periods updated, cash moved with
the right classes, state refreshed and audit entries recorded — and they leave
nothing behind.

```
verify:ledger        balances reconcile against the ledger
verify:payments      allocation, cash classes, idempotency
verify:lifecycle     renewals and settlements
verify:cash          closures, discrepancies, equity identity
verify:collections   today's collections and the calendar
verify:analytics     snapshots and indicators
verify:reports       the 11 reports and their exports
verify:reversals     a reversal restores exactly what the payment moved
verify:tenancy       one organization cannot reach another's rows
```

Run `npm run verify` after restoring a backup, after upgrading, and before
handing the system to a customer.

---

## License

GNU Affero General Public License v3 — full text in [LICENSE](LICENSE), plain
language in [NOTICE](NOTICE).

**Running it for your own lending business carries no obligations whatsoever.**
Use it, change it, keep it to yourself. Nobody has to be told and nothing has
to be published.

The obligation appears only if you modify it *and* let other people use your
modified version — including over a network, which is why this is the Affero
licence rather than the plain GPL. Those people are then entitled to the source
of what they are using.

You may charge for installing, hosting, supporting or training. What you may
not do is take this work, close it, and hand somebody a version they cannot see
or share.

It is distributed **without warranty**. Whoever runs it is responsible for their
own books, their own backups, and their own compliance with the law where they
operate.
