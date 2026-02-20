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
      "Update Firebase Firestore Security Rules to allow authenticated users to read and write their own leads under users/{userId}/leads.",
    ].join(" ");
  }

  return `Firestore request failed (${errorCode}). Check Firestore rules and indexes in Firebase Console.`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return date.toLocaleString();
}

function routeFromHash() {
  if (!window.location.hash || window.location.hash === "#") {
    return { page: "dashboard" };
  }

  const hash = window.location.hash.slice(1);
  if (hash === "dashboard") return { page: "dashboard" };
  if (hash === "new-lead") return { page: "new-lead" };
  if (hash.startsWith("lead/")) {
    return { page: "lead-detail", leadId: hash.split("/")[1] };
  }

  return { page: "dashboard" };
}

function renderLoading(text = "Loading...") {
  viewContainer.innerHTML = `<p class="view-message">${text}</p>`;
}

async function renderDashboard() {
  renderLoading("Loading leads...");

  const leadsQuery = query(
    collection(db, "users", currentUser.uid, "leads"),
    orderBy("createdAt", "desc")
  );

  const snapshot = await getDocs(leadsQuery);
  const leads = snapshot.docs.map((leadDoc) => ({ id: leadDoc.id, ...leadDoc.data() }));

  const feedMarkup = leads.length
    ? leads
        .map(
          (lead) => `
            <button class="lead-card" data-lead-id="${lead.id}" type="button">
              <h3>${lead.name || "Unnamed Lead"}</h3>
              <p>${lead.product || "No Product"}</p>
              <p>${lead.stage || "Stage 1"}</p>
            </button>
          `
        )
        .join("")
    : '<p class="view-message">No leads yet. Click <strong>+ New Lead</strong> to add one.</p>';

  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>Dashboard Feed</h2>
        <button id="new-lead-btn" type="button">+ New Lead</button>
      </div>
      <div class="lead-feed">${feedMarkup}</div>
    </section>
  `;

  document.getElementById("new-lead-btn")?.addEventListener("click", () => {
    window.location.hash = "#new-lead";
  });

  viewContainer.querySelectorAll(".lead-card").forEach((card) => {
    card.addEventListener("click", () => {
      const { leadId } = card.dataset;
      window.location.hash = `#lead/${leadId}`;
    });
  });
}

function renderNewLeadForm() {
  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>New Lead</h2>
      </div>
      <form id="new-lead-form" class="panel form-grid">
        <label>Name <input name="name" required /></label>
        <label>Email <input name="email" type="email" /></label>
        <label>Phone <input name="phone" type="tel" /></label>
        <label>Product <input name="product" /></label>
        <label>Price Quoted <input name="priceQuoted" /></label>
        <label class="full-width">Notes <textarea name="notes" rows="5"></textarea></label>

        <label>Status
          <select name="status">
            <option value="Open" selected>Open</option>
            <option value="Closed">Closed</option>
          </select>
        </label>

        <p class="meta-note">Stage defaults to Stage 1.</p>

        <button type="submit" class="full-width">Save</button>
      </form>
    </section>
  `;

  const formEl = document.getElementById("new-lead-form");
  formEl.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(formEl);
    const nowTimestamp = serverTimestamp();

    const leadPayload = {
      name: String(formData.get("name") || "").trim(),
      email: String(formData.get("email") || "").trim(),
      phone: String(formData.get("phone") || "").trim(),
      product: String(formData.get("product") || "").trim(),
      priceQuoted: String(formData.get("priceQuoted") || "").trim(),
      notes: String(formData.get("notes") || "").trim(),
      stage: "Stage 1",
      status: String(formData.get("status") || "Open"),
      createdAt: nowTimestamp,
      lastUpdatedAt: nowTimestamp,
      userId: currentUser.uid,
      noteEntries: [],
    };

    if (!leadPayload.name) {
      alert("Name is required.");
      return;
    }

    const leadsCollection = collection(db, "users", currentUser.uid, "leads");
    await addDoc(leadsCollection, leadPayload);

    window.location.hash = "#dashboard";
  });
}

async function renderLeadDetail(leadId) {
  renderLoading("Loading lead details...");

  const leadRef = doc(db, "users", currentUser.uid, "leads", leadId);
  const leadSnapshot = await getDoc(leadRef);

  if (!leadSnapshot.exists()) {
    viewContainer.innerHTML = '<p class="view-message">Lead not found.</p>';
    return;
  }

  const lead = leadSnapshot.data();
  const noteEntries = Array.isArray(lead.noteEntries) ? lead.noteEntries : [];

  viewContainer.innerHTML = `
    <section>
      <div class="view-header">
        <h2>${lead.name || "Lead Detail"}</h2>
      </div>
      <div class="panel detail-grid">
        <p><strong>Email:</strong> ${lead.email || "-"}</p>
        <p><strong>Phone:</strong> ${lead.phone || "-"}</p>
        <p><strong>Product:</strong> ${lead.product || "-"}</p>
        <p><strong>Price Quoted:</strong> ${lead.priceQuoted || "-"}</p>
        <p><strong>Status:</strong> ${lead.status || "Open"}</p>
        <p><strong>Stage:</strong> ${lead.stage || "Stage 1"}</p>
        <p><strong>Created:</strong> ${formatDate(lead.createdAt)}</p>
      </div>

      <div class="panel notes-panel">
        <h3>Notes</h3>
        <p class="lead-notes">${lead.notes || "No general notes."}</p>

        <h4>Timeline Notes</h4>
        <ul class="note-list">
          ${
            noteEntries.length
              ? noteEntries
                  .map(
                    (entry) => `<li>
                      <p>${entry.noteText}</p>
                      <small>${formatDate(entry.createdAt)} · ${entry.userId}</small>
                    </li>`
                  )
                  .join("")
              : "<li>No timeline notes yet.</li>"
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

  const addNoteForm = document.getElementById("add-note-form");
  addNoteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const noteText = String(new FormData(addNoteForm).get("noteText") || "").trim();

    if (!noteText) return;

    await updateDoc(leadRef, {
      noteEntries: arrayUnion({
        noteText,
        createdAt: new Date().toISOString(),
        userId: currentUser.uid,
      }),
      lastUpdatedAt: serverTimestamp(),
    });

    await renderLeadDetail(leadId);
  });
}

async function renderCurrentRoute() {
  if (!currentUser) return;

  const route = routeFromHash();

  try {
    if (route.page === "new-lead") {
      renderNewLeadForm();
      return;
    }

    if (route.page === "lead-detail" && route.leadId) {
      await renderLeadDetail(route.leadId);
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
