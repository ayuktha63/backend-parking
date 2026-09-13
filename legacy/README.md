# Legacy backend

## Where the original lives

The pre-transformation backend (a single 1,672-line `server.js`) is **not kept as a
file here**, because it contained three live secrets — a Neon connection string with
its password, a Razorpay live key and an MSG91 auth key. Keeping a working copy in
the tree would mean the secret scanner has to permanently allowlist it, and any
future `grep` for credentials would keep finding it.

It is preserved where it already was, in git history:

```bash
git show 246c9d4:server.js            # the original, verbatim
git log --follow -- server.js         # its full evolution
```

## What replaced it

`src/routes/legacy/legacyRouter.js` is that file, mechanically converted from a
standalone Express app into a Router mounted at `/api`. The conversion changed only
plumbing:

| Original | Now |
|---|---|
| `const app = express()` | `express.Router()`, with the `/api` prefix at the mount point |
| `app.use(express.json())`, `cors`, content-type shim | applied once in `src/app.js` |
| hardcoded Neon `new Pool({...})` | the shared pool from `src/db` |
| hardcoded `MSG91_AUTHKEY` etc. | read from `src/config` |
| `http.createServer` + `new Server(...)` | the shared gateway in `src/sockets` |
| two `setInterval` sweepers | `src/jobs`, with leader election |
| local error handler returning `String(err)` | the global handler, which does not leak exception text |
| `server.listen(...)` | `server.js` |

**Business logic was not touched**, including its defects, because changing behaviour
would change what already-installed app builds observe. Fixes land in `/api/v1`.

## Exceptions — endpoints deliberately NOT preserved

Three legacy endpoints are overridden in `src/routes/legacy/index.js` rather than
passed through. An endpoint that destroys data or bypasses authentication is not
"working behaviour worth keeping":

1. **`POST /api/auth/send-otp` · `/api/auth/verify-otp`** → `410 Gone`.
   These returned the generated passcode in their own response body as `debug_otp`.
   Verified by inspection that neither shipped app ever called them.

2. **`POST /api/owner/login`** → the password-optional branch is removed.
   Sending `{phone}` with no password used to return the account. The operator app's
   profile screen relied on this, and is fixed in the same change.

3. **`POST /api/owner/parking_areas`** → capacity changes are refused with a `409`
   telling the operator to update the app. The original ran
   `DELETE FROM slots` + `DELETE FROM bookings` for the whole lot, unarchived,
   untransacted and unannounced, whenever a slot count changed.

## When this goes away

Removal is gated on evidence, not on a date. Every legacy call is counted in
`deprecated_endpoint_usage`; migration `0008_deprecate_legacy.sql` refuses to run
while that table shows traffic in the last seven days.

```sql
SELECT endpoint, method, client_label, hits, last_seen_at
  FROM deprecated_endpoint_usage
 ORDER BY last_seen_at DESC;
```

## The two other legacy servers

`Parking-slot-Booking/server.js` and `Parking_slot_Booking_Owner/server.js` are
abandoned MongoDB implementations sitting inside the Flutter repositories. Neither is
deployed, neither app has ever referenced them, and the second one cannot start at
all — its connection string is the literal text `mongodb://$apiHost:27017`, Dart
interpolation syntax pasted into JavaScript. They are untouched by this work and are
scheduled for isolation in Phase 6.
