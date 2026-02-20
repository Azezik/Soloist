import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";

/**
 * TODO: Replace this with your actual Firebase project settings.
 * Firebase Console > Project Settings > General > Your Apps > SDK setup and configuration
 */
const firebaseConfig = {
  apiKey: "REPLACE_WITH_FIREBASE_API_KEY",
  authDomain: "REPLACE_WITH_FIREBASE_AUTH_DOMAIN",
  projectId: "REPLACE_WITH_FIREBASE_PROJECT_ID",
  storageBucket: "REPLACE_WITH_FIREBASE_STORAGE_BUCKET",
  messagingSenderId: "REPLACE_WITH_FIREBASE_MESSAGING_SENDER_ID",
  appId: "REPLACE_WITH_FIREBASE_APP_ID",
};

const isConfigured = !Object.values(firebaseConfig).some((value) =>
  value.startsWith("REPLACE_WITH_")
);

const statusEl = document.getElementById("auth-status");
const emailEl = document.getElementById("email");
const passwordEl = document.getElementById("password");
const loginBtn = document.getElementById("login-btn");
const signupBtn = document.getElementById("signup-btn");

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

if (!isConfigured) {
  setStatus("Add your Firebase config in firebase-auth.js to enable authentication.");
  loginBtn.disabled = true;
  signupBtn.disabled = true;
} else {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);

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
      setStatus(`Signup failed: ${error.message}`);
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
      setStatus(`Login failed: ${error.message}`);
    }
  });
}
