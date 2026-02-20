import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";

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
