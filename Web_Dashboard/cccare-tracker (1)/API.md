# Backend API

The dashboard can keep its data in the browser (the default) or on a backend. To use a backend, set `apiBase` in `js/config.js`, or add `?api=<address>` to any page's address. Any server that provides the endpoints below works, in any language. `server/server.py` is a complete reference version in plain Python.

## Conventions

- Every address is relative to `apiBase`. For example, with `apiBase: '/api'`, sign-in is `POST /api/auth/signin`.
- Requests and responses are JSON (`Content-Type: application/json`).
- After sign-in, every request carries `Authorization: Bearer <token>`.
- Errors use a non-2xx status and the body `{ "error": "A sentence the page can show" }`. The pages show that sentence to the user.
- A `401` means "sign in again". The dashboard then signs out and returns to the sign-in page.
- If the site and the API have different addresses, the API must send CORS headers allowing `Authorization` and `Content-Type`. A site served over `https://` can only call an `https://` API, except `http://localhost`.

## Accounts

| Method and path | Body | Response |
| --- | --- | --- |
| `POST /auth/signin` | `{ "username", "password" }` | `200 { "account", "token" }`, or `401` |
| `POST /auth/signup` | `{ "username", "password", "role": "instructor" \| "patient" }` | `201 { "account", "token" }`, or `400` / `409` with the reason |
| `POST /auth/signout` | `{}` | `200`. The token stops working. |

`account` is `{ "username", "role", "participantId" }`. `participantId` is the patient's block, `"P01"` to `"P30"`, or `null` for instructors. The server chooses it at sign-up: the first block no other account uses. Usernames are matched without regard to case. Rules the pages also check: usernames are 3 to 24 letters, digits, `.`, `_` or `-`, and passwords are at least 4 characters.

## Roster

The class list: one entry per block that has a name or a workout.

| Method and path | Who | Body / response |
| --- | --- | --- |
| `GET /roster` | instructor: every entry. Patient: only their own. | `[ { "id": "P01", "name": "Ann", "workout": [ { "exercise": "squat", "sets": 3, "reps": 12, "rest": 45 } ] } ]` |
| `PUT /roster` | instructor | the full list, as above. Replaces what was saved. |

Blocks missing from the list use their defaults. The exercise codes are the keys of `CC.EXERCISES` in `js/exercises.js`. For held exercises such as the plank, `reps` is seconds.

## Sessions

| Method and path | Who | Body / response |
| --- | --- | --- |
| `GET /sessions` | instructor: all. Patient: only sessions they were in, each with only their own result. | list of sessions, any order |
| `POST /sessions` | instructor | one session. Saving the same `id` again replaces it. |

A session:

```json
{
  "id": "S20261109-101500-ab12",
  "startedAt": "2026-11-09T10:15:00.000Z",
  "endedAt":   "2026-11-09T10:52:00.000Z",
  "endedEarly": false,
  "elapsedMs": 2220000,
  "sample": false,
  "participants": [ { "id": "P01", "name": "Ann", "success": 82, "exercises": [ ... ], "...": "..." } ]
}
```

Each participant result is the output of `Tracker.result()` in `js/score.js`. That includes the per-exercise sets and reps done, quality, faults, exertion and `stoppedAt` (where they were if the session ended early). The server can store it as it arrives.

## Profiles

| Method and path | Who | Body / response |
| --- | --- | --- |
| `GET /profiles/<username>` | yourself, or an instructor | `{ "nickname", "bio", "birthday", "photo" }` (empty strings if none) |
| `PUT /profiles/<username>` | yourself | the same object |

`nickname` is at most 30 characters; the patient's own screens show it instead of their username. `bio` is at most 500 characters. `birthday` is `YYYY-MM-DD` or empty. `photo` is a `data:image/jpeg;base64,...` URL (the page shrinks pictures to 256 × 256 first, so they are usually 15–40 KB), or empty.

## Live session

While a session runs, the instructor's page sends the whole live state twice a second. Patient pages ask for it once a second. This lets the patient's screen follow the instructor on another device.

| Method and path | Who | Body / response |
| --- | --- | --- |
| `PUT /live` | instructor | `{ "id", "state": "live" \| "ended" \| "abandoned", "paused", "startedAt", "updatedAt", "participants": { "P01": <block snapshot>, ... } }` |
| `GET /live` | anyone signed in. Patients only see their own block. | the last state sent, plus `"ageMs"`: how long ago the server received it. `null` if none. |

`ageMs` lets patient pages tell when the instructor's page has stopped sending, whatever the two devices' clocks say. The live state doesn't need to be kept on disk.

## Reset

| Method and path | Who | Body |
| --- | --- | --- |
| `POST /reset` | instructor | `{ "sessions": [ ... ] }`: the sample history to start again with. Clears the roster and live state. |

This is the **Reset sample data** link in the footer. A production server can refuse it with `403`.

## Not stored on the server

These stay in each browser: the night-mode choice, the last participant count on the set-up page, and the camera feed address (`?feed=`). The live rep data from the camera pipeline goes straight to the instructor's page over a WebSocket (see the README). It reaches the backend only as part of the saved session.
