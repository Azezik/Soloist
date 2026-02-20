# Firestore security rules for SoloistCRM

If your app can log in but fails with `FirebaseError: Missing or insufficient permissions`, your current Firestore rules are blocking reads/writes.

## Recommended starter rules

Use these rules so each authenticated user can access only their own contacts, tasks, and pipeline settings:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/contacts/{contactId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    match /users/{userId}/tasks/{taskId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    match /users/{userId}/settings/{settingId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

## Why this matches the app

The app reads/writes at:

- `users/{currentUser.uid}/contacts`
- `users/{currentUser.uid}/contacts/{contactId}`
- `users/{currentUser.uid}/tasks`
- `users/{currentUser.uid}/tasks/{taskId}`
- `users/{currentUser.uid}/settings/pipeline`

So rules must explicitly allow those paths for the signed-in user's UID.

## Optional: protect user profile docs too

If you later store user profile data at `users/{userId}`, add this:

```txt
match /users/{userId} {
  allow read, write: if request.auth != null && request.auth.uid == userId;
}
```
