import { collection, db, getDocs } from "../data/firestore-service.js";
import {
  addMonths,
  formatDayTitle,
  formatMonthTitle,
  formatTimeLabel,
  startOfMonth,
  toDate,
  toDayKey,
} from "./date-utils.js";
import {
  buildMonthGrid,
  computeTimePositionPercent,
  groupItemsByDay,
  normalizeCalendarItems,
  splitDayItems,
} from "./calendar-utils.js";

const MAX_MONTH_CHIPS = 3;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_VIEW_START_HOUR = 6;
const DAY_VIEW_END_HOUR = 22;

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getItemClass(itemType) {
  return itemType === "task" ? "calendar-item--task" : "calendar-item--lead";
}

function renderMonthView(state) {
  const grid = buildMonthGrid(state.visibleMonth, 0);
  const byDay = groupItemsByDay(state.items);

  const gridMarkup = grid
    .map((cell) => {
      const dayItems = byDay[cell.dayKey] || [];
      const previewItems = dayItems.slice(0, MAX_MONTH_CHIPS);
      const remaining = dayItems.length - previewItems.length;

      const chips = previewItems
        .map(
          (item) =>
            `<span class="calendar-chip ${getItemClass(item.type)}">${escapeHtml(item.title)}</span>`
        )
        .join("");

      return `
        <button type="button" class="calendar-day-cell ${cell.inMonth ? "" : "calendar-day-cell--outside"} ${
          cell.isToday ? "calendar-day-cell--today" : ""
        }" data-open-day="${cell.dayKey}">
          <span class="calendar-day-number">${cell.date.getDate()}</span>
          <div class="calendar-chip-list">
            ${chips}
            ${remaining > 0 ? `<span class="calendar-more">+${remaining} more</span>` : ""}
          </div>
        </button>
      `;
    })
    .join("");

  state.viewContainer.innerHTML = `
    <section class="crm-view crm-view--calendar">
      <div class="view-header calendar-header">
        <h2>Calendar</h2>
        <div class="calendar-controls">
          <button type="button" data-cal-nav="prev" aria-label="Previous month">←</button>
          <p class="calendar-month-title">${escapeHtml(formatMonthTitle(state.visibleMonth))}</p>
          <button type="button" data-cal-nav="next" aria-label="Next month">→</button>
        </div>
      </div>
      <div class="calendar-weekdays">
        ${WEEKDAY_LABELS.map((label) => `<span>${label}</span>`).join("")}
      </div>
      <div class="calendar-month-grid">${gridMarkup}</div>
    </section>
  `;

  state.viewContainer.querySelectorAll("[data-cal-nav]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", () => {
      const delta = buttonEl.dataset.calNav === "next" ? 1 : -1;
      state.visibleMonth = addMonths(state.visibleMonth, delta);
      renderMonthView(state);
    });
  });

  state.viewContainer.querySelectorAll("[data-open-day]").forEach((dayEl) => {
    dayEl.addEventListener("click", () => {
      state.selectedDayKey = dayEl.dataset.openDay;
      renderDayView(state);
    });
  });
}

function renderDayView(state) {
  const selectedDate = toDate(`${state.selectedDayKey}T00:00:00`) || new Date();
  const { timed, allDay } = splitDayItems(state.items, selectedDate);

  const hourRows = [];
  for (let hour = DAY_VIEW_START_HOUR; hour <= DAY_VIEW_END_HOUR; hour += 1) {
    const rowDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), hour, 0, 0);
    hourRows.push(
      `<div class="calendar-time-row"><span class="calendar-time-label">${formatTimeLabel(rowDate)}</span></div>`
    );
  }

  const timedBlocks = timed
    .map((item) => {
      const top = computeTimePositionPercent(item.date, DAY_VIEW_START_HOUR, DAY_VIEW_END_HOUR);
      return `
        <article class="calendar-day-block ${getItemClass(item.type)}" style="top:${top}%">
          <p>${escapeHtml(item.title)}</p>
          <small>${escapeHtml(formatTimeLabel(item.date))}${item.secondary ? ` · ${escapeHtml(item.secondary)}` : ""}</small>
        </article>
      `;
    })
    .join("");

  const allDayMarkup = allDay.length
    ? allDay
        .map(
          (item) => `
            <article class="calendar-allday-item ${getItemClass(item.type)}">
              <p>${escapeHtml(item.title)}</p>
              ${item.secondary ? `<small>${escapeHtml(item.secondary)}</small>` : ""}
            </article>
          `
        )
        .join("")
    : '<p class="calendar-empty">No all-day items</p>';

  state.viewContainer.innerHTML = `
    <section class="crm-view crm-view--calendar">
      <div class="view-header calendar-header">
        <div>
          <button type="button" class="calendar-back-btn" data-back-month="true">← Month view</button>
          <h2>${escapeHtml(formatDayTitle(selectedDate).replace(",", " —"))}</h2>
        </div>
      </div>

      <section class="calendar-allday-panel panel">
        <h3>All-day / No time</h3>
        <div class="calendar-allday-list">${allDayMarkup}</div>
      </section>

      <section class="calendar-day-grid panel">
        <div class="calendar-time-rows">${hourRows.join("")}</div>
        <div class="calendar-events-layer">${timedBlocks || '<p class="calendar-empty">No timed items</p>'}</div>
      </section>
    </section>
  `;

  state.viewContainer.querySelector("[data-back-month='true']")?.addEventListener("click", () => {
    renderMonthView(state);
  });
}

export async function renderCalendarScreen({ viewContainer, currentUserId }) {
  const [contactsSnapshot, tasksSnapshot, leadsSnapshot] = await Promise.all([
    getDocs(collection(db, "users", currentUserId, "contacts")),
    getDocs(collection(db, "users", currentUserId, "tasks")),
    getDocs(collection(db, "users", currentUserId, "leads")),
  ]);

  const contactsById = contactsSnapshot.docs.reduce((acc, docItem) => {
    acc[docItem.id] = { id: docItem.id, ...docItem.data() };
    return acc;
  }, {});

  const tasks = tasksSnapshot.docs
    .map((taskDoc) => ({ id: taskDoc.id, ...taskDoc.data() }))
    .filter((task) => !task.completed && !task.archived);

  const leads = leadsSnapshot.docs
    .map((leadDoc) => ({ id: leadDoc.id, ...leadDoc.data() }))
    .filter((lead) => lead.stageStatus !== "completed" && !lead.archived)
    .map((lead) => {
      const linkedContact = lead.contactId ? contactsById[lead.contactId] : null;
      return {
        ...lead,
        name: linkedContact?.name || lead.name || "",
        company: linkedContact?.company || lead.company || "",
        email: linkedContact?.email || lead.email || "",
      };
    });

  // Scheduling source of truth:
  // - Tasks use `scheduledFor`.
  // - Leads use `nextActionAt`.
  // If both a date and time exist in the stored timestamp/string, local browser timezone is used for rendering.
  const state = {
    viewContainer,
    visibleMonth: startOfMonth(new Date()),
    selectedDayKey: toDayKey(new Date()),
    items: normalizeCalendarItems(tasks, leads),
  };

  renderMonthView(state);
}
