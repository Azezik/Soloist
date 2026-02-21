# Calendar scheduling notes

This calendar feature is read-only and uses existing persisted fields only:

- **Tasks** are scheduled by `tasks.scheduledFor`.
- **Leads** are scheduled by `leads.nextActionAt`.

## Timestamp handling

The calendar accepts date values that can be converted by JavaScript's `Date` constructor, including Firestore `Timestamp` objects (via `.toDate()`) and ISO datetime strings.

## Timezone handling

Dates/times are rendered in the **user's local browser timezone**. Day grouping is computed from local year/month/day values (not UTC ISO slicing) to avoid off-by-one date shifts.

## Assumptions

- If an item has no usable schedule field value, it is omitted from the calendar.
- Midnight values (`00:00`) are treated as all-day/no-time items in day view.
- Completed/archived tasks and completed/archived leads are not shown.
