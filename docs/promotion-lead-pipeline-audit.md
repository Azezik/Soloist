# smolCRM Lead Pipeline + Promotions Audit (implementation-extracted)

## Scope
This document is extracted from the current implementation (no proposed code changes).

---

## Part 1 — Does the codebase define a “pipeline”?

### Findings
- There is **no standalone `Pipeline` class/service abstraction**. The “pipeline” is represented implicitly as settings data (`pipeline.stages`, `pipeline.dayStartTime`) plus utility functions in `src/domain/settings.js` and action handlers in `src/app.js`.
- Default lead stage sequence is defined as default settings in `DEFAULT_PIPELINE_SETTINGS.stages` with offsets `0, 2, 7, 15, 30` days.
- Configurable gap settings are persisted in Firestore document path `users/{uid}/settings/pipeline`, read through `getPipelineSettings/getAppSettings`, and normalized by `normalizeAppSettings`.

### Concrete code paths
- Default pipeline stage config: `src/domain/settings.js` (`DEFAULT_PIPELINE_SETTINGS`).
- Settings read/write location: `src/data/settings-service.js` (`pipelineSettingsRef`, `getPipelineSettings`, `getAppSettings`) and settings writes in `src/app.js` settings page handlers.

---

## Part 2 — Strict baseline rules for Lead stage management (current behavior)

## A) Creation rules
- On lead creation, persisted fields include `stageId`, `stageStatus`, `state`, `nextActionAt`, plus generic timeline fields (`type`, `status`, `archived`, `deleted`) and metadata (`createdAt`, `updatedAt`).
- `nextActionAt` is computed at creation time via `computeInitialLeadNextActionAt(pipelineSettings, stageId, new Date())`.
- Projected future stages are **not** persisted as lead-stage rows. They are computed on demand in calendar projection logic.
- A mirrored `events/lead_{leadId}` document is written at creation with `scheduledFor`/`nextActionAt` equal to the computed lead next action.

## B) Scheduling rules
- Initial schedule uses stage-level offset from current timestamp (`computeInitialLeadNextActionAt` resolves offsets and adds millis).
- Stage-to-stage progression uses `computeOffsetDeltaDays(currentStage, nextStage)` then `computeNextActionAt(completedAt, deltaDays, dayStartTime)`.
- The system stores an absolute `nextActionAt` timestamp per lead (not only offsets). Offsets are used to compute the next absolute timestamp during stage transitions.

## C) Completion rules
- “Done” on a lead executes `completeLeadStage(...)`.
- If there is a next stage:
  - `stageId` moves to next stage,
  - `stageStatus` set to `pending` (for leads collection),
  - `lastActionAt` + `lastActionSource` set,
  - `nextActionAt` recomputed from completion timestamp.
- If current stage is final:
  - lead is closed/archived, `nextActionAt` cleared,
  - `stageStatus=completed` for lead records,
  - if current state was `open`, state is set to `drop_out`.
- Late completion shifts the next stage because recomputation anchors on actual `completedAt` (`nowDate` passed into `completeLeadStage`).

## D) Push / postpone rules
- There is no explicit “auto push if user ignores due lead” per-item interaction; undismissed due leads remain due in dashboard queries (`where(nextActionAt <= now)`).
- Explicit push exists via push presets (`computePushedTimestamp`), applied from dashboard/lead detail.
- Nightly rollover batch also pushes eligible overdue leads to next day start time (`computeNextActionAt(now, 1, dayStartTime)` + `rescheduleLeadAction`).
- Push mechanics modify `nextActionAt`, `lastActionAt`, `lastActionSource` (`schedule_adjustment`) and do not directly recompute downstream stage rows (because downstream rows are not persisted).

## E) Manual edits
- Editing a lead in the lead edit form recomputes `nextActionAt` from stage offset and **current time**, then writes it.
- Calendar drag/drop for lead items writes an explicit `nextActionAt` absolute date via `rescheduleLeadAction`.
- No global “recompute timeline” persists future stage entries (future projections are recomputed at render-time in calendar).
- Therefore manual edits rewrite current lead anchor (`nextActionAt` and sometimes `stageId`) rather than editing a stored single projected future stage row.

---

## Part 3 — Promotions model and event generation rules (current behavior)

## A) Promotion object model
- Promotion doc persisted fields include:
  - `name`, `endDate`, `touchpoints`, `targeting`, `leadIds`, `snapModeByLead`, `selectionSourcesByLead`, `presetKey`, `presetLabel`, `status`, timestamps, `configSnapshot`.
- Cohort is persisted as `leadIds` at save-time (snapshot list), plus `selectionSourcesByLead` metadata.
- For Snap Active replacements, per-lead snapshot docs are stored at `promotions/{promotionId}/snapshots/{leadId}` with stage identity + pre-promo schedule/anchors.

## B) Promotion dashboard/calendar events
- The system creates **one event per lead per touchpoint** (`buildPromotionEvents` inside `createPromotion`, then `addDoc` for each event).
- Event rows live in generic `/events` collection (shared with lead/task mirrored events), with `type: "promotion"` and references (`promotionId`, `touchpointId`, `leadId`).
- Dashboard and calendar read promotions from generic events stream and filter by `type===promotion || promotionId`.

## C) Snap Active Leads selection logic
- Snap eligibility is computed by `findSnapMatch`/`qualifiesForSnap`:
  - starts from current `lead.nextActionAt` day,
  - if pipeline stages are available, it also forecasts future candidate stage days from current stage onward by offset deltas,
  - compares candidate days to touchpoint days within `snapWindowDays`.
- On promotion save, only leads included via `selectionSourcesByLead[leadId]` containing `snap_active` are snap-evaluated for replacement snapshot creation.
- What gets snapshotted:
  - replaced stage id/index, previous stage id,
  - original stage id/date,
  - prePromo nextActionAt + lastActionAt,
  - pipeline hash,
  - completion counters and restore metadata fields.
- “Stage replaced by promo” representation is not a direct stage row replacement; it is represented by:
  - lead fields `snappedPromotionId` + `snapMetadata`, and
  - promotion event rows carrying `snappedStageId`.

---

## Part 4 — Interaction rules: where Promotions and Lead pipeline collide

1) Lead recompute/reschedule paths that can ignore promo time-lock
- Lead push and drag-reschedule mutate lead anchor timestamps (`nextActionAt`, `lastActionAt`) regardless of promotion state.
- Lead Done progression (`completeLeadStage`) advances stage based on current timestamps.
- Nightly rollover mass-reschedules overdue leads.
- These flows do not check `snappedPromotionId` before mutating lead schedule anchors.

2) Promotions represented as normal schedulable events
- Promotion events are stored in the same generic `/events` timeline and can be calendar-drag-rescheduled (`updateCalendarItemSchedule` for `type=promotion` updates `scheduledFor`).
- That makes promo timestamps operationally elastic in current implementation, not strictly immutable/time-locked.

3) Restoration source of truth
- Restoration prefers snapshot (`prePromoNextActionAt`) but can fall back to recomputation if pipeline hash changed, anchor drift detected, or snapshot next action missing.
- Therefore restoration is partially snapshot-based and partially derived from current state.

---

## Part 5 — Requested output format

## 1) Extracted Spec — Leads (concise)
- Lead pipeline is settings-driven (`pipeline.stages`, `dayStartTime`) with no formal Pipeline class.
- New lead stores current stage + absolute `nextActionAt`; future stages are projected on read, not persisted.
- Stage Done uses actual completion timestamp as anchor to compute next stage due date.
- Push operations rewrite `nextActionAt` and update last-action metadata.
- Dashboard shows any due lead (`nextActionAt <= now`) until done/pushed.
- Nightly rollover can batch-push overdue leads.
- Manual lead edit recalculates `nextActionAt` from stage and current time; calendar drag writes explicit new `nextActionAt`.

## 2) Extracted Spec — Promotions (concise)
- Promotion save persists promotion record + cohort list + touchpoint definitions.
- For each selected lead and each touchpoint, one promotion event row is created in `/events`.
- Snap Active qualification forecasts from current lead stage timeline and touchpoint dates within window.
- Snap creates per-lead snapshot docs plus lead-level snap metadata pointers.
- Promotion event completion updates event status; when all sibling touchpoints for a lead are closed/skipped, lead stage progression is triggered.
- Promotion delete removes promotion doc + promotion events and attempts lead restoration from snapshots.

## 3) Conflict Matrix

| Lead pipeline rule | Promotion rule | Where they conflict (file/function) | Observed/likely symptom in UI |
|---|---|---|---|
| Lead schedule anchor (`nextActionAt`) is mutable via push/drag/nightly rollover. | Snap assumes replaced stage mapping remains valid until restore. | `src/data/calendar-service.js` (`rescheduleLeadAction`), `src/app.js` (`runNightlyRolloverIfDue`). | Snap restore may recompute instead of exact revert after anchor drift. |
| Lead completion uses actual completion time to compute next stage. | Promotion completion eventually calls `completeLeadStage` with actionSource `promotion_touchpoint`. | `src/app.js` (`reconcilePromotionLeadProgress` -> `completeLeadStage`). | Promo completion can advance pipeline based on promo completion time; may shift expected schedule. |
| Generic timeline supports drag reschedule of events. | Promo events are stored as regular events with mutable `scheduledFor`. | `src/data/calendar-service.js` (`updateCalendarItemSchedule` for `promotion`). | Promotion touchpoint dates can move outside Promotion edit flow (violates strict time-lock). |
| Projected lead timeline hides projected stages when replacement index contains `leadId:snappedStageId`. | Replacement index inferred from active promotion event rows. | `src/calendar/calendar-utils.js` (`buildPromotionReplacementIndex`, `buildProjectedLeadItems`). | If promotion events are modified/completed/deleted inconsistently, projection visibility can become inconsistent. |
| Lead edit recalculates `nextActionAt` from now and selected stage. | Snap snapshot stores prePromo state expecting stable restore inputs. | `src/app.js` (`renderEditLeadForm` submit), `src/promotions/promotion-engine.js` (restore decision). | Manual lead edit during promo can trigger restore recompute path, diverging from exact prePromo timestamp. |

## 4) Highest-leverage clarifying questions (current code only)
1. Is `updateCalendarItemSchedule(...promotion...)` intended to be an allowed write path for promotion touchpoint dates, or an accidental side effect of generic event drag support?
2. On editing an existing promotion (`updateDoc` path), should touchpoint date shifts propagate to existing event rows, or is stale event scheduling currently expected?
3. Should `runNightlyRolloverIfDue` skip leads that have `snappedPromotionId` set, or is current behavior (reschedule regardless) intentional?
4. Is `restoreLeadFromPromotionSnapshot` expected to recompute when non-promo anchor drift occurs, or should it always use saved `prePromoNextActionAt` if present?
5. Should skipped promotion events count as resolving stage replacement the same way as done events (current logic treats both as clearing "remaining")?

---

## Part 6 — Determinism, time-lock, revert/delete correctness

## 1) Save-time persistence inventory
On create promotion save (`createPromotion` flow):
- Promotion doc write: name/endDate/touchpoints/targeting/leadIds/snapModeByLead/selectionSourcesByLead/preset metadata/status/configSnapshot.
- For each snap-eligible + snap-matching lead: snapshot doc write in `promotions/{promotionId}/snapshots/{leadId}` including replaced stage identity and prePromo scheduling anchors/hash.
- For each snap-matching lead: lead doc update writes `snapMetadata` + `snappedPromotionId`.
- For each selected lead × touchpoint: event doc write in `/events` with promotion/touchpoint/lead linkage and `scheduledFor`.

Edit promotion save (`state.isEdit`) currently only updates promotion doc fields (`name`, `endDate`, `touchpoints`, `leadIds`, selection/snap maps); it does not rebuild existing events/snapshots.

## 2) Time-lock verdict
**Verdict: partially time-locked.**
- Explicit write paths for promo/touchpoint dates:
  - Promotion doc `endDate`/`touchpoints` update in promotion edit save flow.
  - Promotion event `scheduledFor` update via calendar drag (`updateCalendarItemSchedule` type promotion).
  - Promotion event initial `scheduledFor` creation in `buildPromotionEvents`/`createPromotion`.
- Because calendar drag can mutate promotion event dates outside promotion edit UI, time-lock is not guaranteed.

## 3) Read-time recomputation inventory
- Promotion detail rendering reads persisted promotion doc + events and groups events by `touchpointId`.
- Snap qualification is recomputed during cohort building and at save-time when deciding `snapMatch`.
- Lead projected pipeline dates are recomputed on calendar load from current `lead.nextActionAt` and stage offsets.
- Restore path may recompute restored `nextActionAt` using current pipeline hash + anchors (`shouldRecompute` branch).

## 4) Delete-time side effects inventory
Delete flow (`restoreSnappedLeadsAndDeletePromotion`):
- Reads promotion snapshots + related events + pipeline settings.
- For each `addedViaSnapActive` snapshot lead:
  - runs restore logic to set lead stage/status/nextActionAt and clear snap fields,
  - deletes snapshot doc (or skips/deletes when lead missing/non-snap snapshot).
- Deletes all promotion event rows for that promotion.
- Deletes promotion document.

Also separate expiry restore flow (`restoreExpiredPromotionStageReplacements`) can restore snap-replaced leads with zero completed touchpoints after campaign window ends.

## 5) Revert feasibility verdict
**Verdict: partially deterministic.**
The model stores key restore artifacts (cohort `leadIds`, per-lead snapshots with replaced stage id/index, prePromo `nextActionAt`, prePromo `lastActionAt`, and pipeline hash), which enables deterministic restore in many cases. However, restore can deliberately switch to recomputation when pipeline hash mismatch or non-promo anchor drift is detected, and promotion event dates can be mutated outside promotion edit flow. This means revert behavior is not strictly fixed to snap-time state in all paths.

Must-exist artifacts check:
- Per promo cohort snapshot (`leadIds`): **present**.
- Per snapped lead replaced stage identity/date: **present** (`replacedStageId/index`, `prePromoNextActionAt`, etc.).
- Pre-promo scheduling anchors for restore: **present but conditionally bypassed by recompute logic**.

---

## Part 7 — Event representation audit (current vs target)

## 1) Current model: extracted spec
- Promotion events are explicit per-lead-per-touchpoint rows in generic `/events`.
- Each row carries `promotionId`, `touchpointId`, `leadId`, template payload, `scheduledFor`, status flags.
- Dashboard/calendar consume the same generic events stream for promotions and present each event as an independent actionable item.
- Completion operates at event-row level (`markPromotionEventDone/Skipped`) and lead progression reconciliation scans sibling rows for same lead+promotion.

## 2) Target model: architecture sketch in words (no implementation)
- Represent each touchpoint as one **time-locked container event** (one scheduled object per touchpoint).
- Container references promotion + touchpoint metadata and a persisted cohort snapshot/list.
- Expanded view resolves cohort members and displays per-lead interaction rows (Done/Open Lead/etc.) under the container.
- Per-lead completion status would be stored separately from container schedule (e.g., per-touchpoint per-lead status map/table) so schedule immutability is isolated from interaction state.
- Rendering path changes from “N independent promotion events” to “1 scheduled container + N child statuses”.

## 3) Impact table

| Concern | Current per-lead event model | Target per-touchpoint container model | Code areas likely impacted |
|---|---|---|---|
| Time-lock | Weak: each event has mutable `scheduledFor`; many write surfaces. | Stronger: one schedulable object per touchpoint; fewer mutation paths. | `src/data/calendar-service.js`, `src/promotions/promotion-engine.js`, `src/app.js` promotion detail/dashboard/calendar renderers. |
| Recompute collision | High: many event rows may be interpreted by generic event logic. | Lower: schedule concerns centralized at touchpoint container level. | `src/calendar/calendar-utils.js`, `src/calendar/calendar-screen.js`. |
| Restore determinism | Harder: lead replacement inferred across multiple event rows/states. | Easier: container schedule fixed; child completion state independent. | `src/promotions/promotion-engine.js`, `src/app.js` (`reconcilePromotionLeadProgress`). |
| UI clutter | High for large cohorts (one row/chip per lead per touchpoint). | Lower (one touchpoint item with expandable cohort). | `src/app.js` dashboard/promotion detail/calendar item builders. |
| Performance/query cost | Higher event cardinality (L×T docs). | Lower scheduled-event cardinality; potentially higher detail payload reads. | Firestore query surfaces in `src/app.js`, `src/data/calendar-service.js`. |

## 4) Top 3 most likely collision points
1. Generic calendar reschedule path updates promotion `scheduledFor` directly (`updateCalendarItemSchedule`), allowing non-promotion-UI date mutation.
2. Lead timeline projection suppression depends on active promotion event rows with `snappedStageId`; any event lifecycle mismatch can desync projected timeline hiding.
3. Restore logic mixes snapshot and recomputation based on drift/hash checks, so external lead schedule mutations during promo can alter revert outcomes.

