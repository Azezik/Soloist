import { Timestamp, collection, db, doc, getDocs, serverTimestamp, updateDoc } from "./firestore-service.js";

export async function getCalendarData(currentUserId) {
  const [contactsSnapshot, tasksSnapshot, leadsSnapshot] = await Promise.all([
    getDocs(collection(db, "users", currentUserId, "contacts")),
    getDocs(collection(db, "users", currentUserId, "tasks")),
    getDocs(collection(db, "users", currentUserId, "leads")),
  ]);

  const contactsById = contactsSnapshot.docs.reduce((acc, docItem) => {
    acc[docItem.id] = { id: docItem.id, ...docItem.data() };
    return acc;
  }, {});

  const tasks = tasksSnapshot.docs
    .map((taskDoc) => ({ id: taskDoc.id, ...taskDoc.data() }))
    .filter((task) => !task.completed && !task.archived);

  const leads = leadsSnapshot.docs
    .map((leadDoc) => ({ id: leadDoc.id, ...leadDoc.data() }))
    .filter((lead) => lead.stageStatus !== "completed" && !lead.archived)
    .map((lead) => {
      const linkedContact = lead.contactId ? contactsById[lead.contactId] : null;
      return {
        ...lead,
        name: linkedContact?.name || lead.name || "",
        company: linkedContact?.company || lead.company || "",
        email: linkedContact?.email || lead.email || "",
      };
    });

  return { tasks, leads };
}

export async function updateCalendarItemSchedule(currentUserId, calendarItem, nextDate) {
  if (!currentUserId || !calendarItem?.id || !calendarItem?.type || !(nextDate instanceof Date)) return;

  const isTask = calendarItem.type === "task";
  const itemRef = doc(db, "users", currentUserId, isTask ? "tasks" : "leads", calendarItem.id);
  const dateField = isTask ? "scheduledFor" : "nextActionAt";

  await updateDoc(itemRef, {
    [dateField]: Timestamp.fromDate(nextDate),
    updatedAt: serverTimestamp(),
  });
}
