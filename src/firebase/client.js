import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app-check.js";
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
initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider("6LcwdnMsAAAAAGS8urVdkRWv0w9TzqL44M5wqYQo"),
  isTokenAutoRefreshEnabled: true,
});
const auth = getAuth(app);
const db = getFirestore(app);

export {
  app,
  auth,
  db,
  addDoc,
  collection,
  createUserWithEmailAndPassword,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onAuthStateChanged,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  signInWithEmailAndPassword,
  signOut,
  Timestamp,
  updateDoc,
  where,
};
