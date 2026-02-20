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
  doc,
  getDoc,
  getDocs,
  getFirestore,
  orderBy,
  query,
  serverTimestamp,
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
      "Update Firebase Firestore Security Rules to allow authenticated users to read and write users/{userId}/contacts and users/{userId}/tasks.",
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
    return Timestamp.now();
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
  if (hash === "add-task") return { page: "add-task" };
  if (hash === "promotions") return { page: "promotions" };
  if (hash === "settings") return { page: "settings" };
  if (hash.startsWith("contact/")) {
    return { page: "contact-detail", contactId: hash.split("/")[1] };
  }

  return { page: "dashboard" };
}

function renderLoading(text = "Loading...") {
  viewContainer.innerHTML = `<p class="view-message">${text}</p>`;
}

async function renderDashboard() {
  renderLoading("Loading dashboard feed...");

  const now = Timestamp.now();

  const contactsPromise = getDocs(
    query(collection(db, "users", currentUser.uid, "contacts"), orderBy("createdAt", "desc"))
  );
  const tasksPromise = getDocs(
    query(
      collection(db, "users", currentUser.uid, "tasks"),
      where("completed", "==", false),
      where("scheduledFor", "<=", now),
      orderBy("scheduledFor", "asc")
    )
  );

  const [contactsSnapshot, tasksSnapshot] = await Promise.all([contactsPromise, tasksPromise]);

  const feedItems = [
    ...contactsSnapshot.docs.map((contactDoc) => {
      const data = contactDoc.data();
      return {
        type: "contact",
        id: contactDoc.id,
        title: data.name || "Unnamed Contact",
        subtitle: `${data.stage || "Stage 1"} · ${data.status || "Open"}`,
        time: data.createdAt || data.updatedAt,
      };
    }),
    ...tasksSnapshot.docs.map((taskDoc) => {
      const data = taskDoc.data();
      return {
        type: "task",
        id: taskDoc.id,
        title: data.title || "Untitled Task",
        subtitle: data.notes || "No task notes",
        contactId: data.contactId || "",
        time: data.scheduledFor || data.createdAt,
      };
    }),
  ].sort((a, b) => {
    const first = toDate(a.time)?.getTime() || 0;
    const second = toDate(b.time)?.getTime() || 0;
    return first - second;
  });

  const feedMarkup = feedItems.length
    ? feedItems
        .map((item) => {
          if (item.type === "task") {
            const contactLink = item.contactId
              ? `<a href="#contact/${item.contactId}" class="inline-link">View linked contact</a>`
              : "No linked contact";
            return `
              <article class="panel feed-item">
                <p class="feed-type">Task</p>
                <h3>${item.title}</h3>
                <p>${item.subtitle}</p>
                <p><strong>Scheduled:</strong> ${formatDate(item.time)}</p>
                <p>${contactLink}</p>
              </article>
            `;
          }

          return `
            <button class="panel feed-item" data-contact-id="${item.id}" type="button">
              <p class="feed-type">Contact</p>
              <h3>${item.title}</h3>
              <p>${item.subtitle}</p>
              <p><strong>Added:</strong> ${formatDate(item.time)}</p>
            </button>
          `;
        })
        .join("")
    : '<p class="view-message">No feed items yet. Add a contact or task to begin.</p>';

  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>Dashboard Feed</h2>
      </div>
      <div class="feed-list">${feedMarkup}</div>
    </section>
  `;

  viewContainer.querySelectorAll("[data-contact-id]").forEach((itemEl) => {
    itemEl.addEventListener("click", () => {
      window.location.hash = `#contact/${itemEl.dataset.contactId}`;
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

  const stageOptions = ["All", ...new Set(contacts.map((contact) => contact.stage || "Stage 1"))];

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
              .map((stage) => `<option value="${stage}">${stage}</option>`)
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
      const matchesStage = stageValue === "All" || (contact.stage || "Stage 1") === stageValue;

      const hasTasks = Boolean(taskCountByContact[contact.id]);
      const matchesTaskFilter =
        taskFilter === "all" || (taskFilter === "with" ? hasTasks : !hasTasks);

      return matchesSearch && matchesStage && matchesTaskFilter;
    });

    const listEl = document.getElementById("contacts-list");
    listEl.innerHTML = filtered.length
      ? filtered
          .map(
            (contact) => `
              <button class="panel feed-item" data-contact-id="${contact.id}" type="button">
                <h3>${contact.name || "Unnamed Contact"}</h3>
                <p>${contact.email || "No email"}</p>
                <p>${contact.stage || "Stage 1"} · ${contact.status || "Open"}</p>
                <p><strong>Tasks:</strong> ${taskCountByContact[contact.id] || 0}</p>
              </button>
            `
          )
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

function renderAddContactForm() {
  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>Add Contact</h2>
      </div>
      <form id="add-contact-form" class="panel form-grid">
        <label>Name <input name="name" required /></label>
        <label>Email <input name="email" type="email" /></label>
        <label>Phone <input name="phone" type="tel" /></label>
        <label>Product <input name="product" /></label>
        <label>Price Quoted <input name="priceQuoted" /></label>

        <label>Status
          <select name="status">
            <option value="Open" selected>Open</option>
            <option value="Closed">Closed</option>
          </select>
        </label>

        <button type="submit" class="full-width">Save Contact</button>
      </form>
    </section>
  `;

  document.getElementById("add-contact-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);

    const payload = {
      name: String(formData.get("name") || "").trim(),
      email: String(formData.get("email") || "").trim(),
      phone: String(formData.get("phone") || "").trim(),
      product: String(formData.get("product") || "").trim(),
      priceQuoted: String(formData.get("priceQuoted") || "").trim(),
      stage: "Stage 1",
      status: String(formData.get("status") || "Open"),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      notes: [],
    };

    if (!payload.name) {
      alert("Name is required.");
      return;
    }

    await addDoc(collection(db, "users", currentUser.uid, "contacts"), payload);
    window.location.hash = "#contacts";
  });
}

async function renderAddTaskForm() {
  renderLoading("Loading contacts for task creation...");

  const contactsSnapshot = await getDocs(
    query(collection(db, "users", currentUser.uid, "contacts"), orderBy("name", "asc"))
  );

  const contacts = contactsSnapshot.docs.map((contactDoc) => ({ id: contactDoc.id, ...contactDoc.data() }));

  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>Add Task</h2>
      </div>
      <form id="add-task-form" class="panel form-grid">
        <label>Title <input name="title" required /></label>
        <label class="full-width">Notes <textarea name="notes" rows="4"></textarea></label>

        <label>Contact (Optional)
          <select name="contactId">
            <option value="">No contact</option>
            ${contacts
              .map((contact) => `<option value="${contact.id}">${contact.name || contact.email || contact.id}</option>`)
              .join("")}
          </select>
        </label>

        <label>Date (Optional)
          <input name="scheduledDate" type="date" />
        </label>

        <label>Time (Optional)
          <input name="scheduledTime" type="time" />
        </label>

        <button type="submit" class="full-width">Save Task</button>
      </form>
    </section>
  `;

  document.getElementById("add-task-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const scheduledFor = parseScheduledFor(
      String(formData.get("scheduledDate") || "").trim(),
      String(formData.get("scheduledTime") || "").trim()
    );

    if (!scheduledFor) {
      alert("Please provide a valid date/time.");
      return;
    }

    const payload = {
      title: String(formData.get("title") || "").trim(),
      notes: String(formData.get("notes") || "").trim(),
      contactId: String(formData.get("contactId") || "").trim() || null,
      scheduledFor,
      completed: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (!payload.title) {
      alert("Title is required.");
      return;
    }

    await addDoc(collection(db, "users", currentUser.uid, "tasks"), payload);
    window.location.hash = "#dashboard";
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
      </div>

      <div class="panel detail-grid">
        <p><strong>Email:</strong> ${contact.email || "-"}</p>
        <p><strong>Phone:</strong> ${contact.phone || "-"}</p>
        <p><strong>Product:</strong> ${contact.product || "-"}</p>
        <p><strong>Price Quoted:</strong> ${contact.priceQuoted || "-"}</p>
        <p><strong>Status:</strong> ${contact.status || "Open"}</p>
        <p><strong>Stage:</strong> ${contact.stage || "Stage 1"}</p>
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
      renderAddContactForm();
      return;
    }

    if (route.page === "add-task") {
      await renderAddTaskForm();
      return;
    }

    if (route.page === "contact-detail" && route.contactId) {
      await renderContactDetail(route.contactId);
      return;
    }

    if (route.page === "promotions") {
      renderPlaceholder("Promotions");
      return;
    }

    if (route.page === "settings") {
      renderPlaceholder("Settings");
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
