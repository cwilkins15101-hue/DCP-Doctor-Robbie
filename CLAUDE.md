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

## Git LFS

Git LFS is configured. Large binary assets should be tracked with LFS rather than committed directly.
