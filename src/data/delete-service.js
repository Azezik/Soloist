import {
  collection,
  db,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "./firestore-service.js";

function getEntityCollectionName(entityType) {
  if (entityType === "contact") return "contacts";
  if (entityType === "lead") return "leads";
  if (entityType === "task") return "tasks";
  throw new Error(`Unsupported entity type: ${entityType}`);
}

async function softDeleteRecord(ref, deletedBy) {
  const snapshot = await getDoc(ref);
  if (!snapshot.exists()) return { existed: false, alreadyDeleted: true };

  const data = snapshot.data();
  if (data.deleted === true) return { existed: true, alreadyDeleted: true };

  await updateDoc(ref, {
    deleted: true,
    deletedAt: serverTimestamp(),
    deletedBy: deletedBy || null,
    updatedAt: serverTimestamp(),
  });

  return { existed: true, alreadyDeleted: false };
}

async function softDeleteByContactId(currentUserId, collectionName, contactId, deletedBy) {
  const snapshot = await getDocs(
    query(collection(db, "users", currentUserId, collectionName), where("contactId", "==", contactId))
  );

  await Promise.all(snapshot.docs.map((itemDoc) => softDeleteRecord(itemDoc.ref, deletedBy)));
}

export async function deleteEntity(entityType, id, options = {}) {
  const { currentUserId, deletedBy } = options;
  if (!currentUserId || !entityType || !id) return { deleted: false, existed: false };

  const collectionName = getEntityCollectionName(entityType);
  const entityRef = doc(db, "users", currentUserId, collectionName, id);

  if (entityType === "contact") {
    await softDeleteByContactId(currentUserId, "leads", id, deletedBy || currentUserId);
    await softDeleteByContactId(currentUserId, "tasks", id, deletedBy || currentUserId);
  }

  const result = await softDeleteRecord(entityRef, deletedBy || currentUserId);
  return { deleted: true, existed: result.existed, alreadyDeleted: result.alreadyDeleted };
}
