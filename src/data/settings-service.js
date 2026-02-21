import { db, doc, getDoc, setDoc } from "./firestore-service.js";
import { cloneDefaultAppSettings, normalizeAppSettings } from "../domain/settings.js";

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

export { getAppSettings, getPipelineSettings, pipelineSettingsRef };
