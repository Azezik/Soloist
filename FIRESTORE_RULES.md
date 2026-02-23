# Firestore security rules for SoloistCRM

This project uses an **ownership-centered** ruleset with a canonical entitlement document and reserved server-managed namespaces.

## Canonical structure

```txt
/users/{uid}
  /contacts/{contactId}
  /leads/{leadId}
  /tasks/{taskId}
  /notes/{noteId}
  /promotions/{promotionId}
    /snapshots/{snapshotId}
  /promotionEvents/{eventId}
  /events/{eventId}
  /settings/pipeline
  /settings/nightlyRollover
  /settings/main
  /entitlements/main          (read-only to client)
  /billing/{docId}            (server-managed)
  /system/{docId}             (server-managed)
```

## Tier 1 behavior parity (current UX)

Tier 1 remains unchanged:

- Authenticated users can create/read/update/delete their own contacts, leads, tasks, notes, promotions, events, promotion events, and promotion snapshots.
- Users cannot read or write another user's data.
- Existing settings behavior is preserved (`pipeline` and `nightlyRollover` continue to work).

## Why this is more durable (without extra complexity)

1. **Canonical entitlement location**: exactly one authoritative document at `/users/{uid}/entitlements/main`.
2. **Reserved privileged namespaces**: entitlement/billing/system data is server-managed and non-writable by clients.
3. **Stable reserved envelope**: client CRM writes are blocked only from writing a reserved `sys` field, avoiding a growing denylist of privileged field names.
4. **Controlled settings sprawl**: settings stays multi-doc (matching current app usage) but constrained to known IDs (`pipeline`, `nightlyRollover`, `main`).

## Apply rules

1. Open **Firestore Database → Rules**.
2. Paste `firestore.rules` from this repository.
3. Publish.
4. Refresh the app.


## Event unification migration plan

To migrate `promotionEvents` into `/users/{uid}/events` without UX changes:

1. **Dual-write phase**: write all new promotion touchpoints to `/events` (implemented).
2. **Calendar/dashboard read switch**: read promotion timelines from `/events` (implemented).
3. **Lead/task event mirroring**: upsert canonical `events/lead_{leadId}` and `events/task_{taskId}` docs on create/schedule/update paths (implemented for create + schedule updates).
4. **Backfill**: run a one-time admin script to copy legacy `/promotionEvents/*` into `/events/*` for existing tenants.
5. **Cleanup**: after backfill verification, stop writing legacy promotionEvents and eventually remove legacy rules/queries.
