import { auth, createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "./data/auth-service.js";
import {
  db,
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from "./data/firestore-service.js";
import { deleteEntity } from "./data/delete-service.js";
import {
  computeInitialLeadNextActionAt,
  computeNextActionAt,
  computeOffsetDeltaDays,
  computePushedTimestamp,
  getNextStage,
  getStageById,
  normalizeAppSettings,
  sanitizeTimeString,
} from "./domain/settings.js";
import { getAppSettings, getPipelineSettings, pipelineSettingsRef } from "./data/settings-service.js";
import { renderCalendarScreen } from "./calendar/calendar-screen.js";
import { rescheduleLeadAction } from "./data/calendar-service.js";
import {
  DEFAULT_STAGE_TEMPLATE,
  LEAD_TEMPLATE_EMPTY_BODY_PLACEHOLDER,
  buildStageTemplateSettingsMarkup,
  buildTemplateId,
  normalizeStageTemplateEntry,
  normalizeStageTemplates,
  renderTemplateWithLead,
} from "./templates/module.js";

const statusEl = document.getElementById("auth-status");
const emailEl = document.getElementById("email");
const passwordEl = document.getElementById("password");
const loginBtn = document.getElementById("login-btn");
const signupBtn = document.getElementById("signup-btn");
const logoutBtn = document.getElementById("logout-btn");
const authPage = document.getElementById("auth-page");
const appPage = document.getElementById("app-page");
const viewContainer = document.getElementById("view-container");

let currentUser = null;
let nightlyRolloverTimerId = null;
const NIGHTLY_ROLLOVER_HOUR = 23;
const NIGHTLY_ROLLOVER_MINUTE = 59;

function toLocalDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isLeadEligibleForNightlyPush(lead, nowDate) {
  if (!lead || lead.archived || lead.deleted === true) return false;

  const status = String(lead.status || "").toLowerCase();
  const stageStatus = String(lead.stageStatus || "").toLowerCase();
  if (status === "closed" || status === "completed" || status === "done") return false;
  if (stageStatus === "completed" || stageStatus === "done") return false;

  const nextActionDate = toDate(lead.nextActionAt);
  if (!nextActionDate) return false;

  return nextActionDate.getTime() <= nowDate.getTime();
}

async function runNightlyRolloverIfDue() {
  if (!currentUser) return false;

  const nowDate = new Date();
  const reachedCutoff =
    nowDate.getHours() > NIGHTLY_ROLLOVER_HOUR ||
    (nowDate.getHours() === NIGHTLY_ROLLOVER_HOUR && nowDate.getMinutes() >= NIGHTLY_ROLLOVER_MINUTE);

  if (!reachedCutoff) return false;

  const dayKey = toLocalDayKey(nowDate);
  const rolloverStateRef = doc(db, "users", currentUser.uid, "settings", "nightlyRollover");
  const [rolloverStateSnapshot, appSettings, leadsSnapshot] = await Promise.all([
    getDoc(rolloverStateRef),
    getAppSettings(currentUser.uid),
    getDocs(collection(db, "users", currentUser.uid, "leads")),
  ]);

  if (rolloverStateSnapshot.exists() && rolloverStateSnapshot.data()?.lastRunDayKey === dayKey) {
    return false;
  }

  const nextActionAtDate = computeNextActionAt(nowDate, 1, appSettings.pipeline.dayStartTime).toDate();
  const eligibleLeads = leadsSnapshot.docs
    .map((leadDoc) => ({ id: leadDoc.id, ...leadDoc.data() }))
    .filter((lead) => isLeadEligibleForNightlyPush(lead, nowDate));

  await Promise.all(eligibleLeads.map((lead) => rescheduleLeadAction(currentUser.uid, lead.id, nextActionAtDate)));

  await setDoc(
    rolloverStateRef,
    {
      lastRunDayKey: dayKey,
      lastRunAt: serverTimestamp(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  return eligibleLeads.length > 0;
}

function scheduleNightlyRollover() {
  if (nightlyRolloverTimerId) {
    window.clearTimeout(nightlyRolloverTimerId);
    nightlyRolloverTimerId = null;
  }

  if (!currentUser) return;

  const nowDate = new Date();
  const nextRunAt = new Date(nowDate);
  nextRunAt.setHours(NIGHTLY_ROLLOVER_HOUR, NIGHTLY_ROLLOVER_MINUTE, 0, 0);

  if (nextRunAt.getTime() <= nowDate.getTime()) {
    nextRunAt.setDate(nextRunAt.getDate() + 1);
  }

  nightlyRolloverTimerId = window.setTimeout(async () => {
    try {
      const didApplyRollover = await runNightlyRolloverIfDue();
      if (didApplyRollover) {
        await renderCurrentRoute();
      }
    } catch (error) {
      console.error("Nightly rollover failed:", error);
    } finally {
      scheduleNightlyRollover();
    }
  }, Math.max(1, nextRunAt.getTime() - nowDate.getTime()));
}

function setStatus(message) {
  statusEl.textContent = message;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function readCredentials() {
  const email = emailEl.value.trim();
  const password = passwordEl.value;

  if (!email || !password) {
    setStatus("Please enter both email and password.");
    return null;
  }

  return { email, password };
}

function explainAuthError(error, action) {
  const errorCode = error?.code || "auth/unknown";

  const sharedGuidance =
    "If this keeps happening, check Firebase Authentication settings for this project.";

  switch (errorCode) {
    case "auth/invalid-credential":
      return `${action} failed: invalid credentials. This usually means the email/password pair is incorrect, or this account does not exist.`;
    case "auth/invalid-email":
      return `${action} failed: the email address is not valid.`;
    case "auth/user-disabled":
      return `${action} failed: this account has been disabled.`;
    case "auth/operation-not-allowed":
      return `${action} failed: email/password sign-in is not enabled in Firebase Authentication.`;
    case "auth/too-many-requests":
      return `${action} failed: too many attempts. Try again later.`;
    case "auth/email-already-in-use":
      return `${action} failed: an account already exists for this email. Try logging in instead.`;
    case "auth/weak-password":
      return `${action} failed: password must be at least 6 characters.`;
    default:
      return `${action} failed (${errorCode}). ${sharedGuidance}`;
  }
}

function explainFirestoreError(error) {
  const errorCode = error?.code || "firestore/unknown";

  if (errorCode === "permission-denied") {
    return [
      "This account is signed in, but Firestore access was denied.",
      "Update Firebase Firestore Security Rules to allow authenticated users to read and write users/{userId}/contacts, users/{userId}/leads, users/{userId}/tasks, users/{userId}/notes, and users/{userId}/settings/pipeline.",
    ].join(" ");
  }

  return `Firestore request failed (${errorCode}). Check Firestore rules and indexes in Firebase Console.`;
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = toDate(value);
  if (!date) return "-";
  return date.toLocaleString();
}

async function copyTextToClipboard(value) {
  const text = String(value || "").trim();
  if (!text) return;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch (error) {
    console.error("Clipboard API copy failed, falling back.", error);
  }

  const fallbackInput = document.createElement("textarea");
  fallbackInput.value = text;
  fallbackInput.setAttribute("readonly", "readonly");
  fallbackInput.style.position = "absolute";
  fallbackInput.style.left = "-9999px";
  document.body.appendChild(fallbackInput);
  fallbackInput.select();
  document.execCommand("copy");
  document.body.removeChild(fallbackInput);
}

function attachClipboardHandlers(scopeEl = viewContainer) {
  scopeEl.querySelectorAll("[data-copy-text]").forEach((copyButton) => {
    copyButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await copyTextToClipboard(copyButton.dataset.copyText || "");
    });
  });
}

const clipboardIconMarkup = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="9" y="9" width="10" height="10" rx="1.5"></rect>
    <rect x="5" y="5" width="10" height="10" rx="1.5"></rect>
  </svg>
`;

function buildEmailDetailLine(emailValue) {
  const email = String(emailValue || "").trim();
  if (!email) {
    return '<p><strong>Email:</strong> -</p>';
  }

  return `<p><strong>Email:</strong> <span class="contact-detail-inline">${escapeHtml(email)} <button type="button" class="clipboard-copy-btn" data-copy-text="${escapeHtml(email)}" aria-label="Copy email" title="Copy email">${clipboardIconMarkup}</button></span></p>`;
}

function normalizeBoolean(value) {
  return value === true;
}

function isActiveRecord(value) {
  return value?.deleted !== true;
}

function buildTimelineEventFields(type, values = {}) {
  return {
    type,
    contactId: values.contactId || null,
    status: String(values.status || "open"),
    archived: normalizeBoolean(values.archived),
    deleted: false,
  };
}

function getLeadState(lead) {
  const normalizedState = String(lead?.state || "").trim().toLowerCase();
  if (["open", "closed_won", "closed_lost", "drop_out"].includes(normalizedState)) {
    return normalizedState;
  }
  return "open";
}

const LEAD_STATE_FILTERS = [
  { value: "open", label: "Open" },
  { value: "closed_won", label: "Closed — Won" },
  { value: "closed_lost", label: "Closed — Lost" },
  { value: "drop_out", label: "Drop Out" },
];

async function completeLeadStage({ userId, leadRef, lead, leadSource, pipelineSettings }) {
  const nowDate = new Date();
  const currentStageId = lead.stageId || pipelineSettings.stages[0]?.id;
  const nextStage = getNextStage(pipelineSettings, currentStageId);

  if (!nextStage) {
    const updates = {
      status: "closed",
      archived: true,
      nextActionAt: null,
      lastActionAt: Timestamp.fromDate(nowDate),
      updatedAt: serverTimestamp(),
    };
    if (leadSource === "leads") {
      updates.stageStatus = "completed";
      if (getLeadState(lead) === "open") {
        updates.state = "drop_out";
      }
    }
    await updateDoc(leadRef, updates);
    return;
  }

  const deltaDays = computeOffsetDeltaDays(pipelineSettings, currentStageId, nextStage.id);
  const nextActionAt = computeNextActionAt(nowDate, deltaDays, pipelineSettings.dayStartTime);

  await updateDoc(leadRef, {
    stageId: nextStage.id,
    ...(leadSource === "leads" ? { stageStatus: "pending", status: "open", archived: false } : {}),
    lastActionAt: Timestamp.fromDate(nowDate),
    nextActionAt,
    updatedAt: serverTimestamp(),
  });
}

async function pushLeadFromPreset({ userId, entityId, leadSource, preset }) {
  const pushedAt = computePushedTimestamp(new Date(), preset);
  if (leadSource === "leads") {
    await rescheduleLeadAction(userId, entityId, pushedAt.toDate());
    return;
  }

  await updateDoc(doc(db, "users", userId, leadSource, entityId), {
    nextActionAt: pushedAt,
    lastActionAt: Timestamp.now(),
    updatedAt: serverTimestamp(),
  });
}

async function addTimelineNote({ contactId = null, parentType = "contact", parentId = null, noteText = "" }) {
  const trimmed = String(noteText || "").trim();
  if (!trimmed) return;

  await addDoc(collection(db, "users", currentUser.uid, "notes"), {
    contactId,
    parentType,
    parentId,
    noteText: trimmed,
    createdAt: Timestamp.now(),
    updatedAt: serverTimestamp(),
  });
}

function parseScheduledFor(dateString, timeString) {
  if (!dateString && !timeString) {
    return null;
  }

  if (!dateString) {
    return null;
  }

  const combined = `${dateString}T${timeString || "00:00"}`;
  const parsed = new Date(combined);
  if (Number.isNaN(parsed.getTime())) return null;
  return Timestamp.fromDate(parsed);
}

function routeFromHash() {
  if (!window.location.hash || window.location.hash === "#") {
    return { page: "dashboard" };
  }

  const rawHash = window.location.hash.slice(1);
  const [hash, queryString = ""] = rawHash.split("?");
  const params = new URLSearchParams(queryString);
  if (hash === "dashboard") return { page: "dashboard" };
  if (hash === "contacts") return { page: "contacts" };
  if (hash === "add-contact") return { page: "add-contact" };
  if (hash === "add-lead") return { page: "add-lead" };
  if (hash === "leads") return { page: "leads", params };
  if (hash === "tasks") return { page: "tasks" };
  if (hash === "calendar") return { page: "calendar", params };
  if (hash === "tasks/new") return { page: "add-task" };
  if (hash === "add-task") return { page: "add-task" };
  if (hash === "promotions") return { page: "promotions" };
  if (hash === "settings") return { page: "settings" };
  if (hash.startsWith("contact/") && hash.endsWith("/edit")) {
    const parts = hash.split("/");
    return { page: "contact-edit", contactId: parts[1], params };
  }

  if (hash.startsWith("lead/") && hash.endsWith("/edit")) {
    const parts = hash.split("/");
    return { page: "lead-edit", leadId: parts[1], params };
  }

  if (hash.startsWith("task/") && hash.endsWith("/edit")) {
    const parts = hash.split("/");
    return { page: "task-edit", taskId: parts[1], params };
  }

  if (hash.startsWith("contact/")) {
    return { page: "contact-detail", contactId: hash.split("/")[1], params };
  }

  if (hash.startsWith("lead/")) {
    return { page: "lead-detail", leadId: hash.split("/")[1], params };
  }

  if (hash.startsWith("task/")) {
    return { page: "task-detail", taskId: hash.split("/")[1], params };
  }

  return { page: "dashboard" };
}

function getCurrentRouteOrigin(params) {
  return decodeURIComponent(params?.get("from") || "").trim() || null;
}

function appendOriginToHash(path, originRoute) {
  if (!originRoute) return path;
  return `${path}?from=${encodeURIComponent(originRoute)}`;
}

function navigateAfterDelete(originRoute, fallbackRoute) {
  window.location.hash = originRoute || fallbackRoute;
}

function renderLoading(text = "Loading...") {
  viewContainer.innerHTML = `<p class="view-message">${escapeHtml(text)}</p>`;
}

async function renderDashboard() {
  renderLoading("Loading dashboard feed...");

  const now = Timestamp.now();
  const appSettings = await getAppSettings(currentUser.uid);
  const pipelineSettings = appSettings.pipeline;
  const pushPresets = appSettings.pushPresets;

  const [contactsSnapshot, leadsSnapshot, legacyLeadsSnapshot, tasksSnapshot] = await Promise.all([
    getDocs(collection(db, "users", currentUser.uid, "contacts")),
    getDocs(
      query(
        collection(db, "users", currentUser.uid, "leads"),
        where("nextActionAt", "<=", now),
        orderBy("nextActionAt", "asc"),
        orderBy("createdAt", "desc")
      )
    ),
    getDocs(
      query(
        collection(db, "users", currentUser.uid, "contacts"),
        where("status", "==", "Open"),
        where("nextActionAt", "<=", now),
        orderBy("nextActionAt", "asc"),
        orderBy("createdAt", "desc")
      )
    ),
    getDocs(
      query(
        collection(db, "users", currentUser.uid, "tasks"),
        where("completed", "==", false),
        where("scheduledFor", "<=", now),
        orderBy("scheduledFor", "asc")
      )
    ),
  ]);

  const contactById = contactsSnapshot.docs.reduce((acc, contactDoc) => {
    const value = { id: contactDoc.id, ...contactDoc.data() };
    if (isActiveRecord(value)) {
      acc[contactDoc.id] = value;
    }
    return acc;
  }, {});

  const dueLeads = leadsSnapshot.docs
    .map((leadDoc) => ({ id: leadDoc.id, ...leadDoc.data() }))
    .filter((lead) => isActiveRecord(lead) && lead.stageStatus !== "completed")
    .map((lead) => {
      const contact = contactById[lead.contactId] || {};
      return {
        type: "lead",
        id: lead.id,
        source: "leads",
        contactId: lead.contactId || null,
        title: contact.name || "Unnamed Contact",
        subtitle: contact.email || contact.phone || "No contact details",
        email: contact.email || "",
        stageId: lead.stageId,
        product: lead.product || "",
        dueAt: lead.nextActionAt,
      };
    });

  const legacyDueLeads = legacyLeadsSnapshot.docs
    .map((contactDoc) => {
      const contact = { id: contactDoc.id, ...contactDoc.data() };
      if (!isActiveRecord(contact)) return null;
      return {
        type: "lead",
        id: contact.id,
        source: "contacts",
        contactId: contact.id,
        title: contact.name || "Unnamed Contact",
        subtitle: contact.email || contact.phone || "No contact details",
        stageId: contact.stageId,
        dueAt: contact.nextActionAt,
      };
    })
    .filter(Boolean);

  const dueTasks = tasksSnapshot.docs.map((taskDoc) => {
    const task = { id: taskDoc.id, ...taskDoc.data() };
    if (!isActiveRecord(task)) return null;
    const contact = task.contactId ? contactById[task.contactId] : null;
    return {
      type: "task",
      id: task.id,
      contactId: task.contactId || null,
      title: task.title || "Untitled Task",
      subtitle: contact?.name || "No contact",
      notes: task.notes || "",
      dueAt: task.scheduledFor,
    };
  }).filter(Boolean);

  const pushOptionsMarkup = pushPresets
    .map(
      (preset, index) =>
        `<button type="button" data-push-select="true" data-preset-index="${index}" class="push-option">${escapeHtml(preset.label)}</button>`
    )
    .join("");

  const feedItems = [...dueLeads, ...legacyDueLeads, ...dueTasks].sort(
    (a, b) => (toDate(a.dueAt)?.getTime() || 0) - (toDate(b.dueAt)?.getTime() || 0)
  );

  const feedMarkup = feedItems.length
    ? feedItems
        .map((item) => {
          if (item.type === "lead") {
            const stageLabel = getStageById(pipelineSettings, item.stageId)?.label || "Unknown stage";
            return `
              <article class="panel feed-item feed-item-clickable feed-item--lead" data-open-feed-item="true" data-feed-type="lead" data-feed-id="${item.id}" data-lead-source="${item.source}" tabindex="0" role="button">
                <p class="feed-type">Lead</p>
                <h3>${escapeHtml(item.title)}</h3>
                <p>${escapeHtml(item.subtitle)}</p>
                ${item.email ? `<p><strong>Email:</strong> <span class="contact-detail-inline">${escapeHtml(item.email)} <button type="button" class="clipboard-copy-btn" data-copy-text="${escapeHtml(item.email)}" aria-label="Copy email" title="Copy email">${clipboardIconMarkup}</button></span></p>` : ""}
                <p><strong>Stage:</strong> ${escapeHtml(stageLabel)}${item.product ? `<span class="dashboard-stage-product">• Product: ${escapeHtml(item.product)}</span>` : ""}</p>
                <p><strong>Due:</strong> ${formatDate(item.dueAt)}</p>
                <div class="button-row">
                  <button type="button" class="dashboard-action-btn" data-lead-action="done" data-lead-source="${item.source}" data-lead-id="${item.id}">Done</button>
                  <details class="push-menu">
                    <summary class="dashboard-action-btn">Push</summary>
                    <div class="push-dropdown" data-push-source="${item.source}" data-push-entity="lead" data-push-id="${item.id}">
                      ${pushOptionsMarkup}
                    </div>
                  </details>
                </div>
              </article>
            `;
          }

          return `
            <article class="panel feed-item feed-item-clickable feed-item--task" data-open-feed-item="true" data-feed-type="task" data-feed-id="${item.id}" tabindex="0" role="button">
              <p class="feed-type">Task</p>
              <h3>${escapeHtml(item.title)}</h3>
              <p>${escapeHtml(item.subtitle)}</p>
              <p><strong>Due:</strong> ${formatDate(item.dueAt)}</p>
              ${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ""}
              <div class="button-row">
                <button type="button" class="dashboard-action-btn" data-task-action="done" data-task-id="${item.id}">Done</button>
                <details class="push-menu">
                  <summary class="dashboard-action-btn">Push</summary>
                  <div class="push-dropdown" data-push-entity="task" data-push-id="${item.id}">
                    ${pushOptionsMarkup}
                  </div>
                </details>
              </div>
            </article>
          `;
        })
        .join("")
    : '<p class="view-message">No leads or tasks are due right now.</p>';

  viewContainer.innerHTML = `
    <section class="crm-view crm-view--dashboard">
      <div class="view-header">
        <h2>Dashboard Feed</h2>
        <div class="view-header-actions">
          <button id="new-lead-btn" type="button">New Lead +</button>
          <button id="add-task-btn" type="button">Add Task</button>
        </div>
      </div>
      <div class="feed-list">${feedMarkup}</div>
    </section>
  `;

  document.getElementById("new-lead-btn")?.addEventListener("click", () => {
    window.location.hash = "#add-lead";
  });

  document.getElementById("add-task-btn")?.addEventListener("click", () => {
    window.location.hash = "#tasks/new";
  });

  viewContainer.querySelectorAll('[data-open-feed-item="true"]').forEach((itemEl) => {
    const navigateToDetail = () => {
      const feedType = itemEl.dataset.feedType;
      const feedId = itemEl.dataset.feedId;
      if (!feedType || !feedId) return;

      if (feedType === "task") {
        window.location.hash = appendOriginToHash(`#task/${feedId}`, window.location.hash);
        return;
      }

      const leadSource = itemEl.dataset.leadSource;
      if (leadSource === "contacts") {
        window.location.hash = appendOriginToHash(`#contact/${feedId}`, window.location.hash);
        return;
      }

      window.location.hash = appendOriginToHash(`#lead/${feedId}`, window.location.hash);
    };

    itemEl.addEventListener("click", (event) => {
      if (event.target.closest("button") || event.target.closest("summary")) return;
      navigateToDetail();
    });

    itemEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      navigateToDetail();
    });
  });

  viewContainer.querySelectorAll("[data-lead-action]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", async () => {
      const leadId = buttonEl.dataset.leadId;
      const leadSource = buttonEl.dataset.leadSource;
      if (!leadId || !leadSource) return;

      const leadRef = doc(db, "users", currentUser.uid, leadSource, leadId);
      const leadSnapshot = await getDoc(leadRef);
      if (!leadSnapshot.exists()) return;
      const lead = leadSnapshot.data();

      await completeLeadStage({ userId: currentUser.uid, leadRef, lead, leadSource, pipelineSettings });
      await renderDashboard();
    });
  });

  viewContainer.querySelectorAll("[data-task-action]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", async () => {
      const taskId = buttonEl.dataset.taskId;
      if (!taskId) return;

      await updateDoc(doc(db, "users", currentUser.uid, "tasks", taskId), {
        completed: true,
        status: "completed",
        archived: true,
        updatedAt: serverTimestamp(),
      });
      await renderDashboard();
    });
  });

  attachClipboardHandlers();

  viewContainer.querySelectorAll("[data-push-select]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", async () => {
      const presetIndex = Number.parseInt(buttonEl.dataset.presetIndex, 10);
      const preset = pushPresets[presetIndex];
      if (!preset) return;

      const pushContainer = buttonEl.closest("[data-push-entity]");
      const entityType = pushContainer?.dataset.pushEntity;
      const entityId = pushContainer?.dataset.pushId;
      const leadSource = pushContainer?.dataset.pushSource;
      if (!entityType || !entityId) return;

      const pushedAt = computePushedTimestamp(new Date(), preset);
      if (entityType === "task") {
        await updateDoc(doc(db, "users", currentUser.uid, "tasks", entityId), {
          scheduledFor: pushedAt,
          updatedAt: serverTimestamp(),
        });
      } else {
        if (!leadSource) return;
        await pushLeadFromPreset({ userId: currentUser.uid, entityId, leadSource, preset });
      }

      await renderDashboard();
    });
  });
}

async function renderContactsPage() {
  renderLoading("Loading contacts...");

  const [contactsSnapshot, tasksSnapshot] = await Promise.all([
    getDocs(query(collection(db, "users", currentUser.uid, "contacts"), orderBy("createdAt", "desc"))),
    getDocs(collection(db, "users", currentUser.uid, "tasks")),
  ]);

  const contacts = contactsSnapshot.docs
    .map((contactDoc) => ({ id: contactDoc.id, ...contactDoc.data() }))
    .filter((contact) => isActiveRecord(contact));
  const tasks = tasksSnapshot.docs
    .map((taskDoc) => ({ id: taskDoc.id, ...taskDoc.data() }))
    .filter((task) => isActiveRecord(task));

  const taskCountByContact = tasks.reduce((acc, task) => {
    if (!task.contactId) return acc;
    acc[task.contactId] = (acc[task.contactId] || 0) + 1;
    return acc;
  }, {});

  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>Contacts</h2>
        <button id="add-contact-btn" type="button">+ Add Contact</button>
      </div>

      <div class="panel filters-grid">
        <label>Search
          <input id="contact-search" placeholder="Name, email, phone" />
        </label>

        <label>Task Filter
          <select id="task-filter">
            <option value="all">All</option>
            <option value="with">With tasks</option>
            <option value="without">Without tasks</option>
          </select>
        </label>
      </div>

      <div id="contacts-list" class="feed-list"></div>
    </section>
  `;

  function renderFilteredContacts() {
    const searchValue = String(document.getElementById("contact-search")?.value || "")
      .trim()
      .toLowerCase();
    const taskFilter = document.getElementById("task-filter")?.value || "all";

    const filtered = contacts.filter((contact) => {
      const haystack = `${contact.name || ""} ${contact.email || ""} ${contact.phone || ""}`.toLowerCase();
      const matchesSearch = !searchValue || haystack.includes(searchValue);
      const hasTasks = Boolean(taskCountByContact[contact.id]);
      const matchesTaskFilter =
        taskFilter === "all" || (taskFilter === "with" ? hasTasks : !hasTasks);

      return matchesSearch && matchesTaskFilter;
    });

    const listEl = document.getElementById("contacts-list");
    listEl.innerHTML = filtered.length
      ? filtered
          .map((contact) => {
            return `
              <button class="panel feed-item" data-contact-id="${contact.id}" type="button">
                <h3>${escapeHtml(contact.name || "Unnamed Contact")}</h3>
                <p>${escapeHtml(contact.email || "No email")}</p>
                <p>${escapeHtml(contact.phone || "No phone")}</p>
                <p><strong>Tasks:</strong> ${taskCountByContact[contact.id] || 0}</p>
              </button>
            `;
          })
          .join("")
      : '<p class="view-message">No contacts match the current filters.</p>';

    listEl.querySelectorAll("[data-contact-id]").forEach((itemEl) => {
      itemEl.addEventListener("click", () => {
        window.location.hash = appendOriginToHash(`#contact/${itemEl.dataset.contactId}`, window.location.hash);
      });
    });
  }

  ["contact-search", "task-filter"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", renderFilteredContacts);
    document.getElementById(id)?.addEventListener("change", renderFilteredContacts);
  });

  document.getElementById("add-contact-btn")?.addEventListener("click", () => {
    window.location.hash = "#add-contact";
  });

  renderFilteredContacts();
}

function dateInputValue(value) {
  const date = toDate(value);
  if (!date) return "";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function timeInputValue(value) {
  const date = toDate(value);
  if (!date) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function parseContactFormValues(formEl) {
  const formData = new FormData(formEl);
  return {
    name: String(formData.get("name") || "").trim(),
    email: String(formData.get("email") || "").trim(),
    phone: String(formData.get("phone") || "").trim(),
  };
}

function renderContactForm({ mode, values, onSubmit, onCancel, onDelete }) {
  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>${escapeHtml(mode === "create" ? "Add Contact" : values.name || "Edit Contact")}</h2>
      </div>
      <form id="contact-form" class="panel form-grid">
        <label>Name <input name="name" value="${escapeHtml(values.name || "")}" required /></label>
        <label>Email <input name="email" type="email" value="${escapeHtml(values.email || "")}" /></label>
        <label>Phone <input name="phone" type="tel" value="${escapeHtml(values.phone || "")}" /></label>

        <div class="button-row full-width">
          <button type="submit">Save</button>
          ${mode === "edit" ? '<button type="button" id="contact-cancel-btn" class="secondary-btn">Cancel</button><button type="button" id="contact-delete-btn" class="secondary-btn">Delete</button>' : ""}
        </div>
      </form>
    </section>
  `;

  document.getElementById("contact-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = parseContactFormValues(event.currentTarget);
    if (!payload.name) {
      alert("Name is required.");
      return;
    }
    await onSubmit(payload);
  });

  document.getElementById("contact-cancel-btn")?.addEventListener("click", onCancel);
  document.getElementById("contact-delete-btn")?.addEventListener("click", onDelete);
}

function parseLeadFormValues(formEl) {
  const formData = new FormData(formEl);

  return {
    selectedContactId: String(formData.get("selectedContactId") || "").trim() || null,
    contactName: String(formData.get("contactName") || "").trim(),
    contactEmail: String(formData.get("contactEmail") || "").trim(),
    contactPhone: String(formData.get("contactPhone") || "").trim(),
    stageId: String(formData.get("stageId") || "").trim(),
    product: String(formData.get("product") || "").trim(),
    stageStatus: String(formData.get("stageStatus") || "pending").trim() || "pending",
    initialNote: String(formData.get("initialNote") || "").trim(),
  };
}

function renderLeadForm({ mode, pipelineSettings, contacts, values, onSubmit, onCancel, onDelete }) {
  const selectedContact = contacts.find((contact) => contact.id === values.contactId) || null;
  const initialContactName = values.contactName || selectedContact?.name || "";
  const initialContactEmail = values.contactEmail || selectedContact?.email || "";
  const initialContactPhone = values.contactPhone || selectedContact?.phone || "";

  viewContainer.innerHTML = `
    <section class="crm-view crm-view--leads">
      <div class="view-header">
        <h2>${mode === "create" ? "New Lead" : "Edit Lead"}</h2>
      </div>
      <form id="lead-form" class="panel panel--lead form-grid">
        <h3 class="full-width">Contact Info</h3>
        <input type="hidden" name="selectedContactId" value="${values.contactId || ""}" />

        <label>Name
          <input name="contactName" id="lead-contact-name" value="${escapeHtml(initialContactName)}" autocomplete="off" />
        </label>

        <div id="lead-contact-suggestions" class="lead-contact-suggestions full-width"></div>

        <label>Email
          <input name="contactEmail" id="lead-contact-email" type="email" value="${escapeHtml(initialContactEmail)}" />
        </label>

        <label>Phone
          <input name="contactPhone" id="lead-contact-phone" type="tel" value="${escapeHtml(initialContactPhone)}" />
        </label>

        <h3 class="full-width">Lead Info</h3>

        <label>Stage
          <select name="stageId">
            ${pipelineSettings.stages
              .map((stage) => `<option value="${stage.id}" ${values.stageId === stage.id ? "selected" : ""}>${escapeHtml(stage.label)}</option>`)
              .join("")}
          </select>
        </label>

        <label>Product
          <input name="product" value="${escapeHtml(values.product || "")}" />
        </label>

        <label>Status
          <select name="stageStatus">
            ${["pending", "completed"].map((status) => `<option value="${status}" ${values.stageStatus === status ? "selected" : ""}>${status}</option>`).join("")}
          </select>
        </label>


        <label class="full-width">Initial Note (Optional)
          <textarea name="initialNote" rows="3">${escapeHtml(values.initialNote || "")}</textarea>
        </label>

        <div class="button-row full-width">
          <button type="submit">Save</button>
          ${mode === "edit" ? '<button type="button" id="lead-cancel-btn" class="secondary-btn">Cancel</button><button type="button" id="lead-delete-btn" class="secondary-btn">Delete</button>' : ""}
        </div>
      </form>
    </section>
  `;

  const formEl = document.getElementById("lead-form");
  const hiddenContactIdEl = formEl?.querySelector('input[name="selectedContactId"]');
  const nameEl = document.getElementById("lead-contact-name");
  const emailEl = document.getElementById("lead-contact-email");
  const phoneEl = document.getElementById("lead-contact-phone");
  const suggestionsEl = document.getElementById("lead-contact-suggestions");

  function clearSelectedContact() {
    if (!hiddenContactIdEl) return;
    hiddenContactIdEl.value = "";
  }

  function applySelectedContact(contact) {
    if (!hiddenContactIdEl || !nameEl || !emailEl || !phoneEl) return;
    hiddenContactIdEl.value = contact.id;
    nameEl.value = contact.name || "";
    emailEl.value = contact.email || "";
    phoneEl.value = contact.phone || "";
    suggestionsEl.innerHTML = "";
  }

  function renderSuggestions(searchText) {
    if (!suggestionsEl) return;
    const normalized = searchText.trim().toLowerCase();
    if (!normalized) {
      suggestionsEl.innerHTML = "";
      return;
    }

    const matches = contacts
      .filter((contact) => (contact.name || "").toLowerCase().includes(normalized))
      .slice(0, 5);

    suggestionsEl.innerHTML = matches.length
      ? matches
          .map(
            (contact) =>
              `<button type="button" class="lead-contact-option" data-contact-option-id="${contact.id}">${escapeHtml(contact.name || "Unnamed")} ${contact.email ? `· ${escapeHtml(contact.email)}` : ""}</button>`
          )
          .join("")
      : '<p class="lead-contact-empty">No existing contacts matched. Saving will create a new contact.</p>';

    suggestionsEl.querySelectorAll("[data-contact-option-id]").forEach((optionEl) => {
      optionEl.addEventListener("click", () => {
        const chosen = contacts.find((contact) => contact.id === optionEl.dataset.contactOptionId);
        if (!chosen) return;
        applySelectedContact(chosen);
      });
    });
  }

  nameEl?.addEventListener("input", () => {
    clearSelectedContact();
    renderSuggestions(nameEl.value);
  });

  emailEl?.addEventListener("input", clearSelectedContact);
  phoneEl?.addEventListener("input", clearSelectedContact);

  formEl?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = parseLeadFormValues(event.currentTarget);
    if (!payload.stageId) {
      alert("Stage is required.");
      return;
    }
    await onSubmit(payload);
  });

  document.getElementById("lead-cancel-btn")?.addEventListener("click", onCancel);
  document.getElementById("lead-delete-btn")?.addEventListener("click", onDelete);
}

function parseTaskFormValues(formEl) {
  const formData = new FormData(formEl);
  const scheduledDate = String(formData.get("scheduledDate") || "").trim();
  const scheduledTime = String(formData.get("scheduledTime") || "").trim();
  const hasDate = Boolean(scheduledDate);
  const hasTime = Boolean(scheduledTime);

  let scheduledFor = null;
  if (!hasDate && !hasTime) {
    scheduledFor = Timestamp.now();
  } else {
    const now = new Date();
    const resolvedDate = hasDate ? scheduledDate : dateInputValue(now);
    const resolvedTime = hasTime ? scheduledTime : timeInputValue(now);
    scheduledFor = parseScheduledFor(resolvedDate, resolvedTime);
  }

  if ((scheduledDate || scheduledTime) && !scheduledFor) {
    throw new Error("Please provide a valid date/time.");
  }

  return {
    title: String(formData.get("title") || "").trim(),
    notes: String(formData.get("notes") || "").trim(),
    email: String(formData.get("email") || "").trim(),
    contactId: String(formData.get("contactId") || "").trim() || null,
    scheduledFor,
  };
}

function renderTaskForm({ mode, contacts, values, onSubmit, onCancel, onDelete }) {
  const selectedContact = contacts.find((contact) => contact.id === values.contactId) || null;
  const initialEmail = values.email || selectedContact?.email || "";

  viewContainer.innerHTML = `
    <section class="crm-view crm-view--tasks">
      <div class="view-header">
        <h2>${escapeHtml(mode === "create" ? "Add Task" : values.title || "Edit Task")}</h2>
      </div>
      <form id="task-form" class="panel panel--task form-grid">
        <label>Title <input name="title" value="${escapeHtml(values.title || "")}" required /></label>
        <label class="full-width">Notes <textarea name="notes" rows="4">${escapeHtml(values.notes || "")}</textarea></label>

        <label>Contact (Optional)
          <select name="contactId">
            <option value="">No contact</option>
            ${contacts
              .map((contact) => `<option value="${contact.id}" ${values.contactId === contact.id ? "selected" : ""}>${escapeHtml(contact.name || contact.email || contact.id)}</option>`)
              .join("")}
          </select>
        </label>

        <label>Email (Optional)
          <input name="email" id="task-email" type="email" value="${escapeHtml(initialEmail)}" />
        </label>

        <label>Date (Optional)
          <input name="scheduledDate" type="date" value="${dateInputValue(values.scheduledFor)}" />
        </label>

        <label>Time (Optional)
          <input name="scheduledTime" type="time" value="${timeInputValue(values.scheduledFor)}" />
        </label>

        <div class="button-row full-width">
          <button type="submit">Save</button>
          ${mode === "edit" ? '<button type="button" id="task-cancel-btn" class="secondary-btn">Cancel</button><button type="button" id="task-delete-btn" class="secondary-btn">Delete</button>' : ""}
        </div>
      </form>
    </section>
  `;

  document.getElementById("task-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const payload = parseTaskFormValues(event.currentTarget);
      if (!payload.title) {
        alert("Title is required.");
        return;
      }
      await onSubmit(payload);
    } catch (error) {
      alert(error.message);
    }
  });

  document.getElementById("task-cancel-btn")?.addEventListener("click", onCancel);
  document.getElementById("task-delete-btn")?.addEventListener("click", onDelete);

  const contactSelectEl = viewContainer.querySelector('select[name="contactId"]');
  const emailInputEl = document.getElementById("task-email");
  contactSelectEl?.addEventListener("change", () => {
    if (!emailInputEl) return;
    const selectedId = String(contactSelectEl.value || "").trim();
    const linkedContact = contacts.find((contact) => contact.id === selectedId);
    if (!linkedContact) return;
    emailInputEl.value = linkedContact.email || "";
  });
}

async function renderAddContactForm() {
  renderLoading("Loading contact form...");

  renderContactForm({
    mode: "create",
    values: {},
    onSubmit: async (values) => {
      const now = Timestamp.now();
      await addDoc(collection(db, "users", currentUser.uid, "contacts"), {
        ...values,
        createdAt: now,
        updatedAt: serverTimestamp(),
      });
      window.location.hash = "#contacts";
    },
  });
}

async function renderAddLeadForm() {
  renderLoading("Loading lead form...");
  const [pipelineSettings, contactsSnapshot] = await Promise.all([
    getPipelineSettings(currentUser.uid),
    getDocs(query(collection(db, "users", currentUser.uid, "contacts"), orderBy("name", "asc"))),
  ]);
  const contacts = contactsSnapshot.docs
    .map((contactDoc) => ({ id: contactDoc.id, ...contactDoc.data() }))
    .filter((contact) => isActiveRecord(contact));
  const firstStageId = pipelineSettings.stages[0]?.id || "stage1";

  renderLeadForm({
    mode: "create",
    pipelineSettings,
    contacts,
    values: { stageId: firstStageId, stageStatus: "pending" },
    onSubmit: async (values) => {
      const now = Timestamp.now();
      const computedNextActionAt = computeInitialLeadNextActionAt(pipelineSettings, values.stageId, new Date());
      let contactId = values.selectedContactId || null;

      if (!contactId && values.contactName) {
        const createdContact = await addDoc(collection(db, "users", currentUser.uid, "contacts"), {
          name: values.contactName,
          email: values.contactEmail,
          phone: values.contactPhone,
          createdAt: now,
          updatedAt: serverTimestamp(),
        });
        contactId = createdContact.id;
      }

      const leadPayload = {
        ...buildTimelineEventFields("lead", {
          contactId,
          status: values.stageStatus || "pending",
          archived: values.stageStatus === "completed",
        }),
        title: values.contactName || "Lead",
        summary: values.initialNote || "",
        stageId: values.stageId,
        product: values.product || "",
        stageStatus: values.stageStatus || "pending",
        state: "open",
        nextActionAt: computedNextActionAt,
        createdAt: now,
        updatedAt: serverTimestamp(),
      };

      const leadDoc = await addDoc(collection(db, "users", currentUser.uid, "leads"), leadPayload);
      if (values.initialNote) {
        await addTimelineNote({
          contactId,
          parentType: "lead",
          parentId: leadDoc.id,
          noteText: values.initialNote,
        });
      }
      window.location.hash = "#dashboard";
    },
  });
}

async function renderAddTaskForm() {
  renderLoading("Loading contacts for task creation...");

  const contactsSnapshot = await getDocs(
    query(collection(db, "users", currentUser.uid, "contacts"), orderBy("name", "asc"))
  );

  const contacts = contactsSnapshot.docs
    .map((contactDoc) => ({ id: contactDoc.id, ...contactDoc.data() }))
    .filter((contact) => isActiveRecord(contact));

  renderTaskForm({
    mode: "create",
    contacts,
    values: {},
    onSubmit: async (values) => {
      const now = Timestamp.now();
      await addDoc(collection(db, "users", currentUser.uid, "tasks"), {
        ...buildTimelineEventFields("task", {
          contactId: values.contactId,
          status: "open",
          archived: false,
        }),
        ...values,
        completed: false,
        summary: values.notes || "",
        createdAt: now,
        updatedAt: serverTimestamp(),
      });
      window.location.hash = "#tasks";
    },
  });
}

async function renderLeadsPage() {
  renderLoading("Loading leads...");
  const route = routeFromHash();
  const selectedState = LEAD_STATE_FILTERS.some((filterOption) => filterOption.value === route.params?.get("state"))
    ? route.params.get("state")
    : "open";

  const [pipelineSettings, contactsSnapshot, leadsSnapshot] = await Promise.all([
    getPipelineSettings(currentUser.uid),
    getDocs(collection(db, "users", currentUser.uid, "contacts")),
    getDocs(collection(db, "users", currentUser.uid, "leads")),
  ]);

  const contactById = contactsSnapshot.docs.reduce((acc, contactDoc) => {
    acc[contactDoc.id] = { id: contactDoc.id, ...contactDoc.data() };
    return acc;
  }, {});

  const leads = leadsSnapshot.docs
    .map((leadDoc) => ({ id: leadDoc.id, ...leadDoc.data() }))
    .filter((lead) => isActiveRecord(lead) && getLeadState(lead) === selectedState)
    .sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0));

  viewContainer.innerHTML = `
    <section class="crm-view crm-view--leads">
      <div class="view-header">
        <h2>Leads</h2>
        <div class="view-header-actions">
          <div class="lead-state-switcher" role="tablist" aria-label="Lead state filter">
            ${LEAD_STATE_FILTERS.map(
              (filterOption) => `
                <button
                  type="button"
                  class="secondary-btn ${filterOption.value === selectedState ? "is-active" : ""}"
                  data-lead-state-filter="${filterOption.value}"
                  aria-pressed="${filterOption.value === selectedState ? "true" : "false"}"
                >
                  ${escapeHtml(filterOption.label)}
                </button>
              `
            ).join("")}
          </div>
          <button id="add-lead-btn" type="button">Add Lead +</button>
        </div>
      </div>
      <div class="feed-list">
        ${
          leads.length
            ? leads
                .map((lead) => {
                  const linkedContact = lead.contactId ? contactById[lead.contactId] : null;
                  return `
                    <button class="panel feed-item feed-item--lead" data-lead-id="${lead.id}" type="button">
                      <h3>${escapeHtml(linkedContact?.name || "Unnamed Lead")}</h3>
                      <p><strong>Stage:</strong> ${escapeHtml(getStageById(pipelineSettings, lead.stageId)?.label || lead.stageId || "-")}</p>
                      <p><strong>Status:</strong> ${escapeHtml(lead.stageStatus || "pending")}</p>
                      <p><strong>Next Action:</strong> ${lead.nextActionAt ? formatDate(lead.nextActionAt) : "-"}</p>
                      <p><strong>Created:</strong> ${formatDate(lead.createdAt)}</p>
                    </button>
                  `;
                })
                .join("")
            : '<p class="view-message">No leads yet.</p>'
        }
      </div>
    </section>
  `;

  document.getElementById("add-lead-btn")?.addEventListener("click", () => {
    window.location.hash = "#add-lead";
  });

  viewContainer.querySelectorAll("[data-lead-state-filter]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", () => {
      const nextState = buttonEl.dataset.leadStateFilter;
      if (!nextState || nextState === selectedState) return;
      window.location.hash = nextState === "open" ? "#leads" : `#leads?state=${encodeURIComponent(nextState)}`;
    });
  });

  viewContainer.querySelectorAll("[data-lead-id]").forEach((leadEl) => {
    leadEl.addEventListener("click", () => {
      window.location.hash = appendOriginToHash(`#lead/${leadEl.dataset.leadId}`, window.location.hash);
    });
  });
}

async function renderTasksPage() {
  renderLoading("Loading tasks...");

  const [contactsSnapshot, tasksSnapshot] = await Promise.all([
    getDocs(collection(db, "users", currentUser.uid, "contacts")),
    getDocs(collection(db, "users", currentUser.uid, "tasks")),
  ]);

  const contactById = contactsSnapshot.docs.reduce((acc, contactDoc) => {
    acc[contactDoc.id] = { id: contactDoc.id, ...contactDoc.data() };
    return acc;
  }, {});

  const allTasks = tasksSnapshot.docs
    .map((taskDoc) => ({ id: taskDoc.id, ...taskDoc.data() }))
    .filter((task) => isActiveRecord(task));

  const getTaskLastSavedTime = (task) =>
    Math.max(toDate(task.updatedAt)?.getTime() || 0, toDate(task.createdAt)?.getTime() || 0);

  const getTaskSortTime = (task) => {
    const scheduledTime = toDate(task.scheduledFor)?.getTime();
    if (scheduledTime) return scheduledTime;
    return getTaskLastSavedTime(task);
  };

  const activeTasks = allTasks
    .filter((task) => !task.completed)
    .sort((a, b) => getTaskSortTime(b) - getTaskSortTime(a));

  const completedTasks = allTasks
    .filter((task) => task.completed)
    .sort((a, b) => getTaskSortTime(b) - getTaskSortTime(a));

  const renderTaskCard = (task) => {
    const linkedContact = task.contactId ? contactById[task.contactId] : null;
    return `
      <button class="panel feed-item feed-item--task" data-task-id="${task.id}" type="button">
        <h3>${escapeHtml(task.title || "Untitled Task")}</h3>
        <p><strong>Scheduled:</strong> ${task.scheduledFor ? formatDate(task.scheduledFor) : "No schedule"}</p>
        <p><strong>Contact:</strong> ${escapeHtml(linkedContact?.name || "No contact")}</p>
        <p><strong>Status:</strong> ${task.completed ? "Completed" : "Active"}</p>
      </button>
    `;
  };

  viewContainer.innerHTML = `
    <section class="crm-view crm-view--tasks">
      <div class="view-header">
        <h2>Tasks</h2>
        <button id="add-task-btn" type="button">Add Task +</button>
      </div>
      <div class="feed-list">
        ${
          activeTasks.length
            ? activeTasks.map((task) => renderTaskCard(task)).join("")
            : '<p class="view-message">No active tasks.</p>'
        }

        ${
          completedTasks.length
            ? `
              <div class="tasks-divider" role="separator" aria-label="Completed Tasks section">
                <h3>Completed Tasks</h3>
              </div>
              ${completedTasks.map((task) => renderTaskCard(task)).join("")}
            `
            : ""
        }
      </div>
    </section>
  `;

  document.getElementById("add-task-btn")?.addEventListener("click", () => {
    window.location.hash = "#tasks/new";
  });

  viewContainer.querySelectorAll("[data-task-id]").forEach((taskEl) => {
    taskEl.addEventListener("click", () => {
      window.location.hash = appendOriginToHash(`#task/${taskEl.dataset.taskId}`, window.location.hash);
    });
  });
}

async function renderTaskDetail(taskId) {
  renderLoading("Loading task details...");
  const route = routeFromHash();
  const originRoute = getCurrentRouteOrigin(route.params);

  const taskRef = doc(db, "users", currentUser.uid, "tasks", taskId);
  const [taskSnapshot, contactsSnapshot, taskNotesSnapshot] = await Promise.all([
    getDoc(taskRef),
    getDocs(query(collection(db, "users", currentUser.uid, "contacts"), orderBy("name", "asc"))),
    getDocs(query(collection(db, "users", currentUser.uid, "notes"), where("parentType", "==", "task"), where("parentId", "==", taskId))),
  ]);

  if (!taskSnapshot.exists()) {
    viewContainer.innerHTML = '<p class="view-message">Task not found.</p>';
    return;
  }

  const task = { id: taskSnapshot.id, ...taskSnapshot.data() };
  if (!isActiveRecord(task)) {
    viewContainer.innerHTML = '<p class="view-message">Task not found.</p>';
    return;
  }
  const contacts = contactsSnapshot.docs
    .map((contactDoc) => ({ id: contactDoc.id, ...contactDoc.data() }))
    .filter((contact) => isActiveRecord(contact));
  const linkedContact = contacts.find((contact) => contact.id === task.contactId) || null;
  const taskNotes = taskNotesSnapshot.docs
    .map((noteDoc) => ({ id: noteDoc.id, ...noteDoc.data() }))
    .sort((a, b) => (toDate(a.createdAt)?.getTime() || 0) - (toDate(b.createdAt)?.getTime() || 0));

  viewContainer.innerHTML = `
    <section class="crm-view crm-view--tasks">
      <div class="view-header">
        <h2>${escapeHtml(task.title || "Task Detail")}</h2>
        <button id="edit-task-btn" type="button">Edit</button>
      </div>
      <div class="panel panel--task detail-grid">
        <p><strong>Contact:</strong> ${escapeHtml(linkedContact?.name || "No contact")}</p>
        ${buildEmailDetailLine(task.email)}
        <p><strong>Scheduled:</strong> ${task.scheduledFor ? formatDate(task.scheduledFor) : "No schedule"}</p>
        <p><strong>Status:</strong> ${task.completed ? "Completed" : "Active"}</p>
        <p><strong>Created:</strong> ${formatDate(task.createdAt)}</p>
        <p><strong>Updated:</strong> ${formatDate(task.updatedAt)}</p>
      </div>
      <div class="panel panel--task notes-panel">
        <h3>Task Notes</h3>
        <ul class="note-list">
          ${taskNotes.length ? taskNotes.map((entry) => `<li><p>${escapeHtml(entry.noteText)}</p><small>${formatDate(entry.createdAt)}</small></li>`).join("") : "<li>No notes yet.</li>"}
        </ul>
        <form id="task-note-form" class="form-grid">
          <label class="full-width">Add Note
            <textarea name="noteText" rows="3"></textarea>
          </label>
          <div class="button-row full-width">
            <button type="submit">Save Note</button>
            ${task.completed ? '<button type="button" class="secondary-btn" disabled>Completed</button>' : '<button type="button" id="task-mark-done-btn" class="secondary-btn">Mark Done</button>'}
          </div>
        </form>
      </div>
    </section>
  `;

  document.getElementById("edit-task-btn")?.addEventListener("click", () => {
    window.location.hash = appendOriginToHash(`#task/${taskId}/edit`, originRoute);
  });

  document.getElementById("task-note-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const noteText = String(new FormData(event.currentTarget).get("noteText") || "").trim();
    if (!noteText) return;

    await addTimelineNote({
      contactId: task.contactId || null,
      parentType: "task",
      parentId: taskId,
      noteText,
    });

    await updateDoc(taskRef, {
      updatedAt: serverTimestamp(),
    });

    await renderTaskDetail(taskId);
  });

  document.getElementById("task-mark-done-btn")?.addEventListener("click", async () => {
    await updateDoc(taskRef, {
      completed: true,
      status: "completed",
      archived: true,
      updatedAt: serverTimestamp(),
    });
    await renderTaskDetail(taskId);
  });

  attachClipboardHandlers();
}

async function renderEditTaskForm(taskId) {
  renderLoading("Loading task form...");

  const route = routeFromHash();
  const originRoute = getCurrentRouteOrigin(route.params);
  const taskRef = doc(db, "users", currentUser.uid, "tasks", taskId);
  const [taskSnapshot, contactsSnapshot] = await Promise.all([
    getDoc(taskRef),
    getDocs(query(collection(db, "users", currentUser.uid, "contacts"), orderBy("name", "asc"))),
  ]);

  if (!taskSnapshot.exists()) {
    viewContainer.innerHTML = '<p class="view-message">Task not found.</p>';
    return;
  }

  const task = { id: taskSnapshot.id, ...taskSnapshot.data() };
  if (!isActiveRecord(task)) {
    viewContainer.innerHTML = '<p class="view-message">Task not found.</p>';
    return;
  }
  const contacts = contactsSnapshot.docs
    .map((contactDoc) => ({ id: contactDoc.id, ...contactDoc.data() }))
    .filter((contact) => isActiveRecord(contact));
  const taskDetailRoute = appendOriginToHash(`#task/${taskId}`, originRoute);

  renderTaskForm({
    mode: "edit",
    contacts,
    values: task,
    onSubmit: async (values) => {
      await updateDoc(taskRef, {
        ...values,
        contactId: values.contactId || null,
        status: values.completed ? "completed" : "open",
        archived: values.completed === true,
        summary: values.notes || "",
        updatedAt: serverTimestamp(),
      });
      window.location.hash = taskDetailRoute;
    },
    onCancel: async () => {
      window.location.hash = taskDetailRoute;
    },
    onDelete: async () => {
      await deleteEntity("task", taskId, { currentUserId: currentUser.uid, deletedBy: currentUser.uid });
      navigateAfterDelete(originRoute, "#tasks");
    },
  });
}

async function renderLeadDetail(leadId) {
  renderLoading("Loading lead details...");
  const route = routeFromHash();
  const originRoute = getCurrentRouteOrigin(route.params);

  const leadRef = doc(db, "users", currentUser.uid, "leads", leadId);
  const [appSettings, leadSnapshot, contactsSnapshot, leadNotesSnapshot] = await Promise.all([
    getAppSettings(currentUser.uid),
    getDoc(leadRef),
    getDocs(query(collection(db, "users", currentUser.uid, "contacts"), orderBy("name", "asc"))),
    getDocs(query(collection(db, "users", currentUser.uid, "notes"), where("parentType", "==", "lead"), where("parentId", "==", leadId))),
  ]);
  const pipelineSettings = appSettings.pipeline;
  const pushPresets = appSettings.pushPresets;

  if (!leadSnapshot.exists()) {
    viewContainer.innerHTML = '<p class="view-message">Lead not found.</p>';
    return;
  }

  const lead = { id: leadSnapshot.id, ...leadSnapshot.data() };
  if (!isActiveRecord(lead)) {
    viewContainer.innerHTML = '<p class="view-message">Lead not found.</p>';
    return;
  }
  const contacts = contactsSnapshot.docs
    .map((contactDoc) => ({ id: contactDoc.id, ...contactDoc.data() }))
    .filter((contact) => isActiveRecord(contact));
  const linkedContact = contacts.find((contact) => contact.id === lead.contactId) || null;
  const currentStage = getStageById(pipelineSettings, lead.stageId) || pipelineSettings.stages[0] || null;
  const stageTemplates = normalizeStageTemplates(currentStage || {});
  const selectedTemplate = stageTemplates[0] || normalizeStageTemplateEntry(DEFAULT_STAGE_TEMPLATE);
  const leadEmail = String(linkedContact?.email || "").trim();
  const stageLabel = currentStage?.label || "Unknown stage";
  const leadNotes = leadNotesSnapshot.docs
    .map((noteDoc) => ({ id: noteDoc.id, ...noteDoc.data() }))
    .sort((a, b) => (toDate(a.createdAt)?.getTime() || 0) - (toDate(b.createdAt)?.getTime() || 0));
  const pushOptionsMarkup = pushPresets
    .map(
      (preset, index) =>
        `<button type="button" data-push-select="true" data-preset-index="${index}" class="push-option">${escapeHtml(preset.label)}</button>`
    )
    .join("");

  viewContainer.innerHTML = `
    <section class="crm-view crm-view--leads">
      <div class="view-header">
        <h2>Lead</h2>
        <div class="view-header-actions">
          <button type="button" id="lead-close-won-btn" class="secondary-btn">Close — Won</button>
          <button type="button" id="lead-close-lost-btn" class="secondary-btn">Close — Lost</button>
          <button id="edit-lead-btn" type="button">Edit</button>
        </div>
      </div>
      <div class="panel panel--lead detail-grid">
        <p><strong>Contact:</strong> ${escapeHtml(linkedContact?.name || "No contact")}</p>
        ${buildEmailDetailLine(linkedContact?.email || "")}
        <p><strong>Phone:</strong> ${escapeHtml(linkedContact?.phone || "-")}</p>
        <p><strong>Stage:</strong> ${escapeHtml(getStageById(pipelineSettings, lead.stageId)?.label || lead.stageId || "-")}</p>
        <p><strong>Status:</strong> ${escapeHtml(lead.stageStatus || lead.status || "pending")}</p>
        <p><strong>Next Action:</strong> ${lead.nextActionAt ? formatDate(lead.nextActionAt) : "-"}</p>
        <p><strong>Created:</strong> ${formatDate(lead.createdAt)}</p>
        <p><strong>Updated:</strong> ${formatDate(lead.updatedAt)}</p>
      </div>

      <div class="panel panel--lead notes-panel">
        <h3>Lead Notes</h3>
        <ul class="note-list">
          ${leadNotes.length ? leadNotes.map((entry) => `<li><p>${escapeHtml(entry.noteText)}</p><small>${formatDate(entry.createdAt)}</small></li>`).join("") : "<li>No notes yet.</li>"}
        </ul>

        <form id="lead-note-form" class="form-grid">
          <label class="full-width">Add Note
            <textarea name="noteText" rows="3"></textarea>
          </label>
          <div class="button-row full-width">
            <button type="submit">Save Note</button>
            ${lead.contactId ? `<a href="#contact/${encodeURIComponent(lead.contactId)}" class="timeline-link-pill">View contact activity</a>` : ""}
            <button type="button" id="lead-done-stage-btn" class="secondary-btn">Done Stage</button>
            <details class="push-menu">
              <summary class="secondary-btn">Push</summary>
              <div class="push-dropdown" data-push-source="leads" data-push-entity="lead" data-push-id="${leadId}">
                ${pushOptionsMarkup}
              </div>
            </details>
          </div>
        </form>
      </div>

      <div class="panel panel--lead notes-panel">
        <h3>Template: ${escapeHtml(stageLabel)}</h3>
        <label class="full-width">Select template
          <select id="lead-template-select" ${stageTemplates.length <= 1 ? "disabled" : ""}>
            ${stageTemplates
              .map(
                (template) =>
                  `<option value="${escapeHtml(template.id)}" ${template.id === selectedTemplate.id ? "selected" : ""}>${escapeHtml(template.name || "Untitled template")}</option>`
              )
              .join("")}
          </select>
        </label>
        <label class="full-width">Generated template
          <textarea id="lead-template-output" rows="8" readonly class="lead-template-output" placeholder="${escapeHtml(LEAD_TEMPLATE_EMPTY_BODY_PLACEHOLDER)}"></textarea>
        </label>
        <div class="button-row full-width">
          <button
            type="button"
            id="lead-open-mail-btn"
            ${leadEmail ? `data-mail-to="${escapeHtml(leadEmail)}"` : "disabled"}
          >
            Open in mail
          </button>
          <button type="button" id="lead-copy-template-btn">Copy template</button>
        </div>
      </div>
    </section>
  `;

  document.getElementById("edit-lead-btn")?.addEventListener("click", () => {
    window.location.hash = appendOriginToHash(`#lead/${leadId}/edit`, originRoute);
  });

  document.getElementById("lead-note-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const noteText = String(new FormData(event.currentTarget).get("noteText") || "").trim();
    if (!noteText) return;
    await addTimelineNote({
      contactId: lead.contactId || null,
      parentType: "lead",
      parentId: leadId,
      noteText,
    });
    await updateDoc(leadRef, { updatedAt: serverTimestamp() });
    await renderLeadDetail(leadId);
  });

  document.getElementById("lead-done-stage-btn")?.addEventListener("click", async () => {
    await completeLeadStage({ userId: currentUser.uid, leadRef, lead, leadSource: "leads", pipelineSettings });
    await renderLeadDetail(leadId);
  });

  document.getElementById("lead-close-won-btn")?.addEventListener("click", async () => {
    await updateDoc(leadRef, {
      state: "closed_won",
      status: "closed",
      archived: true,
      nextActionAt: null,
      updatedAt: serverTimestamp(),
    });
    await renderLeadDetail(leadId);
  });

  document.getElementById("lead-close-lost-btn")?.addEventListener("click", async () => {
    await updateDoc(leadRef, {
      state: "closed_lost",
      status: "closed",
      archived: true,
      nextActionAt: null,
      updatedAt: serverTimestamp(),
    });
    await renderLeadDetail(leadId);
  });

  viewContainer.querySelectorAll("[data-push-select]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", async () => {
      const presetIndex = Number.parseInt(buttonEl.dataset.presetIndex, 10);
      const preset = pushPresets[presetIndex];
      if (!preset) return;

      await pushLeadFromPreset({ userId: currentUser.uid, entityId: leadId, leadSource: "leads", preset });
      await renderLeadDetail(leadId);
    });
  });

  let currentTemplate = selectedTemplate;
  const templateSelectEl = document.getElementById("lead-template-select");
  const templateOutputEl = document.getElementById("lead-template-output");
  const leadCopyTemplateBtn = document.getElementById("lead-copy-template-btn");
  const leadOpenMailBtn = document.getElementById("lead-open-mail-btn");

  function updateLeadTemplateOutput() {
    const assembledTemplateText = renderTemplateWithLead(currentTemplate, linkedContact?.name || "");
    const hasTemplateBody = currentTemplate.bodyText.trim().length > 0;
    const templateOutputText = hasTemplateBody ? assembledTemplateText : "";

    if (templateOutputEl) {
      templateOutputEl.value = templateOutputText;
      templateOutputEl.classList.toggle("lead-template-output--placeholder", !hasTemplateBody);
    }

    if (leadCopyTemplateBtn) {
      leadCopyTemplateBtn.dataset.copyText = assembledTemplateText;
      leadCopyTemplateBtn.disabled = !hasTemplateBody;
    }

    if (leadOpenMailBtn) {
      leadOpenMailBtn.dataset.mailBody = templateOutputText;
      leadOpenMailBtn.dataset.mailSubject = String(currentTemplate?.subjectText || "");
    }
  }

  templateSelectEl?.addEventListener("change", () => {
    const selectedId = String(templateSelectEl.value || "");
    currentTemplate = stageTemplates.find((template) => template.id === selectedId) || stageTemplates[0] || currentTemplate;
    updateLeadTemplateOutput();
  });

  leadOpenMailBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const mailButton = event.currentTarget;
    const to = String(mailButton?.dataset.mailTo || "").trim();
    if (!to) {
      alert("No email on this lead.");
      return;
    }
    const subject = String(mailButton?.dataset.mailSubject || "");
    const body = String(mailButton?.dataset.mailBody || "");
    const bodyWithoutTrailingNewlines = body.replace(/\n+$/, "");
    const mailtoParams = new URLSearchParams();
    if (subject.trim()) {
      mailtoParams.set("subject", subject);
    }
    mailtoParams.set("body", bodyWithoutTrailingNewlines);
    const mailtoQuery = mailtoParams.toString().replace(/\+/g, "%20");
    const mailtoUrl = `mailto:${to}?${mailtoQuery}`;
    window.location.href = mailtoUrl;
  });

  updateLeadTemplateOutput();
  attachClipboardHandlers();
}

async function renderEditLeadForm(leadId) {
  renderLoading("Loading lead form...");

  const route = routeFromHash();
  const originRoute = getCurrentRouteOrigin(route.params);
  const leadRef = doc(db, "users", currentUser.uid, "leads", leadId);
  const [pipelineSettings, leadSnapshot, contactsSnapshot] = await Promise.all([
    getPipelineSettings(currentUser.uid),
    getDoc(leadRef),
    getDocs(query(collection(db, "users", currentUser.uid, "contacts"), orderBy("name", "asc"))),
  ]);

  if (!leadSnapshot.exists()) {
    viewContainer.innerHTML = '<p class="view-message">Lead not found.</p>';
    return;
  }

  const lead = { id: leadSnapshot.id, ...leadSnapshot.data() };
  if (!isActiveRecord(lead)) {
    viewContainer.innerHTML = '<p class="view-message">Lead not found.</p>';
    return;
  }
  const contacts = contactsSnapshot.docs
    .map((contactDoc) => ({ id: contactDoc.id, ...contactDoc.data() }))
    .filter((contact) => isActiveRecord(contact));
  const linkedContact = contacts.find((contact) => contact.id === lead.contactId) || null;
  const leadDetailRoute = appendOriginToHash(`#lead/${leadId}`, originRoute);

  renderLeadForm({
    mode: "edit",
    pipelineSettings,
    contacts,
    values: {
      ...lead,
      contactName: linkedContact?.name || "",
      contactEmail: linkedContact?.email || "",
      contactPhone: linkedContact?.phone || "",
    },
    onSubmit: async (values) => {
      if (lead.contactId) {
        const contactRef = doc(db, "users", currentUser.uid, "contacts", lead.contactId);
        const existingName = linkedContact?.name || "";
        const existingEmail = linkedContact?.email || "";
        const existingPhone = linkedContact?.phone || "";
        const contactChanged =
          values.contactName !== existingName ||
          values.contactEmail !== existingEmail ||
          values.contactPhone !== existingPhone;

        if (contactChanged) {
          await updateDoc(contactRef, {
            name: values.contactName,
            email: values.contactEmail,
            phone: values.contactPhone,
            updatedAt: serverTimestamp(),
          });
        }
      }

      const computedNextActionAt = computeInitialLeadNextActionAt(pipelineSettings, values.stageId, new Date());

      await updateDoc(leadRef, {
        ...buildTimelineEventFields("lead", {
          contactId: lead.contactId || null,
          status: values.stageStatus || "pending",
          archived: values.stageStatus === "completed",
        }),
        title: values.contactName || lead.title || "Lead",
        stageId: values.stageId,
        product: values.product || "",
        stageStatus: values.stageStatus || "pending",
        nextActionAt: computedNextActionAt,
        updatedAt: serverTimestamp(),
      });
      window.location.hash = leadDetailRoute;
    },
    onCancel: async () => {
      window.location.hash = leadDetailRoute;
    },
    onDelete: async () => {
      await deleteEntity("lead", leadId, { currentUserId: currentUser.uid, deletedBy: currentUser.uid });
      navigateAfterDelete(originRoute, "#dashboard");
    },
  });
}

async function renderContactDetail(contactId) {
  renderLoading("Loading contact details...");
  const route = routeFromHash();
  const originRoute = getCurrentRouteOrigin(route.params);

  const contactRef = doc(db, "users", currentUser.uid, "contacts", contactId);
  const [contactSnapshot, tasksSnapshot, leadsSnapshot, notesSnapshot] = await Promise.all([
    getDoc(contactRef),
    getDocs(query(collection(db, "users", currentUser.uid, "tasks"), where("contactId", "==", contactId))),
    getDocs(query(collection(db, "users", currentUser.uid, "leads"), where("contactId", "==", contactId))),
    getDocs(query(collection(db, "users", currentUser.uid, "notes"), where("contactId", "==", contactId))),
  ]);

  if (!contactSnapshot.exists()) {
    viewContainer.innerHTML = '<p class="view-message">Contact not found.</p>';
    return;
  }

  const contact = { id: contactSnapshot.id, ...contactSnapshot.data() };
  if (!isActiveRecord(contact)) {
    viewContainer.innerHTML = '<p class="view-message">Contact not found.</p>';
    return;
  }
  const tasks = tasksSnapshot.docs
    .map((taskDoc) => ({ id: taskDoc.id, ...taskDoc.data() }))
    .filter((task) => isActiveRecord(task));
  const leads = leadsSnapshot.docs
    .map((leadDoc) => ({ id: leadDoc.id, ...leadDoc.data() }))
    .filter((lead) => isActiveRecord(lead));
  const notes = notesSnapshot.docs.map((noteDoc) => ({ id: noteDoc.id, ...noteDoc.data() }));

  const timeline = [
    ...leads.map((lead) => ({ kind: "lead", when: lead.createdAt, label: `Lead ${lead.archived ? "Closed" : "Created"}`, detail: lead.title || lead.summary || "Lead activity", href: appendOriginToHash(`#lead/${lead.id}`, window.location.hash) })),
    ...tasks.map((task) => ({ kind: "task", when: task.createdAt, label: `Task ${task.completed ? "Completed" : "Created"}`, detail: task.title || "Task activity", href: appendOriginToHash(`#task/${task.id}`, window.location.hash) })),
    ...notes.map((note) => ({ kind: "note", when: note.createdAt, label: "Note", detail: note.noteText, href: null })),
  ].sort((a, b) => (toDate(a.when)?.getTime() || 0) - (toDate(b.when)?.getTime() || 0));

  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>${escapeHtml(contact.name || "Contact Detail")}</h2>
        <button id="edit-contact-btn" type="button">Edit</button>
      </div>

      <div class="panel detail-grid">
        <p><strong>Email:</strong> ${escapeHtml(contact.email || "-")}</p>
        <p><strong>Phone:</strong> ${escapeHtml(contact.phone || "-")}</p>
        <p><strong>Created:</strong> ${formatDate(contact.createdAt)}</p>
        <p><strong>Updated:</strong> ${formatDate(contact.updatedAt)}</p>
      </div>

      <div class="panel notes-panel">
        <h3>Timeline</h3>
        <ul class="timeline-list">
          ${timeline.length ? timeline.map((entry) => {
            const toneClass = entry.kind === "lead" ? "timeline-item--lead" : entry.kind === "task" ? "timeline-item--task" : "";
            const rowBody = `<div><p><strong>${escapeHtml(entry.label)}:</strong> ${escapeHtml(entry.detail)}</p><small>${formatDate(entry.when)}</small></div>`;
            if (!entry.href) return `<li class="timeline-item ${toneClass}">${rowBody}</li>`;
            return `<li><a class="timeline-item timeline-item-link ${toneClass}" href="${escapeHtml(entry.href)}">${rowBody}<span class="timeline-link-pill">View</span></a></li>`;
          }).join("") : "<li>No timeline events yet.</li>"}
        </ul>

        <form id="add-note-form" class="form-grid">
          <label class="full-width">Add Note
            <textarea name="noteText" rows="4" required></textarea>
          </label>
          <button type="submit">Save Note</button>
        </form>
      </div>
    </section>
  `;

  document.getElementById("edit-contact-btn")?.addEventListener("click", () => {
    window.location.hash = appendOriginToHash(`#contact/${contactId}/edit`, originRoute);
  });

  document.getElementById("add-note-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const noteText = String(new FormData(event.currentTarget).get("noteText") || "").trim();
    if (!noteText) return;

    await addTimelineNote({
      contactId,
      parentType: "contact",
      parentId: contactId,
      noteText,
    });

    await updateDoc(contactRef, {
      updatedAt: serverTimestamp(),
    });

    await renderContactDetail(contactId);
  });
}

async function renderEditContactForm(contactId) {
  renderLoading("Loading contact form...");

  const route = routeFromHash();
  const originRoute = getCurrentRouteOrigin(route.params);
  const contactRef = doc(db, "users", currentUser.uid, "contacts", contactId);
  const contactSnapshot = await getDoc(contactRef);

  if (!contactSnapshot.exists()) {
    viewContainer.innerHTML = '<p class="view-message">Contact not found.</p>';
    return;
  }

  const contact = { id: contactSnapshot.id, ...contactSnapshot.data() };
  if (!isActiveRecord(contact)) {
    viewContainer.innerHTML = '<p class="view-message">Contact not found.</p>';
    return;
  }
  const contactDetailRoute = appendOriginToHash(`#contact/${contactId}`, originRoute);

  renderContactForm({
    mode: "edit",
    values: contact,
    onSubmit: async (values) => {
      await updateDoc(contactRef, {
        ...values,
        updatedAt: serverTimestamp(),
      });
      window.location.hash = contactDetailRoute;
    },
    onCancel: async () => {
      window.location.hash = contactDetailRoute;
    },
    onDelete: async () => {
      await deleteEntity("contact", contactId, { currentUserId: currentUser.uid, deletedBy: currentUser.uid });
      navigateAfterDelete(originRoute, "#contacts");
    },
  });
}

function renderPlaceholder(title) {
  viewContainer.innerHTML = `
    <section>
      <div class="view-header"><h2>${escapeHtml(title)}</h2></div>
      <p class="view-message">${escapeHtml(title)} is ready for future configuration.</p>
    </section>
  `;
}

async function renderSettingsPage() {
  renderLoading("Loading settings...");

  let appSettings = await getAppSettings(currentUser.uid);
  let editableSettings = normalizeAppSettings(appSettings);

  function readStageTemplatesFromForm(formEl, stageIndex, stage) {
    const stageTemplates = normalizeStageTemplates(stage);

    return stageTemplates.map((template, templateIndex) => {
      const templateDefaults = normalizeStageTemplateEntry(template, { stageId: stage.id, templateIndex });
      return {
        id: String(formEl.elements[`template-id-${stageIndex}-${templateIndex}`]?.value || templateDefaults.id || buildTemplateId(stage.id, templateIndex)),
        name: String(formEl.elements[`template-name-${stageIndex}-${templateIndex}`]?.value || templateDefaults.name || `Template ${templateIndex + 1}`).trim() || `Template ${templateIndex + 1}`,
        subjectText: String(formEl.elements[`template-subject-${stageIndex}-${templateIndex}`]?.value ?? templateDefaults.subjectText),
        introText: String(formEl.elements[`template-intro-${stageIndex}-${templateIndex}`]?.value ?? templateDefaults.introText),
        populateName: formEl.elements[`template-populate-name-${stageIndex}-${templateIndex}`]?.checked === true,
        bodyText: String(formEl.elements[`template-body-${stageIndex}-${templateIndex}`]?.value ?? templateDefaults.bodyText),
        outroText: String(formEl.elements[`template-outro-${stageIndex}-${templateIndex}`]?.value ?? templateDefaults.outroText),
        order: templateIndex,
      };
    });
  }

  function readPipelineFromForm(formEl) {
    const dayStartTime = sanitizeTimeString(String(formEl.elements.dayStartTime?.value || "08:30"));
    const stages = editableSettings.pipeline.stages.map((stage, index) => ({
      ...stage,
      offsetDays: Number.parseInt(String(formEl.elements[`offset-${index}`]?.value || stage.offsetDays), 10),
      templates: readStageTemplatesFromForm(formEl, index, stage),
    }));

    return { dayStartTime, stages };
  }

  function renderSettingsForm() {
    const pipelineSettings = editableSettings.pipeline;
    const pushPresets = editableSettings.pushPresets;

    viewContainer.innerHTML = `
      <section>
        <div class="view-header"><h2>Settings</h2></div>
        <form id="pipeline-settings-form" class="panel form-grid">
          <h3>Pipeline Settings</h3>
          <label>Day Start Time (HH:MM)
            <input name="dayStartTime" type="time" value="${pipelineSettings.dayStartTime}" required />
          </label>

          ${pipelineSettings.stages
            .map(
              (stage, index) => `
                <div class="panel detail-grid">
                  <p><strong>${escapeHtml(stage.label)}</strong></p>
                  <label>Offset Days
                    <input type="number" step="1" name="offset-${index}" value="${stage.offsetDays}" required />
                  </label>
                  ${buildStageTemplateSettingsMarkup(stage, index, escapeHtml)}
                </div>
              `
            )
            .join("")}

          <h3>Dashboard Push Presets</h3>
          ${pushPresets
            .map((preset, index) => {
              const behavior = preset.behavior || {};
              return `
                <div class="panel detail-grid">
                  <p><strong>Preset ${index + 1}</strong></p>
                  <label>Label
                    <input name="push-label-${index}" value="${escapeHtml(preset.label)}" required />
                  </label>
                  <label>Behavior
                    <select name="push-type-${index}">
                      <option value="addHours" ${behavior.type === "addHours" ? "selected" : ""}>Add hours from now</option>
                      <option value="nextTime" ${behavior.type === "nextTime" ? "selected" : ""}>Next time (today/tomorrow)</option>
                      <option value="nextWeekdayTime" ${behavior.type === "nextWeekdayTime" ? "selected" : ""}>Next weekday at time</option>
                    </select>
                  </label>
                  <label>Hours (for "Add hours")
                    <input type="number" min="1" step="1" name="push-hours-${index}" value="${behavior.type === "addHours" ? behavior.hours : 1}" />
                  </label>
                  <label>Time (for next time/day)
                    <input type="time" name="push-time-${index}" value="${sanitizeTimeString(behavior.time || "08:30")}" />
                  </label>
                  <label>Weekday (for next weekday)
                    <select name="push-weekday-${index}">
                      ${[
                        [0, "Sunday"],
                        [1, "Monday"],
                        [2, "Tuesday"],
                        [3, "Wednesday"],
                        [4, "Thursday"],
                        [5, "Friday"],
                        [6, "Saturday"],
                      ]
                        .map(
                          ([value, label]) =>
                            `<option value="${value}" ${behavior.weekday === value ? "selected" : ""}>${label}</option>`
                        )
                        .join("")}
                    </select>
                  </label>
                </div>
              `;
            })
            .join("")}

          <button type="submit" class="full-width">Save Settings</button>
        </form>
      </section>
    `;

    const formEl = document.getElementById("pipeline-settings-form");

    formEl?.addEventListener("click", (event) => {
      const addTemplateButton = event.target.closest("[data-add-template-stage-index]");
      if (!addTemplateButton) return;

      const stageIndex = Number.parseInt(addTemplateButton.dataset.addTemplateStageIndex, 10);
      if (Number.isNaN(stageIndex)) return;

      const pipelineFromForm = readPipelineFromForm(formEl);
      const nextStages = pipelineFromForm.stages.map((stage, idx) => {
        if (idx !== stageIndex) return stage;
        const templateNumber = stage.templates.length + 1;
        return {
          ...stage,
          templates: [
            ...stage.templates,
            {
              id: buildTemplateId(stage.id, stage.templates.length),
              name: `Template ${templateNumber}`,
              order: stage.templates.length,
              ...DEFAULT_STAGE_TEMPLATE,
            },
          ],
        };
      });

      editableSettings = {
        ...editableSettings,
        pipeline: {
          ...editableSettings.pipeline,
          dayStartTime: pipelineFromForm.dayStartTime,
          stages: nextStages,
        },
      };

      renderSettingsForm();
    });

    formEl?.addEventListener("click", async (event) => {
      const saveStageButton = event.target.closest("[data-save-stage-index]");
      if (!saveStageButton) return;

      const stageIndex = Number.parseInt(saveStageButton.dataset.saveStageIndex, 10);
      if (Number.isNaN(stageIndex)) return;

      const pipelineFromForm = readPipelineFromForm(formEl);
      const targetStage = pipelineFromForm.stages[stageIndex];
      if (!targetStage || Number.isNaN(targetStage.offsetDays) || targetStage.offsetDays < 0) {
        alert("Offset days must be a non-negative integer.");
        return;
      }

      const latestSettings = normalizeAppSettings(await getAppSettings(currentUser.uid));
      const updatedStages = latestSettings.pipeline.stages.map((stage, idx) => (idx === stageIndex ? targetStage : stage));

      const normalized = normalizeAppSettings({
        pipeline: { dayStartTime: latestSettings.pipeline.dayStartTime, stages: updatedStages },
        pushPresets: latestSettings.pushPresets,
      });

      await setDoc(pipelineSettingsRef(currentUser.uid), normalized);
      editableSettings = normalized;
      renderSettingsForm();
    });

    formEl?.addEventListener("submit", async (event) => {
      event.preventDefault();

      const formData = new FormData(formEl);
      const pipelineFromForm = readPipelineFromForm(formEl);

      if (pipelineFromForm.stages.some((stage) => Number.isNaN(stage.offsetDays) || stage.offsetDays < 0)) {
        alert("Offset days must be a non-negative integer.");
        return;
      }

      const pushPresetsPayload = editableSettings.pushPresets.map((_, index) => {
        const label = String(formData.get(`push-label-${index}`) || "").trim() || `Preset ${index + 1}`;
        const type = String(formData.get(`push-type-${index}`) || "nextTime");
        const hours = Number.parseInt(String(formData.get(`push-hours-${index}`) || "1"), 10);
        const time = sanitizeTimeString(String(formData.get(`push-time-${index}`) || "08:30"));
        const weekday = Number.parseInt(String(formData.get(`push-weekday-${index}`) || "1"), 10);

        if (type === "addHours") {
          return { label, behavior: { type, hours } };
        }

        if (type === "nextWeekdayTime") {
          return { label, behavior: { type, weekday, time } };
        }

        return { label, behavior: { type: "nextTime", time } };
      });

      const normalized = normalizeAppSettings({
        pipeline: pipelineFromForm,
        pushPresets: pushPresetsPayload,
      });
      await setDoc(pipelineSettingsRef(currentUser.uid), normalized);
      editableSettings = normalized;
      renderSettingsForm();
    });
  }

  renderSettingsForm();
}

async function renderCurrentRoute() {
  if (!currentUser) return;

  const route = routeFromHash();

  try {
    if (route.page === "dashboard") {
      await renderDashboard();
      return;
    }

    if (route.page === "contacts") {
      await renderContactsPage();
      return;
    }

    if (route.page === "add-contact") {
      await renderAddContactForm();
      return;
    }

    if (route.page === "add-lead") {
      await renderAddLeadForm();
      return;
    }

    if (route.page === "add-task") {
      await renderAddTaskForm();
      return;
    }

    if (route.page === "leads") {
      await renderLeadsPage();
      return;
    }

    if (route.page === "tasks") {
      await renderTasksPage();
      return;
    }

    if (route.page === "calendar") {
      const initialView = ["month", "week", "day"].includes(route.params?.get("view")) ? route.params.get("view") : undefined;
      const initialDateRaw = route.params?.get("date");
      const initialDate = initialDateRaw ? new Date(`${initialDateRaw}T00:00:00`) : undefined;
      await renderCalendarScreen({
        viewContainer,
        currentUserId: currentUser.uid,
        initialView,
        initialDate: Number.isNaN(initialDate?.getTime?.()) ? undefined : initialDate,
      });
      return;
    }

    if (route.page === "contact-detail" && route.contactId) {
      await renderContactDetail(route.contactId);
      return;
    }

    if (route.page === "contact-edit" && route.contactId) {
      await renderEditContactForm(route.contactId);
      return;
    }

    if (route.page === "lead-detail" && route.leadId) {
      await renderLeadDetail(route.leadId);
      return;
    }

    if (route.page === "lead-edit" && route.leadId) {
      await renderEditLeadForm(route.leadId);
      return;
    }

    if (route.page === "task-detail" && route.taskId) {
      await renderTaskDetail(route.taskId);
      return;
    }

    if (route.page === "task-edit" && route.taskId) {
      await renderEditTaskForm(route.taskId);
      return;
    }

    if (route.page === "promotions") {
      renderPlaceholder("Promotions");
      return;
    }

    if (route.page === "settings") {
      await renderSettingsPage();
      return;
    }

    await renderDashboard();
  } catch (error) {
    console.error("Render error:", error);
    viewContainer.innerHTML = `<p class="view-message">${explainFirestoreError(error)}</p>`;
  }
}

signupBtn.addEventListener("click", async () => {
  const creds = readCredentials();
  if (!creds) return;

  try {
    const userCredential = await createUserWithEmailAndPassword(
      auth,
      creds.email,
      creds.password
    );
    setStatus(`Signup successful: ${userCredential.user.email}`);
  } catch (error) {
    console.error("Signup error:", error);
    setStatus(explainAuthError(error, "Signup"));
  }
});

loginBtn.addEventListener("click", async () => {
  const creds = readCredentials();
  if (!creds) return;

  try {
    const userCredential = await signInWithEmailAndPassword(
      auth,
      creds.email,
      creds.password
    );
    setStatus(`Login successful: ${userCredential.user.email}`);
  } catch (error) {
    console.error("Login error:", error);
    setStatus(explainAuthError(error, "Login"));
  }
});

logoutBtn.addEventListener("click", async () => {
  await signOut(auth);
  window.location.hash = "";
});

onAuthStateChanged(auth, async (user) => {
  currentUser = user;

  if (user) {
    authPage.classList.add("hidden");
    appPage.classList.remove("hidden");

    if (!window.location.hash || window.location.hash === "#") {
      window.location.hash = "#dashboard";
    }

    await runNightlyRolloverIfDue();
    scheduleNightlyRollover();
    await renderCurrentRoute();
  } else {
    if (nightlyRolloverTimerId) {
      window.clearTimeout(nightlyRolloverTimerId);
      nightlyRolloverTimerId = null;
    }
    authPage.classList.remove("hidden");
    appPage.classList.add("hidden");
    setStatus("Please log in to continue.");
  }
});

window.addEventListener("hashchange", () => {
  renderCurrentRoute();
});
