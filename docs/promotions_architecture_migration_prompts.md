# Promotions Redesign — Architecture Breakdown + Paste-Back Prompts

## Current Architecture Audit (as implemented)

### 1) Cohort generation
- Promotion setup computes candidates via `computeTargetLeads()` using:
  - `promotion.targeting` toggles (`snap_active`, `all_active`, `drop_out`, `custom_search`),
  - optional search text,
  - snap qualification (`qualifiesForSnap()`),
  - lead state predicates (`isLeadActive()`, `isLeadDropOut()`).
- The UI keeps a `selectedLeadIds` set that is initialized from the current computed list, then manually edited via checkboxes/select-all.
- On create, only `selectedLeadIds` is persisted as `promotion.leadIds`; this is the locked cohort.

### 2) Snap logic
- Snap matching is computed by `findSnapMatch()`:
  - projects candidate stage days from lead `nextActionAt` + pipeline offsets,
  - computes each touchpoint day from end date and offset,
  - matches when abs(day diff) <= global snap window.
- On promotion creation, for each selected lead:
  - optional snapshot is written under `promotions/{promotionId}/snapshots/{leadId}` with `originalStageId` and original scheduled date,
  - promotion events are created in `users/{userId}/events` (one event per touchpoint per lead).

### 3) Per-lead state tracking
- There is no dedicated per-touchpoint state document.
- State is event-driven:
  - each promotion touchpoint for a lead is an event record with `completed`, `archived`, `status`.
  - `Done` updates that event to completed.
- Progression logic:
  - after marking one event done, system queries sibling events by `(promotionId, leadId)`;
  - if none remain open, lead stage is advanced via `completeLeadStage()`.
- This already supports “done now, remain in later touchpoints” because untouched sibling events stay open.

### 4) Current gaps vs requested redesign
- No promotion-level expanded container touchpoint dashboard exists yet; current detail page is single event detail.
- Cohort building UX is toggle/filter + manual checkbox set, not explicit additive actions with a cohort-preview source of truth.
- No explicit `Skip` action for touchpoints.
- Template UX currently shows per-event template fields and allows open-mail from single event detail.

---

## What must change (minimal structural deltas)

### A) Containerized touchpoint model (finalization)
- Introduce a promotion-level detail view as the primary “expanded” experience.
- Display touchpoints as metadata variants (due date/template/ordinal), all referencing the same locked `promotion.leadIds` cohort.
- Keep per-lead touchpoint state event-driven (reuse existing event docs); do not introduce a second workflow engine.

### B) Action semantics
- Add `Skip` at lead+touchpoint scope:
  - write to that specific event (`status: skipped`, `skippedAt`, `archived: true`, `completed: false`).
- Finalization rule remains sibling-event based:
  - if no open siblings remain after done/skip, call `completeLeadStage()`.
- Replace promotion “Push” affordance with “Skip” only in promotion touchpoint UI.

### C) Template behavior (Option B)
- In touchpoint expanded view:
  - show base template preview and detected variables,
  - add `Preview As…` lead selector to render one personalized sample,
  - no per-lead inline editing.
- Keep edit flow routed to promotion configuration screen; save updates touchpoint template config.

### D) Additive cohort building + preview as source of truth
- Replace implicit toggle-driven selection with explicit additive actions:
  - `Snap Active Leads` => add matching IDs into cohort set,
  - `Drop Off Leads` => add matching IDs into cohort set,
  - `All Active Leads` => add active IDs into cohort set.
- `Custom Search` adds only user-selected lead(s) to the same cohort set.
- Cohort preview panel is canonical state (`cohortDraftLeadIds` set); all buttons mutate this set only.
- Include explicit clear/remove controls to make replacement intentional.

### E) Snap mutation mode distinction
- Add a per-lead snap-mode marker when cohort is built:
  - `snap_mode: precision` for snap-active selections,
  - `snap_mode: full_active` for all-active selections.
- Preserve existing snap window logic for qualification; extend downstream mutation handling to branch by mode where required (without changing baseline pipeline APIs).

---

## Migration plan (safe, staged)

1. **Introduce data shape additions, backward compatible**
   - Optional fields only (`status: skipped`, `skippedAt`, `selectionSources` / `snapModeByLead`).
   - Keep existing reads defaulting unknown values.

2. **Build promotion container detail screen**
   - New route for promotion-level expanded view.
   - Aggregate existing events by touchpoint and lead.

3. **Implement Skip action + completion reconciliation**
   - Reuse sibling query logic currently used for Done.

4. **Switch setup UX to additive cohort builder**
   - Cohort preview set becomes single source of truth.
   - Preserve create payload contract (`leadIds`) plus optional metadata.

5. **Template Option B UI adjustments**
   - Base template + variable list + preview-as selector.
   - Edit button links to existing promotion config.

6. **Compatibility and rollout**
   - Existing promotions render through fallback path if new metadata absent.
   - No migration script required; lazy-compatible reads.

---

## Paste-back prompt (single combined prompt)

```text
Implement the Promotions redesign in this repository with a minimal-risk, backward-compatible migration.

GOALS
1) Finalize promotion touchpoints as a container model:
   - One promotion owns one cohort (`leadIds`).
   - Touchpoints do not own separate cohorts.
   - Touchpoints differ only by metadata (due date, template, ordinal label).
   - Build/route an expanded promotion-level detail view (mini dashboard) showing:
     - promotion metadata,
     - touchpoint metadata,
     - Edit button to promotion configuration.

2) Template behavior (Option B):
   - In expanded touchpoint view, show base template preview only.
   - Show detected template variables.
   - Add “Preview As…” selector to render one selected lead’s personalization.
   - No per-lead inline template editing there.
   - Keep personalization for lead-row actions (Open Mail / Copy) at action time.

3) Per-lead actions:
   - Support Open Mail, Copy, Done, Skip (Skip replaces Push in promotion touchpoint context).
   - Skip applies only to that lead in that touchpoint.
   - If final touchpoint is done/skipped for that lead, complete promotion for that lead and advance normal pipeline progression.

4) State model:
   - Audit existing per-lead/per-touchpoint tracking and reuse current event-driven approach.
   - Do NOT redesign from scratch.
   - Extend only where necessary to represent skipped state and reconciliation.

5) Cohort generation redesign (additive + explicit):
   - Buttons become additive actions into one cohort preview set:
     - Snap Active Leads => add matching leads.
     - Drop Off Leads => add matching leads.
     - All Active Leads => add matching leads.
   - Custom Search is additive-only (adds selected lead(s), no hidden preset implications).
   - Cohort preview is single source of truth; no hidden internal selection state.
   - Support explicit clear/remove.

6) Snap behavior distinction:
   - Preserve existing active snap rules.
   - Add minimal metadata to distinguish precision snap vs full-active selection where needed for downstream pipeline mutation behavior.

CONSTRAINTS
- Preserve existing pipeline progression contracts and deterministic behavior.
- Backward-compatible reads/writes for existing promotions and events.
- Prefer optional new fields over destructive schema changes.
- Keep changes scoped; avoid introducing a second workflow engine.

DELIVERABLES
- Code changes.
- Brief architecture note in docs summarizing:
  - previous behavior,
  - new behavior,
  - migration compatibility approach.
- Tests/checks for affected logic and UI interactions.
```
