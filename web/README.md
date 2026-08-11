# Doctor Robbie — web (Dragon Copilot SDK)

A browser-based version of Doctor Robbie that replaces the mobile app's Whisper + Claude pipeline
with the [Dragon Copilot SDK for JavaScript](https://learn.microsoft.com/en-us/javascript/api/dragon-copilot-sdk-javascript/dragon-copilot-overview).
The original Expo/React Native app (`../App.js`) is untouched — this lives in its own `web/`
subfolder with an independent `package.json`.

## Prerequisites

From **Dragon Admin Center**:
- Partner GUID
- Dragon Medical Server URL + OAuth scope
- Environment ID

From your **Microsoft Entra** app registration:
- Application (client) ID
- Directory (tenant) ID
- Redirect URI registered as this app's origin (e.g. `http://localhost:5173` for local dev)

## Setup

```bash
npm install
cp .env.example .env.local   # fill in the values above
npm run dev                  # http://localhost:5173
```

## How it's wired

- The SDK itself loads via the CDN `<script>` tag in `index.html` (per Microsoft's own
  install instructions) and attaches to `window.DragonCopilotSDK.dragon` — there is no npm
  runtime package for it. `@microsoft/dragon-copilot-sdk-types` (devDependency) supplies real
  TypeScript types for that global, declared in `src/types/dragon-global.d.ts`.
- `src/auth.ts` — MSAL sign-in and the `acquireAccessToken` callback the SDK calls whenever it
  needs a token for a given scope.
- `src/dragonClient.ts` — initializes the SDK, builds `AmbientSessionData` from a selected
  patient, and starts/stops ambient recording.
- `src/App.tsx` — sign in → pick patient (from an uploaded roster CSV, reusing the mobile app's
  CSV format) → ambient recording with a live volume meter and upload-status pill → note screen.

## Important gap: the SDK does not hand back the generated note

The browser SDK's job ends at capturing and uploading ambient audio (`ambientRecordingUploadStatusChanged`
tells you when the upload finishes). The AI-generated draft note and transcript come back through
Dragon's separate **EHR Integration Service** (FHIR-based), which is a backend-to-backend
integration — it is not exposed by this client-side SDK. There's no backend in this repo yet, so
the note screen currently lets you paste in a note manually (e.g. copied from Dragon Admin Center
or a webhook payload) to preview the SOAP-style markdown rendering. Wiring up the real EHR
Integration Service call is the next piece of work once server-side credentials/infra exist.

## Known limitations / TODO

- No backend — note retrieval is manual/paste-in for now (see above).
- Patient identity mapping is best-effort (roster CSV has one "Patient Name" field; Dragon's
  `Patient` type wants first/last split separately — see `splitName` in `dragonClient.ts`).
- Not yet tested against a live Dragon Medical Server — needs real credentials from Dragon Admin
  Center to verify end-to-end.
