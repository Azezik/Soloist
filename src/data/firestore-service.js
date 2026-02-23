import {
  auth,
  db,
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc as rawGetDoc,
  getDocs as rawGetDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from "../firebase/client.js";

function describeFirestoreTarget(target) {
  const path = target?.path;
  if (path) return path;

  const queryPath = target?._query?.path?.canonicalString?.();
  if (queryPath) return queryPath;

  return "<unknown-path>";
}

function logFirestoreRead(opName, target) {
  const authUid = auth.currentUser?.uid || null;
  console.info(`[firestore:${opName}] auth.currentUser?.uid=${authUid} target=${describeFirestoreTarget(target)}`);
}

async function getDoc(ref) {
  logFirestoreRead("getDoc", ref);
  return rawGetDoc(ref);
}

async function getDocs(refOrQuery) {
  logFirestoreRead("getDocs", refOrQuery);
  return rawGetDocs(refOrQuery);
}

export {
  auth,
  db,
  addDoc,
  collection,
  deleteDoc,
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
};
