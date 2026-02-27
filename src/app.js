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
  isLeadDropOutState,
} from "./domain/settings.js";
import { getAppSettings, getPipelineSettings, pipelineSettingsRef } from "./data/settings-service.js";
import { renderCalendarScreen } from "./calendar/calendar-screen.js";
import { rescheduleLeadAction } from "./data/calendar-service.js";
import { PROMOTION_PRESETS, buildPromotionTouchpoints, toPromotionDate } from "./promotions/presets.js";
import { computeTargetLeads, findSnapMatch, isLeadActive } from "./promotions/snap-engine.js";
import {
  createPromotion,
  restoreExpiredPromotionStageReplacements,
  restoreSnappedLeadsAndDeletePromotion,
  syncPromotionTouchpointContainers,
  syncSnappedLeadPromotionPause
} from "./promotions/promotion-engine.js";
import { composeSequenceDisplayName, createSequence, markSequenceStepStatus } from "./sequences/sequence-engine.js";
import {
  DEFAULT_STAGE_TEMPLATE,
  LEAD_TEMPLATE_EMPTY_BODY_PLACEHOLDER,
  buildStageTemplateSettingsMarkup,
  buildTemplateId,
  normalizePromotionTemplateConfig,
  normalizeStageTemplateEntry,
  normalizeStageTemplates,
  renderTemplateWithLead,
  toPromotionTemplatePayload,
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
const demoNameEl = document.getElementById("demo-name");
const demoEmailEl = document.getElementById("demo-email");
const demoPhoneEl = document.getElementById("demo-phone");
const demoNotesEl = document.getElementById("demo-notes");
const demoSaveEl = document.getElementById("demo-save");
const demoResultEl = document.getElementById("demo-result");
const demoSectionEl = document.getElementById("demo-section");
const strippedSectionEl = document.getElementById("stripped-section");

const DEMO_LOOP_MS = 6000;
const SPREADSHEET_HEADERS = ["Date Added", "Contact Name", "Email", "Phone Number", "Product", "Status", "Stage"];
const IMPORT_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEMO_STEPS = [
  { delay: 500, target: demoNameEl, value: "Carl Simon" },
  { delay: 1100, target: demoEmailEl, value: "carl@email.com" },
  { delay: 1700, target: demoPhoneEl, value: "555-1234" },
  { delay: 2300, target: demoNotesEl, value: "Interested in Jacuzzi." },
];

let demoLoopIntervalId = null;

function clearDemoFields() {
  [demoNameEl, demoEmailEl, demoPhoneEl, demoNotesEl].forEach((fieldEl) => {
    if (fieldEl) {
      fieldEl.textContent = " ";
    }
  });
}

function renderDemoResult(text, className = "") {
  if (!demoResultEl) return;
  demoResultEl.textContent = text;
  demoResultEl.className = "demo-result";
  if (className) {
    demoResultEl.classList.add(className);
  }
  if (text.trim()) {
    demoResultEl.classList.add("is-visible");
  }
}

function runDemoCycle() {
  if (!demoNameEl || !demoSaveEl || !demoResultEl) return;

  clearDemoFields();
  renderDemoResult(" ");
  demoSaveEl.classList.remove("is-saving");

  DEMO_STEPS.forEach(({ delay, target, value }) => {
    window.setTimeout(() => {
      if (target) {
        target.textContent = value;
      }
    }, delay);
  });

  window.setTimeout(() => {
    demoSaveEl.classList.add("is-saving");
  }, 2950);

  window.setTimeout(() => {
    demoSaveEl.classList.remove("is-saving");
    renderDemoResult("Carl Simon – Contact Today", "is-lead");
  }, 3350);

  window.setTimeout(() => {
    renderDemoResult("Dashboard cleared: 1/1 complete.", "is-clear");
  }, 4500);

  window.setTimeout(() => {
    clearDemoFields();
    renderDemoResult(" ");
  }, 5650);
}

function startAuthDemo() {
  if (!authPage || !demoNameEl || demoLoopIntervalId) return;
  runDemoCycle();
  demoLoopIntervalId = window.setInterval(runDemoCycle, DEMO_LOOP_MS);
}

function stopAuthDemo() {
  if (!demoLoopIntervalId) return;
  window.clearInterval(demoLoopIntervalId);
  demoLoopIntervalId = null;
}

function initAuthPageAnimations() {
  const revealSections = document.querySelectorAll(".section-reveal");
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
        }
      });
    },
    { threshold: 0.18 }
  );

  revealSections.forEach((sectionEl) => revealObserver.observe(sectionEl));

  if (strippedSectionEl) {
    const strippedObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          entry.target.classList.toggle("is-active", entry.isIntersecting);
        });
      },
      { threshold: 0.35 }
    );
    strippedObserver.observe(strippedSectionEl);
  }

  if (demoSectionEl) {
    const demoObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            startAuthDemo();
          } else {
            stopAuthDemo();
          }
        });
      },
      { threshold: 0.3 }
    );
    demoObserver.observe(demoSectionEl);
  }
}

let currentUser = null;
let authStateResolved = false;
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
  await restoreExpiredPromotionStageReplacements({ db, userId: currentUser.uid, asOfDate: nowDate });

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
      "Update Firebase Firestore Security Rules to allow authenticated users to read and write users/{userId}/contacts, users/{userId}/leads, users/{userId}/tasks, users/{userId}/notes, users/{userId}/promotions, users/{userId}/events, users/{userId}/promotions/{promotionId}/snapshots, and users/{userId}/settings/pipeline.",
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

function formatDateForSpreadsheet(value) {
  const date = toDate(value);
  if (!date) return "";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseImportDate(value) {
  const trimmedValue = String(value || "").trim();
  const matches = IMPORT_DATE_PATTERN.exec(trimmedValue);
  if (!matches) return null;
  const year = Number.parseInt(matches[1], 10);
  const month = Number.parseInt(matches[2], 10);
  const day = Number.parseInt(matches[3], 10);
  const parsed = new Date(year, month - 1, day);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
  return parsed;
}

function escapeCsvCell(value) {
  const stringValue = String(value ?? "");
  if (!/[",\n]/.test(stringValue)) return stringValue;
  return `"${stringValue.replace(/"/g, '""')}"`;
}

function buildCsv(rows) {
  return rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(",")).join("\n");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (inQuotes) {
    throw new Error("Invalid CSV format: unclosed quoted field.");
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function validateSpreadsheetHeaders(headerRow) {
  if (!Array.isArray(headerRow) || headerRow.length !== SPREADSHEET_HEADERS.length) {
    throw new Error(`Invalid headers. Expected: ${SPREADSHEET_HEADERS.join(", ")}`);
  }

  const hasMismatch = SPREADSHEET_HEADERS.some((header, index) => headerRow[index] !== header);
  if (hasMismatch) {
    throw new Error(`Invalid headers. Expected: ${SPREADSHEET_HEADERS.join(", ")}`);
  }
}

function mapStageIndexToStageId(pipelineSettings, stageValue, fallbackStageId) {
  const trimmedStage = String(stageValue || "").trim();
  if (!trimmedStage) return fallbackStageId;
  const matched = /^stage\s+(\d+)$/i.exec(trimmedStage);
  if (!matched) return null;
  const stageIndex = Number.parseInt(matched[1], 10) - 1;
  if (Number.isNaN(stageIndex) || stageIndex < 0 || stageIndex >= pipelineSettings.stages.length) return null;
  return pipelineSettings.stages[stageIndex]?.id || null;
}

function mapStageIdToStageConcept(pipelineSettings, stageId) {
  const index = pipelineSettings.stages.findIndex((stage) => stage.id === stageId);
  if (index < 0) return "";
  return `Stage ${index + 1}`;
}

async function createLeadViaManualFlow({ pipelineSettings, values, createdAtDate = new Date() }) {
  const now = Timestamp.fromDate(createdAtDate);
  const computedNextActionAt = computeInitialLeadNextActionAt(pipelineSettings, values.stageId, createdAtDate);
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
  await setDoc(doc(db, "users", currentUser.uid, "events", `lead_${leadDoc.id}`), {
    type: "lead",
    sourceId: leadDoc.id,
    contactId,
    scheduledFor: computedNextActionAt,
    nextActionAt: computedNextActionAt,
    title: leadPayload.title || "Lead",
    status: leadPayload.status || "open",
    completed: false,
    archived: false,
    deleted: false,
    updatedAt: serverTimestamp(),
  }, { merge: true });

  if (values.initialNote) {
    await addTimelineNote({
      contactId,
      parentType: "lead",
      parentId: leadDoc.id,
      noteText: values.initialNote,
    });
  }
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

async function completeLeadStage({ userId, leadRef, lead, leadSource, pipelineSettings, completedAt = new Date(), actionSource = "non_promo" }) {
  const nowDate = completedAt instanceof Date ? completedAt : new Date(completedAt);
  const currentStageId = lead.stageId || pipelineSettings.stages[0]?.id;
  const nextStage = getNextStage(pipelineSettings, currentStageId);

  if (!nextStage) {
    const updates = {
      status: "closed",
      archived: true,
      nextActionAt: null,
      lastActionAt: Timestamp.fromDate(nowDate),
      lastActionSource: actionSource,
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
    lastActionSource: actionSource,
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

async function pushSequenceStepFromPreset({ userId, eventId, preset }) {
  const pushedAt = computePushedTimestamp(new Date(), preset);
  const eventRef = doc(db, "users", userId, "events", eventId);
  const eventSnapshot = await getDoc(eventRef);
  if (!eventSnapshot.exists()) return;

  const event = { id: eventSnapshot.id, ...eventSnapshot.data() };
  if (!event.sequenceId || !event.stepId) return;

  const sequenceSnapshot = await getDoc(doc(db, "users", userId, "sequences", event.sequenceId));
  if (!sequenceSnapshot.exists()) return;
  const sequence = sequenceSnapshot.data() || {};
  const orderedSteps = (Array.isArray(sequence.steps) ? sequence.steps : [])
    .map((step, index) => ({ ...step, order: Number.isInteger(step?.order) ? step.order : index }))
    .sort((a, b) => a.order - b.order);
  const anchorIndex = orderedSteps.findIndex((step) => step.id === event.stepId);
  if (anchorIndex < 0) return;

  const now = serverTimestamp();
  let cursorDate = pushedAt.toDate();

  for (let index = anchorIndex; index < orderedSteps.length; index += 1) {
    const step = orderedSteps[index];
    if (index > anchorIndex) {
      const previousStep = orderedSteps[index - 1];
      if (previousStep?.triggerImmediatelyAfterPrevious === true) {
        continue;
      }
      const offsetDays = Math.max(0, Number(step.delayDaysFromPrevious) || 0);
      cursorDate = new Date(cursorDate);
      cursorDate.setDate(cursorDate.getDate() + offsetDays);
    }

    const stepEventId = `sequence_${event.sequenceId}_step_${step.id}`;
    const stepRef = doc(db, "users", userId, "events", stepEventId);
    await updateDoc(stepRef, {
      scheduledFor: Timestamp.fromDate(cursorDate),
      nextActionAt: Timestamp.fromDate(cursorDate),
      blockedUntilPreviousComplete: false,
      updatedAt: now,
    });
  }
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
  if (hash === "sequences/new") return { page: "add-sequence" };
  if (hash === "calendar") return { page: "calendar", params };
  if (hash === "tasks/new") return { page: "add-task" };
  if (hash === "add-task") return { page: "add-task" };
  if (hash === "promotions") return { page: "promotions", params };
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

  if (hash.startsWith("promotion-event/")) {
    return { page: "promotion-event-detail", promotionEventId: hash.split("/")[1], params };
  }

  if (hash.startsWith("sequence-event/")) {
    return { page: "sequence-event-detail", sequenceEventId: hash.split("/")[1], params };
  }

  if (hash.startsWith("promotion/")) {
    return { page: "promotion-detail", promotionId: hash.split("/")[1], params };
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

  const [contactsSnapshot, leadsSnapshot, legacyLeadsSnapshot, tasksSnapshot, promoEventsSnapshot] = await Promise.all([
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
    getDocs(
      query(
        collection(db, "users", currentUser.uid, "events"),
        where("completed", "==", false),
        where("scheduledFor", "<=", now),
        orderBy("scheduledFor", "asc")
      )
    ),
  ]);

  const contactById = contactsSnapshot.docs.reduce((acc, contactDoc) => {
    const value = { id: contactDoc.id, ...contactDoc.data() };
    if (isActiveRecord(value)) acc[contactDoc.id] = value;
    return acc;
  }, {});

  const dueLeads = leadsSnapshot.docs
    .map((leadDoc) => ({ id: leadDoc.id, ...leadDoc.data() }))
    .filter((lead) => isActiveRecord(lead) && lead.stageStatus !== "completed")
    .map((lead) => {
      const contact = contactById[lead.contactId] || {};
      return { type: "lead", id: lead.id, source: "leads", contactId: lead.contactId || null, title: contact.name || "Unnamed Contact", subtitle: contact.email || contact.phone || "No contact details", email: contact.email || "", stageId: lead.stageId, product: lead.product || "", dueAt: lead.nextActionAt };
    });

  const legacyDueLeads = legacyLeadsSnapshot.docs.map((contactDoc) => {
    const contact = { id: contactDoc.id, ...contactDoc.data() };
    if (!isActiveRecord(contact)) return null;
    return { type: "lead", id: contact.id, source: "contacts", contactId: contact.id, title: contact.name || "Unnamed Contact", subtitle: contact.email || contact.phone || "No contact details", stageId: contact.stageId, dueAt: contact.nextActionAt };
  }).filter(Boolean);

  const dueTasks = tasksSnapshot.docs.map((taskDoc) => {
    const task = { id: taskDoc.id, ...taskDoc.data() };
    if (!isActiveRecord(task)) return null;
    const contact = task.contactId ? contactById[task.contactId] : null;
    return { type: "task", id: task.id, contactId: task.contactId || null, title: task.title || "Untitled Task", subtitle: contact?.name || "No contact", notes: task.notes || "", dueAt: task.scheduledFor };
  }).filter(Boolean);

  const duePromotions = promoEventsSnapshot.docs.map((eventDoc) => {
    const event = { id: eventDoc.id, ...eventDoc.data() };
    const isPromotionEvent = event.type === "promotion" || event.type === "promotion_touchpoint" || Boolean(event.promotionId);
    const isSequenceEvent = event.type === "sequence" || event.type === "sequence_step" || Boolean(event.sequenceId);
    if (!isActiveRecord(event) || (!isPromotionEvent && !isSequenceEvent)) return null;
    const contact = event.contactId ? contactById[event.contactId] : null;
    const isContainer = event.type === "promotion_touchpoint" || event.type === "sequence_step" || !event.leadId;
    const isSequence = isSequenceEvent;
    return {
      type: isSequence ? "sequence" : "promotion",
      id: event.id,
      leadId: event.leadId || null,
      title: isContainer ? (event.title || event.name || (isSequence ? "Sequence step" : "Promotion touchpoint")) : (contact?.name || "Unnamed Contact"),
      subtitle: isContainer ? (isSequence ? "Sequence" : "Promotion") : (event.touchpointName || event.stepName || event.title || event.name || "Sequence step"),
      dueAt: event.scheduledFor || event.nextActionAt,
      isContainer,
    };
  }).filter(Boolean);

  const pushOptionsMarkup = pushPresets.map((preset, index) => `<button type="button" data-push-select="true" data-preset-index="${index}" class="push-option">${escapeHtml(preset.label)}</button>`).join("");

  const feedItems = [...dueLeads, ...legacyDueLeads, ...dueTasks, ...duePromotions].sort((a, b) => (toDate(a.dueAt)?.getTime() || 0) - (toDate(b.dueAt)?.getTime() || 0));

  const feedMarkup = feedItems.length ? feedItems.map((item) => {
    if (item.type === "lead") {
      const stageLabel = getStageById(pipelineSettings, item.stageId)?.label || "Unknown stage";
      return `<article class="panel feed-item feed-item-clickable feed-item--lead" data-open-feed-item="true" data-feed-type="lead" data-feed-id="${item.id}" data-lead-source="${item.source}" tabindex="0" role="button"><p class="feed-type">Lead</p><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.subtitle)}</p>${item.email ? `<p><strong>Email:</strong> <span class="contact-detail-inline">${escapeHtml(item.email)} <button type="button" class="clipboard-copy-btn" data-copy-text="${escapeHtml(item.email)}" aria-label="Copy email" title="Copy email">${clipboardIconMarkup}</button></span></p>` : ""}<p><strong>Stage:</strong> ${escapeHtml(stageLabel)}${item.product ? `<span class="dashboard-stage-product">• Product: ${escapeHtml(item.product)}</span>` : ""}</p><p><strong>Due:</strong> ${formatDate(item.dueAt)}</p><div class="button-row"><button type="button" class="dashboard-action-btn" data-lead-action="done" data-lead-source="${item.source}" data-lead-id="${item.id}">Done</button><details class="push-menu"><summary class="dashboard-action-btn">Push</summary><div class="push-dropdown" data-push-source="${item.source}" data-push-entity="lead" data-push-id="${item.id}">${pushOptionsMarkup}</div></details></div></article>`;
    }

    if (item.type === "promotion" || item.type === "sequence") {
      const eventPath = item.type === "sequence" ? `#sequence-event/${item.id}` : `#promotion-event/${item.id}`;
      const label = item.type === "sequence" ? "Sequence" : "Promotion";
      const feedClass = item.type === "sequence" ? "feed-item--sequence" : "feed-item--promotion";
      const actionsMarkup = item.type === "sequence"
        ? `<button type="button" class="dashboard-action-btn" data-promo-event-done="${item.id}">Done</button><details class="push-menu"><summary class="dashboard-action-btn">Push</summary><div class="push-dropdown" data-push-entity="sequence" data-push-id="${item.id}">${pushOptionsMarkup}</div></details>`
        : (item.isContainer ? '<a class="timeline-link-pill" href="' + appendOriginToHash(eventPath, window.location.hash) + '">Open</a>' : `<button type="button" class="dashboard-action-btn" data-promo-event-done="${item.id}">Done</button>`);
      return `<article class="panel feed-item feed-item-clickable ${feedClass}" data-open-feed-item="true" data-feed-type="${item.type}" data-feed-id="${item.id}" tabindex="0" role="button"><p class="feed-type">${label}</p><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.subtitle)}</p><p><strong>Due:</strong> ${formatDate(item.dueAt)}</p><div class="button-row">${actionsMarkup}</div></article>`;
    }

    return `<article class="panel feed-item feed-item-clickable feed-item--task" data-open-feed-item="true" data-feed-type="task" data-feed-id="${item.id}" tabindex="0" role="button"><p class="feed-type">Task</p><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.subtitle)}</p><p><strong>Due:</strong> ${formatDate(item.dueAt)}</p>${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ""}<div class="button-row"><button type="button" class="dashboard-action-btn" data-task-action="done" data-task-id="${item.id}">Done</button><details class="push-menu"><summary class="dashboard-action-btn">Push</summary><div class="push-dropdown" data-push-entity="task" data-push-id="${item.id}">${pushOptionsMarkup}</div></details></div></article>`;
  }).join("") : '<p class="view-message">No leads, tasks, or promotions are due right now.</p>';

  viewContainer.innerHTML = `<section class="crm-view crm-view--dashboard"><div class="view-header"><h2>Dashboard Feed</h2><div class="view-header-actions"><button id="new-lead-btn" type="button">New Lead +</button><button id="add-task-btn" type="button">Add Task</button></div></div><div class="feed-list">${feedMarkup}</div></section>`;

  document.getElementById("new-lead-btn")?.addEventListener("click", () => { window.location.hash = "#add-lead"; });
  document.getElementById("add-task-btn")?.addEventListener("click", () => { window.location.hash = "#tasks/new"; });

  viewContainer.querySelectorAll('[data-open-feed-item="true"]').forEach((itemEl) => {
    const navigateToDetail = () => {
      const feedType = itemEl.dataset.feedType;
      const feedId = itemEl.dataset.feedId;
      if (!feedType || !feedId) return;
      if (feedType === "task") return void (window.location.hash = appendOriginToHash(`#task/${feedId}`, window.location.hash));
      if (feedType === "promotion") return void (window.location.hash = appendOriginToHash(`#promotion-event/${feedId}`, window.location.hash));
      if (feedType === "sequence") return void (window.location.hash = appendOriginToHash(`#sequence-event/${feedId}`, window.location.hash));
      const leadSource = itemEl.dataset.leadSource;
      if (leadSource === "contacts") return void (window.location.hash = appendOriginToHash(`#contact/${feedId}`, window.location.hash));
      window.location.hash = appendOriginToHash(`#lead/${feedId}`, window.location.hash);
    };
    itemEl.addEventListener("click", (event) => { if (event.target.closest("button") || event.target.closest("summary")) return; navigateToDetail(); });
    itemEl.addEventListener("keydown", (event) => { if (event.key !== "Enter" && event.key !== " ") return; event.preventDefault(); navigateToDetail(); });
  });

  viewContainer.querySelectorAll("[data-promo-event-done]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", async () => {
      const eventId = buttonEl.dataset.promoEventDone;
      if (!eventId) return;
      await markPromotionEventDone(eventId);
      await renderDashboard();
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
      await updateDoc(doc(db, "users", currentUser.uid, "tasks", taskId), { completed: true, status: "completed", archived: true, updatedAt: serverTimestamp() });
      await setDoc(doc(db, "users", currentUser.uid, "events", `task_${taskId}`), {
        type: "task",
        sourceId: taskId,
        completed: true,
        archived: true,
        status: "completed",
        updatedAt: serverTimestamp(),
      }, { merge: true });
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
        await updateDoc(doc(db, "users", currentUser.uid, "tasks", entityId), { scheduledFor: pushedAt, updatedAt: serverTimestamp() });
        await setDoc(doc(db, "users", currentUser.uid, "events", `task_${entityId}`), {
          type: "task",
          sourceId: entityId,
          scheduledFor: pushedAt,
          updatedAt: serverTimestamp(),
        }, { merge: true });
      } else if (entityType === "sequence") {
        await pushSequenceStepFromPreset({ userId: currentUser.uid, eventId: entityId, preset });
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
      await createLeadViaManualFlow({ pipelineSettings, values, createdAtDate: new Date() });
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
      const taskDoc = await addDoc(collection(db, "users", currentUser.uid, "tasks"), {
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
      await setDoc(doc(db, "users", currentUser.uid, "events", `task_${taskDoc.id}`), {
        type: "task",
        sourceId: taskDoc.id,
        contactId: values.contactId || null,
        scheduledFor: values.scheduledFor || null,
        title: values.title || "Untitled Task",
        status: "open",
        completed: false,
        archived: false,
        deleted: false,
        updatedAt: serverTimestamp(),
      }, { merge: true });
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

  const [contactsSnapshot, tasksSnapshot, sequenceEventsSnapshot] = await Promise.all([
    getDocs(collection(db, "users", currentUser.uid, "contacts")),
    getDocs(collection(db, "users", currentUser.uid, "tasks")),
    getDocs(collection(db, "users", currentUser.uid, "events")),
  ]);

  const contactById = contactsSnapshot.docs.reduce((acc, contactDoc) => {
    acc[contactDoc.id] = { id: contactDoc.id, ...contactDoc.data() };
    return acc;
  }, {});

  const allTasks = tasksSnapshot.docs
    .map((taskDoc) => ({ id: taskDoc.id, ...taskDoc.data() }))
    .filter((task) => isActiveRecord(task));
  const allSequenceSteps = sequenceEventsSnapshot.docs
    .map((eventDoc) => ({ id: eventDoc.id, ...eventDoc.data() }))
    .filter((event) => isActiveRecord(event) && (event.type === "sequence" || event.type === "sequence_step" || Boolean(event.sequenceId)));


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

  const getSequenceSortTime = (entry) => toDate(entry.scheduledFor || entry.nextActionAt)?.getTime() || 0;
  const activeSequenceSteps = allSequenceSteps
    .filter((entry) => !entry.completed && entry.status !== "skipped")
    .sort((a, b) => getSequenceSortTime(b) - getSequenceSortTime(a));
  const completedSequenceSteps = allSequenceSteps
    .filter((entry) => entry.completed || entry.status === "skipped")
    .sort((a, b) => getSequenceSortTime(b) - getSequenceSortTime(a));

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

  const renderSequenceCard = (entry) => {
    const linkedContact = entry.contactId ? contactById[entry.contactId] : null;
    const statusText = entry.status === "skipped" ? "Completed" : (entry.completed ? "Completed" : "Active");
    return `
      <button class="panel feed-item feed-item--sequence" data-sequence-event-id="${entry.id}" type="button">
        <h3>${escapeHtml(entry.title || entry.name || entry.stepName || "Sequence Step")}</h3>
        <p><strong>Scheduled:</strong> ${entry.scheduledFor ? formatDate(entry.scheduledFor) : "Pending previous step"}</p>
        <p><strong>Contact:</strong> ${escapeHtml(linkedContact?.name || "No contact")}</p>
        <p><strong>Status:</strong> ${statusText}</p>
      </button>
    `;
  };

  viewContainer.innerHTML = `
    <section class="crm-view crm-view--tasks">
      <div class="view-header">
        <h2>Tasks</h2>
        <div class="view-header-actions"><button id="add-task-btn" type="button">Add Task +</button><button id="add-sequence-btn" type="button" class="secondary-btn">Add Sequence</button></div>
      </div>
      <div class="feed-list">
        ${
          activeTasks.length || activeSequenceSteps.length
            ? `${activeTasks.map((task) => renderTaskCard(task)).join("")}${activeSequenceSteps.map((entry) => renderSequenceCard(entry)).join("")}`
            : '<p class="view-message">No active tasks.</p>'
        }

        ${
          completedTasks.length || completedSequenceSteps.length
            ? `
              <div class="tasks-divider" role="separator" aria-label="Completed Tasks section">
                <h3>Completed Tasks</h3>
              </div>
              ${completedTasks.map((task) => renderTaskCard(task)).join("")}
              ${completedSequenceSteps.map((entry) => renderSequenceCard(entry)).join("")}
            `
            : ""
        }
      </div>
    </section>
  `;

  document.getElementById("add-task-btn")?.addEventListener("click", () => {
    window.location.hash = "#tasks/new";
  });

  document.getElementById("add-sequence-btn")?.addEventListener("click", () => {
    window.location.hash = "#sequences/new";
  });

  viewContainer.querySelectorAll("[data-task-id]").forEach((taskEl) => {
    taskEl.addEventListener("click", () => {
      window.location.hash = appendOriginToHash(`#task/${taskEl.dataset.taskId}`, window.location.hash);
    });
  });

  viewContainer.querySelectorAll("[data-sequence-event-id]").forEach((sequenceEl) => {
    sequenceEl.addEventListener("click", () => {
      window.location.hash = appendOriginToHash(`#sequence-event/${sequenceEl.dataset.sequenceEventId}`, window.location.hash);
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
  const [contactSnapshot, tasksSnapshot, leadsSnapshot, notesSnapshot, sequencesSnapshot] = await Promise.all([
    getDoc(contactRef),
    getDocs(query(collection(db, "users", currentUser.uid, "tasks"), where("contactId", "==", contactId))),
    getDocs(query(collection(db, "users", currentUser.uid, "leads"), where("contactId", "==", contactId))),
    getDocs(query(collection(db, "users", currentUser.uid, "notes"), where("contactId", "==", contactId))),
    getDocs(query(collection(db, "users", currentUser.uid, "sequences"), where("contactId", "==", contactId))),
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
  const sequences = sequencesSnapshot.docs.map((sequenceDoc) => ({ id: sequenceDoc.id, ...sequenceDoc.data() }));

  const timeline = [
    ...leads.map((lead) => ({ kind: "lead", when: lead.createdAt, label: `Lead ${lead.archived ? "Closed" : "Created"}`, detail: lead.title || lead.summary || "Lead activity", href: appendOriginToHash(`#lead/${lead.id}`, window.location.hash) })),
    ...tasks.map((task) => ({ kind: "task", when: task.createdAt, label: `Task ${task.completed ? "Completed" : "Created"}`, detail: task.title || "Task activity", href: appendOriginToHash(`#task/${task.id}`, window.location.hash) })),
    ...sequences.map((sequence) => ({
      kind: "sequence",
      when: sequence.createdAt,
      label: `Sequence ${sequence.status === "completed" ? "Completed" : "Created"}`,
      detail: composeSequenceDisplayName(sequence) || "Sequence activity",
      href: null,
    })),
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

async function syncPromotionSnapshotProgress({ promotionId, leadId }) {
  if (!promotionId || !leadId) return;

  const promotionRef = doc(db, "users", currentUser.uid, "promotions", promotionId);
  const promotionSnapshot = await getDoc(promotionRef);
  if (!promotionSnapshot.exists()) return;

  const promotion = promotionSnapshot.data() || {};
  const touchpoints = Array.isArray(promotion.touchpoints) ? promotion.touchpoints : [];
  const statusSnapshots = await Promise.all(
    touchpoints.map((touchpoint) =>
      getDoc(doc(db, "users", currentUser.uid, "promotions", promotionId, "touchpoints", touchpoint.id, "statuses", leadId))
    )
  );

  const statusEntries = statusSnapshots
    .filter((entry) => entry.exists())
    .map((entry) => ({ id: entry.id, ...entry.data() }));

  const completedTouchpointCount = statusEntries.filter((entry) => entry.completed === true).length;
  const snapshotRef = doc(db, "users", currentUser.uid, "promotions", promotionId, "snapshots", leadId);
  const snapshotDoc = await getDoc(snapshotRef);
  if (!snapshotDoc.exists()) return;

  const snapshot = snapshotDoc.data() || {};
  if (snapshot?.addedViaSnapActive !== true) return;

  await updateDoc(snapshotRef, {
    completedTouchpointCount,
    zeroTouchpointsCompleted: completedTouchpointCount === 0,
    lastCompletedPromotionTouchpointAt: completedTouchpointCount
      ? serverTimestamp()
      : snapshot.lastCompletedPromotionTouchpointAt || null,
    updatedAt: serverTimestamp(),
  });
}

async function reconcilePromotionLeadProgressFromStatuses({ promotionId, leadId, completedAt = new Date() }) {
  if (!promotionId || !leadId) return;

  const promotionRef = doc(db, "users", currentUser.uid, "promotions", promotionId);
  const promotionSnapshot = await getDoc(promotionRef);
  if (!promotionSnapshot.exists()) return;

  const promotion = promotionSnapshot.data() || {};
  const touchpoints = Array.isArray(promotion.touchpoints) ? promotion.touchpoints : [];
  if (!touchpoints.length) return;

  const statusSnapshots = await Promise.all(
    touchpoints.map((touchpoint) =>
      getDoc(doc(db, "users", currentUser.uid, "promotions", promotionId, "touchpoints", touchpoint.id, "statuses", leadId))
    )
  );

  const unresolved = statusSnapshots.some((snapshotDoc) => {
    if (!snapshotDoc.exists()) return true;
    const status = snapshotDoc.data() || {};
    return status.completed !== true && status.status !== "skipped";
  });

  await syncPromotionSnapshotProgress({ promotionId, leadId });

  if (unresolved) return;

  const leadRef = doc(db, "users", currentUser.uid, "leads", leadId);
  const [leadSnapshot, pipelineSettings] = await Promise.all([getDoc(leadRef), getPipelineSettings(currentUser.uid)]);
  if (!leadSnapshot.exists()) return;

  const promotionEndDate = toPromotionDate(promotion.endDate);
  const completionAnchor = promotionEndDate || completedAt;

  await completeLeadStage({
    userId: currentUser.uid,
    leadRef,
    lead: leadSnapshot.data(),
    leadSource: "leads",
    pipelineSettings,
    completedAt: completionAnchor,
    actionSource: "promotion_touchpoint",
  });

  const snapshotRef = doc(db, "users", currentUser.uid, "promotions", promotionId, "snapshots", leadId);
  const snapshotDoc = await getDoc(snapshotRef);
  if (snapshotDoc.exists()) {
    await updateDoc(snapshotRef, {
      promotionResolvedAt: serverTimestamp(),
      lastCompletedPromotionTouchpointAt: Timestamp.fromDate(completedAt instanceof Date ? completedAt : new Date(completedAt)),
      updatedAt: serverTimestamp(),
    });
  }
}

async function markPromotionTouchpointLeadStatus({ event, leadId, status }) {
  if (!event?.promotionId || !event?.touchpointId || !leadId) return;
  const statusRef = doc(
    db,
    "users",
    currentUser.uid,
    "promotions",
    event.promotionId,
    "touchpoints",
    event.touchpointId,
    "statuses",
    leadId
  );

  const isDone = status === "completed";
  await setDoc(
    statusRef,
    {
      leadId,
      promotionId: event.promotionId,
      touchpointId: event.touchpointId,
      status,
      completed: isDone,
      skipped: status === "skipped",
      completedAt: isDone ? serverTimestamp() : null,
      skippedAt: status === "skipped" ? serverTimestamp() : null,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  const [statusSnapshot, eventSnapshot] = await Promise.all([
    getDocs(collection(db, "users", currentUser.uid, "promotions", event.promotionId, "touchpoints", event.touchpointId, "statuses")),
    getDocs(query(collection(db, "users", currentUser.uid, "events"), where("promotionId", "==", event.promotionId), where("touchpointId", "==", event.touchpointId))),
  ]);
  const allResolved = statusSnapshot.docs.every((statusDoc) => {
    const statusData = statusDoc.data() || {};
    return statusData.completed === true || statusData.status === "skipped";
  });

  const containerEvent = eventSnapshot.docs
    .map((docItem) => ({ id: docItem.id, ...docItem.data() }))
    .find((entry) => entry.type === "promotion_touchpoint");

  if (containerEvent) {
    await updateDoc(doc(db, "users", currentUser.uid, "events", containerEvent.id), {
      completed: allResolved,
      archived: allResolved,
      status: allResolved ? "completed" : "open",
      updatedAt: serverTimestamp(),
    });
  }

  await reconcilePromotionLeadProgressFromStatuses({
    promotionId: event.promotionId,
    leadId,
    completedAt: new Date(),
  });
}

async function reconcilePromotionLeadProgress(event, eventId) {
  if (event?.type === "promotion_touchpoint") return;

  const siblingSnapshot = await getDocs(
    query(collection(db, "users", currentUser.uid, "events"), where("promotionId", "==", event.promotionId), where("leadId", "==", event.leadId))
  );
  const siblings = siblingSnapshot.docs.map((docItem) => ({ id: docItem.id, ...docItem.data() }));
  const remaining = siblings.filter((item) => item.id !== eventId && !item.completed && item.status !== "skipped");
  const completedSiblings = siblings.filter((item) => item.completed);

  const snapshotRef = doc(db, "users", currentUser.uid, "promotions", event.promotionId, "snapshots", event.leadId);
  const snapshotDoc = await getDoc(snapshotRef);
  const snapshot = snapshotDoc.exists() ? snapshotDoc.data() || {} : null;

  if (snapshot?.addedViaSnapActive === true) {
    const completedTouchpointCount = completedSiblings.length;
    await updateDoc(snapshotRef, {
      completedTouchpointCount,
      zeroTouchpointsCompleted: completedTouchpointCount === 0,
      lastCompletedPromotionTouchpointAt: completedTouchpointCount
        ? serverTimestamp()
        : snapshot.lastCompletedPromotionTouchpointAt || null,
      updatedAt: serverTimestamp(),
    });
  }

  if (remaining.length === 0 && event.leadId) {
    const leadRef = doc(db, "users", currentUser.uid, "leads", event.leadId);
    const [leadSnapshot, pipelineSettings] = await Promise.all([getDoc(leadRef), getPipelineSettings(currentUser.uid)]);
    if (leadSnapshot.exists()) {
      const completedAt = toDate(event.completedAt) || new Date();
      const promotionRef = doc(db, "users", currentUser.uid, "promotions", event.promotionId);
      const promotionSnapshot = await getDoc(promotionRef);
      const promotionEndDate = promotionSnapshot.exists() ? toPromotionDate(promotionSnapshot.data()?.endDate) : null;
      const completionAnchor = promotionEndDate || completedAt;
      await completeLeadStage({
        userId: currentUser.uid,
        leadRef,
        lead: leadSnapshot.data(),
        leadSource: "leads",
        pipelineSettings,
        completedAt: completionAnchor,
        actionSource: "promotion_touchpoint",
      });

      if (snapshotDoc.exists()) {
        await updateDoc(snapshotRef, {
          promotionResolvedAt: serverTimestamp(),
          lastCompletedPromotionTouchpointAt: toDate(event.completedAt) ? Timestamp.fromDate(toDate(event.completedAt)) : serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }
  }
}

async function markPromotionEventDone(eventId) {
  const eventRef = doc(db, "users", currentUser.uid, "events", eventId);
  const eventSnapshot = await getDoc(eventRef);
  if (!eventSnapshot.exists()) return;

  const event = { id: eventSnapshot.id, ...eventSnapshot.data() };
  if (event.type === "promotion_touchpoint") return;
  if (event.completed || event.status === "skipped") return;

  const completedAt = new Date();
  await updateDoc(eventRef, {
    completed: true,
    archived: true,
    status: "completed",
    completedAt: Timestamp.fromDate(completedAt),
    updatedAt: serverTimestamp(),
  });

  await reconcilePromotionLeadProgress({ ...event, completedAt }, eventId);
}

async function markPromotionEventSkipped(eventId) {
  const eventRef = doc(db, "users", currentUser.uid, "events", eventId);
  const eventSnapshot = await getDoc(eventRef);
  if (!eventSnapshot.exists()) return;

  const event = { id: eventSnapshot.id, ...eventSnapshot.data() };
  if (event.type === "promotion_touchpoint") return;
  if (event.completed || event.status === "skipped") return;

  await updateDoc(eventRef, {
    status: "skipped",
    archived: true,
    completed: false,
    skippedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await reconcilePromotionLeadProgress(event, eventId);
}

function detectTemplateVariables(templateConfig = {}) {
  const text = [templateConfig.subjectText, templateConfig.introText, templateConfig.bodyText, templateConfig.outroText]
    .map((entry) => String(entry || ""))
    .join("\n");
  const matches = text.match(/\{[^}]+\}|\[Name\]/g) || [];
  return [...new Set(matches)];
}

async function renderPromotionEventDetail(eventId) {
  renderLoading("Loading promotion event...");
  const route = routeFromHash();
  const originRoute = getCurrentRouteOrigin(route.params);

  const eventRef = doc(db, "users", currentUser.uid, "events", eventId);
  const eventSnapshot = await getDoc(eventRef);
  if (!eventSnapshot.exists()) {
    viewContainer.innerHTML = '<p class="view-message">Promotion event not found.</p>';
    return;
  }

  const event = { id: eventSnapshot.id, ...eventSnapshot.data() };

  if (event.type === "promotion_touchpoint") {
    const promotionRef = doc(db, "users", currentUser.uid, "promotions", event.promotionId);
    const promotionSnapshot = await getDoc(promotionRef);
    if (!promotionSnapshot.exists()) {
      viewContainer.innerHTML = '<p class="view-message">Promotion not found.</p>';
      return;
    }

    const promotion = { id: promotionSnapshot.id, ...promotionSnapshot.data() };
    const touchpoint = (Array.isArray(promotion.touchpoints) ? promotion.touchpoints : []).find((entry) => entry.id === event.touchpointId);
    if (!touchpoint) {
      viewContainer.innerHTML = '<p class="view-message">Touchpoint not found.</p>';
      return;
    }

    const leadIds = Array.isArray(promotion.leadIds) ? promotion.leadIds : [];
    const [leadsSnapshot, contactsSnapshot, statusesSnapshot] = await Promise.all([
      getDocs(collection(db, "users", currentUser.uid, "leads")),
      getDocs(collection(db, "users", currentUser.uid, "contacts")),
      getDocs(collection(db, "users", currentUser.uid, "promotions", event.promotionId, "touchpoints", event.touchpointId, "statuses")),
    ]);

    const leadsById = leadsSnapshot.docs.reduce((acc, leadDoc) => {
      acc[leadDoc.id] = { id: leadDoc.id, ...leadDoc.data() };
      return acc;
    }, {});
    const contactsById = contactsSnapshot.docs.reduce((acc, contactDoc) => {
      acc[contactDoc.id] = { id: contactDoc.id, ...contactDoc.data() };
      return acc;
    }, {});
    const statusesByLeadId = statusesSnapshot.docs.reduce((acc, statusDoc) => {
      acc[statusDoc.id] = { id: statusDoc.id, ...statusDoc.data() };
      return acc;
    }, {});

    const templateConfig = normalizePromotionTemplateConfig(touchpoint.templateConfig || touchpoint.template || event.templateConfig || {});

    const leadCards = leadIds.map((leadId) => {
      const lead = leadsById[leadId] || {};
      const contact = contactsById[lead.contactId] || {};
      const name = contact.name || lead.name || "Unnamed";
      const mailBody = renderTemplateWithLead(templateConfig, name).trim();
      const mailTo = String(contact.email || "").trim();
      const status = statusesByLeadId[leadId] || {};
      const isCompleted = status.completed || status.status === "completed" || status.status === "skipped";
      const stateLabel = status.status === "skipped" ? "Skipped" : isCompleted ? "Done" : "Open";
      return {
        isCompleted,
        markup: `<article class="promo-touchpoint-lead-card panel panel--lead ${isCompleted ? "promo-touchpoint-lead-card--completed" : ""}" ${lead.id ? `data-promo-lead-card="${escapeHtml(lead.id)}" tabindex="0" role="button"` : ""}><div class="promo-touchpoint-lead-meta"><p class="promo-touchpoint-lead-name">${escapeHtml(name)}</p><p class="promo-touchpoint-lead-detail">${escapeHtml(lead.product || "No product")}</p><p class="promo-touchpoint-lead-status">Status: ${escapeHtml(stateLabel)}</p></div><div class="promo-touchpoint-lead-actions" aria-label="Lead actions"><div class="promo-touchpoint-action-group"><button type="button" class="secondary-btn" data-promo-open-mail="${leadId}" ${mailTo ? `data-mail-to="${escapeHtml(mailTo)}"` : "disabled"} data-mail-subject="${escapeHtml(templateConfig.subjectText || "")}" data-mail-body="${escapeHtml(mailBody)}">Open Mail</button><button type="button" class="secondary-btn" data-copy-text="${escapeHtml(mailBody)}">Copy</button></div><div class="promo-touchpoint-action-divider" aria-hidden="true"></div><div class="promo-touchpoint-action-group"><button type="button" class="secondary-btn" data-promo-touchpoint-done="${leadId}" ${isCompleted ? "disabled" : ""}>Done</button><button type="button" class="secondary-btn" data-promo-touchpoint-skip="${leadId}" ${isCompleted ? "disabled" : ""}>Skip</button></div></div></article>`
      };
    });

    const activeLeadMarkup = leadCards.filter((entry) => !entry.isCompleted).map((entry) => entry.markup).join("");
    const completedLeadMarkup = leadCards.filter((entry) => entry.isCompleted).map((entry) => entry.markup).join("");

    const mailPreview = renderTemplateWithLead(templateConfig, contact?.name || "").trim();

    viewContainer.innerHTML = `
      <section class="crm-view crm-view--promotions">
        <div class="view-header">
          <h2>${escapeHtml(event.title || event.name || `${promotion.name || "Promotion"} — ${touchpoint.name || "Touchpoint"}`)}</h2>
          <div class="view-header-actions">
            <button id="back-dashboard-btn" type="button" class="secondary-btn">Back</button>
          </div>
        </div>
        <div class="panel panel--sequence detail-grid feed-item--sequence">
          <p><strong>Promotion:</strong> ${escapeHtml(promotion.name || "Untitled promo")}</p>
          <p><strong>Touchpoint:</strong> ${escapeHtml(touchpoint.name || "Touchpoint")}</p>
          <p><strong>Due:</strong> ${formatDate(event.scheduledFor)}</p>
        </div>
        <div class="panel panel--lead notes-panel">
          <label class="full-width">Template Preview<textarea rows="5" readonly>${escapeHtml(mailPreview)}</textarea></label>
          <div class="promo-touchpoint-leads-wrap">
            <div class="promo-touchpoint-lead-section">
              <h3>Active</h3>
              <div class="promo-touchpoint-lead-list">${activeLeadMarkup || '<p class="view-message">No active leads in this touchpoint.</p>'}</div>
            </div>
            <div class="promo-touchpoint-lead-section promo-touchpoint-lead-section--completed">
              <h3>Completed</h3>
              <div class="promo-touchpoint-lead-list">${completedLeadMarkup || '<p class="view-message">No completed leads yet.</p>'}</div>
            </div>
          </div>
        </div>
      </section>
    `;

    document.getElementById("back-dashboard-btn")?.addEventListener("click", () => {
      window.location.hash = originRoute || "#dashboard";
    });

    document.querySelectorAll("[data-promo-lead-card]").forEach((cardEl) => {
      const leadId = cardEl.dataset.promoLeadCard;
      if (!leadId) return;
      const openLead = () => {
        window.location.hash = appendOriginToHash(`#lead/${encodeURIComponent(leadId)}`, originRoute);
      };
      cardEl.addEventListener("click", () => {
        openLead();
      });
      cardEl.addEventListener("keydown", (keyboardEvent) => {
        if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
        keyboardEvent.preventDefault();
        openLead();
      });
    });

    document.querySelectorAll(".promo-touchpoint-lead-actions button").forEach((buttonEl) => {
      buttonEl.addEventListener("click", (clickEvent) => {
        clickEvent.stopPropagation();
      });
    });

    document.querySelectorAll("[data-promo-open-mail]").forEach((buttonEl) => {
      buttonEl.addEventListener("click", () => {
        const to = buttonEl.dataset.mailTo || "";
        if (!to) return;
        const subject = encodeURIComponent(buttonEl.dataset.mailSubject || "");
        const body = encodeURIComponent(buttonEl.dataset.mailBody || "");
        window.open(`mailto:${encodeURIComponent(to)}?subject=${subject}&body=${body}`, "_blank");
      });
    });

    document.querySelectorAll("[data-promo-touchpoint-done]").forEach((buttonEl) => {
      buttonEl.addEventListener("click", async () => {
        const leadId = buttonEl.dataset.promoTouchpointDone;
        if (!leadId) return;
        await markPromotionTouchpointLeadStatus({ event, leadId, status: "completed" });
        await renderPromotionEventDetail(eventId);
      });
    });

    document.querySelectorAll("[data-promo-touchpoint-skip]").forEach((buttonEl) => {
      buttonEl.addEventListener("click", async () => {
        const leadId = buttonEl.dataset.promoTouchpointSkip;
        if (!leadId) return;
        await markPromotionTouchpointLeadStatus({ event, leadId, status: "skipped" });
        await renderPromotionEventDetail(eventId);
      });
    });

    attachClipboardHandlers(viewContainer);
    return;
  }

  const [contactSnapshot, leadSnapshot] = await Promise.all([
    event.contactId ? getDoc(doc(db, "users", currentUser.uid, "contacts", event.contactId)) : Promise.resolve(null),
    event.leadId ? getDoc(doc(db, "users", currentUser.uid, "leads", event.leadId)) : Promise.resolve(null),
  ]);
  const contact = contactSnapshot?.exists?.() ? { id: contactSnapshot.id, ...contactSnapshot.data() } : null;
  const lead = leadSnapshot?.exists?.() ? { id: leadSnapshot.id, ...leadSnapshot.data() } : null;
  const templateConfig = normalizePromotionTemplateConfig(event.templateConfig || event.template || {});
  const mailBody = renderTemplateWithLead(templateConfig, contact?.name || "").trim();
  const mailTo = String(contact?.email || "").trim();

  viewContainer.innerHTML = `
    <section class="crm-view crm-view--leads">
      <div class="view-header">
        <h2>Promotion Event</h2>
        <div class="view-header-actions">
          <button id="back-dashboard-btn" type="button" class="secondary-btn">Back</button>
        </div>
      </div>
      <div class="panel panel--sequence detail-grid feed-item--sequence">
        <p><strong>Lead:</strong> ${escapeHtml(contact?.name || "Unnamed Contact")}</p>
        <p><strong>Promotion:</strong> ${escapeHtml(event.touchpointName || event.name || "Promotion touchpoint")}</p>
        <p><strong>Due:</strong> ${formatDate(event.scheduledFor)}</p>
      </div>
      <div class="panel panel--lead notes-panel">
        <h3>Template</h3>
        <label class="full-width">Subject
          <input value="${escapeHtml(templateConfig.subjectText || "")}" readonly />
        </label>
        <label class="full-width">Intro
          <textarea rows="2" readonly>${escapeHtml(templateConfig.introText || "")}</textarea>
        </label>
        <label class="full-width">Body
          <textarea rows="6" readonly>${escapeHtml(templateConfig.bodyText || "")}</textarea>
        </label>
        <label class="full-width">Outro
          <textarea rows="2" readonly>${escapeHtml(templateConfig.outroText || "")}</textarea>
        </label>
        <div class="button-row full-width">
          <button id="promotion-open-mail-btn" type="button" ${mailTo ? `data-mail-to="${escapeHtml(mailTo)}"` : "disabled"} data-mail-subject="${escapeHtml(templateConfig.subjectText || "")}" data-mail-body="${escapeHtml(mailBody)}">Open in mail</button>
          <button id="promotion-done-btn" type="button" class="secondary-btn">Done</button>
          ${lead ? `<a href="#lead/${encodeURIComponent(lead.id)}" class="timeline-link-pill">Open lead</a>` : ""}
        </div>
      </div>
    </section>
  `;

  document.getElementById("back-dashboard-btn")?.addEventListener("click", () => {
    window.location.hash = originRoute || "#dashboard";
  });

  document.getElementById("promotion-done-btn")?.addEventListener("click", async () => {
    await markPromotionEventDone(eventId);
    window.location.hash = originRoute || "#dashboard";
  });

  document.getElementById("promotion-open-mail-btn")?.addEventListener("click", () => {
    const button = document.getElementById("promotion-open-mail-btn");
    const to = button?.dataset.mailTo || "";
    if (!to) return;
    const subject = encodeURIComponent(button?.dataset.mailSubject || "");
    const body = encodeURIComponent(button?.dataset.mailBody || "");
    window.open(`mailto:${encodeURIComponent(to)}?subject=${subject}&body=${body}`, "_blank");
  });
}

async function renderPromotionDetail(promotionId) {
  renderLoading("Loading promotion...");
  const promotionRef = doc(db, "users", currentUser.uid, "promotions", promotionId);
  const promotionSnapshot = await getDoc(promotionRef);
  if (!promotionSnapshot.exists()) {
    viewContainer.innerHTML = '<p class="view-message">Promotion not found.</p>';
    return;
  }

  const promotion = { id: promotionSnapshot.id, ...promotionSnapshot.data() };
  const [eventsSnapshot, leadsSnapshot, contactsSnapshot] = await Promise.all([
    getDocs(query(collection(db, "users", currentUser.uid, "events"), where("promotionId", "==", promotionId))),
    getDocs(collection(db, "users", currentUser.uid, "leads")),
    getDocs(collection(db, "users", currentUser.uid, "contacts")),
  ]);

  const leadsById = leadsSnapshot.docs.reduce((acc, leadDoc) => {
    acc[leadDoc.id] = { id: leadDoc.id, ...leadDoc.data() };
    return acc;
  }, {});
  const contactsById = contactsSnapshot.docs.reduce((acc, contactDoc) => {
    acc[contactDoc.id] = { id: contactDoc.id, ...contactDoc.data() };
    return acc;
  }, {});

  const events = eventsSnapshot.docs.map((eventDoc) => ({ id: eventDoc.id, ...eventDoc.data() }));
  const touchpoints = Array.isArray(promotion.touchpoints) ? promotion.touchpoints : [];
  const previewState = {};
  const statusesByTouchpoint = {};
  await Promise.all(
    touchpoints.map(async (touchpoint) => {
      const statusSnapshot = await getDocs(collection(db, "users", currentUser.uid, "promotions", promotionId, "touchpoints", touchpoint.id, "statuses"));
      statusesByTouchpoint[touchpoint.id] = statusSnapshot.docs.reduce((acc, statusDoc) => {
        acc[statusDoc.id] = { id: statusDoc.id, ...statusDoc.data() };
        return acc;
      }, {});
    })
  );

  const touchpointMarkup = touchpoints.map((touchpoint, index) => {
    const touchpointEvents = events
      .filter((event) => event.touchpointId === touchpoint.id)
      .sort((a, b) => (toDate(a.scheduledFor)?.getTime() || 0) - (toDate(b.scheduledFor)?.getTime() || 0));
    const legacyLeadEvents = touchpointEvents.filter((event) => Boolean(event.leadId));
    const touchpointStatuses = statusesByTouchpoint[touchpoint.id] || {};
    const templateConfig = normalizePromotionTemplateConfig(touchpoint.templateConfig || touchpoint.template || {});
    const variables = detectTemplateVariables(templateConfig);
    const leadOptions = legacyLeadEvents.length
      ? legacyLeadEvents.map((event) => {
        const lead = leadsById[event.leadId] || {};
        const contact = contactsById[lead.contactId] || {};
        return { event, lead, contact, name: contact.name || lead.name || "Unnamed" };
      })
      : (Array.isArray(promotion.leadIds) ? promotion.leadIds : []).map((leadId) => {
        const lead = leadsById[leadId] || {};
        const contact = contactsById[lead.contactId] || {};
        const status = touchpointStatuses[leadId] || {};
        return {
          event: {
            id: `${promotionId}:${touchpoint.id}:${leadId}`,
            leadId,
            status: status.status || "open",
            completed: status.completed === true,
            touchpointId: touchpoint.id,
          },
          lead,
          contact,
          name: contact.name || lead.name || "Unnamed",
        };
      });
    const previewLeadId = leadOptions[0]?.event?.leadId || "";
    previewState[touchpoint.id] = previewLeadId;

    const rowsMarkup = leadOptions.length
      ? leadOptions.map(({ event, lead, contact, name }) => {
        const mailBody = renderTemplateWithLead(templateConfig, name).trim();
        const mailTo = String(contact.email || "").trim();
        const stateLabel = event.status === "skipped" ? "Skipped" : event.completed ? "Done" : "Open";
        return `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(lead.product || "-")}</td><td>${escapeHtml(stateLabel)}</td><td><div class="button-row"><button type="button" class="secondary-btn" data-promo-open-mail="${event.id}" ${mailTo ? `data-mail-to="${escapeHtml(mailTo)}"` : "disabled"} data-mail-subject="${escapeHtml(templateConfig.subjectText || "")}" data-mail-body="${escapeHtml(mailBody)}">Open Mail</button><button type="button" class="secondary-btn" data-copy-text="${escapeHtml(mailBody)}">Copy</button><button type="button" class="secondary-btn" data-promo-touchpoint-done="${event.id}" ${event.completed || event.status === "skipped" ? "disabled" : ""}>Done</button><button type="button" class="secondary-btn" data-promo-touchpoint-skip="${event.id}" ${event.completed || event.status === "skipped" ? "disabled" : ""}>Skip</button></div></td></tr>`;
      }).join("")
      : '<tr><td colspan="4">No leads in this touchpoint.</td></tr>';

    const previewLead = leadOptions.find((entry) => entry.event.leadId === previewLeadId) || leadOptions[0];
    const previewName = previewLead?.name || "";
    const personalizedPreview = renderTemplateWithLead(templateConfig, previewName).trim();

    return `<details class="panel" open><summary><strong>${escapeHtml(touchpoint.name || `Touchpoint ${index + 1}`)}</strong> · ${escapeHtml(`Touchpoint ${index + 1} of ${touchpoints.length}`)}</summary><p><strong>Due:</strong> ${formatDate(toPromotionDate(promotion.endDate) ? Timestamp.fromDate(new Date(toPromotionDate(promotion.endDate).getTime() - (Number(touchpoint.offsetDays) || 0) * 86400000)) : null)}</p><p><strong>Template Variables:</strong> ${variables.length ? escapeHtml(variables.join(", ")) : "None"}</p><label>Preview As… <select data-preview-touchpoint="${touchpoint.id}">${leadOptions.map((entry) => `<option value="${entry.event.leadId}">${escapeHtml(entry.name)}</option>`).join("")}</select></label><label class="full-width">Base Template Preview<textarea rows="5" readonly>${escapeHtml(renderTemplateWithLead(templateConfig, "").trim())}</textarea></label><label class="full-width">Preview Output<textarea rows="5" readonly data-preview-output="${touchpoint.id}">${escapeHtml(personalizedPreview)}</textarea></label><div class="table-wrap"><table><thead><tr><th>Lead</th><th>Product</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rowsMarkup}</tbody></table></div></details>`;
  }).join("");

  viewContainer.innerHTML = `<section class="crm-view crm-view--promotions"><div class="view-header"><h2>${escapeHtml(promotion.name || "Promotion")}</h2><div class="view-header-actions"><button id="promotion-back-btn" type="button" class="secondary-btn">Back</button><button id="promotion-edit-btn" type="button" class="secondary-btn">Edit</button></div></div><div class="panel detail-grid panel--promo-summary"><p><strong>End Date:</strong> ${formatDate(promotion.endDate)}</p><p><strong>Cohort Size:</strong> ${Array.isArray(promotion.leadIds) ? promotion.leadIds.length : 0}</p><p><strong>Status:</strong> ${escapeHtml(promotion.status || "active")}</p></div><div class="promotion-touchpoints-stack">${touchpointMarkup || '<p class="view-message">No touchpoints configured.</p>'}</div></section>`;

  document.getElementById("promotion-back-btn")?.addEventListener("click", () => { window.location.hash = "#promotions"; });
  document.getElementById("promotion-edit-btn")?.addEventListener("click", () => {
    window.location.hash = `#promotions?edit=${encodeURIComponent(promotion.id)}`;
  });

  document.querySelectorAll("[data-preview-touchpoint]").forEach((selectEl) => {
    selectEl.addEventListener("change", () => {
      const touchpointId = selectEl.dataset.previewTouchpoint;
      if (!touchpointId) return;
      const touchpoint = touchpoints.find((entry) => entry.id === touchpointId);
      if (!touchpoint) return;
      const templateConfig = normalizePromotionTemplateConfig(touchpoint.templateConfig || touchpoint.template || {});
      const leadId = selectEl.value;
      const lead = leadsById[leadId] || {};
      const contact = contactsById[lead.contactId] || {};
      const outputEl = document.querySelector(`[data-preview-output="${touchpointId}"]`);
      if (outputEl) outputEl.value = renderTemplateWithLead(templateConfig, contact.name || lead.name || "").trim();
    });
  });

  document.querySelectorAll("[data-promo-open-mail]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", () => {
      const to = buttonEl.dataset.mailTo || "";
      if (!to) return;
      const subject = encodeURIComponent(buttonEl.dataset.mailSubject || "");
      const body = encodeURIComponent(buttonEl.dataset.mailBody || "");
      window.open(`mailto:${encodeURIComponent(to)}?subject=${subject}&body=${body}`, "_blank");
    });
  });

  document.querySelectorAll("[data-promo-touchpoint-done]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", async () => {
      const eventId = buttonEl.dataset.promoTouchpointDone;
      if (!eventId) return;
      if (eventId.includes(":")) {
        const [, touchpointId, leadId] = eventId.split(":");
        const containerEvent = events.find((entry) => entry.touchpointId === touchpointId && entry.type === "promotion_touchpoint") || { promotionId, touchpointId };
        await markPromotionTouchpointLeadStatus({ event: containerEvent, leadId, status: "completed" });
      } else {
        await markPromotionEventDone(eventId);
      }
      await renderPromotionDetail(promotionId);
    });
  });

  document.querySelectorAll("[data-promo-touchpoint-skip]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", async () => {
      const eventId = buttonEl.dataset.promoTouchpointSkip;
      if (!eventId) return;
      if (eventId.includes(":")) {
        const [, touchpointId, leadId] = eventId.split(":");
        const containerEvent = events.find((entry) => entry.touchpointId === touchpointId && entry.type === "promotion_touchpoint") || { promotionId, touchpointId };
        await markPromotionTouchpointLeadStatus({ event: containerEvent, leadId, status: "skipped" });
      } else {
        await markPromotionEventSkipped(eventId);
      }
      await renderPromotionDetail(promotionId);
    });
  });

  attachClipboardHandlers(viewContainer);
}

async function renderPromotionsPage() {
  renderLoading("Loading promotions...");
  const appSettings = await getAppSettings(currentUser.uid);
  const snapWindowDays = appSettings.snapWindowDays || 2;
  const pipelineStages = appSettings.pipeline?.stages || [];
  const [promotionsSnapshot, leadsSnapshot, contactsSnapshot] = await Promise.all([
    getDocs(query(collection(db, "users", currentUser.uid, "promotions"), orderBy("createdAt", "desc"))),
    getDocs(collection(db, "users", currentUser.uid, "leads")),
    getDocs(collection(db, "users", currentUser.uid, "contacts")),
  ]);

  const contactsById = contactsSnapshot.docs.reduce((acc, entry) => {
    acc[entry.id] = { id: entry.id, ...entry.data() };
    return acc;
  }, {});

  const leads = leadsSnapshot.docs.map((leadDoc) => {
    const lead = { id: leadDoc.id, ...leadDoc.data() };
    const contact = contactsById[lead.contactId] || {};
    return { ...lead, name: contact.name || lead.name || "", product: lead.product || "" };
  }).filter((lead) => isActiveRecord(lead));

  const promotions = promotionsSnapshot.docs.map((promoDoc) => ({ id: promoDoc.id, ...promoDoc.data() }));
  const now = new Date();
  const active = promotions.filter((promo) => {
    const endDate = toPromotionDate(promo.endDate);
    return endDate && endDate.getTime() >= now.getTime();
  }).sort((a, b) => {
    const delta = (toPromotionDate(a.endDate)?.getTime() || 0) - (toPromotionDate(b.endDate)?.getTime() || 0);
    if (delta !== 0) return delta;
    return (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0);
  });

  const finished = promotions.filter((promo) => {
    const endDate = toPromotionDate(promo.endDate);
    return endDate && endDate.getTime() < now.getTime();
  }).sort((a, b) => (toPromotionDate(b.endDate)?.getTime() || 0) - (toPromotionDate(a.endDate)?.getTime() || 0));

  const renderCards = (items) => items.length ? items.map((promo) => `<article class="panel panel--promo feed-item-clickable promotion-list-card" data-open-promotion="${promo.id}" tabindex="0" role="button"><p class="feed-type">Promotion</p><h3>${escapeHtml(promo.name || "Untitled promo")}</h3><p><strong>Ends:</strong> ${formatDate(promo.endDate)}</p><p><strong>Cohort:</strong> ${Array.isArray(promo.leadIds) ? promo.leadIds.length : 0}</p></article>`).join("") : `<p class="view-message">No promotions.</p>`;

  viewContainer.innerHTML = `
    <section class="crm-view crm-view--promotions">
      <div class="view-header"><h2>Promotions</h2></div>
      <div class="panel panel--promo-actions"><button id="new-promo-btn" class="full-width" type="button">New Promotion</button></div>
      <div class="panel panel--promo-section"><h3>Active</h3><div class="promotion-list-grid">${renderCards(active)}</div></div>
      <div class="panel panel--promo-section"><h3>Finished</h3><div class="promotion-list-grid">${renderCards(finished)}</div></div>
    </section>
  `;

  document.getElementById("new-promo-btn")?.addEventListener("click", () => {
    renderPromotionCreateFlow({ snapWindowDays, pipelineStages, pipelineDayStartTime: appSettings.pipeline?.dayStartTime || "09:00", leads, promotions });
  });

  const route = routeFromHash();
  const editPromotionId = route.params?.get("edit") || "";
  if (editPromotionId) {
    const editablePromotion = promotions.find((promo) => promo.id === editPromotionId);
    if (editablePromotion) {
      renderPromotionCreateFlow({ snapWindowDays, pipelineStages, pipelineDayStartTime: appSettings.pipeline?.dayStartTime || "09:00", leads, promotions, existingPromotion: editablePromotion });
      return;
    }
  }

  viewContainer.querySelectorAll("[data-open-promotion]").forEach((itemEl) => {
    const open = () => {
      const promoId = itemEl.dataset.openPromotion;
      if (!promoId) return;
      window.location.hash = `#promotion/${promoId}`;
    };
    itemEl.addEventListener("click", open);
    itemEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
}

function toDateTimeLocalInputValue(value) {
  const date = toPromotionDate(value);
  if (!date) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function buildPromotionTouchpointState(inputTouchpoint = {}, index = 0) {
  const order = Number.isInteger(inputTouchpoint?.order) ? inputTouchpoint.order : index;
  const templateConfig = normalizePromotionTemplateConfig(inputTouchpoint.templateConfig || inputTouchpoint.template || {});
  return {
    id: String(inputTouchpoint.id || `tp-${index + 1}`),
    name: String(inputTouchpoint.name || `Touchpoint ${order + 1}`),
    order,
    offsetDays: Number.parseInt(inputTouchpoint.offsetDays, 10) || 0,
    templateConfig,
    template: toPromotionTemplatePayload(templateConfig),
  };
}

function buildPromotionTouchpointMarkup(touchpoint, index) {
  const template = normalizePromotionTemplateConfig(touchpoint.templateConfig || touchpoint.template || {});
  return `<div class="panel detail-grid"><label>Touchpoint name<input data-touchpoint-name="${index}" value="${escapeHtml(touchpoint.name || `Touchpoint ${index + 1}`)}" /></label><label>Notify Leads <input type="number" min="0" data-touchpoint-offset="${index}" value="${touchpoint.offsetDays}" /> days before end of promo</label><label>Subject<input data-touchpoint-subject="${index}" value="${escapeHtml(template.subjectText)}" /></label><label>Intro<input data-touchpoint-intro="${index}" value="${escapeHtml(template.introText)}" /></label><label class="template-checkbox-row"><input type="checkbox" data-touchpoint-populate-name="${index}" ${template.populateName ? "checked" : ""} /><span>Populate name</span></label><label>Body<textarea rows="4" data-touchpoint-body="${index}">${escapeHtml(template.bodyText)}</textarea></label><label>Outro<input data-touchpoint-outro="${index}" value="${escapeHtml(template.outroText)}" /></label></div>`;
}

function syncPromotionTouchpointsFromForm(touchpoints = []) {
  return touchpoints.map((touchpoint, index) => {
    const templateConfig = normalizePromotionTemplateConfig({
      subjectText: document.querySelector(`[data-touchpoint-subject="${index}"]`)?.value || "",
      introText: document.querySelector(`[data-touchpoint-intro="${index}"]`)?.value || "",
      populateName: document.querySelector(`[data-touchpoint-populate-name="${index}"]`)?.checked === true,
      bodyText: document.querySelector(`[data-touchpoint-body="${index}"]`)?.value || "",
      outroText: document.querySelector(`[data-touchpoint-outro="${index}"]`)?.value || "",
    });

    return {
      ...touchpoint,
      name: String(document.querySelector(`[data-touchpoint-name="${index}"]`)?.value || touchpoint.name || `Touchpoint ${index + 1}`),
      order: index,
      offsetDays: Number.parseInt(document.querySelector(`[data-touchpoint-offset="${index}"]`)?.value || touchpoint.offsetDays, 10) || 0,
      templateConfig,
      template: toPromotionTemplatePayload(templateConfig),
    };
  });
}

function buildPromotionWizardTouchpointMarkup(touchpoint, index) {
  const template = normalizePromotionTemplateConfig(touchpoint.templateConfig || touchpoint.template || {});
  const touchpointLabel = index === 0 ? "Primary message" : `Reminder ${index}`;
  return `<article class="panel detail-grid promotion-wizard-message-card"><p class="promotion-wizard-card-title"><strong>${escapeHtml(touchpointLabel)}</strong></p><label class="promotion-wizard-timing-sentence">Send this message <input class="promotion-wizard-offset-input" type="number" min="0" data-touchpoint-offset="${index}" value="${touchpoint.offsetDays}" /> days before this promotion ends.</label><label>Subject<input data-touchpoint-subject="${index}" value="${escapeHtml(template.subjectText)}" /></label><label>Intro<input data-touchpoint-intro="${index}" value="${escapeHtml(template.introText)}" /></label><label class="template-checkbox-row"><input type="checkbox" data-touchpoint-populate-name="${index}" ${template.populateName ? "checked" : ""} /><span>Populate name</span></label><label>Body<textarea rows="4" data-touchpoint-body="${index}">${escapeHtml(template.bodyText)}</textarea></label><label>Outro<input data-touchpoint-outro="${index}" value="${escapeHtml(template.outroText)}" /></label></article>`;
}

function renderPromotionCreateFlow({ snapWindowDays, pipelineStages = [], pipelineDayStartTime = "09:00", leads, existingPromotion = null }) {
  const DEFAULT_PROMO_TIME = "08:30";
  const DEFAULT_TOUCHPOINT_OFFSET = 2;

  const state = {
    mode: existingPromotion?.id ? "advanced" : "wizard",
    wizardStep: 1,
    showTimeEditor: false,
    isEdit: Boolean(existingPromotion?.id),
    editingPromotionId: existingPromotion?.id || null,
    name: existingPromotion?.name || "",
    endDate: existingPromotion ? toDateTimeLocalInputValue(existingPromotion.endDate) : "",
    presetKey: existingPromotion?.presetKey || "custom",
    touchpoints: (existingPromotion?.touchpoints || []).map((touchpoint, index) => buildPromotionTouchpointState(touchpoint, index)),
    cohortDraftLeadIds: new Set(existingPromotion?.leadIds || []),
    searchText: "",
    searchResults: [],
    snapModeByLead: { ...(existingPromotion?.snapModeByLead || {}) },
    selectionSourcesByLead: { ...(existingPromotion?.selectionSourcesByLead || {}) },
    snapMatchByLead: { ...(existingPromotion?.snapMatchByLead || {}) },
  };

  const ensureDefaultTouchpoints = () => {
    if (!state.touchpoints.length) {
      state.touchpoints = [buildPromotionTouchpointState({ offsetDays: DEFAULT_TOUCHPOINT_OFFSET, order: 0 }, 0)];
    }
  };

  const ensureDefaultTime = () => {
    if (!state.endDate) return;
    if (!state.endDate.includes("T")) {
      state.endDate = `${state.endDate}T${DEFAULT_PROMO_TIME}`;
      return;
    }
    const [datePart, timePart] = state.endDate.split("T");
    if (!timePart) state.endDate = `${datePart}T${DEFAULT_PROMO_TIME}`;
  };

  const setEndDateFromDateInput = (rawDate) => {
    const datePart = String(rawDate || "").trim();
    if (!datePart) {
      state.endDate = "";
      return;
    }
    const existingTime = state.endDate.includes("T") ? state.endDate.split("T")[1] : "";
    state.endDate = `${datePart}T${existingTime || DEFAULT_PROMO_TIME}`;
  };

  const addLeadsToCohort = (leadList, sourceKey) => {
    leadList.forEach((lead) => {
      state.cohortDraftLeadIds.add(lead.id);
      if (!state.selectionSourcesByLead[lead.id]) state.selectionSourcesByLead[lead.id] = [];
      if (!state.selectionSourcesByLead[lead.id].includes(sourceKey)) state.selectionSourcesByLead[lead.id].push(sourceKey);
      if (sourceKey === "all_active") state.snapModeByLead[lead.id] = "full_active";
      if (sourceKey === "snap_active" && !state.snapModeByLead[lead.id]) state.snapModeByLead[lead.id] = "precision";
    });
  };

  const applyDefaultCohortSelection = () => {
    if (state.isEdit || state.cohortDraftLeadIds.size) return;
    addLeadsToCohort(leads.filter((lead) => isLeadActive(lead)), "all_active");
    const endDate = toPromotionDate(state.endDate);
    if (!endDate) return;
    leads
      .map((lead) => ({ lead, match: findSnapMatch(lead, state.touchpoints, endDate, snapWindowDays, pipelineStages) }))
      .filter((entry) => entry.match)
      .forEach((entry) => {
        addLeadsToCohort([entry.lead], "snap_active");
        state.snapMatchByLead[entry.lead.id] = entry.match;
      });
  };

  ensureDefaultTouchpoints();
  ensureDefaultTime();
  applyDefaultCohortSelection();

  const syncFromAdvancedForm = () => {
    state.name = document.getElementById("promo-name-edit")?.value || state.name;
    state.endDate = document.getElementById("promo-end-edit")?.value || state.endDate;
    state.touchpoints = syncPromotionTouchpointsFromForm(state.touchpoints);
  };

  const syncFromWizardBasics = () => {
    state.name = document.getElementById("promo-name")?.value || state.name;
    setEndDateFromDateInput(document.getElementById("promo-end-date")?.value || "");
    if (state.showTimeEditor) {
      const explicitDateTime = document.getElementById("promo-end-time-edit")?.value || "";
      if (explicitDateTime) state.endDate = explicitDateTime;
    }
    ensureDefaultTime();
  };

  const syncFromWizardTouchpoints = () => {
    state.touchpoints = syncPromotionTouchpointsFromForm(state.touchpoints).map((touchpoint, index) => ({
      ...touchpoint,
      name: touchpoint.name || `Touchpoint ${index + 1}`,
      order: index,
    }));
  };

  const savePromotion = async () => {
    const selectedLeads = leads.filter((lead) => state.cohortDraftLeadIds.has(lead.id));
    if (!selectedLeads.length) return alert("Please select at least one lead.");

    try {
      if (state.isEdit && state.editingPromotionId) {
        const touchpointsPayload = buildPromotionTouchpoints(state.touchpoints);
        const leadIdsPayload = selectedLeads.map((lead) => lead.id);
        await updateDoc(doc(db, "users", currentUser.uid, "promotions", state.editingPromotionId), {
          name: state.name,
          endDate: Timestamp.fromDate(new Date(state.endDate)),
          touchpoints: touchpointsPayload,
          leadIds: leadIdsPayload,
          selectionSourcesByLead: state.selectionSourcesByLead,
          snapModeByLead: state.snapModeByLead,
          snapMatchByLead: state.snapMatchByLead,
          updatedAt: serverTimestamp(),
        });
        await syncPromotionTouchpointContainers({
          db,
          userId: currentUser.uid,
          promotionId: state.editingPromotionId,
          promotion: {
            name: state.name,
            endDate: state.endDate,
            touchpoints: touchpointsPayload,
            leadIds: leadIdsPayload,
          },
        });
        await syncSnappedLeadPromotionPause({
          db,
          userId: currentUser.uid,
          promotionId: state.editingPromotionId,
          endDate: state.endDate,
          pipelineDayStartTime,
        });
        await renderPromotionDetail(state.editingPromotionId);
        return;
      }

      await createPromotion({
        db,
        userId: currentUser.uid,
        promotion: {
          name: state.name,
          endDate: state.endDate,
          touchpoints: buildPromotionTouchpoints(state.touchpoints),
          targeting: Object.keys(state.selectionSourcesByLead),
          presetKey: state.presetKey,
        },
        selectedLeads,
        snapWindowDays,
        pipelineStages,
        pipelineDayStartTime,
        presetLabel: PROMOTION_PRESETS[state.presetKey]?.label || "Custom",
        snapModeByLead: state.snapModeByLead,
        selectionSourcesByLead: state.selectionSourcesByLead,
        snapMatchByLead: state.snapMatchByLead,
      });

      await renderPromotionsPage();
    } catch (error) {
      console.error("Failed to save promotion", error);
      alert(`Could not save promotion: ${error?.message || "Unknown error"}`);
    }
  };

  const draw = () => {
    if (state.mode === "wizard") {
      if (state.wizardStep === 1) {
        const dateOnlyValue = state.endDate ? String(state.endDate).split("T")[0] : "";
        viewContainer.innerHTML = `<section class="crm-view crm-view--promotions"><div class="view-header"><h2>New Promotion</h2></div><div class="panel form-grid promotion-config-panel"><p>Please name your promotion.</p><label>Promo Name<input id="promo-name" value="${escapeHtml(state.name)}" /></label><p>When does it end?</p><label>End Date<input id="promo-end-date" type="date" value="${escapeHtml(dateOnlyValue)}" /></label><button type="button" class="link-btn" id="edit-promo-time-btn">${state.showTimeEditor ? "Hide time" : "Edit time"}</button>${state.showTimeEditor ? `<label>End Time<input id="promo-end-time-edit" type="datetime-local" value="${escapeHtml(state.endDate)}" /></label>` : ""}<div class="button-row promotion-submit-row"><button id="promo-next-basics-btn" type="button">Next</button></div><button type="button" id="open-custom-from-page1" class="link-btn">Create a custom promotion</button></div></section>`;

        document.getElementById("edit-promo-time-btn")?.addEventListener("click", () => {
          syncFromWizardBasics();
          state.showTimeEditor = !state.showTimeEditor;
          draw();
        });

        document.getElementById("promo-next-basics-btn")?.addEventListener("click", () => {
          syncFromWizardBasics();
          if (!state.name.trim() || !state.endDate) return alert("Name and end date are required.");
          state.wizardStep = 2;
          draw();
        });

        document.getElementById("open-custom-from-page1")?.addEventListener("click", () => {
          syncFromWizardBasics();
          state.mode = "advanced";
          draw();
        });
        return;
      }

      if (state.wizardStep === 2) {
        viewContainer.innerHTML = `<section class="crm-view crm-view--promotions"><div class="view-header"><h2>New Promotion</h2></div><div class="panel form-grid promotion-config-panel"><section class="promotion-wizard-block"><p class="promotion-wizard-section-label">When would you like to inform people about this promotion?</p><h3 class="promotion-wizard-main-prompt">What would you like to say to them?</h3><div id="touchpoint-list" class="promotion-touchpoints-stack">${state.touchpoints.map((tp, index) => buildPromotionWizardTouchpointMarkup(tp, index)).join("")}</div><button id="add-touchpoint-btn" class="secondary-btn" type="button">+ Add reminder touchpoint</button></section><div class="button-row promotion-submit-row"><button id="promo-next-message-btn" type="button">Next</button></div></div></section>`;

        document.getElementById("add-touchpoint-btn")?.addEventListener("click", () => {
          syncFromWizardTouchpoints();
          state.touchpoints.push(buildPromotionTouchpointState({ order: state.touchpoints.length, offsetDays: 0 }, state.touchpoints.length));
          draw();
        });

        document.getElementById("promo-next-message-btn")?.addEventListener("click", () => {
          syncFromWizardTouchpoints();
          state.wizardStep = 3;
          draw();
        });
        return;
      }

      const endDate = toPromotionDate(state.endDate);
      const touchpointSummary = state.touchpoints.map((touchpoint, index) => {
        const sendAt = endDate ? new Date(endDate.getTime() - (Number(touchpoint.offsetDays) || 0) * 86400000) : null;
        const template = normalizePromotionTemplateConfig(touchpoint.templateConfig || touchpoint.template || {});
        const snippet = [template.introText, template.bodyText].filter(Boolean).join(" ").trim();
        return `<article class="panel panel--lead"><p><strong>Touchpoint ${index + 1}</strong> · ${escapeHtml(String(touchpoint.offsetDays || 0))} days before end</p><p><strong>Scheduled:</strong> ${escapeHtml(sendAt ? sendAt.toLocaleString() : "-")}</p><p><strong>Subject:</strong> ${escapeHtml(template.subjectText || "(No subject)")}</p><p>${escapeHtml(snippet ? `${snippet.slice(0, 120)}${snippet.length > 120 ? "…" : ""}` : "No preview text yet.")}</p></article>`;
      }).join("");
      const cohortRows = leads.filter((lead) => state.cohortDraftLeadIds.has(lead.id));

      viewContainer.innerHTML = `<section class="crm-view crm-view--promotions"><div class="view-header"><h2>Review Promotion</h2></div><div class="panel form-grid promotion-config-panel"><h3>Recap</h3><p><strong>Name:</strong> ${escapeHtml(state.name || "Untitled promo")}</p><p><strong>Ends:</strong> ${escapeHtml(endDate ? endDate.toLocaleString() : "-")}</p><div class="promotion-touchpoints-stack">${touchpointSummary}</div><h3>Cohort Preview</h3><p>Default cohort: <strong>All Active Leads</strong>. Snap Active behavior applies automatically to leads that qualify in your snap window.</p><p><strong>Selected leads:</strong> ${cohortRows.length}</p><div class="promotion-lead-list">${cohortRows.length ? cohortRows.map((lead) => `<article class="panel panel--lead promotion-lead-list-item"><div><p><strong>${escapeHtml(lead.name || "Unnamed")}</strong></p><p>${escapeHtml(lead.product || "No product")}</p></div><button type="button" class="secondary-btn promotion-inline-remove-btn" data-remove-wizard-lead="${lead.id}" aria-label="Remove ${escapeHtml(lead.name || "lead")} from cohort">Remove</button></article>`).join("") : '<article class="panel panel--lead"><p>No leads selected yet.</p></article>'}</div><div class="button-row promotion-submit-row"><button id="create-promo-btn" type="button">Create Promotion</button></div><button type="button" id="open-custom-from-page3" class="link-btn">Customize cohort / targeting</button></div></section>`;

      document.getElementById("create-promo-btn")?.addEventListener("click", async () => {
        syncFromWizardTouchpoints();
        await savePromotion();
      });

      document.getElementById("open-custom-from-page3")?.addEventListener("click", () => {
        syncFromWizardTouchpoints();
        state.mode = "advanced";
        draw();
      });

      document.querySelectorAll("[data-remove-wizard-lead]").forEach((buttonEl) => {
        buttonEl.addEventListener("click", () => {
          const leadId = buttonEl.dataset.removeWizardLead;
          if (!leadId) return;
          state.cohortDraftLeadIds.delete(leadId);
          delete state.selectionSourcesByLead[leadId];
          delete state.snapModeByLead[leadId];
          delete state.snapMatchByLead[leadId];
          draw();
        });
      });
      return;
    }

    const cohortLeads = leads.filter((lead) => state.cohortDraftLeadIds.has(lead.id));
    viewContainer.innerHTML = `<section class="crm-view crm-view--promotions"><div class="view-header"><h2>${state.isEdit ? "Edit Promotion" : "Promotion Setup"}</h2></div><div class="panel form-grid promotion-config-panel"><h3>Basic Info</h3><label>Promo Name<input id="promo-name-edit" value="${escapeHtml(state.name)}" /></label><label>End Date<input id="promo-end-edit" type="datetime-local" value="${escapeHtml(state.endDate)}" /></label><h3>Touchpoints</h3><div id="touchpoint-list" class="promotion-touchpoints-stack">${state.touchpoints.map((tp, index) => buildPromotionTouchpointMarkup(tp, index)).join("")}</div><button id="add-touchpoint-btn" class="secondary-btn" type="button">Add Touchpoint</button><h3>Add to Cohort</h3><div class="button-row promotion-group-actions"><button type="button" class="secondary-btn" data-add-group="snap_active">Snap Active Leads</button><button type="button" class="secondary-btn" data-add-group="drop_out">Drop Off Leads</button><button type="button" class="secondary-btn" data-add-group="all_active">All Active Leads</button><button type="button" class="secondary-btn" id="clear-cohort-btn">Clear Cohort</button></div><label>Custom Search (additive)<input id="promo-search" value="${escapeHtml(state.searchText)}" placeholder="Name or product" /></label><div id="promo-search-results" class="lead-list promotion-lead-list"></div><h3>Cohort Preview (source of truth)</h3><div id="promo-cohort-preview" class="lead-list promotion-lead-list"></div><div class="button-row promotion-submit-row"><button id="create-promo-btn" type="button">${state.isEdit ? "Save Promotion" : "Create Promotion"}</button>${state.isEdit ? '<button id="delete-promo-btn" type="button" class="secondary-btn danger-btn">Delete Promotion</button>' : ""}</div></div></section>`;

    const renderSearchResults = () => {
      const promotionConfig = { name: state.name, endDate: state.endDate, touchpoints: state.touchpoints, targeting: ["custom_search"] };
      state.searchResults = computeTargetLeads({ leads, promotion: promotionConfig, snapWindowDays, searchText: state.searchText, pipelineStages });
      const listEl = document.getElementById("promo-search-results");
      if (!listEl) return;
      if (!state.searchText.trim()) {
        listEl.innerHTML = '<article class="panel panel--lead"><p>Type to search active and dropped-off leads.</p></article>';
        return;
      }
      if (!state.searchResults.length) {
        listEl.innerHTML = '<article class="panel panel--lead"><p>No matching leads.</p></article>';
        return;
      }
      listEl.innerHTML = state.searchResults.map((lead) => `<article class="panel panel--lead"><p><strong>${escapeHtml(lead.name || "Unnamed")}</strong></p><p>${escapeHtml(lead.product || "No product")}</p><button type="button" class="secondary-btn" data-add-search-lead="${lead.id}">Add to cohort</button></article>`).join("");
      listEl.querySelectorAll("[data-add-search-lead]").forEach((buttonEl) => {
        buttonEl.addEventListener("click", () => {
          const lead = leads.find((entry) => entry.id === buttonEl.dataset.addSearchLead);
          if (!lead) return;
          addLeadsToCohort([lead], "custom_search");
          renderCohortPreview();
        });
      });
    };

    const renderCohortPreview = () => {
      const previewEl = document.getElementById("promo-cohort-preview");
      if (!previewEl) return;
      const rows = leads.filter((lead) => state.cohortDraftLeadIds.has(lead.id));
      if (!rows.length) {
        previewEl.innerHTML = '<article class="panel panel--lead"><p>No leads selected yet.</p></article>';
        return;
      }
      previewEl.innerHTML = rows.map((lead) => `<article class="panel panel--lead"><p><strong>${escapeHtml(lead.name || "Unnamed")}</strong></p><p>${escapeHtml(lead.product || "No product")}</p><small>${escapeHtml((state.selectionSourcesByLead[lead.id] || []).join(", ") || "manual")}</small><button type="button" class="secondary-btn" data-remove-cohort-lead="${lead.id}">Remove</button></article>`).join("");
      previewEl.querySelectorAll("[data-remove-cohort-lead]").forEach((buttonEl) => {
        buttonEl.addEventListener("click", () => {
          const leadId = buttonEl.dataset.removeCohortLead;
          if (!leadId) return;
          state.cohortDraftLeadIds.delete(leadId);
          delete state.selectionSourcesByLead[leadId];
          delete state.snapModeByLead[leadId];
          delete state.snapMatchByLead[leadId];
          renderCohortPreview();
        });
      });
    };

    document.querySelectorAll("[data-add-group]").forEach((buttonEl) => {
      buttonEl.addEventListener("click", () => {
        syncFromAdvancedForm();
        const group = buttonEl.dataset.addGroup;
        const endDateValue = toPromotionDate(state.endDate);
        if (!endDateValue) return;
        let additions = [];
        if (group === "all_active") additions = leads.filter((lead) => isLeadActive(lead));
        if (group === "drop_out") additions = leads.filter((lead) => isLeadDropOutState(lead));
        if (group === "snap_active") {
          const matchedLeads = leads
            .map((lead) => ({
              lead,
              match: findSnapMatch(lead, state.touchpoints, endDateValue, snapWindowDays, pipelineStages),
            }))
            .filter((entry) => entry.match);
          additions = matchedLeads.map((entry) => entry.lead);
          matchedLeads.forEach((entry) => {
            state.snapMatchByLead[entry.lead.id] = entry.match;
          });
        }
        addLeadsToCohort(additions, group || "manual");
        renderCohortPreview();
      });
    });

    document.getElementById("clear-cohort-btn")?.addEventListener("click", () => {
      state.cohortDraftLeadIds = new Set();
      state.selectionSourcesByLead = {};
      state.snapModeByLead = {};
      state.snapMatchByLead = {};
      renderCohortPreview();
    });

    document.getElementById("promo-search")?.addEventListener("input", (event) => {
      state.searchText = String(event.target.value || "");
      renderSearchResults();
    });

    document.getElementById("add-touchpoint-btn")?.addEventListener("click", () => {
      syncFromAdvancedForm();
      state.touchpoints.push(buildPromotionTouchpointState({ order: state.touchpoints.length, offsetDays: 0 }, state.touchpoints.length));
      draw();
    });

    document.getElementById("delete-promo-btn")?.addEventListener("click", async () => {
      if (!state.editingPromotionId) return;
      if (!window.confirm("Delete this promotion? This will remove all associated touchpoint events and restore snapped leads to their original timeline and stage.")) return;
      try {
        await restoreSnappedLeadsAndDeletePromotion({ db, userId: currentUser.uid, promotionId: state.editingPromotionId });
        await renderPromotionsPage();
      } catch (error) {
        console.error("Failed to delete promotion", error);
        alert(`Could not delete promotion: ${error?.message || "Unknown error"}`);
      }
    });

    document.getElementById("create-promo-btn")?.addEventListener("click", async () => {
      syncFromAdvancedForm();
      await savePromotion();
    });

    renderSearchResults();
    renderCohortPreview();
  };

  draw();
}


async function exportSpreadsheetData() {
  const [pipelineSettings, contactsSnapshot, leadsSnapshot] = await Promise.all([
    getPipelineSettings(currentUser.uid),
    getDocs(collection(db, "users", currentUser.uid, "contacts")),
    getDocs(collection(db, "users", currentUser.uid, "leads")),
  ]);

  const contactById = contactsSnapshot.docs.reduce((acc, contactDoc) => {
    const contact = { id: contactDoc.id, ...contactDoc.data() };
    if (isActiveRecord(contact)) acc[contact.id] = contact;
    return acc;
  }, {});

  const leadRows = leadsSnapshot.docs
    .map((leadDoc) => ({ id: leadDoc.id, ...leadDoc.data() }))
    .filter((lead) => isActiveRecord(lead))
    .sort((a, b) => (toDate(a.createdAt)?.getTime() || 0) - (toDate(b.createdAt)?.getTime() || 0));

  const rows = [
    SPREADSHEET_HEADERS,
    ...leadRows.map((lead) => {
      const linkedContact = lead.contactId ? contactById[lead.contactId] : null;
      return [
        formatDateForSpreadsheet(lead.createdAt),
        linkedContact?.name || lead.title || "",
        linkedContact?.email || "",
        linkedContact?.phone || "",
        lead.product || "",
        lead.stageStatus || "pending",
        mapStageIdToStageConcept(pipelineSettings, lead.stageId),
      ];
    }),
  ];

  const csvText = buildCsv(rows);
  const csvBlob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
  const downloadUrl = URL.createObjectURL(csvBlob);
  const linkEl = document.createElement("a");
  linkEl.href = downloadUrl;
  linkEl.download = "smolcrm-spreadsheet.csv";
  document.body.appendChild(linkEl);
  linkEl.click();
  document.body.removeChild(linkEl);
  URL.revokeObjectURL(downloadUrl);
}

async function importSpreadsheetFile(file, pipelineSettings) {
  const fileText = await file.text();
  const rows = parseCsv(fileText);
  if (!rows.length) throw new Error("Spreadsheet is empty.");

  validateSpreadsheetHeaders(rows[0]);

  const firstStageId = pipelineSettings.stages[0]?.id || "stage1";
  let importedCount = 0;
  let skippedCount = 0;

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const normalizedRow = SPREADSHEET_HEADERS.reduce((acc, header, index) => {
      acc[header] = String(row[index] || "").trim();
      return acc;
    }, {});

    const hasAnyContent = Object.values(normalizedRow).some((value) => value);
    if (!hasAnyContent) continue;

    const parsedDate = parseImportDate(normalizedRow["Date Added"]);
    const stageId = mapStageIndexToStageId(pipelineSettings, normalizedRow.Stage, firstStageId);
    const statusValue = String(normalizedRow.Status || "pending").toLowerCase();
    const isValidStatus = statusValue === "pending" || statusValue === "completed";

    if (!parsedDate || !normalizedRow["Contact Name"] || !stageId || !isValidStatus) {
      skippedCount += 1;
      continue;
    }

    await createLeadViaManualFlow({
      pipelineSettings,
      createdAtDate: parsedDate,
      values: {
        selectedContactId: null,
        contactName: normalizedRow["Contact Name"],
        contactEmail: normalizedRow.Email,
        contactPhone: normalizedRow["Phone Number"],
        stageId,
        product: normalizedRow.Product,
        stageStatus: statusValue,
        initialNote: "",
      },
    });

    importedCount += 1;
  }

  return { importedCount, skippedCount };
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
          <label>Snap Window (Days)
            <input name="snapWindowDays" type="number" min="0" step="1" value="${editableSettings.snapWindowDays || 2}" required />
          </label>
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

          <h3>Spreadsheet Import / Export</h3>
          <p class="view-message">Use this format exactly: ${SPREADSHEET_HEADERS.join(", ")}.</p>
          <div class="button-row full-width">
            <button type="button" id="export-spreadsheet-btn" class="secondary-btn">Export Spreadsheet</button>
          </div>
          <label>Import Spreadsheet (.csv)
            <input type="file" id="import-spreadsheet-input" accept=".csv,text/csv" />
          </label>
          <div class="button-row full-width">
            <button type="button" id="import-spreadsheet-btn" class="secondary-btn">Import Spreadsheet</button>
          </div>
        </form>
      </section>
    `;

    const formEl = document.getElementById("pipeline-settings-form");
    const importInputEl = document.getElementById("import-spreadsheet-input");

    document.getElementById("export-spreadsheet-btn")?.addEventListener("click", async () => {
      try {
        await exportSpreadsheetData();
      } catch (error) {
        console.error("Spreadsheet export failed", error);
        alert("Spreadsheet export failed.");
      }
    });

    document.getElementById("import-spreadsheet-btn")?.addEventListener("click", async () => {
      const selectedFile = importInputEl?.files?.[0] || null;
      if (!selectedFile) {
        alert("Select a spreadsheet file first.");
        return;
      }

      try {
        const pipelineSettings = editableSettings.pipeline;
        const importResult = await importSpreadsheetFile(selectedFile, pipelineSettings);
        alert(`Import complete. Imported: ${importResult.importedCount}. Skipped: ${importResult.skippedCount}.`);
        importInputEl.value = "";
      } catch (error) {
        console.error("Spreadsheet import failed", error);
        alert(error.message || "Spreadsheet import failed.");
      }
    });

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
        snapWindowDays: latestSettings.snapWindowDays,
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
        snapWindowDays: Number.parseInt(String(formData.get("snapWindowDays") || editableSettings.snapWindowDays || 2), 10),
      });
      await setDoc(pipelineSettingsRef(currentUser.uid), normalized);
      editableSettings = normalized;
      renderSettingsForm();
    });
  }

  renderSettingsForm();
}


function buildSequenceStepState(step = {}, index = 0) {
  const template = normalizePromotionTemplateConfig(step.templateConfig || step.template || {});
  const triggerImmediatelyAfterPrevious = index > 0 && step.triggerImmediatelyAfterPrevious === true;
  const stepType = step.stepType === "task_reminder" ? "task_reminder" : "email";
  return {
    id: String(step.id || `step-${index + 1}`),
    order: index,
    name: String(step.name || `Step ${index + 1}`),
    delayDaysFromPrevious: index === 0 ? 0 : (triggerImmediatelyAfterPrevious ? 0 : Math.max(0, Number(step.delayDaysFromPrevious) || 0)),
    triggerImmediatelyAfterPrevious,
    useContactEmail: step.useContactEmail === true,
    toEmail: String(step.toEmail || ""),
    stepType,
    taskConfig: {
      title: String(step?.taskConfig?.title || step?.taskTitle || "").trim(),
      notes: String(step?.taskConfig?.notes || step?.taskNotes || "").trim(),
    },
    templateConfig: {
      ...template,
      populateName: template.populateName === true && step.useContactEmail === true,
    },
  };
}

function syncSequenceStepsFromForm(steps = []) {
  return steps.map((step, index) => {
    const stepTypeValue = document.querySelector(`[data-sequence-step-type="${index}"]`)?.value;
    const stepType = stepTypeValue === "task_reminder" ? "task_reminder" : "email";
    const useContactEmail = document.querySelector(`[data-sequence-step-use-contact-email="${index}"]`)?.checked === true;
    const toFieldValue = document.querySelector(`[data-sequence-step-to="${index}"]`)?.value;
    const triggerImmediatelyAfterPrevious = index > 0 && document.querySelector(`[data-sequence-step-trigger-immediate="${index}"]`)?.checked === true;
    const parsedDelayDays = Number.parseInt(document.querySelector(`[data-sequence-step-delay="${index}"]`)?.value || step.delayDaysFromPrevious || 0, 10) || 0;
    return {
      ...step,
      name: String(document.querySelector(`[data-sequence-step-name="${index}"]`)?.value || step.name || `Step ${index + 1}`),
      delayDaysFromPrevious: index === 0 ? 0 : (triggerImmediatelyAfterPrevious ? 0 : Math.max(0, parsedDelayDays)),
      triggerImmediatelyAfterPrevious,
      useContactEmail,
      toEmail: String(toFieldValue !== undefined ? toFieldValue : (step.toEmail || "")),
      stepType,
      taskConfig: {
        title: document.querySelector(`[data-sequence-step-task-title="${index}"]`)?.value || "",
        notes: document.querySelector(`[data-sequence-step-task-notes="${index}"]`)?.value || "",
      },
      templateConfig: {
        subjectText: document.querySelector(`[data-sequence-step-subject="${index}"]`)?.value || "",
        introText: document.querySelector(`[data-sequence-step-intro="${index}"]`)?.value || "",
        populateName: document.querySelector(`[data-sequence-step-populate-name="${index}"]`)?.checked === true,
        bodyText: document.querySelector(`[data-sequence-step-body="${index}"]`)?.value || "",
        outroText: document.querySelector(`[data-sequence-step-outro="${index}"]`)?.value || "",
      },
    };
  });
}

function buildSequenceStepMarkup(step, index) {
  const template = normalizePromotionTemplateConfig(step.templateConfig || {});
  const stepType = step.stepType === "task_reminder" ? "task_reminder" : "email";
  const taskTitle = String(step?.taskConfig?.title || "");
  const taskNotes = String(step?.taskConfig?.notes || "");
  return `<article class="panel detail-grid promotion-wizard-message-card"><p class="promotion-wizard-card-title"><strong>${escapeHtml(step.name || `Step ${index + 1}`)}</strong></p><label>Step Type<select data-sequence-step-type="${index}"><option value="email" ${stepType === "email" ? "selected" : ""}>Email</option><option value="task_reminder" ${stepType === "task_reminder" ? "selected" : ""}>Task Reminder</option></select></label><label>Step Name<input data-sequence-step-name="${index}" value="${escapeHtml(step.name || `Step ${index + 1}`)}" /></label>${index > 0 ? `<label class="sequence-offset-row"><span>Send this message</span><input class="promotion-wizard-offset-input" type="number" min="0" data-sequence-step-delay="${index}" value="${step.triggerImmediatelyAfterPrevious ? 0 : (Number(step.delayDaysFromPrevious) || 0)}" ${step.triggerImmediatelyAfterPrevious ? "disabled" : ""} /><span>days after the previous step.</span></label><label class="template-checkbox-row"><input type="checkbox" data-sequence-step-trigger-immediate="${index}" ${step.triggerImmediatelyAfterPrevious ? "checked" : ""} /><span>Trigger immediately upon completion of the previous step</span></label>` : '<p>Step 1 sends at Start Date (or immediately if unset).</p>'}<div data-sequence-email-fields="${index}" class="${stepType === "task_reminder" ? "hidden" : ""}"><label>To<input type="email" data-sequence-step-to="${index}" value="${escapeHtml(step.toEmail || "")}" placeholder="person@example.com" /></label><label class="template-checkbox-row"><input type="checkbox" data-sequence-step-use-contact-email="${index}" ${step.useContactEmail ? "checked" : ""} /><span>Use contact email for this step</span></label><label>Subject<input data-sequence-step-subject="${index}" value="${escapeHtml(template.subjectText)}" /></label><label>Intro<input data-sequence-step-intro="${index}" value="${escapeHtml(template.introText)}" /></label><label class="template-checkbox-row"><input type="checkbox" data-sequence-step-populate-name="${index}" ${template.populateName ? "checked" : ""} /><span>Auto populate name</span></label><label>Body<textarea rows="4" data-sequence-step-body="${index}">${escapeHtml(template.bodyText)}</textarea></label><label>Outro<input data-sequence-step-outro="${index}" value="${escapeHtml(template.outroText)}" /></label></div><div data-sequence-task-fields="${index}" class="${stepType === "task_reminder" ? "" : "hidden"}"><label>Title<input data-sequence-step-task-title="${index}" value="${escapeHtml(taskTitle)}" /></label><label class="full-width">Notes<textarea rows="4" data-sequence-step-task-notes="${index}">${escapeHtml(taskNotes)}</textarea></label></div></article>`;
}

function applySequenceStepTypeRules(index) {
  const stepTypeSelect = document.querySelector(`[data-sequence-step-type="${index}"]`);
  const emailFields = document.querySelector(`[data-sequence-email-fields="${index}"]`);
  const taskFields = document.querySelector(`[data-sequence-task-fields="${index}"]`);
  const stepType = stepTypeSelect?.value === "task_reminder" ? "task_reminder" : "email";
  if (emailFields) emailFields.classList.toggle("hidden", stepType !== "email");
  if (taskFields) taskFields.classList.toggle("hidden", stepType !== "task_reminder");
}

function applySequenceStepContactRules(step, index, selectedContact = null) {
  const stepType = document.querySelector(`[data-sequence-step-type="${index}"]`)?.value || step.stepType || "email";
  if (stepType !== "email") return;
  const toInput = document.querySelector(`[data-sequence-step-to="${index}"]`);
  const useContactCheckbox = document.querySelector(`[data-sequence-step-use-contact-email="${index}"]`);
  const populateNameCheckbox = document.querySelector(`[data-sequence-step-populate-name="${index}"]`);
  const hasContact = Boolean(selectedContact?.email);

  if (!toInput || !useContactCheckbox || !populateNameCheckbox) return;

  useContactCheckbox.disabled = !hasContact;
  if (!hasContact) useContactCheckbox.checked = false;

  const useContactEmail = hasContact && useContactCheckbox.checked === true;
  if (useContactEmail) {
    toInput.value = selectedContact.email || "";
    toInput.readOnly = true;
    toInput.classList.add("sequence-readonly-input");
  } else {
    if (toInput.classList.contains("sequence-contact-email-value")) {
      toInput.value = "";
    }
    toInput.readOnly = false;
    toInput.classList.remove("sequence-readonly-input");
  }

  toInput.classList.toggle("sequence-contact-email-value", useContactEmail);

  populateNameCheckbox.disabled = !useContactEmail;
  if (!useContactEmail) populateNameCheckbox.checked = false;
}

async function renderSequenceCreateFlow() {
  renderLoading("Loading sequences...");
  const [appSettings, sequencesSnapshot, contactsSnapshot] = await Promise.all([
    getAppSettings(currentUser.uid),
    getDocs(query(collection(db, "users", currentUser.uid, "sequences"), orderBy("createdAt", "desc"))),
    getDocs(query(collection(db, "users", currentUser.uid, "contacts"), orderBy("name", "asc"))),
  ]);
  const existing = sequencesSnapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
  const contacts = contactsSnapshot.docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => isActiveRecord(c));

  const state = {
    page: "select",
    selectedTemplate: null,
    sourceTemplate: null,
    sequenceName: "",
    instanceName: "",
    startDate: "",
    contactId: "",
    steps: [buildSequenceStepState({}, 0)],
  };

  const render = () => {
    if (state.page === "select") {
      const options = existing.length
        ? `<div class="feed-list">${existing.map((entry) => `<button type="button" class="panel feed-item" data-select-sequence-template="${entry.id}"><h3>${escapeHtml(entry.name || "Untitled Sequence")}</h3><p>${Array.isArray(entry.steps) ? entry.steps.length : 0} steps</p></button>`).join("")}</div><div class="button-row"><button type="button" id="configure-sequence-btn">Configure New Sequence</button></div>`
        : '<div class="button-row"><button type="button" id="configure-sequence-btn">Configure New Sequence</button></div>';
      viewContainer.innerHTML = `<section class="crm-view crm-view--promotions"><div class="view-header"><h2>New Sequence</h2><div class="view-header-actions"><button id="sequence-cancel-btn" type="button" class="secondary-btn">Back</button></div></div><div class="panel"><h3>Select Sequence</h3>${options}</div></section>`;
      document.getElementById("sequence-cancel-btn")?.addEventListener("click", () => { window.location.hash = "#tasks"; });
      document.getElementById("configure-sequence-btn")?.addEventListener("click", () => {
        state.selectedTemplate = null;
        state.sourceTemplate = null;
        state.sequenceName = "";
        state.instanceName = "";
        state.contactId = "";
        state.startDate = "";
        state.steps = [buildSequenceStepState({}, 0)];
        state.page = "configure";
        render();
      });
      document.querySelectorAll("[data-select-sequence-template]").forEach((buttonEl) => {
        buttonEl.addEventListener("click", () => {
          const selected = existing.find((entry) => entry.id === buttonEl.dataset.selectSequenceTemplate);
          state.selectedTemplate = selected || null;
          state.sourceTemplate = selected || null;
          state.sequenceName = selected?.name || "";
          state.instanceName = "";
          state.steps = (selected?.steps || []).map((step, index) => buildSequenceStepState(step, index));
          if (!state.steps.length) state.steps = [buildSequenceStepState({}, 0)];
          state.page = "schedule";
          render();
        });
      });
      return;
    }

    if (state.page === "schedule") {
      const sequenceLabel = state.selectedTemplate?.name || "Untitled Sequence";
      viewContainer.innerHTML = `<section class="crm-view crm-view--promotions"><div class="view-header"><h2>Use Sequence</h2></div><div class="panel detail-grid"><p><strong>${escapeHtml(sequenceLabel)}</strong></p><label>Instance Name (optional)<input id="sequence-instance-name" value="${escapeHtml(state.instanceName)}" placeholder="e.g. Order Number, Company" /></label><label>Add Contact (optional)<select id="sequence-contact-id"><option value="">No contact</option>${contacts.map((c) => `<option value="${c.id}" ${state.contactId === c.id ? "selected" : ""}>${escapeHtml(c.name || c.email || "Unnamed")}</option>`).join("")}</select></label><label>Start Date (optional)<input id="sequence-start-date" type="datetime-local" value="${escapeHtml(state.startDate)}" /></label></div><div class="button-row"><button id="sequence-schedule-back-btn" type="button" class="secondary-btn">Back</button><button id="sequence-edit-btn" type="button" class="secondary-btn">Edit</button><button id="sequence-save-btn" type="button">Save</button></div></section>`;
      document.getElementById("sequence-schedule-back-btn")?.addEventListener("click", () => {
        state.page = "select";
        render();
      });
      document.getElementById("sequence-edit-btn")?.addEventListener("click", () => {
        state.contactId = document.getElementById("sequence-contact-id")?.value || "";
        state.startDate = document.getElementById("sequence-start-date")?.value || "";
        state.instanceName = document.getElementById("sequence-instance-name")?.value || "";
        state.page = "configure";
        render();
      });
      document.getElementById("sequence-save-btn")?.addEventListener("click", async () => {
        state.contactId = document.getElementById("sequence-contact-id")?.value || "";
        state.startDate = document.getElementById("sequence-start-date")?.value || "";
        state.instanceName = document.getElementById("sequence-instance-name")?.value || "";
        const payload = {
          name: state.selectedTemplate?.name || state.sequenceName || "Untitled Sequence",
          instanceName: state.instanceName || "",
          startDate: state.startDate ? new Date(state.startDate) : null,
          steps: (state.selectedTemplate?.steps || state.steps || []).map((entry, index) => ({ ...entry, order: index, name: entry.name || `Step ${index + 1}` })),
        };
        await createSequence({ db, userId: currentUser.uid, sequence: payload, contactId: state.contactId || null, dayStartTime: appSettings.pipeline?.dayStartTime });
        window.location.hash = "#tasks";
      });
      return;
    }

    if (state.page === "configure") {
      viewContainer.innerHTML = `<section class="crm-view crm-view--promotions"><div class="view-header"><h2>New Sequence</h2></div><div class="panel detail-grid"><p><strong>${escapeHtml(state.selectedTemplate?.name || state.sequenceName || "Configure New Sequence")}</strong></p><label>Sequence Name<input id="sequence-name-input" value="${escapeHtml(state.sequenceName || state.selectedTemplate?.name || "")}" /></label><label>Add Contact (optional)<select id="sequence-contact-id"><option value="">No contact</option>${contacts.map((c) => `<option value="${c.id}" ${state.contactId === c.id ? "selected" : ""}>${escapeHtml(c.name || c.email || "Unnamed")}</option>`).join("")}</select></label><label>Start Date (optional)<input id="sequence-start-date" type="datetime-local" value="${escapeHtml(state.startDate)}" /></label></div><div class="button-row"><button id="sequence-prev-btn" type="button" class="secondary-btn">Back</button><button id="sequence-next-btn" type="button">Next</button></div></section>`;
      document.getElementById("sequence-prev-btn")?.addEventListener("click", () => {
        state.page = state.sourceTemplate ? "schedule" : "select";
        render();
      });
      document.getElementById("sequence-next-btn")?.addEventListener("click", () => {
        state.sequenceName = document.getElementById("sequence-name-input")?.value || state.sequenceName || "";
        state.contactId = document.getElementById("sequence-contact-id")?.value || "";
        state.startDate = document.getElementById("sequence-start-date")?.value || "";
        state.page = "steps";
        render();
      });
      return;
    }

    if (state.page === "steps") {
      const selectedContact = contacts.find((entry) => entry.id === state.contactId) || null;
      viewContainer.innerHTML = `<section class="crm-view crm-view--promotions"><div class="view-header"><h2>${escapeHtml(state.sequenceName || "New Sequence")}</h2></div><div class="promotion-wizard-message-list">${state.steps.map((step, index) => buildSequenceStepMarkup(step, index)).join("")}</div><div class="button-row"><button id="sequence-add-step-btn" type="button" class="secondary-btn">Add Sequence Step</button><button id="sequence-steps-prev-btn" type="button" class="secondary-btn">Back</button><button id="sequence-create-btn" type="button">Create</button></div></section>`;

      state.steps.forEach((step, index) => {
        applySequenceStepTypeRules(index);
        applySequenceStepContactRules(step, index, selectedContact);
        document.querySelector(`[data-sequence-step-type="${index}"]`)?.addEventListener("change", () => {
          applySequenceStepTypeRules(index);
          applySequenceStepContactRules(step, index, selectedContact);
        });
        document.querySelector(`[data-sequence-step-use-contact-email="${index}"]`)?.addEventListener("change", () => {
          applySequenceStepContactRules(step, index, selectedContact);
        });
        document.querySelector(`[data-sequence-step-trigger-immediate="${index}"]`)?.addEventListener("change", (event) => {
          const delayInput = document.querySelector(`[data-sequence-step-delay="${index}"]`);
          if (!delayInput) return;
          if (event.target.checked === true) {
            delayInput.value = "0";
          }
          delayInput.disabled = event.target.checked === true;
        });
        const immediateChecked = document.querySelector(`[data-sequence-step-trigger-immediate="${index}"]`)?.checked === true;
        const delayInput = document.querySelector(`[data-sequence-step-delay="${index}"]`);
        if (delayInput && immediateChecked) {
          delayInput.value = "0";
          delayInput.disabled = true;
        }
      });

      document.getElementById("sequence-add-step-btn")?.addEventListener("click", () => {
        state.steps = syncSequenceStepsFromForm(state.steps);
        state.steps.push(buildSequenceStepState({ name: `Step ${state.steps.length + 1}`, delayDaysFromPrevious: 1 }, state.steps.length));
        render();
      });
      document.getElementById("sequence-steps-prev-btn")?.addEventListener("click", () => {
        state.steps = syncSequenceStepsFromForm(state.steps);
        state.page = "configure";
        render();
      });
      document.getElementById("sequence-create-btn")?.addEventListener("click", async () => {
        state.steps = syncSequenceStepsFromForm(state.steps).map((entry, index) => ({ ...entry, order: index, name: entry.name || `Step ${index + 1}` }));
        const payload = {
          name: state.sequenceName || state.selectedTemplate?.name || "Untitled Sequence",
          instanceName: state.instanceName || "",
          startDate: state.startDate ? new Date(state.startDate) : null,
          steps: state.steps,
        };
        await createSequence({ db, userId: currentUser.uid, sequence: payload, contactId: state.contactId || null, dayStartTime: appSettings.pipeline?.dayStartTime });
        window.location.hash = "#tasks";
      });
    }
  };

  render();
}

async function renderSequenceEventDetail(eventId) {
  renderLoading("Loading sequence event...");
  const route = routeFromHash();
  const originRoute = getCurrentRouteOrigin(route.params);

  const eventRef = doc(db, "users", currentUser.uid, "events", eventId);
  const eventSnapshot = await getDoc(eventRef);
  if (!eventSnapshot.exists()) {
    viewContainer.innerHTML = '<p class="view-message">Sequence event not found.</p>';
    return;
  }

  const event = { id: eventSnapshot.id, ...eventSnapshot.data() };
  if (!event.sequenceId) {
    viewContainer.innerHTML = '<p class="view-message">Sequence not found.</p>';
    return;
  }

  const [sequenceSnapshot, eventsSnapshot] = await Promise.all([
    getDoc(doc(db, "users", currentUser.uid, "sequences", event.sequenceId)),
    getDocs(query(collection(db, "users", currentUser.uid, "events"), where("sequenceId", "==", event.sequenceId))),
  ]);
  if (!sequenceSnapshot.exists()) {
    viewContainer.innerHTML = '<p class="view-message">Sequence not found.</p>';
    return;
  }
  const sequence = { id: sequenceSnapshot.id, ...sequenceSnapshot.data() };
  const contactSnapshot = sequence.contactId ? await getDoc(doc(db, "users", currentUser.uid, "contacts", sequence.contactId)) : null;
  const contact = contactSnapshot?.exists() ? { id: contactSnapshot.id, ...contactSnapshot.data() } : null;
  const events = eventsSnapshot.docs.map((docItem) => ({ id: docItem.id, ...docItem.data() })).sort((a, b) => (Number(a.stepOrder) || 0) - (Number(b.stepOrder) || 0));

  const current = events.find((entry) => entry.id === eventId) || event;
  const next = events.find((entry) => (Number(entry.stepOrder) || 0) > (Number(current.stepOrder) || 0) && !entry.completed && entry.status !== "skipped");
  const completed = events.filter((entry) => entry.completed || entry.status === "skipped");
  const stepType = current.stepType === "task_reminder" ? "task_reminder" : "email";
  const templateConfig = normalizePromotionTemplateConfig(current.templateConfig || current.template || {});
  const mailPreview = renderTemplateWithLead(templateConfig, contact?.name || "").trim();
  const renderStepCard = (entry, withActions = false) => {
    const entryType = entry.stepType === "task_reminder" ? "task_reminder" : "email";
    const cfg = normalizePromotionTemplateConfig(entry.templateConfig || entry.template || {});
    const body = renderTemplateWithLead(cfg, contact?.name || "").trim();
    const to = String(entry.useContactEmail ? (contact?.email || "") : (entry.toEmail || "")).trim();
    const stateLabel = entry.status === "skipped" ? "Skipped" : entry.completed ? "Done" : "Open";
    const actionMarkup = withActions
      ? `<div class="promo-touchpoint-lead-actions">${entryType === "email" ? `<div class="promo-touchpoint-action-group"><button type="button" class="secondary-btn" data-sequence-open-mail="${entry.id}" ${to ? `data-mail-to="${escapeHtml(to)}"` : "disabled"} data-mail-subject="${escapeHtml(cfg.subjectText || "")}" data-mail-body="${escapeHtml(body)}">Open Mail</button><button type="button" class="secondary-btn" data-copy-text="${escapeHtml(body)}">Copy</button></div><div class="promo-touchpoint-action-divider" aria-hidden="true"></div>` : ""}<div class="promo-touchpoint-action-group"><button type="button" class="secondary-btn" data-sequence-step-done="${entry.id}" ${entry.completed || entry.status === "skipped" ? "disabled" : ""}>Done</button><button type="button" class="secondary-btn" data-sequence-step-skip="${entry.id}" ${entry.completed || entry.status === "skipped" ? "disabled" : ""}>Skip</button></div></div>`
      : "";
    const reminderContent = entryType === "task_reminder"
      ? `<div class="detail-grid"><p><strong>Task Name:</strong> ${escapeHtml(String(entry?.taskConfig?.title || entry?.taskTitle || entry.stepName || "Task Reminder"))}</p><label class="full-width">Notes<textarea rows="3" readonly>${escapeHtml(String(entry?.taskConfig?.notes || entry?.taskNotes || ""))}</textarea></label></div>`
      : "";
    return `<article class="promo-touchpoint-lead-card panel panel--sequence ${entry.completed || entry.status === "skipped" ? "promo-touchpoint-lead-card--completed" : ""}"><div class="promo-touchpoint-lead-meta"><p class="promo-touchpoint-lead-name">${escapeHtml(entry.stepName || "Step")}</p><p class="promo-touchpoint-lead-detail">Scheduled for ${escapeHtml(formatDate(entry.scheduledFor))}</p><p class="promo-touchpoint-lead-status">Status: ${escapeHtml(stateLabel)}</p></div>${reminderContent}${actionMarkup}</article>`;
  };

  const previewMarkup = stepType === "task_reminder"
    ? ""
    : `<label class="full-width">Template Preview<textarea rows="5" readonly>${escapeHtml(mailPreview)}</textarea></label>`;

  const sequenceDisplayName = composeSequenceDisplayName(sequence);
  viewContainer.innerHTML = `<section class="crm-view crm-view--promotions"><div class="view-header"><h2>${escapeHtml(sequenceDisplayName || "Sequence")}</h2><div class="view-header-actions"><button id="back-dashboard-btn" type="button" class="secondary-btn">Back</button></div></div><div class="panel panel--sequence detail-grid feed-item--sequence"><p><strong>Sequence:</strong> ${escapeHtml(sequenceDisplayName || "Untitled sequence")}</p><p><strong>Step:</strong> ${escapeHtml(current.stepName || "Step")}</p><p><strong>Due:</strong> ${formatDate(current.scheduledFor)}</p></div><div class="panel panel--lead notes-panel">${previewMarkup}<div class="promo-touchpoint-leads-wrap"><div class="promo-touchpoint-lead-section"><h3>Active</h3><div class="promo-touchpoint-lead-list">${renderStepCard(current, true)}</div></div><div class="promo-touchpoint-lead-section"><h3>Up Next</h3><div class="promo-touchpoint-lead-list">${next ? renderStepCard(next, false) : '<p class="view-message">No next step.</p>'}</div></div><div class="promo-touchpoint-lead-section promo-touchpoint-lead-section--completed"><h3>Completed</h3><div class="promo-touchpoint-lead-list">${completed.length ? completed.map((entry) => renderStepCard(entry, false)).join("") : '<p class="view-message">No completed steps yet.</p>'}</div></div></div></div></section>`;

  document.getElementById("back-dashboard-btn")?.addEventListener("click", () => {
    window.location.hash = originRoute || "#dashboard";
  });

  document.querySelectorAll("[data-sequence-open-mail]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", () => {
      const to = buttonEl.dataset.mailTo || "";
      if (!to) return;
      const subject = encodeURIComponent(buttonEl.dataset.mailSubject || "");
      const body = encodeURIComponent(buttonEl.dataset.mailBody || "");
      window.open(`mailto:${encodeURIComponent(to)}?subject=${subject}&body=${body}`, "_blank");
    });
  });

  const reconcile = async () => {
    const refreshed = await getDocs(query(collection(db, "users", currentUser.uid, "events"), where("sequenceId", "==", event.sequenceId)));
    const unresolved = refreshed.docs.some((docItem) => {
      const value = docItem.data() || {};
      return value.completed !== true && value.status !== "skipped";
    });
    if (!unresolved) {
      await updateDoc(doc(db, "users", currentUser.uid, "sequences", event.sequenceId), {
        status: "completed",
        updatedAt: serverTimestamp(),
      });
    }
  };

  document.querySelectorAll("[data-sequence-step-done]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", async () => {
      const targetId = buttonEl.dataset.sequenceStepDone;
      const target = events.find((entry) => entry.id === targetId);
      if (!target) return;
      await markSequenceStepStatus({ db, userId: currentUser.uid, event: target, status: "completed" });
      await reconcile();
      await renderSequenceEventDetail(targetId);
    });
  });

  document.querySelectorAll("[data-sequence-step-skip]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", async () => {
      const targetId = buttonEl.dataset.sequenceStepSkip;
      const target = events.find((entry) => entry.id === targetId);
      if (!target) return;
      await markSequenceStepStatus({ db, userId: currentUser.uid, event: target, status: "skipped" });
      await reconcile();
      await renderSequenceEventDetail(targetId);
    });
  });

  attachClipboardHandlers(viewContainer);
}

async function renderCurrentRoute() {
  if (!authStateResolved || !currentUser) return;

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

    if (route.page === "add-sequence") {
      await renderSequenceCreateFlow();
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
      await renderPromotionsPage();
      return;
    }

    if (route.page === "promotion-event-detail" && route.promotionEventId) {
      await renderPromotionEventDetail(route.promotionEventId);
      return;
    }

    if (route.page === "sequence-event-detail" && route.sequenceEventId) {
      await renderSequenceEventDetail(route.sequenceEventId);
      return;
    }

    if (route.page === "promotion-detail" && route.promotionId) {
      await renderPromotionDetail(route.promotionId);
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
  authStateResolved = true;
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
    stopAuthDemo();
    setStatus("Please log in to continue.");
  }
});

initAuthPageAnimations();

window.addEventListener("hashchange", () => {
  if (!authStateResolved) return;
  renderCurrentRoute();
});
