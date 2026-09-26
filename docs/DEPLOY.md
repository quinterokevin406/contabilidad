# Deploying to a VPS

One deployment can serve one business or several. Sell the software outright and
each customer gets their own server; run it as a service and several lenders
share one, kept apart by Row-Level Security in the database. This guide covers
both — see **Deploying for a customer** at the end for the difference.

This walkthrough takes about thirty minutes the first time and ten minutes
every time after.

---

## What you need

| | |
|---|---|
| A VPS | 2 GB RAM is comfortable, 1 GB works. Hetzner, DigitalOcean, Contabo |
| A domain | Or a subdomain, e.g. `prestamos.tunegocio.co` |
| SSH access | As root, or a user with `sudo` |

**TLS is mandatory, not a nicety.** Session cookies are marked `Secure` in
production, so over plain HTTP the browser throws them away and the login form
silently returns to itself with no error. Caddy handles the certificate
automatically; you do not have to think about it again.

---

## 1. Point the domain at the server

Create an `A` record for your domain pointing to the server's IP address.

Do this **first**. Caddy asks Let's Encrypt for a certificate on its first
start, and that only works once the domain resolves. Propagation is usually
minutes, sometimes an hour.

Check it from your own machine:

```bash
ping prestamos.tunegocio.co
```

It has to answer with the server's IP before you continue.

---

## 2. Prepare the server

Connect:

```bash
ssh root@<server-ip>
```

Install Docker:

```bash
curl -fsSL https://get.docker.com | sh
```

Close everything except SSH and the web:

```bash
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw enable
```

Note what is *not* open: **5432**. The database is reachable only from the
application container, over Docker's internal network. A PostgreSQL exposed to
the internet is found by scanners within hours.

---

## 3. Get the code

```bash
git clone https://github.com/<your-user>/<your-repo>.git /opt/capital-control
cd /opt/capital-control
```

A private repository will ask for credentials. Use a GitHub personal access
token with read-only repository scope — never your account password, and never
a token with write access on a server you may hand to a customer.

---

## 4. Configure it

```bash
cp .env.example .env
nano .env
```

Fill in, at minimum:

```bash
APP_DOMAIN="prestamos.tunegocio.co"
POSTGRES_PASSWORD="<generated, see below>"
AUTH_SECRET="<generated, see below>"
SEED_ADMIN_EMAIL="vos@tunegocio.co"
SEED_ADMIN_PASSWORD="<a real password>"
SEED_ORG_NAME="Tu Negocio"
SEED_ORG_SLUG="tu-negocio"
SEED_DEMO_DATA="false"
```

Generate the two secrets — do not invent them by hand:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"   # POSTGRES_PASSWORD
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"      # AUTH_SECRET
```

No Node on the server yet? `openssl rand -base64 32` does the same job.

`DATABASE_URL` and `AUTH_URL` are **not** set by hand here: compose builds both
from `APP_DOMAIN` and `POSTGRES_PASSWORD`. Two fields that must agree are two
chances to disagree, and a mismatched `AUTH_URL` breaks login without producing
a useful error.

Lock the file down — it holds the keys to every session and to the database:

```bash
chmod 600 .env
```

---

## 5. Start it

```bash
docker compose up -d --build
```

The first build takes a few minutes. Then create the schema and the initial
data:

```bash
docker compose exec app npm run db:deploy
docker compose exec app npm run db:seed
```

Open `https://prestamos.tunegocio.co` and sign in with the admin credentials
from `.env`.

### If it does not come up

```bash
docker compose ps            # which containers are running
docker compose logs app      # application errors
docker compose logs caddy    # certificate problems
```

The two failures that account for almost everything:

**The certificate was not issued.** Caddy's log will say so. Almost always the
`A` record is not pointing here yet, or port 80 is closed — Let's Encrypt
validates over port 80 even though the site ends up on 443.

**Login returns to the login page with no error.** You are reaching the site
over `http://`. The cookie is being set and immediately discarded. Use
`https://`.

---

## 6. Schedule the backups — today, not later

The server holds the only copy of every balance you have.

```bash
crontab -e
```

```
0 2 * * * cd /opt/capital-control && docker compose exec -T app npm run backup -- --out /backups
```

That writes a nightly dump into `./backups` on the host, which survives the
containers being rebuilt.

**And then get it off the server.** A backup sitting on the same machine as the
database does not survive the failure you are actually afraid of. Copy it to
your own computer, or to object storage, on a schedule.

Full detail — retention, verifying a restore, moving to another server — is in
[`BACKUP.md`](BACKUP.md).

---

## 7. Updating

```bash
cd /opt/capital-control
docker compose exec -T app npm run backup -- --out /backups   # first, always
git pull
docker compose up -d --build
docker compose exec app npm run db:deploy
```

`db:deploy` only applies migrations that have not run yet, and never drops
data. The backup before it is cheap insurance, not superstition.

**Never run `db:reset` on a real deployment.** It drops the database and
reseeds it. It exists for development.

---

## 8. Confirm the books still balance

After any restore, migration or upgrade:

```bash
docker compose exec app npm run verify
```

This re-derives every balance from the recorded movements and checks it against
what the loans say. It is also the honest answer when a customer asks how they
can know the numbers are right.

---

## Deploying for a customer

The same steps, with three differences:

1. **Their own server, their own domain, their own `.env`** — if you are
   selling the software outright and handing it over. Nothing to operate, and
   nothing of yours to keep running.

   If instead you run it for them and charge a subscription, several lenders on
   one deployment is the normal shape, and the schema was built for it: every
   tenant-scoped table is under Row-Level Security, so the database itself
   refuses to hand one organization another's rows. Run `npm run verify:tenancy`
   before you put the second customer on a server, and again after any change to
   how queries are built.
2. **Generate fresh secrets for each one.** Reusing an `AUTH_SECRET` across
   deployments means a session token from one works on another.
3. **Set up their backups before handing it over**, and show them the restore
   working. A backup nobody has ever restored is a hypothesis.
