smolCRM — Promotions System
Full Engineering Specification - Promotions Tab

Concept Overview

A Promotion is a deadline-based micro-pipeline that:

Contains one or more touchpoints relative to an End Date

Temporarily replaces a lead’s current stage if Snap logic qualifies

Overrides execution of that stage

Advances the pipeline normally after completion

Never auto-sends emails (manual execution only)

Promotions are color-coded green in the UI.

Promotions Tab (Main Screen)

Layout

Top of page:

Large button: New Promo >

Below:

Section 1: Active

Displays all active promotions

Green bordered cards (same structural style as Leads list, but green)

Card displays:

Promotion Name only

Sorting rules:

Sorted by closest upcoming End Date first

If tie: most recently created first

Section 2: Finished

Displays expired promotions

Green bordered cards

Sorted by most recently finished first

A promotion automatically moves from Active → Finished when:

Current date/time > End Date

Promotion Creation Flow

Page 1 — Preset Selection

Layout:

Title: New Promo

Input: Promo Name

Input: End Date (date + time picker)

Below that:

Presets (Required Selection)

User must select one:

Precision Strike

Deadline Push

High Impact

Revival

Custom

Below Custom:

Recent Presets

Automatically generated from previous promo configurations.
Displays:

Preset name

Created date

Selecting a preset pre-configures Page 2 but does not lock it.

Preset Definitions

Presets pre-fill:

Touchpoints

Targeting Strategy

User can modify before saving.

Precision Strike

Touchpoints:

1 touchpoint

Notify 2 days before end date

Targeting:

Snap Active Leads only

Purpose:
Replace existing scheduled follow-ups with promo messaging.

Deadline Push

Touchpoints:

2 touchpoints

5 days before

1 day before

Targeting:

Snap Active Leads

All Active Leads

High Impact

Touchpoints:

3 touchpoints

7 days before

2 days before

0 days (end date)

Targeting:

All Active Leads

All Drop-Off Leads

Revival

Touchpoints:

1 touchpoint

2 days before

Targeting:

All Drop-Off Leads only

Custom

No prefilled values.

User configures manually.

Promotion Setup — Page 2 (Configuration)

Layout sections:

5.1 Basic Info

Promo Name (editable)

End Date (editable)

5.2 Touchpoints Section

Displayed inside bordered container.

Each touchpoint contains:

“Notify Leads [X days] before end of promo”

Dropdown for X

Template fields:

Subject

Opening

Body

Closing

Button:

Add Touchpoint

Duplicates block

Touchpoints are independent.

Templates may be left blank.

Touchpoint date calculation:

Touchpoint Date =
End Date – Offset

5.3 Targeting Strategy

Four toggle buttons (multi-select allowed):

Snap Active Leads

All Drop-Off Leads

All Active

Custom Search

Selected buttons visually highlighted.

Definitions

Active Lead:

State is not Closed – Won

Not Closed – Lost

Not Drop-Out

Drop-Out Lead:

Reached final stage

Not marked Won or Lost

Auto-classified as Drop-Out

Snap System

6.1 Global Setting

In Settings:

Snap Window (Days)

Default: ±2

User editable.

Applies globally to all promotions.

6.2 Snap Qualification Logic

For each promotion touchpoint:

Touchpoint Date =
End Date – Offset

Snap Window =
Touchpoint Date ± Snap Window

If an Active lead has a scheduled stage event within that range,
the lead qualifies as Snap Active.

Qualification by any one touchpoint is sufficient.

Stage Replacement Model (Critical)

When a lead qualifies as Snap Active and is included:

The system performs a full stage replacement.

Steps:

Identify the lead’s current stage.

Identify all scheduled events associated with that stage.

Permanently delete those scheduled events.

Replace stage execution with promotion touchpoints.

Internal Engineering Note:
At snap time, store originalStageId and originalScheduledDate internally in `promotions/{promotionId}/snapshots/{leadId}`.
This state is used for deterministic per-lead restoration when deleting a promotion.

Promotion Deletion Restoration:
- Delete the promotion document.
- Delete all `events` where `promotionId` matches.
- For each snapshot lead, restore that specific lead's `stageId` and `nextActionAt` from snapshot state.
- Remove temporary snap metadata fields from each restored lead.
- If a lead changed independently after snap, current behavior is **authoritative restore** (snapshot wins) to preserve deterministic “as-if-promotion-never-existed” semantics.

The original scheduled stage events:

Are deleted

Are not suppressed

Leave no UI artifact

Are not visible in dashboard

Entire stage is replaced.
Not partial.

Promotion as Micro-Pipeline

For snapped leads:

Current stage execution becomes:

Promo Touchpoint 1

Promo Touchpoint 2

...

These appear as dashboard events.

They function identically to normal stage events.

The promotion becomes the execution engine for that stage.

Stage Completion Behavior

When the final promotion touchpoint is completed:

Current stage is marked complete.

Lead advances to next stage.

Next stage scheduling is calculated from:

The last completed promotion contact date.

Never from:

Original stage date

Promo end date

First promo contact

Always:
Last contact date.

Resume Example

Carl
Stage 3
Original follow-up: Feb 7

Promo:
End Date: Feb 10

Touchpoints:

Feb 8

Feb 9

Snap Window: ±2

Carl qualifies.

System:

Deletes Feb 7 event.

Stage 3 execution:

Feb 8 promo

Feb 9 promo

User completes Feb 9.

Stage 4 scheduling begins from Feb 9.

If Stage 4 delay = 10 days → Feb 19.

Target List Display

Below targeting buttons:

System displays matching leads.

Each lead:

Appears as standard lead card

Pre-selected

Checkbox toggle

Select All option

Custom Search:

Text search by:

Name

Product (text-based)

User can manually unselect leads.

Create Promo

When user clicks Create Promo:

System stores:

Promo Name

End Date

Touchpoints

Explicit lead list at time of creation

Preset configuration snapshot

Promotion becomes Active.

Removal Edge Case

If a lead is removed from promo before any promo touchpoint is completed:

System recalculates current stage schedule:

New schedule =
Today + stage delay

Original deleted event is not restored.

System remains deterministic.

Deterministic Rules Summary

Normal:

Stage → Event → Done → Next Stage

Snap:

Stage → Delete Original Events → Promo Touchpoints → Done → Next Stage

No branching.
No dual schedules.
No overlap.
No partial execution.

Explicit Non-Goals

This system does not:

Auto-send emails

Track open rates

Track clicks

Auto-complete stages

Add marketing analytics

This is execution override only.

Engineering Notes

Order of operations:

Compute touchpoint dates.

Compute snap windows.

Evaluate lead eligibility.

Generate target list.

On create:

Lock explicit lead list.

On snap:

Delete stage events.

Insert promo events.

All snap logic must be deterministic and reversible only by recalculation, not restoration.

Clarification: Promotions as Bulk-Scheduled Dashboard Events

The core mental model of smolCRM is:

The Dashboard is the system.

Salespeople do not think in terms of abstract pipelines.
They think in terms of:

“What do I need to do today?”

Everything in smolCRM ultimately resolves into dashboard events.

Pipeline stages create dashboard events.
Tasks create dashboard events.
Promotions must behave the same way.

Promotions Are Not Campaign Engines

Promotions are not marketing automation.

They are a way to bulk schedule dashboard events in a controlled and structured way.

When a promotion is created:

It generates individual scheduled events for each selected lead.

Those events appear on the dashboard exactly like normal stage events.

They also appear on the calendar exactly like normal scheduled actions.

From the user’s perspective, there is no conceptual difference between:

A Stage 3 follow-up

A Task reminder

A Promotion touchpoint

They are all simply:

“Contact Carl on February 9.”

The only difference is how they were generated.

Promotions Are Individual at Execution Time

Even though a promotion is created in bulk:

Once it hits the dashboard, each event is independent.

Example:

On February 9, the dashboard may show:

Carl Simon – Contact for Jacuzzi Promo

Denise Taylor – Contact for Sauna Promo

Rhonda – Stage 4 Follow-up

Each entry behaves like a normal lead interaction:

Click → opens expanded view

Template is prefilled

Open Mail

Click Done

From the system’s perspective, each promotion touchpoint becomes a normal executable event.

Overlapping Promotions

Promotions do not need to block or prevent overlap at the system level.

If a lead qualifies for multiple promotions:

The dashboard will simply show multiple scheduled entries.

Example:

February 9:

Carl Simon – Jacuzzi Promo

Carl Simon – Sauna Promo

This is not a system conflict.

It is a visibility issue.

The user will see both and can choose to:

Combine messaging manually

Execute both

Clear one

The system remains deterministic and transparent.

Footnote — Dashboard Visual Behavior & Structural Constraints

Promotion Events in Dashboard

Promotion-generated events must behave and appear structurally identical to existing dashboard event cards (lead stage events and tasks).

They must:

Be the exact same size.

Use the same layout.

Use the same spacing and typography.

Expand the same way when clicked.

Use the same interaction patterns (Open Mail, Done, etc.).

The only visual distinction:

The border color of promotion-generated events is green.

Lead stage events remain blue.

Task events remain red.

No additional badges, icons, tags, or indicators should be added at this stage.

Promotion cards in the Promotions tab also use the same green border styling for consistency.

Expanded View Behavior (Dashboard → Promotion Event)

When a user clicks a promotion-generated event from the dashboard:

It should open using the same expanded view layout as a lead stage event.

The UI structure must be identical.

The only difference is that the template shown is the promotion template associated with that specific touchpoint.

Specifically:

Subject, Opening, Body, and Closing fields should reflect the promotion touchpoint configuration.

Open Mail and Done behavior remain identical to stage-based events.

Completing the final touchpoint triggers stage advancement logic as defined in the Snap override specification.

No alternate layout should be introduced for promotion events.

They must feel native to the system.

Code Structure & Modularity Requirements

This feature must respect existing architecture and modular structure.

Implementation guidelines:

Reuse the existing Template module for promotion touchpoints.

Reuse existing Dashboard event rendering components.

Do not duplicate logic for:

Event rendering

Template generation

Stage completion handling

Introduce new modules only where necessary (e.g., PromotionEngine, SnapEngine).

Snap logic, promotion configuration, and stage replacement behavior should be isolated into clearly defined modules.

Avoid:

Embedding snap logic directly inside stage logic.

Hardcoding promotion conditions inside dashboard rendering.

Creating one-off logic branches that bypass existing pipeline systems.

The system must remain deterministic and modular.

Promotion events should plug into the existing event system, not fork it.

This feature must be implemented as strictly additive.

All existing functionality — including dashboard behavior, stage progression logic, task handling, template rendering, and lead state management — should be treated as fully functional and stable.

No unrelated logic should be modified, refactored, or “cleaned up” as part of this implementation.

The promotions system must integrate into the existing architecture without altering or breaking current behavior.

If behavior overlap is detected, the solution must adapt to the existing system rather than rewrite it.

Implementation Directive:

Implement the full Promotions system exactly as specified above.

This is not a planning phase. This is a full feature implementation.

All functionality described in this document must be completed, integrated, and working end-to-end, including:

Promotions tab UI

Promotion creation flow (Preset + Configuration pages)

Snap logic and stage replacement

Dashboard event generation

Targeting logic

Deterministic stage advancement behavior

Green promotion event rendering

Modularity and structural constraints

Do not return a proposal or partial outline.

Return a completed implementation.

After implementation, provide:

A concise summary of all files modified and created.

A clear description of new modules introduced (e.g., PromotionEngine, SnapEngine).

A confirmation that no existing unrelated functionality was altered.

Any assumptions made during implementation.

The goal is a fully functional, integrated Promotions system.
