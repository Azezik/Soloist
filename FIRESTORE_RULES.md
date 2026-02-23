# Firestore security rules for SoloistCRM

If your app can log in but fails with `FirebaseError: Missing or insufficient permissions`, your current Firestore rules are blocking reads/writes.

## Recommended starter rules

Use these rules so each authenticated user can access only their own CRM data (contacts, leads, tasks, notes, settings, promotions, promotion events, and promotion snapshots):

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/contacts/{contactId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    match /users/{userId}/leads/{leadId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    match /users/{userId}/tasks/{taskId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    match /users/{userId}/notes/{noteId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    match /users/{userId}/promotions/{promotionId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    match /users/{userId}/promotions/{promotionId}/snapshots/{snapshotId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    match /users/{userId}/promotionEvents/{eventId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    match /users/{userId}/settings/{settingId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

## Why this matches the app

The app reads/writes at:

- `users/{currentUser.uid}/contacts`
- `users/{currentUser.uid}/contacts/{contactId}`
- `users/{currentUser.uid}/leads`
- `users/{currentUser.uid}/leads/{leadId}`
- `users/{currentUser.uid}/tasks`
- `users/{currentUser.uid}/tasks/{taskId}`
- `users/{currentUser.uid}/notes`
- `users/{currentUser.uid}/notes/{noteId}`
- `users/{currentUser.uid}/promotions`
- `users/{currentUser.uid}/promotions/{promotionId}`
- `users/{currentUser.uid}/promotions/{promotionId}/snapshots/{leadId}`
- `users/{currentUser.uid}/promotionEvents`
- `users/{currentUser.uid}/promotionEvents/{eventId}`
- `users/{currentUser.uid}/settings/pipeline`

So rules must explicitly allow those paths for the signed-in user's UID.

## Firebase Console quick apply

1. Open **Firestore Database → Rules**.
2. Replace your rules with either:
   - the full strict rules from this repo's `firestore.rules`, or
   - the starter snippet above.
3. Click **Publish**.
4. Refresh SoloistCRM.
