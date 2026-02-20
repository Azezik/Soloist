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

function cloneDefaultPipelineSettings() {
  return {
    dayStartTime: DEFAULT_PIPELINE_SETTINGS.dayStartTime,
    stages: DEFAULT_PIPELINE_SETTINGS.stages.map((stage) => ({ ...stage })),
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

function pipelineSettingsRef(uid) {
  return doc(db, "users", uid, "settings", "pipeline");
}

async function getPipelineSettings(uid) {
  const settingsRef = pipelineSettingsRef(uid);
  const settingsSnapshot = await getDoc(settingsRef);

  if (!settingsSnapshot.exists()) {
    const defaults = cloneDefaultPipelineSettings();
    await setDoc(settingsRef, defaults);
    return defaults;
  }

  return normalizePipelineSettings(settingsSnapshot.data());
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
  const pipelineSettings = await getPipelineSettings(currentUser.uid);

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
        subtitle: contact.product || "No product",
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
      subtitle: contact.product || "No product",
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

  const feedItems = [...dueLeads, ...legacyDueLeads, ...dueTasks].sort(
    (a, b) => (toDate(a.dueAt)?.getTime() || 0) - (toDate(b.dueAt)?.getTime() || 0)
  );

  const feedMarkup = feedItems.length
    ? feedItems
        .map((item) => {
          if (item.type === "lead") {
            const stageLabel = getStageById(pipelineSettings, item.stageId)?.label || "Unknown stage";
            return `
              <article class="panel feed-item${item.contactId ? " feed-item-clickable" : ""}" ${
                item.contactId ? `data-open-contact-card="true" data-contact-id="${item.contactId}" tabindex="0" role="button"` : ""
              }>
                <p class="feed-type">Lead</p>
                <h3>${item.title}</h3>
                <p>${item.subtitle}</p>
                <p><strong>Stage:</strong> ${stageLabel}</p>
                <p><strong>Due:</strong> ${formatDate(item.dueAt)}</p>
                <div class="button-row">
                  ${item.source === "leads" ? `<button type="button" data-open-lead-id="${item.id}">View</button>` : ""}
                  <button type="button" data-lead-action="done" data-lead-source="${item.source}" data-lead-id="${item.id}">Done</button>
                  <button type="button" class="secondary-btn" data-lead-action="push" data-lead-source="${item.source}" data-lead-id="${item.id}">Push</button>
                </div>
              </article>
            `;
          }

          return `
            <article class="panel feed-item${item.contactId ? " feed-item-clickable" : ""}" ${
              item.contactId ? `data-open-contact-card="true" data-contact-id="${item.contactId}" tabindex="0" role="button"` : ""
            }>
              <p class="feed-type">Task</p>
              <h3>${item.title}</h3>
              <p>${item.subtitle}</p>
              <p><strong>Due:</strong> ${formatDate(item.dueAt)}</p>
              ${item.notes ? `<p>${item.notes}</p>` : ""}
              <div class="button-row">
                <button type="button" data-open-task-id="${item.id}">View</button>
                <button type="button" data-task-action="complete" data-task-id="${item.id}">Complete</button>
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

  viewContainer.querySelectorAll('[data-open-contact-card="true"]').forEach((itemEl) => {
    const navigateToContact = () => {
      window.location.hash = `#contact/${itemEl.dataset.contactId}`;
    };

    itemEl.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      navigateToContact();
    });

    itemEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      navigateToContact();
    });
  });

  viewContainer.querySelectorAll("[data-open-lead-id]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", () => {
      const leadId = buttonEl.dataset.openLeadId;
      if (!leadId) return;
      window.location.hash = `#lead/${leadId}`;
    });
  });

  viewContainer.querySelectorAll("[data-open-task-id]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", () => {
      const taskId = buttonEl.dataset.openTaskId;
      if (!taskId) return;
      window.location.hash = `#task/${taskId}`;
    });
  });

  viewContainer.querySelectorAll("[data-lead-action]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", async () => {
      const leadId = buttonEl.dataset.leadId;
      const leadSource = buttonEl.dataset.leadSource;
      if (!leadId || !leadSource) return;

      const action = buttonEl.dataset.leadAction;
      const nowDate = new Date();
      const leadRef = doc(db, "users", currentUser.uid, leadSource, leadId);
      const leadSnapshot = await getDoc(leadRef);
      if (!leadSnapshot.exists()) return;
      const lead = leadSnapshot.data();

      if (action === "push") {
        const nextActionAt = computeNextActionAt(nowDate, 1, pipelineSettings.dayStartTime);
        await updateDoc(leadRef, {
          nextActionAt,
          lastActionAt: Timestamp.fromDate(nowDate),
          updatedAt: serverTimestamp(),
        });
        await renderDashboard();
        return;
      }

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
}

async function renderContactsPage() {
  renderLoading("Loading contacts...");

  const [pipelineSettings, contactsSnapshot, tasksSnapshot] = await Promise.all([
    getPipelineSettings(currentUser.uid),
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

  const stageOptions = ["All", ...pipelineSettings.stages.map((stage) => stage.id)];

  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>Contacts</h2>
        <button id="add-contact-btn" type="button">+ Add Contact</button>
      </div>

      <div class="panel filters-grid">
        <label>Search
          <input id="contact-search" placeholder="Name, email, product" />
        </label>

        <label>Stage
          <select id="stage-filter">
            ${stageOptions
              .map((stageId) => {
                const label = stageId === "All" ? "All" : getStageById(pipelineSettings, stageId)?.label || stageId;
                return `<option value="${stageId}">${label}</option>`;
              })
              .join("")}
          </select>
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
    const stageValue = document.getElementById("stage-filter")?.value || "All";
    const taskFilter = document.getElementById("task-filter")?.value || "all";

    const filtered = contacts.filter((contact) => {
      const haystack = `${contact.name || ""} ${contact.email || ""} ${contact.product || ""}`.toLowerCase();
      const matchesSearch = !searchValue || haystack.includes(searchValue);
      const stageId = contact.stageId || pipelineSettings.stages[0]?.id;
      const matchesStage = stageValue === "All" || stageId === stageValue;

      const hasTasks = Boolean(taskCountByContact[contact.id]);
      const matchesTaskFilter =
        taskFilter === "all" || (taskFilter === "with" ? hasTasks : !hasTasks);

      return matchesSearch && matchesStage && matchesTaskFilter;
    });

    const listEl = document.getElementById("contacts-list");
    listEl.innerHTML = filtered.length
      ? filtered
          .map((contact) => {
            const stageLabel = getStageById(pipelineSettings, contact.stageId)?.label || contact.stage || "Unknown stage";
            return `
              <button class="panel feed-item" data-contact-id="${contact.id}" type="button">
                <h3>${contact.name || "Unnamed Contact"}</h3>
                <p>${contact.email || "No email"}</p>
                <p>${stageLabel} · ${contact.status || "Open"}</p>
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

  ["contact-search", "stage-filter", "task-filter"].forEach((id) => {
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
    product: String(formData.get("product") || "").trim(),
    priceQuoted: String(formData.get("priceQuoted") || "").trim(),
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
        <label>Product <input name="product" value="${values.product || ""}" /></label>
        <label>Price Quoted <input name="priceQuoted" value="${values.priceQuoted || ""}" /></label>

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
    contactId: String(formData.get("contactId") || "").trim() || null,
    stageId: String(formData.get("stageId") || "").trim(),
    stageStatus: String(formData.get("stageStatus") || "pending").trim() || "pending",
    nextActionAt,
  };
}

function renderLeadForm({ mode, pipelineSettings, contacts, values, onSubmit, onCancel, onDelete }) {
  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>${mode === "create" ? "New Lead" : "Edit Lead"}</h2>
      </div>
      <form id="lead-form" class="panel form-grid">
        <label>Contact
          <select name="contactId">
            <option value="">No contact</option>
            ${contacts
              .map((contact) => `<option value="${contact.id}" ${values.contactId === contact.id ? "selected" : ""}>${contact.name || contact.email || contact.id}</option>`)
              .join("")}
          </select>
        </label>

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

  document.getElementById("lead-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const payload = parseLeadFormValues(event.currentTarget);
      if (!payload.stageId) {
        alert("Stage is required.");
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
  const scheduledFor = parseScheduledFor(scheduledDate, scheduledTime);

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
  const pipelineSettings = await getPipelineSettings(currentUser.uid);
  const firstStageId = pipelineSettings.stages[0]?.id || "stage1";

  renderContactForm({
    mode: "create",
    values: {},
    onSubmit: async (values) => {
      const now = Timestamp.now();
      await addDoc(collection(db, "users", currentUser.uid, "contacts"), {
        ...values,
        stageId: firstStageId,
        status: "Open",
        createdAt: now,
        nextActionAt: now,
        lastActionAt: now,
        updatedAt: serverTimestamp(),
        notes: [],
      });
      window.location.hash = "#dashboard";
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
      await addDoc(collection(db, "users", currentUser.uid, "leads"), {
        ...values,
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

async function renderTaskDetail(taskId, mode = "view") {
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

  if (mode === "edit") {
    renderTaskForm({
      mode: "edit",
      contacts,
      values: task,
      onSubmit: async (values) => {
        await updateDoc(taskRef, {
          ...values,
          updatedAt: serverTimestamp(),
        });
        await renderTaskDetail(taskId, "view");
      },
      onCancel: async () => {
        await renderTaskDetail(taskId, "view");
      },
      onDelete: async () => {
        await deleteDoc(taskRef);
        window.location.hash = "#tasks";
      },
    });
    return;
  }

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
    renderTaskDetail(taskId, "edit");
  });
}

async function renderLeadDetail(leadId, mode = "view") {
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

  if (mode === "edit") {
    renderLeadForm({
      mode: "edit",
      pipelineSettings,
      contacts,
      values: lead,
      onSubmit: async (values) => {
        await updateDoc(leadRef, {
          ...values,
          updatedAt: serverTimestamp(),
        });
        await renderLeadDetail(leadId, "view");
      },
      onCancel: async () => {
        await renderLeadDetail(leadId, "view");
      },
      onDelete: async () => {
        await deleteDoc(leadRef);
        window.location.hash = "#dashboard";
      },
    });
    return;
  }

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
    renderLeadDetail(leadId, "edit");
  });
}

async function renderContactDetail(contactId, mode = "view") {
  renderLoading("Loading contact details...");

  const contactRef = doc(db, "users", currentUser.uid, "contacts", contactId);
  const [pipelineSettings, contactSnapshot, tasksSnapshot] = await Promise.all([
    getPipelineSettings(currentUser.uid),
    getDoc(contactRef),
    getDocs(query(collection(db, "users", currentUser.uid, "tasks"), where("contactId", "==", contactId))),
  ]);

  if (!contactSnapshot.exists()) {
    viewContainer.innerHTML = '<p class="view-message">Contact not found.</p>';
    return;
  }

  const contact = contactSnapshot.data();

  if (mode === "edit") {
    renderContactForm({
      mode: "edit",
      values: contact,
      onSubmit: async (values) => {
        await updateDoc(contactRef, {
          ...values,
          updatedAt: serverTimestamp(),
        });
        await renderContactDetail(contactId, "view");
      },
      onCancel: async () => {
        await renderContactDetail(contactId, "view");
      },
      onDelete: async () => {
        await deleteDoc(contactRef);
        window.location.hash = "#contacts";
      },
    });
    return;
  }

  const notes = Array.isArray(contact.notes) ? contact.notes : [];
  const tasks = tasksSnapshot.docs.map((taskDoc) => ({ id: taskDoc.id, ...taskDoc.data() }));
  const stageLabel = getStageById(pipelineSettings, contact.stageId)?.label || contact.stage || "Unknown stage";

  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>${contact.name || "Contact Detail"}</h2>
        <button id="edit-contact-btn" type="button">Edit</button>
      </div>

      <div class="panel detail-grid">
        <p><strong>Email:</strong> ${contact.email || "-"}</p>
        <p><strong>Phone:</strong> ${contact.phone || "-"}</p>
        <p><strong>Product:</strong> ${contact.product || "-"}</p>
        <p><strong>Price Quoted:</strong> ${contact.priceQuoted || "-"}</p>
        <p><strong>Status:</strong> ${contact.status || "Open"}</p>
        <p><strong>Stage:</strong> ${stageLabel}</p>
        <p><strong>Next Action:</strong> ${formatDate(contact.nextActionAt)}</p>
        <p><strong>Last Action:</strong> ${formatDate(contact.lastActionAt)}</p>
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
    renderContactDetail(contactId, "edit");
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

  const pipelineSettings = await getPipelineSettings(currentUser.uid);

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

        <button type="submit" class="full-width">Save Pipeline Settings</button>
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

    const normalized = normalizePipelineSettings({ dayStartTime, stages });
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

    if (route.page === "lead-detail" && route.leadId) {
      await renderLeadDetail(route.leadId);
      return;
    }

    if (route.page === "task-detail" && route.taskId) {
      await renderTaskDetail(route.taskId);
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
