# Promotions + Snap Active timeline behavior

## Timeline morphing scope

- Promotions only morph lead pipeline timelines when that lead was added through the **Snap Active Leads** targeting strategy.
- Leads included through **All Active Leads**, **Drop Off Leads**, or **Custom Search** still receive promotion touchpoint events, but their pipeline schedule is not replaced, snapped, or restored by promotion lifecycle logic.

## Per-lead independence

- Stage replacement, touchpoint completion tracking, and restoration are tracked per lead.
- Completing or skipping promotion touchpoints for one lead does not mutate other leads in the same promotion cohort.

## Restore / recalculate rules

For snap-active leads with a replaced stage:

- On promotion deletion, the replaced stage is restored as pending and recalculated from the lead's last completed non-promotion stage timestamp using normal stage-gap math.
- On nightly rollover after promotion expiry, if a snap-active lead completed zero touchpoints, the replaced stage is restored and recalculated the same way.
- Restores avoid replaying stale saved dates where possible and recompute deterministic schedule timestamps from pipeline settings.

## Hybrid restore policy (Option C)

For `snap_active` leads that received a promotion snapshot:

- Restore always resets stage identity to the replaced stage (`replacedStageId`).
- Restore then decides between:
  - **Strict restore:** use `snapshot.prePromoNextActionAt` exactly.
  - **Recompute restore:** derive `nextActionAt` from pipeline offsets + anchor.

Recompute is used only when:

1. Pipeline settings hash changed since promotion creation (`prePromoPipelineHash` mismatch), or
2. Non-promo anchor drift is detected:
   - `lead.lastActionAt > snapshot.prePromoLastActionAt`, and
   - `lead.lastActionSource !== "promotion_touchpoint"`.

Otherwise strict restore is used, preventing unnecessary date drift on promo deletion/expiry.

Example:
- If a lead was due Feb 24 before promo creation and no non-promo anchor changes happened, delete/expiry restore returns it to **exactly Feb 24**.
- If the lead was genuinely rescheduled by non-promo actions (e.g. push/rollover/normal stage progression), restore recomputes from that new anchor.
