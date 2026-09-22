# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Doctor Robbie

Doctor Robbie is a physician productivity app prototype (no real patient data), forked from Physicker. A physician signs into the app with their Microsoft account (`msftAuth.js` — this is Doctor Robbie's own login, gating the whole app), records a patient conversation on their mobile device, and the app sends it to Dragon Copilot for processing into a structured clinical note. Recording *submission* itself stays a pure server-to-server integration with no per-request auth beyond that initial sign-in — see "Doctor Robbie's own login" below for why the sign-in exists at all despite that.

Core pipeline: **audio recording → Doctor Robbie's own backend (dde-webhook) → Dragon Copilot Ambient Audio Streaming (WebSocket) → Dragon Data Exchange webhook → display note**

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

## Doctor Robbie's own login (Microsoft sign-in)

Before anything else in the app is reachable, a physician signs in with their Microsoft account (`msftAuth.js` — Authorization Code + PKCE via `expo-auth-session`, a public client, no secret; `App.js` gates its entire render tree behind `msftUser`). This uses the same Entra tenant/app registration `dde-webhook` already uses server-to-server for Ambient Audio Streaming, but it's a genuinely different, *delegated* flow — a real person authenticates and consents, rather than the app proving its own identity with a client secret.

This sign-in exists specifically because of "Launch Dragon Copilot" (see below): Dragon Copilot's Token Launch API rejects an app-only, server-minted access token outright (confirmed live: 401 Unauthorized). Decoding a token from a working manual test showed `"idtyp": "user"` and a `"scp"` (delegated scope) claim, not the `"roles"` claim an app-only token carries — Token Launch specifically requires proof a physician is signed in. Rather than bolt on a separate sign-in just for that one button, the whole app's login *is* this Microsoft sign-in, so the same in-memory token (in-memory only, cleared on reload — no refresh-token persistence across app restarts, though `getAccessToken()` does silently refresh mid-session via `offline_access`) covers both.

Config: `EXPO_PUBLIC_MSFT_TENANT_ID` / `EXPO_PUBLIC_MSFT_CLIENT_ID` (both default to this account's confirmed-working values) — see `.env.example`. The resulting redirect URI (logged to the in-app Debug Log on first sign-in) must be registered on that Entra app registration as a **Single-page application** redirect URI specifically — registering it under "Web" instead breaks the token exchange with a CORS error, since the exchange is called directly from browser JS with no client secret.

## Architecture

The app follows a linear pipeline:

1. **Audio recording** — uses Expo AV (`expo-av`) to capture microphone input and produce an audio file. Recording still happens as a whole file client-side (no live mic streaming from the phone) — what changed is how the *finished* file gets to Dragon Copilot.
2. **Submission** (`dragonCopilotBackend.js` → `dde-webhook`'s `submitRecording.js`) — the app POSTs the finished file to Doctor Robbie's own backend, which creates an ambient session (REST, `ambientSession.js`) and then streams the audio to Dragon Copilot over the **Ambient Audio Streaming WebSocket API** (`audioStreamUpload.js`) — replaced an earlier REST chunked-upload implementation (`audioUpload.js`, removed) for faster downstream processing and because Voice-to-Form's `outputFormIds` field only exists on the WebSocket API. See `audioStreamUpload.js`'s header comment for the documented message-framing quirks (binary frames whose content is still JSON text with base64 audio inside; a custom `Path=`/header block above the JSON body on text messages).
3. **Result delivery** — Dragon Copilot calls back the `dde-webhook` server's Dragon Data Exchange webhook once processing finishes; the app polls (`ddeClient.js`) for the stored result
4. **Display** (`parseDragonNote` in `App.js`) — the note's `resources[]` sections (each with a section name and text) are parsed out of the "Dragon standard payload" and rendered as separate, individually-editable text boxes; a "Display additional note sections" checkbox reveals sections Dragon Copilot left blank (the encounter didn't cover them) so a physician can fill them in manually. Falls back to raw JSON if the shape doesn't match at all — a genuinely empty/unparseable payload, not just blank sections.

**Voice-to-Form**: the record screen has an "Output" picker (chips: Standard Clinical Note, or one of a handful of test `outputFormIds` Microsoft provided — `encounter_note_pi_mdm`, `letter_to_patient`, `letter_to_pcp_gp`, `referral_letter_to_clinician`) that's threaded through `submitRecording` → `RecordingOpen.outputFormIds` on the WebSocket. **Not yet handled**: the *response* payload shape for a custom-form result isn't documented yet, so `parseDragonNote` still only knows how to render the standard clinical-note shape — a form-based result likely needs its own parser once that's confirmed (falls back to raw JSON for now, same as any unrecognized shape). The real custom form Microsoft is provisioning isn't available yet either — only these test IDs are.

Config needed: `EXPO_PUBLIC_DDE_SERVER_URL`, `EXPO_PUBLIC_DDE_APP_SECRET`, and `EXPO_PUBLIC_DRAGON_EXTERNAL_USER_ID` (must match a registered App user ID — see above) — see `.env.example`. The `dde-webhook` server has its own separate `.env` (see `dde-webhook/.env.example` and `dde-webhook/README.md`), including `AAS_WS_URL` if the WebSocket endpoint's default host ever needs overriding (see that file for why).

On the results screen, "Launch Dragon Copilot" (web build only) opens Dragon Copilot's own web app in a new tab via Microsoft's Token Launch API, seeded with the current encounter's `correlationId` and — when the patient came from Epic — their FHIR patient context (`patient`, `patientName`, `patientDob`, `patientMrn`, `patientGender`). This is a different Dragon Copilot API surface than Ambient Audio Streaming, and its access token comes from the signed-in physician's own delegated token (`MsftAuth.getAccessToken()` — see "Doctor Robbie's own login" above), not anything `dde-webhook` mints. `dde-webhook`'s `tokenLaunchInfo` endpoint only hands back the Microsoft-assigned partner/org/product/EHR identifiers that live in its own `.env` — `DRAGON_EHR_ID` defaults to `sectra`, a placeholder EHR identifier confirmed working in this sandbox, since neither this account's Clinical app connector name (`doctor-robbie`) nor its "App ID" GUID work (both got a blanket 403 — Token Launch isn't provisioned for the doctor-robbie connector yet on Microsoft's side). Swap it for the real value once Microsoft provisions Token Launch for `doctor-robbie` and confirms what to use. The Token Launch docs explicitly say a REST client shouldn't call the launch endpoint directly (it relies on a real browser following a 302 redirect via POST-REDIRECT-GET, opened in a new tab) — so `dragonCopilotBackend.js`'s `launchDragonCopilot` builds and submits an actual HTML `<form>` in the browser rather than using `fetch()`.

## Epic on FHIR sandbox (patient lookup + chart)

"Get Patients from Epic" (next to "Load Patient List") signs into the Epic on FHIR sandbox directly from the app (`epicAuth.js` — Authorization Code + PKCE via `expo-auth-session`, a public client, no client secret) and fetches the sandbox's documented test patients by known FHIR ID (`epicClient.js`), converting each FHIR `Patient` resource into the same field shape used by CSV-loaded patients (plus its FHIR `id`, which CSV-loaded patients don't have). The sandbox doesn't support open-ended patient search, which is why this fetches a fixed list of IDs rather than searching.

For a patient loaded from Epic (has a FHIR `id`), the red "Epic Chart Summary" button on the recording screen opens a right-side slide-in panel (not a full-screen takeover) with:
- **Problems & Reason for Visit** — `Condition.Search` (`EpicClient.fetchConditions`), no category filter (Epic surfaces both under the same API).
- **International Patient Summary** — a single `Patient/{id}/$summary` call (`EpicClient.fetchIPS`) returning discrete Problems/Allergies/Medications/Immunizations plus ready-to-render narrative HTML per section, rendered with `react-native-render-html`. Replaced an earlier CCD-via-`$docref` implementation that could never get past a generic "FHIR ID provided was not found" error no matter how it was invoked (bare id vs `Patient/<id>`, GET vs POST, with/without an explicit type) — IPS is Epic's newer, better-documented alternative and reuses the same HTML-rendering path already needed for Clinical Notes.
- **Clinical Notes** — the list of the patient's actual written notes (progress notes, H&P, discharge summaries, etc.) via `DocumentReference.Search` with `category=clinical-note` (`EpicClient.fetchClinicalNotes`); tapping a note lazily fetches and expands its text (`EpicClient.fetchClinicalNoteText`), resolving the attachment (inline base64, or a separate `Binary` fetch — Epic sometimes returns a relative reference here, which must be resolved against the FHIR base URL rather than fetched as-is) and rendering it as HTML, since Epic returns note bodies as HTML rather than plain text.

At the top of that panel, "Compile for Dragon Copilot" (`handleCompileForDragon` in `App.js`) fetches whatever IPS/note content isn't already loaded, converts each HTML section/note to plain text (`htmlToPlainText`), and copies the whole thing to the clipboard as one document — meant to be pasted into Dragon Copilot's own Chat app for summarization/interaction, since there's no API for that (it's a separate, non-API product).

Requires `EXPO_PUBLIC_EPIC_CLIENT_ID` from a free "Non-Production" app registered at fhir.epic.com/Developer — see `.env.example`. That app's Incoming APIs list must include Patient, Condition, DocumentReference (Clinical Notes, both Read and Search), Binary (Clinical Notes), and whatever Incoming API backs `Patient.$summary`/IPS — all R4. Epic's Incoming API permissions are split finely (a Read entry doesn't cover Search, and a document category's DocumentReference entry doesn't cover reading its Binary content — each needs its own explicit entry), and newly-added entries can take a while to actually take effect even after saving. The app's Endpoint URI must also match your current dev tunnel URL exactly. Tokens are cached in memory only (cleared on reload); there's no refresh-token handling, so sign-in runs again once a token expires.

## Git LFS

Git LFS is configured. Large binary assets should be tracked with LFS rather than committed directly.
