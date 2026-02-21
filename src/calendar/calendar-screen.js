import { getCalendarData, updateCalendarItemSchedule } from "../data/calendar-service.js";
import {
  addDays,
  addMonths,
  addWeeks,
  formatDayTitle,
  formatMonthTitle,
  formatTimeLabel,
  formatWeekRangeTitle,
  fromDayKey,
  startOfDay,
  startOfMonth,
  toDayKey,
} from "./date-utils.js";
import {
  buildMonthGrid,
  buildWeekDays,
  computeTimedBlockStyle,
  groupItemsByDay,
  normalizeCalendarItems,
  splitDayItems,
} from "./calendar-utils.js";

const MAX_MONTH_CHIPS = 3;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_VIEW_START_HOUR = 0;
const DAY_VIEW_END_HOUR = 24;
const VIEW_MONTH = "month";
const VIEW_WEEK = "week";
const VIEW_DAY = "day";
const SNAP_MINUTES = 15;
const DEFAULT_DROP_TIME = { hour: 8, minute: 30 };

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

function renderEventChip(item, className = "calendar-chip") {
  return `<button type="button" draggable="true" class="${className} ${getItemClass(item.type)}" data-open-item="${item.path}" data-drag-item-id="${item.id}" data-drag-item-type="${item.type}">${escapeHtml(
    item.title
  )}</button>`;
}

function openItem(path) {
  window.location.hash = path;
}

function addDefaultTime(date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    DEFAULT_DROP_TIME.hour,
    DEFAULT_DROP_TIME.minute,
    0,
    0
  );
}

function withTimeFromMinutes(date, minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

function toSnappedMinutes(rawMinutes) {
  return Math.round(rawMinutes / SNAP_MINUTES) * SNAP_MINUTES;
}

function resolveDroppedDate(item, targetDay, options = {}) {
  const keepNoTime = options.keepNoTime ?? !item.hasTime;
  if (keepNoTime) {
    return new Date(targetDay.getFullYear(), targetDay.getMonth(), targetDay.getDate(), 0, 0, 0, 0);
  }

  if (typeof options.minutes === "number") {
    return withTimeFromMinutes(targetDay, toSnappedMinutes(options.minutes));
  }

  return addDefaultTime(targetDay);
}

async function applyItemReschedule(state, dragItem, nextDate) {
  await updateCalendarItemSchedule(state.currentUserId, dragItem, nextDate);
  state.items = state.items
    .map((item) => {
      if (item.id !== dragItem.id || item.type !== dragItem.type) return item;
      return {
        ...item,
        date: nextDate,
        dayKey: toDayKey(nextDate),
        hasTime: nextDate.getHours() !== 0 || nextDate.getMinutes() !== 0 || nextDate.getSeconds() !== 0,
      };
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

function getDraggedItem(state) {
  if (!state.dragState?.itemId || !state.dragState?.itemType) return null;
  return (
    state.items.find((item) => item.id === state.dragState.itemId && item.type === state.dragState.itemType) || null
  );
}

function renderCalendarHeader(state, title) {
  return `
    <div class="view-header calendar-header">
      <h2>Calendar</h2>
      <div class="calendar-toolbar">
        <div class="calendar-nav-controls">
          <button type="button" data-cal-nav="prev" aria-label="Go previous period">←</button>
          <button type="button" data-cal-today="true">Today</button>
          <button type="button" data-cal-nav="next" aria-label="Go next period">→</button>
          <p class="calendar-period-title">${escapeHtml(title)}</p>
        </div>
        <div class="calendar-view-switcher" role="tablist" aria-label="Calendar view switcher">
          <button type="button" data-cal-view="month" class="${state.view === VIEW_MONTH ? "is-active" : ""}">Month</button>
          <button type="button" data-cal-view="week" class="${state.view === VIEW_WEEK ? "is-active" : ""}">Week</button>
          <button type="button" data-cal-view="day" class="${state.view === VIEW_DAY ? "is-active" : ""}">Day</button>
        </div>
      </div>
    </div>
  `;
}

function attachSharedHeaderEvents(state) {
  state.viewContainer.querySelectorAll("[data-cal-view]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", () => {
      state.view = buttonEl.dataset.calView;
      renderByView(state);
    });
  });

  state.viewContainer.querySelector("[data-cal-today='true']")?.addEventListener("click", () => {
    state.focusedDate = startOfDay(new Date());
    renderByView(state);
  });

  state.viewContainer.querySelectorAll("[data-cal-nav]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", () => {
      const delta = buttonEl.dataset.calNav === "next" ? 1 : -1;
      if (state.view === VIEW_MONTH) state.focusedDate = addMonths(state.focusedDate, delta);
      if (state.view === VIEW_WEEK) state.focusedDate = addWeeks(state.focusedDate, delta);
      if (state.view === VIEW_DAY) state.focusedDate = addDays(state.focusedDate, delta);
      renderByView(state);
    });
  });
}

function attachSharedDragEvents(state) {
  state.viewContainer.querySelectorAll("[data-drag-item-id]").forEach((itemEl) => {
    itemEl.addEventListener("dragstart", (event) => {
      state.dragState = {
        itemId: itemEl.dataset.dragItemId,
        itemType: itemEl.dataset.dragItemType,
      };
      state.suppressNextOpen = false;
      itemEl.classList.add("calendar-chip--dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", `${state.dragState.itemType}:${state.dragState.itemId}`);
    });

    itemEl.addEventListener("dragend", () => {
      itemEl.classList.remove("calendar-chip--dragging");
      state.dragState = null;
      state.suppressNextOpen = true;
      window.setTimeout(() => {
        state.suppressNextOpen = false;
      }, 0);
      state.viewContainer.querySelectorAll(".calendar-drop-target--active").forEach((el) => {
        el.classList.remove("calendar-drop-target--active");
      });
    });
  });
}

function renderMonthView(state) {
  const monthDate = startOfMonth(state.focusedDate);
  const grid = buildMonthGrid(monthDate, 0);
  const byDay = groupItemsByDay(state.items);

  const gridMarkup = grid
    .map((cell) => {
      const dayItems = byDay[cell.dayKey] || [];
      const previewItems = dayItems.slice(0, MAX_MONTH_CHIPS);
      const remaining = dayItems.length - previewItems.length;

      const chips = previewItems.map((item) => renderEventChip(item)).join("");

      return `
        <article class="calendar-day-cell ${cell.inMonth ? "" : "calendar-day-cell--outside"} ${
          cell.isToday ? "calendar-day-cell--today" : ""
        }" data-open-day="${cell.dayKey}" data-drop-day="${cell.dayKey}" role="button" tabindex="0" aria-label="Open ${cell.date.toDateString()}">
          <span class="calendar-day-number">${cell.date.getDate()}</span>
          <div class="calendar-chip-list">
            ${chips}
            ${remaining > 0 ? `<button type="button" class="calendar-more" data-open-day="${cell.dayKey}">+${remaining} more</button>` : ""}
          </div>
        </article>
      `;
    })
    .join("");

  state.viewContainer.innerHTML = `
    <section class="crm-view crm-view--calendar">
      ${renderCalendarHeader(state, formatMonthTitle(monthDate))}
      <div class="calendar-weekdays">${WEEKDAY_LABELS.map((label) => `<span>${label}</span>`).join("")}</div>
      <div class="calendar-month-grid">${gridMarkup}</div>
    </section>
  `;

  attachSharedHeaderEvents(state);
  attachSharedDragEvents(state);

  state.viewContainer.querySelectorAll(".calendar-day-cell[data-open-day]").forEach((dayEl) => {
    dayEl.addEventListener("click", () => {
      if (state.suppressNextOpen) return;
      const selectedDate = fromDayKey(dayEl.dataset.openDay);
      if (!selectedDate) return;
      state.focusedDate = selectedDate;
      state.view = VIEW_DAY;
      renderByView(state);
    });

    dayEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      const selectedDate = fromDayKey(dayEl.dataset.openDay);
      if (!selectedDate) return;
      state.focusedDate = selectedDate;
      state.view = VIEW_DAY;
      renderByView(state);
    });

    dayEl.addEventListener("dragover", (event) => {
      if (!state.dragState) return;
      event.preventDefault();
      dayEl.classList.add("calendar-drop-target--active");
    });

    dayEl.addEventListener("dragleave", () => {
      dayEl.classList.remove("calendar-drop-target--active");
    });

    dayEl.addEventListener("drop", async (event) => {
      if (!state.dragState) return;
      event.preventDefault();
      event.stopPropagation();
      dayEl.classList.remove("calendar-drop-target--active");
      const targetDate = fromDayKey(dayEl.dataset.dropDay);
      const dragItem = getDraggedItem(state);
      if (!targetDate || !dragItem) return;
      const nextDate = resolveDroppedDate(dragItem, targetDate, { keepNoTime: !dragItem.hasTime });
      await applyItemReschedule(state, dragItem, nextDate);
      renderByView(state);
    });
  });

  state.viewContainer.querySelectorAll(".calendar-more[data-open-day]").forEach((moreEl) => {
    moreEl.addEventListener("click", (event) => {
      event.stopPropagation();
      const selectedDate = fromDayKey(moreEl.dataset.openDay);
      if (!selectedDate) return;
      state.focusedDate = selectedDate;
      state.view = VIEW_DAY;
      renderByView(state);
    });
  });

  state.viewContainer.querySelectorAll("[data-open-item]").forEach((itemEl) => {
    itemEl.addEventListener("click", (event) => {
      if (state.suppressNextOpen) return;
      event.stopPropagation();
      openItem(itemEl.dataset.openItem);
    });
  });
}

function renderWeekView(state) {
  const weekDays = buildWeekDays(state.focusedDate, 0);

  const allDayColumns = weekDays
    .map((day) => {
      const { allDay } = splitDayItems(state.items, day.date);
      const preview = allDay.slice(0, 2).map((item) => renderEventChip(item)).join("");
      const remaining = allDay.length - 2;
      return `
        <div class="calendar-week-all-day-cell" data-open-day="${day.dayKey}" data-week-drop-day="${day.dayKey}" data-week-drop-minutes="${
          DEFAULT_DROP_TIME.hour * 60 + DEFAULT_DROP_TIME.minute
        }">
          ${preview || '<span class="calendar-empty">No all-day</span>'}
          ${remaining > 0 ? `<span class="calendar-more" data-open-day="${day.dayKey}">+${remaining} more</span>` : ""}
        </div>
      `;
    })
    .join("");

  const headerDays = weekDays
    .map(
      (day) => `<button type="button" class="calendar-week-day-header ${
        day.isToday ? "calendar-week-day-header--today" : ""
      }" data-open-day="${day.dayKey}">${day.date.toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
      })}</button>`
    )
    .join("");

  const timedRows = [];
  for (let hour = DAY_VIEW_START_HOUR; hour < DAY_VIEW_END_HOUR; hour += 1) {
    const rowColumns = weekDays
      .map((day) => {
        const { timed } = splitDayItems(state.items, day.date);
        const thisHour = timed.filter((item) => item.date.getHours() === hour);
        const preview = thisHour
          .slice(0, 2)
          .map((item) => {
            const style = computeTimedBlockStyle(item, thisHour, hour, hour + 1);
            return `<button type="button" draggable="true" class="calendar-week-event ${getItemClass(
              item.type
            )}" style="left:${style.left}%;width:${style.width}%;" data-open-item="${item.path}" data-drag-item-id="${
              item.id
            }" data-drag-item-type="${item.type}">${escapeHtml(formatTimeLabel(item.date))} · ${escapeHtml(item.title)}</button>`;
          })
          .join("");
        const remaining = thisHour.length - 2;

        return `<div class="calendar-week-cell" data-open-day="${day.dayKey}" data-week-drop-day="${day.dayKey}" data-week-drop-minutes="${
          hour * 60
        }">${preview}${remaining > 0 ? `<span class="calendar-more">+${remaining} more</span>` : ""}</div>`;
      })
      .join("");

    timedRows.push(`
      <div class="calendar-week-time-label">${hour.toString().padStart(2, "0")}:00</div>
      ${rowColumns}
    `);
  }

  state.viewContainer.innerHTML = `
    <section class="crm-view crm-view--calendar">
      ${renderCalendarHeader(state, formatWeekRangeTitle(weekDays[0].date))}
      <section class="calendar-week-grid panel">
        <div class="calendar-week-top-left">All-day</div>
        ${headerDays}
        <div class="calendar-week-top-left"></div>
        ${allDayColumns}
        ${timedRows.join("")}
      </section>
    </section>
  `;

  attachSharedHeaderEvents(state);
  attachSharedDragEvents(state);

  state.viewContainer.querySelectorAll("[data-open-day]").forEach((dayEl) => {
    dayEl.addEventListener("click", () => {
      const selectedDate = fromDayKey(dayEl.dataset.openDay);
      if (!selectedDate) return;
      state.focusedDate = selectedDate;
      state.view = VIEW_DAY;
      renderByView(state);
    });
  });

  state.viewContainer.querySelectorAll("[data-week-drop-day]").forEach((cellEl) => {
    cellEl.addEventListener("dragover", (event) => {
      if (!state.dragState) return;
      event.preventDefault();
      cellEl.classList.add("calendar-drop-target--active");
    });

    cellEl.addEventListener("dragleave", () => {
      cellEl.classList.remove("calendar-drop-target--active");
    });

    cellEl.addEventListener("drop", async (event) => {
      if (!state.dragState) return;
      event.preventDefault();
      event.stopPropagation();
      cellEl.classList.remove("calendar-drop-target--active");
      const targetDate = fromDayKey(cellEl.dataset.weekDropDay);
      const targetMinutes = Number(cellEl.dataset.weekDropMinutes);
      const dragItem = getDraggedItem(state);
      if (!targetDate || !dragItem) return;
      const nextDate = resolveDroppedDate(dragItem, targetDate, {
        minutes: Number.isFinite(targetMinutes) ? targetMinutes : undefined,
      });
      await applyItemReschedule(state, dragItem, nextDate);
      renderByView(state);
    });
  });

  state.viewContainer.querySelectorAll("[data-open-item]").forEach((itemEl) => {
    itemEl.addEventListener("click", (event) => {
      if (state.suppressNextOpen) return;
      event.stopPropagation();
      openItem(itemEl.dataset.openItem);
    });
  });
}

function renderDayView(state) {
  const selectedDate = startOfDay(state.focusedDate);
  const { timed, allDay } = splitDayItems(state.items, selectedDate);

  const allDayMarkup = allDay.length
    ? allDay
        .map(
          (item) => `
            <button type="button" draggable="true" class="calendar-allday-item ${getItemClass(item.type)}" data-open-item="${item.path}" data-drag-item-id="${item.id}" data-drag-item-type="${item.type}">
              <p>${escapeHtml(item.title)}</p>
              ${item.secondary ? `<small>${escapeHtml(item.secondary)}</small>` : ""}
            </button>
          `
        )
        .join("")
    : '<p class="calendar-empty">No all-day items</p>';

  const timelineEventsMarkup = timed
    .map((item) => {
      const minutes = item.date.getHours() * 60 + item.date.getMinutes();
      return `<button type="button" draggable="true" class="calendar-day-block ${getItemClass(item.type)}" style="top: calc(var(--day-minute-height) * ${minutes}px);" data-open-item="${
        item.path
      }" data-drag-item-id="${item.id}" data-drag-item-type="${item.type}"><p>${escapeHtml(item.title)}</p><small>${escapeHtml(
        formatTimeLabel(item.date)
      )}</small></button>`;
    })
    .join("");

  const timeRows = [];
  for (let hour = DAY_VIEW_START_HOUR; hour < DAY_VIEW_END_HOUR; hour += 1) {
    timeRows.push(`<div class="calendar-time-row"><span class="calendar-time-label">${hour.toString().padStart(2, "0")}:00</span></div>`);
  }

  state.viewContainer.innerHTML = `
    <section class="crm-view crm-view--calendar">
      ${renderCalendarHeader(state, formatDayTitle(selectedDate))}

      <section class="calendar-allday-panel panel">
        <h3>All-day / No time</h3>
        <div class="calendar-allday-list">${allDayMarkup}</div>
      </section>

      <section class="calendar-day-grid panel">
        <h3>Timeline</h3>
        <div class="calendar-day-grid-inner">
          <div class="calendar-time-rows">${timeRows.join("")}</div>
          <div class="calendar-events-layer" data-day-drop-zone="true">${
            timelineEventsMarkup || '<p class="calendar-empty">No timed items</p>'
          }</div>
        </div>
      </section>
    </section>
  `;

  attachSharedHeaderEvents(state);
  attachSharedDragEvents(state);

  const dayDropZone = state.viewContainer.querySelector("[data-day-drop-zone]");
  dayDropZone?.addEventListener("dragover", (event) => {
    if (!state.dragState) return;
    event.preventDefault();
    dayDropZone.classList.add("calendar-drop-target--active");
  });

  dayDropZone?.addEventListener("dragleave", () => {
    dayDropZone.classList.remove("calendar-drop-target--active");
  });

  dayDropZone?.addEventListener("drop", async (event) => {
    if (!state.dragState) return;
    event.preventDefault();
    dayDropZone.classList.remove("calendar-drop-target--active");
    const dragItem = getDraggedItem(state);
    if (!dragItem) return;
    const bounds = dayDropZone.getBoundingClientRect();
    const relativeY = Math.max(0, Math.min(event.clientY - bounds.top, bounds.height));
    const dayMinutes = DAY_VIEW_END_HOUR * 60;
    const minuteRatio = bounds.height > 0 ? relativeY / bounds.height : 0;
    const snappedMinutes = toSnappedMinutes(Math.round(minuteRatio * dayMinutes));
    const nextDate = resolveDroppedDate(dragItem, selectedDate, { minutes: Math.min(dayMinutes - SNAP_MINUTES, snappedMinutes) });
    await applyItemReschedule(state, dragItem, nextDate);
    renderByView(state);
  });

  state.viewContainer.querySelectorAll("[data-open-item]").forEach((itemEl) => {
    itemEl.addEventListener("click", () => {
      if (state.suppressNextOpen) return;
      openItem(itemEl.dataset.openItem);
    });
  });
}

function renderByView(state) {
  if (state.view === VIEW_WEEK) {
    renderWeekView(state);
    return;
  }

  if (state.view === VIEW_DAY) {
    renderDayView(state);
    return;
  }

  renderMonthView(state);
}

export async function renderCalendarScreen({ viewContainer, currentUserId }) {
  const { tasks, leads } = await getCalendarData(currentUserId);

  const state = {
    viewContainer,
    currentUserId,
    focusedDate: startOfDay(new Date()),
    view: VIEW_MONTH,
    items: normalizeCalendarItems(tasks, leads),
    dragState: null,
    suppressNextOpen: false,
  };

  renderByView(state);
}
