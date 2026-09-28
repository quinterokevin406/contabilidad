# Backup, restore and migration

This system is the accounting record of a lending business. Losing the database
means losing the balances, the payment history and the evidence of what each
client owes. There is no way to reconstruct that from memory.

Read this section before the day you need it.

---

## What has to be backed up

**The PostgreSQL database. Nothing else.**

Everything in this product derives from the database: balances, portfolio,
profit, reports. The application code can be reinstalled from the repository in
minutes; the data cannot be reinstalled at all.

What is *not* worth backing up:

| Item | Why not |
|---|---|
| `node_modules/` | Rebuilt by `npm ci` |
| `.next/` | Rebuilt by `npm run build` |
| `src/generated/` | Rebuilt by `prisma generate` |
| `.env` | **Keep it, but not with the backups** — see below |

The `.env` file holds `AUTH_SECRET` and the database password. Store it in a
password manager, not next to the dumps. A backup and the credentials to read
it should never live in the same place.

---

## Taking a backup

```bash
npm run backup
```

Writes a compressed dump to `backups/capital-control-<UTC timestamp>.dump`.

```bash
npm run backup:list
```

To list what you have, with sizes and dates.

The dump is PostgreSQL's custom format (`pg_dump -Fc`), not plain SQL. It is
compressed, and it can be restored selectively — one table at a time — if a
partial recovery is ever needed. A `.sql` file cannot do that.

### Why this is not a plain `pg_dump`

Every tenant table enforces Row-Level Security against the table owner too, so
a bare `pg_dump` refuses to run at all. The flag that makes it run,
`--enable-row-security`, has a far nastier property: with no tenant context it
**exits successfully and writes a file containing zero rows**. Measured on a
live database — ten clients with the context, none without, same exit code,
same reassuring output.

So the script declares the context, and then refuses to trust the result until
it has checked it: it reads the client count from the database before dumping
and counts what actually landed in the file afterwards. A mismatch, or an
unreachable `psql`, aborts and writes nothing.

If you ever replace this script with a hand-rolled `pg_dump` line, you will get
empty backups and no warning. `npm run verify:backup` exists to catch exactly
that.

### Inside Docker

```bash
docker compose exec app npm run backup -- --out /backups
```

The compose file mounts `./backups` into the database container, so the dump
lands on the host and survives the container being rebuilt.

---

## The rule that makes a backup real

> **A backup that only exists on the machine running the system is not a backup.**

The failure you are protecting against — a dead disk, a stolen laptop, ransomware,
a flooded office — takes the original and the copy together if they sit in the
same box.

A workable routine for a small business:

1. **Daily**, automatically, to the server's own disk (fast to restore from).
2. **Weekly**, copied off the machine — an external drive, or a cloud folder.
3. **Monthly**, one copy that leaves the building and is not overwritten.

### Scheduling it

**Linux (cron)** — every night at 2 AM:

```bash
0 2 * * * cd /opt/capital-control && /usr/bin/npm run backup >> /var/log/capital-backup.log 2>&1
```

**Windows (Task Scheduler)** — create a daily task running:

```bash
node "C:\ruta\capital-control\scripts\backup.mjs" create
```

Old dumps are deleted automatically: the script keeps the newest thirty and
removes the rest. Change it with `--keep`:

```bash
npm run backup -- --keep 90
```

Safety copies taken before a restore are never pruned — those exist precisely
because something already went wrong.

### Getting it off the machine for free

If the computer already has OneDrive, Google Drive or Dropbox installed, point
the backup at that folder and the copy leaves the machine on its own:

```bash
npm run backup -- --out "C:\Users\TuUsuario\OneDrive\CapitalControl-Backups"
```

Use that same path in the scheduled task. The script reports which case it is
every time it runs — whether the file stayed on this disk or landed somewhere
that syncs — and when it finds a synced folder it prints the exact command.

This is not a real off-site backup policy, and it is enormously better than one
copy on one disk.

### Verify it, or you do not have one

Once a quarter, restore a backup into a scratch database and log in. A backup
nobody has ever restored is a hypothesis, not a safety net.

```bash
createdb capital_test
DATABASE_URL="postgresql://user:pass@localhost:5432/capital_test" \
  node scripts/backup.mjs restore backups/<file>.dump --force
```

---

## Restoring

```bash
npm run backup:restore -- backups/capital-control-20260925-143002.dump --force
```

**A restore replaces everything.** Every client, loan, payment and cash movement
in the current database is dropped and rebuilt from the file. Nothing is merged,
and anything recorded since that dump was taken is gone.

That is why `--force` is required. Without it the command refuses and explains
itself.

Before it restores, the script takes its own dump of the *current* state into
`backups/pre-restore-<timestamp>.dump`. Restoring the wrong file is an ordinary
human mistake and it should be survivable.

After restoring:

```bash
npm run verify
```

This re-derives every balance from the recorded movements and checks it against
what the loans say. If the restore was clean, everything reconciles.

---

## Moving to another server

The database is the whole product. Migration is a dump and a restore:

```bash
# On the old server
npm run backup

# Copy the .dump file across, then on the new one
git clone <repo> && cd capital-control
npm ci
cp .env.example .env         # fill in DATABASE_URL and AUTH_SECRET
npm run db:deploy            # creates the schema
node scripts/backup.mjs restore <file>.dump --force
npm run build && npm start
```

`AUTH_SECRET` may be regenerated on the new server — it only invalidates open
sessions, and everyone logs in again. The `DATABASE_URL` will obviously differ.
Nothing else needs to travel.

---

## Upgrading the application

New versions may add tables or columns. Migrations are versioned in
`prisma/migrations/` and applied with:

```bash
npm run db:deploy
```

**Take a backup first.** `db:deploy` only applies pending migrations and never
drops data, but a five-second backup is cheaper than the alternative.

Never run `npm run db:reset` on a real deployment: it drops the database and
reseeds it. It exists for development.

---

## What is *not* a backup

- **Exporting reports to Excel.** Reports are a view of the data. They do not
  contain the allocations, the periods, the cash movements or the audit trail,
  and you cannot rebuild the system from them.
- **Copying the `data/` folder of a running PostgreSQL.** A file copy of a live
  cluster is very likely corrupt. Stop the server first, or use `pg_dump`.
- **A screenshot.** People do this. It is not a backup.
