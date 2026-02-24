# Exploratory Engineering Report: Promotion Snap + Delete/Restore Semantics

## 1) Cohort selection impact on timeline

### How leads are selected into promotion cohorts
- Promotion setup supports additive cohort inclusion from four source types:
  - `snap_active`
  - `all_active`
  - `drop_out`
  - `custom_search`.
- Selection source(s) are tracked per lead in `selectionSourcesByLead[leadId]` and saved to the promotion document.

### Which strategies trigger timeline morphing
- **Only leads whose `selectionSourcesByLead` includes `snap_active` are snap-eligible for timeline morphing**.
- `createPromotion` gates all snapshot + lead snap metadata writes behind:
  - `snapEligible = wasAddedViaSnapActive(selectionSourcesByLead, lead.id)`
  - then `if (snapEligible && snapMatch) { ...snapshot + lead snap metadata... }`.
- Leads included from `all_active`, `drop_out`, or `custom_search` still get promotion events, but do **not** get snap snapshots and are not restored through snap restore logic.

## 2) Snap algorithm and what it replaces

### Candidate generation and comparison
- Snap matching is implemented in `findSnapMatch`.
- For each lead, candidate timeline points are generated via `getLeadSnapCandidates`:
  - Anchor day = lead `nextActionAt` (UTC day).
  - If pipeline stages are known and lead `stageId` is found, candidates are generated from **current stage onward**.
  - Candidate day for each stage = `scheduledDay + max(0, stage.offsetDays - anchorOffsetDays)`.
- For each promotion touchpoint, touchpoint day = `endDate - offsetDays`.
- Match occurs when absolute day diff between any touchpoint day and any candidate day is `<= snapWindowDays`.
- Matching returns first encountered candidate/touchpoint pair (iteration order driven by touchpoint order + stage order).

### What stage/event is treated as replaced
- The stored replacement target is `snapMatch.stageId`, i.e. the matched candidate stage id.
- This may be:
  - The lead’s current stage, or
  - A projected future stage later in the pipeline (from `pipelineStages.slice(stageIndex)`).
- Existing implementation does **not** delete any lead-stage events at snap time. Instead:
  - It writes promotion events into `/events`.
  - It writes per-lead snapshot metadata.
  - It writes lead snap metadata (`snapMetadata`, `snappedPromotionId`).

## 3) Firestore writes for snap/restore lifecycle

### On promotion create (`createPromotion`)
1. **Promotion document**: `users/{uid}/promotions/{promotionId}`
   - writes name/endDate/touchpoints/targeting/leadIds/snap maps/preset metadata/status/config snapshot/timestamps.
2. **Per snapped lead snapshot document** (only `snap_active` + match):
   - path: `users/{uid}/promotions/{promotionId}/snapshots/{leadId}`
   - fields include:
     - `leadId`
     - `addedViaSnapActive`
     - `replacedStageId`
     - `replacedStageIndex`
     - `previousStageId`
     - `originalStageId`
     - `originalScheduledDate`
     - `lastCompletedNonPromoStageAt`
     - `completedTouchpointCount`
     - `zeroTouchpointsCompleted`
     - `lastCompletedPromotionTouchpointAt`
     - `snappedAt`
     - optional `expectedSnapStageId`
     - optional `expectedSnapScheduledDate`.
3. **Lead document updates for snapped leads**:
   - `snapMetadata` object (promotion id, replaced stage metadata, snap window, source)
   - `snappedPromotionId`
   - `updatedAt`.
4. **Promotion event documents** for all selected leads + all touchpoints:
   - path: `users/{uid}/events/{autoId}`
   - fields include promotion identifiers, lead id, touchpoint metadata, template payload, scheduled date, status/open flags, and optional snap context (`snappedStageId`, `snapMode`, `snapEligible`).

### Snapshot sufficiency for exact revert vs recompute
- Snapshot stores both original values (`originalStageId`, `originalScheduledDate`) and recalculation anchors (`lastCompletedNonPromoStageAt`, `previousStageId`, `replacedStageId/index`).
- **Restore path does not use `originalScheduledDate` for direct restore.**
- Restore recomputes `nextActionAt` from pipeline offsets and anchor timestamp.

## 4) Deletion/restore semantics (current behavior)

### Delete flow
- Deletion entrypoint: `restoreSnappedLeadsAndDeletePromotion`.
- Steps:
  1. Load promotion doc.
  2. Load all snapshot docs for that promotion.
  3. Load all promotion events where `promotionId == ...`.
  4. Load pipeline settings.
  5. For each snapshot doc:
     - if not `addedViaSnapActive`, delete snapshot only.
     - else load lead and call `restoreLeadFromPromotionSnapshot`.
     - then delete snapshot doc.
  6. Delete all matching promotion event docs.
  7. Delete promotion doc.

### Per-lead restore behavior
- Restore function: `restoreLeadFromPromotionSnapshot`.
- Restores:
  - `stageId = replacedStageId`
  - `stageStatus = pending`
  - `status = open`
  - `archived = false`
  - `nextActionAt = computeRecalculatedStageTimestamp(...)`
  - clears snap metadata fields.

### Is restore exact revert or recompute?
- **Current behavior = recompute/hybrid, not strict snapshot date restore.**
- It restores stage identity from snapshot replacement metadata, but schedules by recalculation:
  - anchor = `snapshot.lastCompletedNonPromoStageAt || leadData.lastActionAt`
  - delta = `computeOffsetDeltaDays(pipelineSettings, previousStageId/fallback, replacedStageId)`
  - timestamp = `computeNextActionAt(anchor, delta, dayStartTime)`.

### Why Feb 24 → Feb 22 can happen
- If `lastCompletedNonPromoStageAt` or fallback `lead.lastActionAt` is earlier than the original scheduling anchor, recompute can produce an earlier `nextActionAt` than pre-promo `originalScheduledDate`.
- Since restore ignores stored `originalScheduledDate`, drift to earlier/later dates is expected under this algorithm.

### Why "Christian" may disappear from expected slot
- If Christian was in cohort via non-snap source (`all_active`, `drop_out`, `custom_search`), no snapshot restore occurs; only promotion events are deleted.
- After deletion, only baseline lead schedule remains; if that lead was not independently due on expected date, it appears “missing”.
- Another path: if lead state/archival/completion changed during promotion lifecycle, calendar filters may exclude it.

## 5) Relevant functions and call graph

### Cohort/qualification/snap matching
- `computeTargetLeads` (src/promotions/snap-engine.js): filters leads by targeting strategy, active/dropout/snap eligibility.
- `qualifiesForSnap` (src/promotions/snap-engine.js): boolean wrapper over `findSnapMatch`.
- `findSnapMatch` (src/promotions/snap-engine.js): compares touchpoint days to projected candidate days.
- `getLeadSnapCandidates` / `getLeadSnapCandidateDays` (src/promotions/snap-engine.js): generate current+future stage candidate schedule days.

### Promotion write path
- `createPromotion` (src/promotions/promotion-engine.js): creates promotion doc, optional per-lead snapshots + lead snap metadata, and promotion events.
- `buildPromotionEvents` (src/promotions/promotion-engine.js): constructs event payloads.

### Promotion touchpoint done/skip progression
- `markPromotionEventDone` (src/app.js): marks event complete/archived and reconciles lead progress.
- `markPromotionEventSkipped` (src/app.js): marks event skipped/archived and reconciles lead progress.
- `reconcilePromotionLeadProgress` (src/app.js):
  - updates snapshot completion counters,
  - when all sibling touchpoints are done/skipped, advances lead stage via `completeLeadStage`.
- `completeLeadStage` (src/app.js): stage advancement/closure using pipeline offset deltas and `computeNextActionAt`.

### Push + rollover interactions
- `pushLeadFromPreset` (src/app.js): manual push updates `nextActionAt` and `lastActionAt`.
- `rescheduleLeadAction` (src/data/calendar-service.js): updates lead `nextActionAt` + `lastActionAt`, upserts lead calendar event.
- `runNightlyRolloverIfDue` (src/app.js): nightly due-lead push and post-rollover promotion restoration pass.
- `restoreExpiredPromotionStageReplacements` (src/promotions/promotion-engine.js): restores snap-active leads with zero completed touchpoints after promo expiry.

### Deletion/restore
- `restoreSnappedLeadsAndDeletePromotion` (src/promotions/promotion-engine.js): deletion orchestration.
- `restoreLeadFromPromotionSnapshot` (src/promotions/promotion-engine.js): per-lead restoration.
- `computeRecalculatedStageTimestamp` (src/promotions/promotion-engine.js): recompute timestamp from anchor + pipeline gap.

### High-level call graph
1. UI setup (`renderPromotionForm`) computes cohort via `computeTargetLeads` / `qualifiesForSnap`.
2. Save invokes `createPromotion`.
3. Touchpoint actions invoke `markPromotionEventDone` or `markPromotionEventSkipped` → `reconcilePromotionLeadProgress` → optional `completeLeadStage`.
4. Nightly job invokes `runNightlyRolloverIfDue` → `restoreExpiredPromotionStageReplacements`.
5. Delete invokes `restoreSnappedLeadsAndDeletePromotion` → `restoreLeadFromPromotionSnapshot` per snap-active snapshot lead.

## 6) Consistency assessment against intended model

### Intended: snap should replace a projected future stage, not only immediate upcoming stage
- **Partially matches**.
- Current candidate generation includes projected stages from current stage onward, so future-stage matching is possible.
- However, matching is first-hit based on iteration order, so the selected replacement may not always be “best” projected semantic if multiple candidates qualify.

### Intended: delete promo restores each lead independently
- **Matches** for leads with `addedViaSnapActive === true` snapshots.
- Non-snap-added leads are independent too, but they are not restored because they were never snapped.

### Intended: restore should not drift unless legitimate pipeline-anchor drift
- **Does not fully match strict revert expectations**.
- Implementation intentionally recomputes from anchor (`lastCompletedNonPromoStageAt || lead.lastActionAt`) and ignores stored `originalScheduledDate`.
- Therefore date drift after deletion is expected even without obvious user-visible changes, especially if anchors moved (manual push, rollover, stage completion timing, or stale/missing snapshot anchor).

## Suspected root causes for observed discrepancy
1. **Recompute-based restore, not exact date restore** causes Test Lead date drift (Feb 24 → Feb 22) when anchor timestamp differs from original schedule basis.
2. **Cohort source asymmetry**: Christian may have been included through non-snap targeting (or mixed targeting), so deletion removes promo events but does not restore via snapshot path.
3. **Anchor mutation during promo window**: nightly rollover, manual push, or other lead updates can shift `lastActionAt` anchor fallback used during restore.
4. **First-match snap selection** in `findSnapMatch` may bind to a different candidate stage/day than operator expects if multiple candidates are within window.
