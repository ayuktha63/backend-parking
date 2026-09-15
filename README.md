# PARQX API

Backend for the PARQX parking discovery and reservation platform. Serves the
customer app (`Parking-slot-Booking`) and the operator app
(`Parking_slot_Booking_Owner`).

> **Status: Phase 1 of the transformation.** Authentication, configuration, the
> migration system and the modular structure are in place. Discovery, booking,
> payments and the operator dashboard land in Phases 2–5 — those routes currently
> return `501 Not Implemented` under `/api/v1`, while the legacy `/api/*` surface
> continues to serve already-shipped app builds. See
> [`../architecture/TRANSFORMATION_PLAN.md`](../architecture/TRANSFORMATION_PLAN.md).

---

## Quick start

```bash
# 1. Configuration — there are no hardcoded fallbacks for secrets
cp .env.example .env
$EDITOR .env                    # at minimum: DATABASE_URL

# 2. Generate signing secrets
node -e "console.log('JWT_ACCESS_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('JWT_REFRESH_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"

# 3. Dependencies and schema
npm install
npm run migrate

# 4. Run
npm run dev
curl localhost:3000/api/v1/health
```

**This works against an empty database.** Migration `0003` creates the base tables
when they are absent, so a contributor no longer needs access to the production
instance to get a working environment — which was previously impossible, because the
schema existed only inside the hosted database and no repository contained a single
`CREATE TABLE`.

Requires **Node ≥ 18.17** and a PostgreSQL 13+ instance.

---

## Layout

```
backend-parking/
├── server.js               process bootstrap only (~180 lines)
├── migrations/             numbered, checksummed, immutable once applied
├── scripts/
│   └── check-secrets.js    CI guard against committing credentials
├── legacy/README.md        what happened to the original server.js
├── tests/{unit,contract}/
└── src/
    ├── config/             all environment reading, with validation
    ├── db/                 pool, transactions, advisory locks, migration runner
    ├── middleware/         requestContext · auth · validate · rateLimit · errorHandler
    ├── validators/         zod schemas, one per resource
    ├── repositories/       ALL SQL lives here, nowhere else
    ├── services/           business logic
    ├── controllers/        HTTP in → service → HTTP out
    ├── routes/
    │   ├── v1/             the current API
    │   └── legacy/         adapter for already-shipped app builds
    ├── sockets/            authenticated Socket.IO gateway
    ├── jobs/               sweepers, with leader election
    └── utils/              errors · money · time · logger
```

**The rule:** `routes → controllers → services → repositories → database`. A
controller never writes SQL; a repository never decides business rules. This
replaced a single 1,672-line `server.js` that held routes, SQL, sockets, pricing,
cron and error handling together.

---

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start with file watching |
| `npm start` | Start |
| `npm run migrate` | Apply pending migrations |
| `npm run migrate:status` | List applied / pending / drifted |
| `npm run migrate:dry` | Show what would run, change nothing |
| `npm run migrate:conflicts` | List unresolved backfill ambiguities |
| `npm run migrate:rerun -- --rerun=0007` | Re-apply a re-runnable migration |
| `npm test` | Unit + contract tests |
| `npm run check:secrets` | Fail if a credential is about to be committed |

---

## Migrations

Numbered SQL files applied in order, each in its own transaction, each recorded with
a checksum. **An applied migration is immutable** — editing one is a hard error, not
a silent divergence.

| File | What it does | Destructive? |
|---|---|---|
| `0001_extensions_and_helpers` | `btree_gist`, `updated_at` triggers, `migration_conflicts` | no |
| `0002_core_tables` | owners, vehicles, OTP, refresh tokens, parking_slots, payments, refunds, booking_events, photos, amenities, hours, reviews | additive |
| `0003_base_tables_if_missing` | Creates the legacy-shaped tables when absent, so an empty database works | no-op on production |
| `0004_extend_existing_tables` | Adds nullable columns to existing tables | additive |
| `0005_backfill` | Populates them. **Idempotent, never guesses** | data only |
| `0006_indexes.nontx` | `CREATE INDEX CONCURRENTLY` — runs outside a transaction | no |
| `0007_constraints` | FKs, CHECKs, and the no-overlap exclusion constraint | tightening, gated |
| `0008_deprecate_legacy` | Renames superseded structures. **Refuses to run while legacy routes still see traffic** | rename only |

Three properties worth knowing:

**Nothing is ever dropped.** Tables are renamed, columns are renamed, rows get
status transitions. The old system's habit of `DELETE FROM bookings` on cancel,
complete, sweep *and capacity change* is exactly what these migrations exist to stop
repeating.

**Backfill refuses to guess.** `0005` links parking areas to owners by name — the
only link the old schema had. Where that match is ambiguous or absent, it writes a
row to `migration_conflicts` and leaves the column NULL rather than attaching a lot
to the wrong operator.

**Constraints are gated on clean data.** `0007` skips any constraint whose data
would violate it, with a `NOTICE` explaining why. Resolve the conflicts, then:

```bash
npm run migrate:conflicts
# ...fix the underlying data, set resolved_at...
npm run migrate:rerun -- --rerun=0007
```

### Before running against production

```bash
pg_dump --schema-only "$DATABASE_URL" > migrations/0000_baseline.sql
```

`0000_*` is never applied by the runner and is gitignored (it can contain
identifying structure). It is the reference point every other migration was written
against.

---

## API

Base: `/api/v1`. Every response is `{ "data": ... }` or
`{ "error": { code, message, details?, request_id } }`.

**Authentication is mandatory on every mutation.** `Authorization: Bearer <access token>`.

| Method | Path | Auth |
|---|---|---|
| `POST` | `/auth/otp/request` | — |
| `POST` | `/auth/otp/verify` | — |
| `POST` | `/auth/owner/otp/request` · `/auth/owner/otp/verify` | — |
| `POST` | `/auth/owner/password` | — |
| `POST` | `/auth/owner/password/set` | owner |
| `POST` | `/auth/refresh` · `/auth/logout` | — / optional |
| `GET` | `/auth/sessions` | any |
| `GET` `PATCH` | `/me` | any |
| `GET` `POST` `DELETE` | `/me/vehicles` | customer |
| `GET` | `/health` · `/meta` | — |

`/parking`, `/holds`, `/bookings`, `/payments`, `/owner` return `501` until their
phase lands. That is deliberate: an integrator can tell "not built yet" from "wrong
URL".

### Auth flow

```bash
# 1. Request a code (returned in the response only outside production)
curl -X POST localhost:3000/api/v1/auth/otp/request \
  -H 'Content-Type: application/json' -d '{"phone":"9876543210"}'
# → { "data": { "request_id": "...", "expires_in": 300, "dev_otp": "483920" } }

# 2. Verify — creates the account on first success, so there is no separate signup
curl -X POST localhost:3000/api/v1/auth/otp/verify \
  -H 'Content-Type: application/json' \
  -d '{"phone":"9876543210","otp":"483920","request_id":"...","name":"Asha"}'
# → { "data": { "access_token": "...", "refresh_token": "...", "user": {...} } }

# 3. Use it
curl localhost:3000/api/v1/me -H "Authorization: Bearer <access_token>"
```

Access tokens last 15 minutes. Refresh tokens last 30 days, **rotate on every use**,
and are stored hashed. Presenting an already-rotated token revokes the entire session
family — either the legitimate client or an attacker is replaying, and ending both is
the safe outcome.

---

## Legacy routes

`/api/*` (no version) serves app builds already installed on users' phones. They
delegate to the same services and are removed when evidence — not a date — says it is
safe:

```sql
SELECT endpoint, method, client_label, hits, last_seen_at
  FROM deprecated_endpoint_usage ORDER BY last_seen_at DESC;
```

Migration `0008` refuses to run while that table shows traffic in the last 7 days.

**Three legacy endpoints are deliberately not preserved**, because an endpoint that
destroys data or bypasses authentication is not behaviour worth keeping. See
[`legacy/README.md`](./legacy/README.md).

---

## Configuration

Everything is read in `src/config/index.js` and validated at boot. In production an
invalid configuration is fatal; elsewhere it warns and continues.

There is **no hardcoded fallback for any secret**. The previous version embedded a
production Neon connection string, a live Razorpay key and an MSG91 auth key directly
in source — all three are in git history and must be treated as disclosed.

Feature flags make behaviour changes reversible without a redeploy:

| Flag | Default | Effect |
|---|---|---|
| `FEATURE_AUTH_REQUIRED` | `true` | When false, guards degrade to optional. Rejected in production |
| `FEATURE_SERVER_PAYMENT_VERIFICATION` | `true` | Rejected in production when false |
| `FEATURE_REFUNDS_ENABLED` | `false` | Whether refund obligations are actually sent to the gateway |
| `FEATURE_LEGACY_ROUTES_ENABLED` | `true` | Mount `/api/*` |
| `ENABLE_DEV_RESET` | `false` | Rejected in production |

---

## Testing

```bash
npm test              # all
npm run test:unit     # pure logic, no database needed
npm run test:contract # API contracts, needs a database
```

> **Not verified in the authoring environment.** These tests were written but not
> executed — the machine used to author this change has no Node.js runtime. They are
> deliverables for CI, and should be treated as unrun until a pipeline says otherwise.

---

## Conventions

- **Money is integer paise.** Never a float, never rupees. `src/utils/money.js`.
- **Time is UTC `timestamptz`.** Clients send ISO-8601 with an explicit offset;
  naive timestamps are rejected at validation. `src/utils/time.js`.
- **SQL lives only in `src/repositories/`.**
- **Errors are typed.** Only an `AppError` produces a client-visible message;
  everything else becomes a generic 500 and is logged. Exception text never reaches
  a client.
- **Logs redact automatically.** Phone numbers are masked, credentials removed.
- **Multi-row writes use `withTransaction`**, which retries serialization failures.
- **Double-booking is prevented at the storage layer** by an exclusion constraint
  (`0007`), with advisory locking on top only to turn the raw constraint violation
  into a friendly error.
