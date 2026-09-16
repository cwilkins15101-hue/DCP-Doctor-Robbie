# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Doctor Robbie

Doctor Robbie is a physician productivity app prototype (no real patient data), forked from Physicker. A physician records a patient conversation on their mobile device, and the app sends it to Dragon Copilot for processing into a structured clinical note — no physician sign-in required, this is a pure server-to-server integration.

Core pipeline: **audio recording → Doctor Robbie's own backend (dde-webhook) → Dragon Copilot Ambient Audio Streaming → Dragon Data Exchange webhook → display note**

Dragon Copilot's API accepts app-only (client-credentials) calls — confirmed working — but every request must identify the physician via an `externalUserId` that exactly matches an "App user ID" registered on the Clinical app connector in the Dragon Admin Center (admin.healthplatform.microsoft.com). An unregistered value is rejected with a "Forbidden" error even though authentication otherwise succeeds.

## Tech Stack

- **Framework:** Expo + React Native (mobile, iOS/Android)
- **AI pipeline:** Dragon Copilot only (see `/dde-webhook`)
- **Prototype only:** no real patient data, no HIPAA obligations in this phase

## Development Commands

```bash
npx expo start          # Start the Expo dev server
npx expo start --ios    # Run on iOS simulator
npx expo start --android # Run on Android emulator
npx expo run:ios        # Native build for iOS
npx expo run:android    # Native build for Android
```

## Architecture

The app follows a linear pipeline:

1. **Audio recording** — uses Expo AV (`expo-av`) to capture microphone input and produce an audio file
2. **Submission** (`dragonCopilotBackend.js`) — the recording is uploaded to Doctor Robbie's own backend (`/dde-webhook`), which creates an ambient session and streams the audio to Dragon Copilot's Ambient Audio Streaming API
3. **Result delivery** — Dragon Copilot calls back the `dde-webhook` server's Dragon Data Exchange webhook once processing finishes; the app polls (`ddeClient.js`) for the stored result
4. **Display** (`parseDragonNote` in `App.js`) — the note's `resources[]` sections (each with a section name and text) are parsed out of the "Dragon standard payload" and rendered as separate boxes, skipping empty sections; falls back to raw JSON if the shape doesn't match

Config needed: `EXPO_PUBLIC_DDE_SERVER_URL`, `EXPO_PUBLIC_DDE_APP_SECRET`, and `EXPO_PUBLIC_DRAGON_EXTERNAL_USER_ID` (must match a registered App user ID — see above) — see `.env.example`. The `dde-webhook` server has its own separate `.env` (see `dde-webhook/.env.example` and `dde-webhook/README.md`).

## Epic on FHIR sandbox (patient lookup + chart)

"Get Patients from Epic" (next to "Load Patient List") signs into the Epic on FHIR sandbox directly from the app (`epicAuth.js` — Authorization Code + PKCE via `expo-auth-session`, a public client, no client secret) and fetches the sandbox's documented test patients by known FHIR ID (`epicClient.js`), converting each FHIR `Patient` resource into the same field shape used by CSV-loaded patients (plus its FHIR `id`, which CSV-loaded patients don't have). The sandbox doesn't support open-ended patient search, which is why this fetches a fixed list of IDs rather than searching.

For a patient loaded from Epic (has a FHIR `id`), "View Chart" on the recording screen opens a modal with:
- **Problems & Reason for Visit** — `Condition.Search` (`EpicClient.fetchConditions`), no category filter (Epic surfaces both under the same API).
- **CCD** — the current Continuity of Care Document, generated on demand via the `DocumentReference/$docref` operation (`EpicClient.fetchCCD`), resolving the returned attachment (inline base64 or a separate `Binary` fetch) into raw XML. Shown as a preview with a "Copy Full CCD to Clipboard" action (`expo-clipboard`) rather than a parsed viewer.

Requires `EXPO_PUBLIC_EPIC_CLIENT_ID` from a free "Non-Production" app registered at fhir.epic.com/Developer — see `.env.example`. That app's Incoming APIs list must include Patient, Condition, and the CCD/DocumentReference/Binary entries (all R4), and its Endpoint URI must match your current dev tunnel URL exactly. Tokens are cached in memory only (cleared on reload); there's no refresh-token handling, so sign-in runs again once a token expires.

## Git LFS

Git LFS is configured. Large binary assets should be tracked with LFS rather than committed directly.
