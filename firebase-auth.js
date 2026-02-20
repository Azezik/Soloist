import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  arrayUnion,
  Timestamp,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCvxDrprgML-gEJqYTlO_mQ0w9jtiHri8s",
  authDomain: "soloist-crm.firebaseapp.com",
  projectId: "soloist-crm",
  storageBucket: "soloist-crm.firebasestorage.app",
  messagingSenderId: "467745256357",
  appId: "1:467745256357:web:dd9e94cd494dc610736e4c",
  measurementId: "G-HK1EJ7YJ0Z",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

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

const DEFAULT_PIPELINE_SETTINGS = {
  dayStartTime: "08:30",
  stages: [
    { id: "stage1", label: "Stage 1", offsetDays: 0 },
    { id: "stage2", label: "Stage 2", offsetDays: 2 },
    { id: "stage3", label: "Stage 3", offsetDays: 7 },
    { id: "stage4", label: "Stage 4", offsetDays: 15 },
    { id: "stage5", label: "Stage 5", offsetDays: 30 },
  ],
};

const DEFAULT_PUSH_PRESETS = [
  { label: "+1 hour", behavior: { type: "addHours", hours: 1 } },
  { label: "+3 hours", behavior: { type: "addHours", hours: 3 } },
  { label: "Next 12:00 (noon)", behavior: { type: "nextTime", time: "12:00" } },
  { label: "Next 16:00 (4:00 PM)", behavior: { type: "nextTime", time: "16:00" } },
  {
    label: "Next Monday 08:30",
    behavior: { type: "nextWeekdayTime", weekday: 1, time: "08:30" },
  },
];

function cloneDefaultPushPresets() {
  return DEFAULT_PUSH_PRESETS.map((preset) => ({
    label: preset.label,
    behavior: { ...preset.behavior },
  }));
}

function cloneDefaultPipelineSettings() {
  return {
    dayStartTime: DEFAULT_PIPELINE_SETTINGS.dayStartTime,
    stages: DEFAULT_PIPELINE_SETTINGS.stages.map((stage) => ({ ...stage })),
  };
}

function cloneDefaultAppSettings() {
  return {
    pipeline: cloneDefaultPipelineSettings(),
    pushPresets: cloneDefaultPushPresets(),
  };
}

function sanitizeTimeString(rawValue) {
  if (typeof rawValue !== "string") return DEFAULT_PIPELINE_SETTINGS.dayStartTime;
  const match = rawValue.trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) return DEFAULT_PIPELINE_SETTINGS.dayStartTime;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return DEFAULT_PIPELINE_SETTINGS.dayStartTime;
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function normalizePipelineSettings(input) {
  const fallback = cloneDefaultPipelineSettings();
  const stages = Array.isArray(input?.stages) ? input.stages : fallback.stages;

  return {
    dayStartTime: sanitizeTimeString(input?.dayStartTime),
    stages: stages
      .map((stage, index) => {
        const fallbackStage = fallback.stages[index] || {
          id: `stage${index + 1}`,
          label: `Stage ${index + 1}`,
          offsetDays: index,
        };

        const parsedOffset = Number.parseInt(stage?.offsetDays, 10);

        return {
          id: String(stage?.id || fallbackStage.id),
          label: String(stage?.label || fallbackStage.label),
          offsetDays: Number.isNaN(parsedOffset) ? fallbackStage.offsetDays : parsedOffset,
        };
      }),
  };
}

function normalizePushPresetBehavior(inputBehavior, fallbackBehavior) {
  const type = String(inputBehavior?.type || fallbackBehavior.type);

  if (type === "addHours") {
    const parsedHours = Number.parseInt(inputBehavior?.hours, 10);
    return {
      type,
      hours: Number.isNaN(parsedHours) || parsedHours < 1 ? fallbackBehavior.hours : parsedHours,
    };
  }

  if (type === "nextWeekdayTime") {
    const parsedWeekday = Number.parseInt(inputBehavior?.weekday, 10);
    return {
      type,
      weekday: Number.isNaN(parsedWeekday) || parsedWeekday < 0 || parsedWeekday > 6 ? fallbackBehavior.weekday : parsedWeekday,
      time: sanitizeTimeString(inputBehavior?.time || fallbackBehavior.time),
    };
  }

  return {
    type: "nextTime",
    time: sanitizeTimeString(inputBehavior?.time || fallbackBehavior.time),
  };
}

function normalizePushPresets(inputPresets) {
  const fallback = cloneDefaultPushPresets();
  const source = Array.isArray(inputPresets) ? inputPresets : [];

  return fallback.map((fallbackPreset, index) => {
    const incoming = source[index] || {};
    return {
      label: String(incoming.label || fallbackPreset.label),
      behavior: normalizePushPresetBehavior(incoming.behavior, fallbackPreset.behavior),
    };
  });
}

function normalizeAppSettings(input) {
  const pipelineSource = input?.pipeline || input;
  return {
    pipeline: normalizePipelineSettings(pipelineSource),
    pushPresets: normalizePushPresets(input?.pushPresets),
  };
}

function pipelineSettingsRef(uid) {
  return doc(db, "users", uid, "settings", "pipeline");
}

async function getPipelineSettings(uid) {
  const settingsRef = pipelineSettingsRef(uid);
  const settingsSnapshot = await getDoc(settingsRef);

  if (!settingsSnapshot.exists()) {
    const defaults = cloneDefaultAppSettings();
    await setDoc(settingsRef, defaults);
    return defaults.pipeline;
  }

  const appSettings = normalizeAppSettings(settingsSnapshot.data());
  return appSettings.pipeline;
}

async function getAppSettings(uid) {
  const settingsRef = pipelineSettingsRef(uid);
  const settingsSnapshot = await getDoc(settingsRef);

  if (!settingsSnapshot.exists()) {
    const defaults = cloneDefaultAppSettings();
    await setDoc(settingsRef, defaults);
    return defaults;
  }

  return normalizeAppSettings(settingsSnapshot.data());
}

function getStageById(pipelineSettings, stageId) {
  return pipelineSettings.stages.find((stage) => stage.id === stageId) || null;
}

function getNextStage(pipelineSettings, stageId) {
  const index = pipelineSettings.stages.findIndex((stage) => stage.id === stageId);
  if (index < 0 || index + 1 >= pipelineSettings.stages.length) return null;
  return pipelineSettings.stages[index + 1];
}

function computeOffsetDeltaDays(pipelineSettings, currentStageId, nextStageId) {
  const currentStage = getStageById(pipelineSettings, currentStageId);
  const nextStage = getStageById(pipelineSettings, nextStageId);

  if (!currentStage || !nextStage) return 0;

  return Math.max(0, nextStage.offsetDays - currentStage.offsetDays);
}

function computeNextActionAt(baseNow, deltaDays, dayStartTime) {
  const [hourPart, minutePart] = sanitizeTimeString(dayStartTime).split(":");
  const hours = Number(hourPart);
  const minutes = Number(minutePart);

  const baseDate = new Date(baseNow);
  const targetDate = new Date(baseDate);
  targetDate.setSeconds(0, 0);

  if (deltaDays === 0 && (baseDate.getHours() > hours || (baseDate.getHours() === hours && baseDate.getMinutes() > minutes))) {
    targetDate.setDate(targetDate.getDate() + 1);
  } else {
    targetDate.setDate(targetDate.getDate() + deltaDays);
  }

  targetDate.setHours(hours, minutes, 0, 0);
  return Timestamp.fromDate(targetDate);
}

function computePushedTimestamp(baseNow, preset) {
  const behavior = preset?.behavior || {};
  const nowDate = new Date(baseNow);
  const targetDate = new Date(nowDate);
  targetDate.setSeconds(0, 0);

  if (behavior.type === "addHours") {
    targetDate.setHours(targetDate.getHours() + behavior.hours);
    return Timestamp.fromDate(targetDate);
  }

  const [hourPart, minutePart] = sanitizeTimeString(behavior.time).split(":");
  const hours = Number(hourPart);
  const minutes = Number(minutePart);

  if (behavior.type === "nextWeekdayTime") {
    const targetWeekday = Number.parseInt(behavior.weekday, 10);
    const currentWeekday = targetDate.getDay();
    let daysUntil = (targetWeekday - currentWeekday + 7) % 7;
    if (daysUntil === 0) daysUntil = 7;
    targetDate.setDate(targetDate.getDate() + daysUntil);
    targetDate.setHours(hours, minutes, 0, 0);
    return Timestamp.fromDate(targetDate);
  }

  targetDate.setHours(hours, minutes, 0, 0);
  if (targetDate.getTime() <= nowDate.getTime()) {
    targetDate.setDate(targetDate.getDate() + 1);
  }
  return Timestamp.fromDate(targetDate);
}

function setStatus(message) {
  statusEl.textContent = message;
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
      "Update Firebase Firestore Security Rules to allow authenticated users to read and write users/{userId}/contacts, users/{userId}/leads, users/{userId}/tasks, and users/{userId}/settings/pipeline.",
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

  const hash = window.location.hash.slice(1);
  if (hash === "dashboard") return { page: "dashboard" };
  if (hash === "contacts") return { page: "contacts" };
  if (hash === "add-contact") return { page: "add-contact" };
  if (hash === "add-lead") return { page: "add-lead" };
  if (hash === "tasks") return { page: "tasks" };
  if (hash === "tasks/new") return { page: "add-task" };
  if (hash === "add-task") return { page: "add-task" };
  if (hash === "promotions") return { page: "promotions" };
  if (hash === "settings") return { page: "settings" };
  if (hash.startsWith("contact/") && hash.endsWith("/edit")) {
    const parts = hash.split("/");
    return { page: "contact-edit", contactId: parts[1] };
  }

  if (hash.startsWith("lead/") && hash.endsWith("/edit")) {
    const parts = hash.split("/");
    return { page: "lead-edit", leadId: parts[1] };
  }

  if (hash.startsWith("task/") && hash.endsWith("/edit")) {
    const parts = hash.split("/");
    return { page: "task-edit", taskId: parts[1] };
  }

  if (hash.startsWith("contact/")) {
    return { page: "contact-detail", contactId: hash.split("/")[1] };
  }

  if (hash.startsWith("lead/")) {
    return { page: "lead-detail", leadId: hash.split("/")[1] };
  }

  if (hash.startsWith("task/")) {
    return { page: "task-detail", taskId: hash.split("/")[1] };
  }

  return { page: "dashboard" };
}

function renderLoading(text = "Loading...") {
  viewContainer.innerHTML = `<p class="view-message">${text}</p>`;
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
    acc[contactDoc.id] = { id: contactDoc.id, ...contactDoc.data() };
    return acc;
  }, {});

  const dueLeads = leadsSnapshot.docs
    .map((leadDoc) => ({ id: leadDoc.id, ...leadDoc.data() }))
    .filter((lead) => lead.stageStatus !== "completed")
    .map((lead) => {
      const contact = contactById[lead.contactId] || {};
      return {
        type: "lead",
        id: lead.id,
        source: "leads",
        contactId: lead.contactId || null,
        title: contact.name || "Unnamed Contact",
        subtitle: contact.email || contact.phone || "No contact details",
        stageId: lead.stageId,
        dueAt: lead.nextActionAt,
      };
    });

  const legacyDueLeads = legacyLeadsSnapshot.docs.map((contactDoc) => {
    const contact = { id: contactDoc.id, ...contactDoc.data() };
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
  });

  const dueTasks = tasksSnapshot.docs.map((taskDoc) => {
    const task = { id: taskDoc.id, ...taskDoc.data() };
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
  });

  const pushOptionsMarkup = pushPresets
    .map(
      (preset, index) =>
        `<button type="button" data-push-select="true" data-preset-index="${index}" class="push-option">${preset.label}</button>`
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
              <article class="panel feed-item feed-item-clickable" data-open-feed-item="true" data-feed-type="lead" data-feed-id="${item.id}" data-lead-source="${item.source}" tabindex="0" role="button">
                <p class="feed-type">Lead</p>
                <h3>${item.title}</h3>
                <p>${item.subtitle}</p>
                <p><strong>Stage:</strong> ${stageLabel}</p>
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
            <article class="panel feed-item feed-item-clickable" data-open-feed-item="true" data-feed-type="task" data-feed-id="${item.id}" tabindex="0" role="button">
              <p class="feed-type">Task</p>
              <h3>${item.title}</h3>
              <p>${item.subtitle}</p>
              <p><strong>Due:</strong> ${formatDate(item.dueAt)}</p>
              ${item.notes ? `<p>${item.notes}</p>` : ""}
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
    <section>
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
        window.location.hash = `#task/${feedId}`;
        return;
      }

      const leadSource = itemEl.dataset.leadSource;
      if (leadSource === "contacts") {
        window.location.hash = `#contact/${feedId}`;
        return;
      }

      window.location.hash = `#lead/${feedId}`;
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

      const nowDate = new Date();
      const leadRef = doc(db, "users", currentUser.uid, leadSource, leadId);
      const leadSnapshot = await getDoc(leadRef);
      if (!leadSnapshot.exists()) return;
      const lead = leadSnapshot.data();

      const nextStage = getNextStage(pipelineSettings, lead.stageId || pipelineSettings.stages[0]?.id);
      if (!nextStage) {
        if (leadSource === "leads") {
          await updateDoc(leadRef, {
            stageStatus: "completed",
            nextActionAt: null,
            lastActionAt: Timestamp.fromDate(nowDate),
            updatedAt: serverTimestamp(),
          });
        } else {
          await updateDoc(leadRef, {
            status: "Closed",
            nextActionAt: null,
            lastActionAt: Timestamp.fromDate(nowDate),
            updatedAt: serverTimestamp(),
          });
        }
        await renderDashboard();
        return;
      }

      const currentStageId = lead.stageId || pipelineSettings.stages[0]?.id;
      const deltaDays = computeOffsetDeltaDays(pipelineSettings, currentStageId, nextStage.id);
      const nextActionAt = computeNextActionAt(nowDate, deltaDays, pipelineSettings.dayStartTime);

      await updateDoc(leadRef, {
        stageId: nextStage.id,
        ...(leadSource === "leads" ? { stageStatus: "pending" } : {}),
        lastActionAt: Timestamp.fromDate(nowDate),
        nextActionAt,
        updatedAt: serverTimestamp(),
      });
      await renderDashboard();
    });
  });

  viewContainer.querySelectorAll("[data-task-action]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", async () => {
      const taskId = buttonEl.dataset.taskId;
      if (!taskId) return;

      await updateDoc(doc(db, "users", currentUser.uid, "tasks", taskId), {
        completed: true,
        updatedAt: serverTimestamp(),
      });
      await renderDashboard();
    });
  });

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
        await updateDoc(doc(db, "users", currentUser.uid, leadSource, entityId), {
          nextActionAt: pushedAt,
          lastActionAt: Timestamp.now(),
          updatedAt: serverTimestamp(),
        });
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

  const contacts = contactsSnapshot.docs.map((contactDoc) => ({ id: contactDoc.id, ...contactDoc.data() }));
  const tasks = tasksSnapshot.docs.map((taskDoc) => ({ id: taskDoc.id, ...taskDoc.data() }));

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
                <h3>${contact.name || "Unnamed Contact"}</h3>
                <p>${contact.email || "No email"}</p>
                <p>${contact.phone || "No phone"}</p>
                <p><strong>Tasks:</strong> ${taskCountByContact[contact.id] || 0}</p>
              </button>
            `;
          })
          .join("")
      : '<p class="view-message">No contacts match the current filters.</p>';

    listEl.querySelectorAll("[data-contact-id]").forEach((itemEl) => {
      itemEl.addEventListener("click", () => {
        window.location.hash = `#contact/${itemEl.dataset.contactId}`;
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
        <h2>${mode === "create" ? "Add Contact" : values.name || "Edit Contact"}</h2>
      </div>
      <form id="contact-form" class="panel form-grid">
        <label>Name <input name="name" value="${values.name || ""}" required /></label>
        <label>Email <input name="email" type="email" value="${values.email || ""}" /></label>
        <label>Phone <input name="phone" type="tel" value="${values.phone || ""}" /></label>

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
  const scheduledDate = String(formData.get("nextActionDate") || "").trim();
  const scheduledTime = String(formData.get("nextActionTime") || "").trim();
  const nextActionAt = parseScheduledFor(scheduledDate, scheduledTime);

  if ((scheduledDate || scheduledTime) && !nextActionAt) {
    throw new Error("Please provide a valid next action date/time.");
  }

  return {
    selectedContactId: String(formData.get("selectedContactId") || "").trim() || null,
    contactName: String(formData.get("contactName") || "").trim(),
    contactEmail: String(formData.get("contactEmail") || "").trim(),
    contactPhone: String(formData.get("contactPhone") || "").trim(),
    stageId: String(formData.get("stageId") || "").trim(),
    stageStatus: String(formData.get("stageStatus") || "pending").trim() || "pending",
    nextActionAt,
  };
}

function renderLeadForm({ mode, pipelineSettings, contacts, values, onSubmit, onCancel, onDelete }) {
  const selectedContact = contacts.find((contact) => contact.id === values.contactId) || null;
  const initialContactName = values.contactName || selectedContact?.name || "";
  const initialContactEmail = values.contactEmail || selectedContact?.email || "";
  const initialContactPhone = values.contactPhone || selectedContact?.phone || "";

  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>${mode === "create" ? "New Lead" : "Edit Lead"}</h2>
      </div>
      <form id="lead-form" class="panel form-grid">
        <h3 class="full-width">Contact Info</h3>
        <input type="hidden" name="selectedContactId" value="${values.contactId || ""}" />

        <label>Name
          <input name="contactName" id="lead-contact-name" value="${initialContactName}" required autocomplete="off" />
        </label>

        <div id="lead-contact-suggestions" class="lead-contact-suggestions full-width"></div>

        <label>Email
          <input name="contactEmail" id="lead-contact-email" type="email" value="${initialContactEmail}" />
        </label>

        <label>Phone
          <input name="contactPhone" id="lead-contact-phone" type="tel" value="${initialContactPhone}" />
        </label>

        <h3 class="full-width">Lead Info</h3>

        <label>Stage
          <select name="stageId">
            ${pipelineSettings.stages
              .map((stage) => `<option value="${stage.id}" ${values.stageId === stage.id ? "selected" : ""}>${stage.label}</option>`)
              .join("")}
          </select>
        </label>

        <label>Status
          <select name="stageStatus">
            ${["pending", "completed"].map((status) => `<option value="${status}" ${values.stageStatus === status ? "selected" : ""}>${status}</option>`).join("")}
          </select>
        </label>

        <label>Next Action Date
          <input name="nextActionDate" type="date" value="${dateInputValue(values.nextActionAt)}" />
        </label>

        <label>Next Action Time
          <input name="nextActionTime" type="time" value="${timeInputValue(values.nextActionAt)}" />
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
              `<button type="button" class="lead-contact-option" data-contact-option-id="${contact.id}">${contact.name || "Unnamed"} ${contact.email ? `· ${contact.email}` : ""}</button>`
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
    try {
      const payload = parseLeadFormValues(event.currentTarget);
      if (!payload.stageId) {
        alert("Stage is required.");
        return;
      }
      if (!payload.contactName) {
        alert("Contact name is required.");
        return;
      }
      await onSubmit(payload);
    } catch (error) {
      alert(error.message);
    }
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
    contactId: String(formData.get("contactId") || "").trim() || null,
    scheduledFor,
  };
}

function renderTaskForm({ mode, contacts, values, onSubmit, onCancel, onDelete }) {
  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>${mode === "create" ? "Add Task" : values.title || "Edit Task"}</h2>
      </div>
      <form id="task-form" class="panel form-grid">
        <label>Title <input name="title" value="${values.title || ""}" required /></label>
        <label class="full-width">Notes <textarea name="notes" rows="4">${values.notes || ""}</textarea></label>

        <label>Contact (Optional)
          <select name="contactId">
            <option value="">No contact</option>
            ${contacts
              .map((contact) => `<option value="${contact.id}" ${values.contactId === contact.id ? "selected" : ""}>${contact.name || contact.email || contact.id}</option>`)
              .join("")}
          </select>
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
        notes: [],
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
  const contacts = contactsSnapshot.docs.map((contactDoc) => ({ id: contactDoc.id, ...contactDoc.data() }));
  const firstStageId = pipelineSettings.stages[0]?.id || "stage1";

  renderLeadForm({
    mode: "create",
    pipelineSettings,
    contacts,
    values: { stageId: firstStageId, stageStatus: "pending", nextActionAt: Timestamp.now() },
    onSubmit: async (values) => {
      const now = Timestamp.now();
      let contactId = values.selectedContactId;

      if (!contactId) {
        const createdContact = await addDoc(collection(db, "users", currentUser.uid, "contacts"), {
          name: values.contactName,
          email: values.contactEmail,
          phone: values.contactPhone,
          createdAt: now,
          updatedAt: serverTimestamp(),
          notes: [],
        });
        contactId = createdContact.id;
      }

      await addDoc(collection(db, "users", currentUser.uid, "leads"), {
        contactId,
        stageId: values.stageId,
        stageStatus: values.stageStatus || "pending",
        nextActionAt: values.nextActionAt,
        createdAt: now,
        updatedAt: serverTimestamp(),
      });
      window.location.hash = "#dashboard";
    },
  });
}

async function renderAddTaskForm() {
  renderLoading("Loading contacts for task creation...");

  const contactsSnapshot = await getDocs(
    query(collection(db, "users", currentUser.uid, "contacts"), orderBy("name", "asc"))
  );

  const contacts = contactsSnapshot.docs.map((contactDoc) => ({ id: contactDoc.id, ...contactDoc.data() }));

  renderTaskForm({
    mode: "create",
    contacts,
    values: {},
    onSubmit: async (values) => {
      await addDoc(collection(db, "users", currentUser.uid, "tasks"), {
        ...values,
        completed: false,
        createdAt: Timestamp.now(),
        updatedAt: serverTimestamp(),
      });
      window.location.hash = "#tasks";
    },
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

  const tasks = tasksSnapshot.docs
    .map((taskDoc) => ({ id: taskDoc.id, ...taskDoc.data() }))
    .sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0));

  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>Tasks</h2>
        <button id="add-task-btn" type="button">Add Task +</button>
      </div>
      <div class="feed-list">
        ${
          tasks.length
            ? tasks
                .map((task) => {
                  const linkedContact = task.contactId ? contactById[task.contactId] : null;
                  return `
                    <button class="panel feed-item" data-task-id="${task.id}" type="button">
                      <h3>${task.title || "Untitled Task"}</h3>
                      <p><strong>Scheduled:</strong> ${task.scheduledFor ? formatDate(task.scheduledFor) : "No schedule"}</p>
                      <p><strong>Contact:</strong> ${linkedContact?.name || "No contact"}</p>
                      <p><strong>Status:</strong> ${task.completed ? "Completed" : "Active"}</p>
                    </button>
                  `;
                })
                .join("")
            : '<p class="view-message">No tasks yet.</p>'
        }
      </div>
    </section>
  `;

  document.getElementById("add-task-btn")?.addEventListener("click", () => {
    window.location.hash = "#tasks/new";
  });

  viewContainer.querySelectorAll("[data-task-id]").forEach((taskEl) => {
    taskEl.addEventListener("click", () => {
      window.location.hash = `#task/${taskEl.dataset.taskId}`;
    });
  });
}

async function renderTaskDetail(taskId) {
  renderLoading("Loading task details...");

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
  const contacts = contactsSnapshot.docs.map((contactDoc) => ({ id: contactDoc.id, ...contactDoc.data() }));
  const linkedContact = contacts.find((contact) => contact.id === task.contactId) || null;

  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>${task.title || "Task Detail"}</h2>
        <button id="edit-task-btn" type="button">Edit</button>
      </div>
      <div class="panel detail-grid">
        <p><strong>Notes:</strong> ${task.notes || "-"}</p>
        <p><strong>Contact:</strong> ${linkedContact?.name || "No contact"}</p>
        <p><strong>Scheduled:</strong> ${task.scheduledFor ? formatDate(task.scheduledFor) : "No schedule"}</p>
        <p><strong>Status:</strong> ${task.completed ? "Completed" : "Active"}</p>
        <p><strong>Created:</strong> ${formatDate(task.createdAt)}</p>
        <p><strong>Updated:</strong> ${formatDate(task.updatedAt)}</p>
      </div>
    </section>
  `;

  document.getElementById("edit-task-btn")?.addEventListener("click", () => {
    window.location.hash = `#task/${taskId}/edit`;
  });
}

async function renderEditTaskForm(taskId) {
  renderLoading("Loading task form...");

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
  const contacts = contactsSnapshot.docs.map((contactDoc) => ({ id: contactDoc.id, ...contactDoc.data() }));

  renderTaskForm({
    mode: "edit",
    contacts,
    values: task,
    onSubmit: async (values) => {
      await updateDoc(taskRef, {
        ...values,
        updatedAt: serverTimestamp(),
      });
      window.location.hash = `#task/${taskId}`;
    },
    onCancel: async () => {
      window.location.hash = `#task/${taskId}`;
    },
    onDelete: async () => {
      await deleteDoc(taskRef);
      window.location.hash = "#tasks";
    },
  });
}

async function renderLeadDetail(leadId) {
  renderLoading("Loading lead details...");

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
  const contacts = contactsSnapshot.docs.map((contactDoc) => ({ id: contactDoc.id, ...contactDoc.data() }));
  const linkedContact = contacts.find((contact) => contact.id === lead.contactId) || null;

  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>Lead</h2>
        <button id="edit-lead-btn" type="button">Edit</button>
      </div>
      <div class="panel detail-grid">
        <p><strong>Contact:</strong> ${linkedContact?.name || "No contact"}</p>
        <p><strong>Stage:</strong> ${getStageById(pipelineSettings, lead.stageId)?.label || lead.stageId || "-"}</p>
        <p><strong>Status:</strong> ${lead.stageStatus || "pending"}</p>
        <p><strong>Next Action:</strong> ${lead.nextActionAt ? formatDate(lead.nextActionAt) : "-"}</p>
        <p><strong>Created:</strong> ${formatDate(lead.createdAt)}</p>
        <p><strong>Updated:</strong> ${formatDate(lead.updatedAt)}</p>
      </div>
    </section>
  `;

  document.getElementById("edit-lead-btn")?.addEventListener("click", () => {
    window.location.hash = `#lead/${leadId}/edit`;
  });
}

async function renderEditLeadForm(leadId) {
  renderLoading("Loading lead form...");

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
  const contacts = contactsSnapshot.docs.map((contactDoc) => ({ id: contactDoc.id, ...contactDoc.data() }));
  const linkedContact = contacts.find((contact) => contact.id === lead.contactId) || null;

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

      await updateDoc(leadRef, {
        stageId: values.stageId,
        stageStatus: values.stageStatus || "pending",
        nextActionAt: values.nextActionAt,
        updatedAt: serverTimestamp(),
      });
      window.location.hash = `#lead/${leadId}`;
    },
    onCancel: async () => {
      window.location.hash = `#lead/${leadId}`;
    },
    onDelete: async () => {
      await deleteDoc(leadRef);
      window.location.hash = "#dashboard";
    },
  });
}

async function renderContactDetail(contactId) {
  renderLoading("Loading contact details...");

  const contactRef = doc(db, "users", currentUser.uid, "contacts", contactId);
  const [contactSnapshot, tasksSnapshot] = await Promise.all([
    getDoc(contactRef),
    getDocs(query(collection(db, "users", currentUser.uid, "tasks"), where("contactId", "==", contactId))),
  ]);

  if (!contactSnapshot.exists()) {
    viewContainer.innerHTML = '<p class="view-message">Contact not found.</p>';
    return;
  }

  const contact = contactSnapshot.data();

  const notes = Array.isArray(contact.notes) ? contact.notes : [];
  const tasks = tasksSnapshot.docs.map((taskDoc) => ({ id: taskDoc.id, ...taskDoc.data() }));

  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>${contact.name || "Contact Detail"}</h2>
        <button id="edit-contact-btn" type="button">Edit</button>
      </div>

      <div class="panel detail-grid">
        <p><strong>Email:</strong> ${contact.email || "-"}</p>
        <p><strong>Phone:</strong> ${contact.phone || "-"}</p>
        <p><strong>Created:</strong> ${formatDate(contact.createdAt)}</p>
        <p><strong>Updated:</strong> ${formatDate(contact.updatedAt)}</p>
      </div>

      <div class="panel notes-panel">
        <h3>Tasks</h3>
        <ul class="note-list">
          ${
            tasks.length
              ? tasks
                  .sort((a, b) => (toDate(a.scheduledFor)?.getTime() || 0) - (toDate(b.scheduledFor)?.getTime() || 0))
                  .map(
                    (task) => `<li>
                      <p><strong>${task.title || "Untitled Task"}</strong> · ${task.completed ? "Completed" : "Active"}</p>
                      <small>${formatDate(task.scheduledFor)}${task.notes ? ` · ${task.notes}` : ""}</small>
                    </li>`
                  )
                  .join("")
              : "<li>No tasks linked to this contact.</li>"
          }
        </ul>

        <h3>Notes</h3>
        <ul class="note-list">
          ${
            notes.length
              ? notes
                  .map(
                    (entry) => `<li>
                      <p>${entry.noteText}</p>
                      <small>${formatDate(entry.createdAt)}</small>
                    </li>`
                  )
                  .join("")
              : "<li>No notes yet.</li>"
          }
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
    window.location.hash = `#contact/${contactId}/edit`;
  });

  document.getElementById("add-note-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const noteText = String(new FormData(event.currentTarget).get("noteText") || "").trim();
    if (!noteText) return;

    await updateDoc(contactRef, {
      notes: arrayUnion({ noteText, createdAt: Timestamp.now() }),
      updatedAt: serverTimestamp(),
    });

    await renderContactDetail(contactId);
  });
}

async function renderEditContactForm(contactId) {
  renderLoading("Loading contact form...");

  const contactRef = doc(db, "users", currentUser.uid, "contacts", contactId);
  const contactSnapshot = await getDoc(contactRef);

  if (!contactSnapshot.exists()) {
    viewContainer.innerHTML = '<p class="view-message">Contact not found.</p>';
    return;
  }

  const contact = { id: contactSnapshot.id, ...contactSnapshot.data() };

  renderContactForm({
    mode: "edit",
    values: contact,
    onSubmit: async (values) => {
      await updateDoc(contactRef, {
        ...values,
        updatedAt: serverTimestamp(),
      });
      window.location.hash = `#contact/${contactId}`;
    },
    onCancel: async () => {
      window.location.hash = `#contact/${contactId}`;
    },
    onDelete: async () => {
      await deleteDoc(contactRef);
      window.location.hash = "#contacts";
    },
  });
}

function renderPlaceholder(title) {
  viewContainer.innerHTML = `
    <section>
      <div class="view-header"><h2>${title}</h2></div>
      <p class="view-message">${title} is ready for future configuration.</p>
    </section>
  `;
}

async function renderSettingsPage() {
  renderLoading("Loading settings...");

  const appSettings = await getAppSettings(currentUser.uid);
  const pipelineSettings = appSettings.pipeline;
  const pushPresets = appSettings.pushPresets;

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
                <p><strong>${stage.label}</strong></p>
                <label>Offset Days
                  <input type="number" step="1" name="offset-${index}" value="${stage.offsetDays}" required />
                </label>
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
                  <input name="push-label-${index}" value="${preset.label}" required />
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

  document.getElementById("pipeline-settings-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const dayStartTime = sanitizeTimeString(String(formData.get("dayStartTime") || "08:30"));
    const stages = pipelineSettings.stages.map((stage, index) => ({
      ...stage,
      offsetDays: Number.parseInt(String(formData.get(`offset-${index}`) || stage.offsetDays), 10),
    }));

    if (stages.some((stage) => Number.isNaN(stage.offsetDays) || stage.offsetDays < 0)) {
      alert("Offset days must be a non-negative integer.");
      return;
    }

    const pushPresetsPayload = pushPresets.map((_, index) => {
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
      pipeline: { dayStartTime, stages },
      pushPresets: pushPresetsPayload,
    });
    await setDoc(pipelineSettingsRef(currentUser.uid), normalized);
    await renderSettingsPage();
  });
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

    if (route.page === "tasks") {
      await renderTasksPage();
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

    await renderCurrentRoute();
  } else {
    authPage.classList.remove("hidden");
    appPage.classList.add("hidden");
    setStatus("Please log in to continue.");
  }
});

window.addEventListener("hashchange", () => {
  renderCurrentRoute();
});
