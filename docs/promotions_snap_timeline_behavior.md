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
