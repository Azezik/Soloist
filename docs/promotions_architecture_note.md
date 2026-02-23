# Promotions Redesign Architecture Note

## Previous behavior
- Promotion targeting was driven by toggle filters and implicit selection state during setup.
- Promotion execution state was already event-driven (`users/{userId}/events`) per lead per touchpoint.
- Promotion detail UX was primarily single-event focused (`promotion-event/:id`) instead of a promotion container dashboard.

## New behavior
- Promotion detail now supports a promotion-level container view (`promotion/:id`) with:
  - promotion metadata,
  - touchpoint metadata,
  - touchpoint-level template preview (base + Preview As),
  - per-lead actions: Open Mail, Copy, Done, Skip.
- Cohort building in setup is now additive:
  - add Snap Active leads,
  - add Drop Off leads,
  - add All Active leads,
  - add Custom Search results.
- Cohort preview is the source of truth for what will be affected.

## Migration compatibility
- Existing event-driven progression is preserved; completion still reconciles by checking remaining open sibling touchpoint events.
- `Skip` is implemented as optional event status (`status: skipped`, `skippedAt`) without replacing the engine.
- Promotion writes are backward-compatible by adding optional metadata (`selectionSourcesByLead`, `snapModeByLead`) and keeping `leadIds` as the canonical cohort.
