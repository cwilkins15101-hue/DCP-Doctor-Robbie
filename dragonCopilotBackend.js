// ---------------------------------------------------------------------------
// Client for Doctor Robbie's own Dragon Copilot backend (see /dde-webhook).
// submitRecording() uploads a finished recording directly to our server,
// which forwards it to Dragon Copilot's Ambient Audio Streaming API using
// its own app-only credentials — a plain HTTP upload, no Microsoft sign-in
// involved, working identically on native (iOS/Android) and web.
//
// launchDragonCopilot() is different: it uses the physician's own signed-in
// Microsoft identity (see msftAuth.js, Doctor Robbie's actual login) rather
// than dde-webhook's app-only credentials, since Dragon Copilot's Token
// Launch API specifically requires a delegated (real signed-in user) token.
// ---------------------------------------------------------------------------
import { Platform } from 'react-native';
import { MsftAuth } from './msftAuth';

const DDE_BASE_URL = process.env.EXPO_PUBLIC_DDE_SERVER_URL;
const DDE_APP_SECRET = process.env.EXPO_PUBLIC_DDE_APP_SECRET;
// Dragon Copilot's APIs identify "who recorded this" with a partner-defined
// string, not a real Microsoft identity — Doctor Robbie doesn't yet track
// individual physician accounts, so this is a single fixed value for now.
const EXTERNAL_USER_ID = process.env.EXPO_PUBLIC_DRAGON_EXTERNAL_USER_ID || 'doctor-robbie-physician';

function missingConfigKeys() {
  const required = {
    EXPO_PUBLIC_DDE_SERVER_URL: DDE_BASE_URL,
    EXPO_PUBLIC_DDE_APP_SECRET: DDE_APP_SECRET,
  };
  return Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

// Must be a real GUID — confirmed live (2026-09-23): Dragon Copilot's AAS
// WebSocket endpoint (RecordingOpen.ambientSessionData.correlationId, which
// this value feeds straight into) rejected a non-GUID correlationId with
// "Failed to convert request to RecordingOpenRequest", matching its own docs,
// which explicitly label this field "(GUID)" — unlike the REST API's looser
// "letters/numbers/underscore/hyphen/pipe" rule, which the old
// doctor-robbie-<timestamp>-<random> format satisfied but a GUID check does
// not. No crypto.randomUUID() dependency (not reliably available in React
// Native/Hermes) — plain Math.random()-based UUID v4 is fine here since this
// only needs to be unique, not cryptographically unguessable.
function newCorrelationId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function buildContext(patient) {
  if (!patient) return null;
  return {
    patientName: patient['Patient Name'] ?? null,
    medicalRecordNumber: patient['MRN'] ?? null,
    dateOfBirth: patient['DOB'] ?? null,
    reasonForVisit: patient['Chief Complaint'] ?? null,
  };
}

// Starts a TRUE live stream to Dragon Copilot — web only for now (2026-09-24;
// iOS/Android still use the batch submitRecording() below). Unlike
// submitRecording(), which waits for a finished file and uploads it in one
// shot, this sends audio to dde-webhook AS it's captured (App.js's Web
// Audio API code), via three separate, ordinary HTTP requests
// (streamStart, many streamChunk calls, streamFinish) rather than one
// continuous streaming upload. A single long-lived streaming request body
// was tried first and proved unreliable in practice across several live
// tests (an HTTP/2 requirement, a CORS-labeled timeout, then a silent
// indefinite hang — the request never even reached the server in any of
// them) — ordinary POST requests are the same simple, already-proven
// mechanism every other endpoint in this app uses.
//
// Chunks must already be raw PCM, 16-bit little-endian, 16000 Hz, mono —
// dde-webhook declares exactly that format to Dragon Copilot and does not
// convert anything; whatever bytes arrive are what gets sent.
async function startLiveRecordingStream(patient, recordingId = 1, outputFormIds) {
  const missing = missingConfigKeys();
  if (missing.length > 0) {
    throw new Error(`Dragon Copilot backend isn't configured: missing ${missing.join(', ')}`);
  }

  const entraUserToken = await MsftAuth.getAccessToken();
  const correlationId = newCorrelationId();
  const context = buildContext(patient);
  const authHeaders = { 'x-app-secret': DDE_APP_SECRET, Authorization: `Bearer ${entraUserToken}` };
  const baseUrl = DDE_BASE_URL.replace(/\/$/, '');

  const startParams = new URLSearchParams({
    correlationId,
    recordingId: String(recordingId),
    externalUserId: EXTERNAL_USER_ID,
  });
  if (outputFormIds && outputFormIds.length) startParams.set('outputFormIds', outputFormIds.join(','));
  if (context) startParams.set('context', JSON.stringify(context));

  const startResponse = await fetch(`${baseUrl}/api/streamStart?${startParams.toString()}`, {
    method: 'POST',
    headers: authHeaders,
  });
  if (!startResponse.ok) {
    throw new Error(`Dragon Copilot submission failed (${startResponse.status}): ${await startResponse.text()}`);
  }

  // Chunk uploads are queued one-after-another (rather than fired
  // concurrently) so they arrive at dde-webhook in the same order they
  // were captured — the AAS WebSocket has no way to reorder out-of-order
  // DataChunk frames. A failed chunk is logged and skipped rather than
  // aborting the whole recording; a few dropped chunks are a real but
  // tolerable gap for this prototype, versus losing the whole encounter.
  let chunkQueue = Promise.resolve();
  let ended = false;

  return {
    correlationId,
    pushChunk(bytes) {
      if (ended) return;
      chunkQueue = chunkQueue
        .then(() =>
          fetch(`${baseUrl}/api/streamChunk?correlationId=${encodeURIComponent(correlationId)}`, {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/octet-stream' },
            body: bytes,
          })
        )
        .then((response) => {
          if (!response.ok) throw new Error(`Chunk upload failed (${response.status})`);
        })
        .catch((err) => {
          console.error('Live audio chunk upload failed (continuing):', err);
        });
    },
    // Waits for all in-flight chunk uploads to finish, then signals the
    // recording is done. Resolves with the confirmed correlationId, or
    // throws on failure.
    async finish(recordingLengthSeconds) {
      ended = true;
      await chunkQueue;
      const finishParams = new URLSearchParams({
        correlationId,
        recordingLengthSeconds: String(Math.max(1, recordingLengthSeconds || 1)),
      });
      const response = await fetch(`${baseUrl}/api/streamFinish?${finishParams.toString()}`, {
        method: 'POST',
        headers: authHeaders,
      });
      if (!response.ok) {
        throw new Error(`Dragon Copilot submission failed (${response.status}): ${await response.text()}`);
      }
      const json = await response.json();
      return json.correlationId ?? correlationId;
    },
  };
}

// Uploads a finished recording to Doctor Robbie's own backend. Returns the
// correlationId to poll for results with (see ddeClient.js). Pass an
// existingCorrelationId to add another recording to an encounter already in
// progress — Dragon Copilot ties multiple recordings to one encounter by
// correlation_id (see the Recordings, sessions, and transcript docs) and
// re-processes the note/transcript across all of them. recordingId must be
// unique per recording within that encounter (1 for the first, 2 for the
// next, ...) — reusing recordingId 1 looks to Dragon Copilot like
// re-finalizing the same take rather than a genuinely new one, and silently
// never triggers a new note/transcript notification.
//
// outputFormIds (Voice-to-Form) requests one or more template forms
// instead of (or alongside) the standard clinical note — an array of
// Dragon-assigned form identifiers, e.g. ["encounter_note_pi_mdm"].
//
// recordingLengthSeconds feeds the AAS WebSocket's RecordingClose message,
// which documents it as required — omitted here defaults to 1 (never 0,
// a real live recording always has some length; a picked/uploaded file
// doesn't have a tracked duration, so 1 is a safe placeholder rather than
// the flatly-wrong 0 this used to hardcode server-side).
async function submitRecording(audioUri, audioName, patient, existingCorrelationId, recordingId = 1, outputFormIds, recordingLengthSeconds) {
  const missing = missingConfigKeys();
  if (missing.length > 0) {
    throw new Error(`Dragon Copilot backend isn't configured: missing ${missing.join(', ')}`);
  }

  // Dragon Copilot's support team confirmed live (2026-09-23) that the AAS
  // WebSocket endpoint needs a real Entra *user* (delegated) access token,
  // not the app-only token dde-webhook was minting itself — matching what
  // Token Launch already required. The physician already signs in via
  // MsftAuth as step one of using the app (same Entra tenant/app
  // registration, and the "Connector.Access" scope it requests is the same
  // AAS resource, just delegated instead of app-only), so this reuses that
  // existing token rather than prompting a second sign-in just for this.
  const entraUserToken = await MsftAuth.getAccessToken();

  const correlationId = existingCorrelationId || newCorrelationId();
  const formData = new FormData();

  // The recorded file's real MIME type — not just its display name. On web,
  // Expo's HIGH_QUALITY preset actually records audio/webm (Opus inside a
  // WebM container), regardless of the "Recording.m4a" label shown in the
  // UI; only iOS/Android genuinely record AAC/m4a with this preset. Sent
  // through so dde-webhook can tell Dragon Copilot the *real* format
  // (dataFormat.webmOpus is one of its actively-documented codecs) instead
  // of only ever declaring the generic/opaque byteStream fallback.
  let audioMimeType = 'audio/m4a';
  if (Platform.OS === 'web') {
    const fileRes = await fetch(audioUri);
    const blob = await fileRes.blob();
    audioMimeType = blob.type || audioMimeType;
    formData.append('audio', blob, audioName ?? 'recording.m4a');
  } else {
    formData.append('audio', { uri: audioUri, name: audioName ?? 'recording.m4a', type: 'audio/m4a' });
  }
  formData.append('audioMimeType', audioMimeType);

  formData.append('correlationId', correlationId);
  formData.append('recordingId', String(recordingId));
  formData.append('recordingLengthSeconds', String(Math.max(1, recordingLengthSeconds || 0)));
  formData.append('externalUserId', EXTERNAL_USER_ID);
  if (outputFormIds && outputFormIds.length) {
    formData.append('outputFormIds', outputFormIds.join(','));
  }
  const context = buildContext(patient);
  if (context) formData.append('context', JSON.stringify(context));

  const response = await fetch(`${DDE_BASE_URL.replace(/\/$/, '')}/api/submitRecording`, {
    method: 'POST',
    headers: { 'x-app-secret': DDE_APP_SECRET, Authorization: `Bearer ${entraUserToken}` },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Dragon Copilot submission failed (${response.status}): ${await response.text()}`);
  }
  const json = await response.json();
  return json.correlationId ?? correlationId;
}

// Uploads a manually-picked audio FILE only (the "Upload a file" flow) —
// a separate, older transport from submitRecording()/startLiveRecordingStream()
// above: a plain REST upload via dde-webhook's own app-only credentials, no
// physician sign-in involved, same as this app used before mic recordings
// switched to the AAS WebSocket. Restored 2026-09-24 after live testing
// showed the WebSocket path stalling for this flow specifically, while this
// REST path has a track record of working reliably end to end. Supports
// outputFormIds (Voice-to-Form) too, confirmed 2026-09-24 from Microsoft's
// V2F onboarding guide -- dde-webhook passes it through to the ambient
// session (a different mechanism than the WebSocket's RecordingOpen field,
// see ambientSession.js).
async function uploadRecordingFile(audioUri, audioName, patient, existingCorrelationId, recordingId = 1, outputFormIds) {
  const missing = missingConfigKeys();
  if (missing.length > 0) {
    throw new Error(`Dragon Copilot backend isn't configured: missing ${missing.join(', ')}`);
  }

  const correlationId = existingCorrelationId || newCorrelationId();
  const formData = new FormData();

  if (Platform.OS === 'web') {
    const fileRes = await fetch(audioUri);
    const blob = await fileRes.blob();
    formData.append('audio', blob, audioName ?? 'recording.m4a');
  } else {
    formData.append('audio', { uri: audioUri, name: audioName ?? 'recording.m4a', type: 'audio/m4a' });
  }

  formData.append('correlationId', correlationId);
  formData.append('recordingId', String(recordingId));
  formData.append('externalUserId', EXTERNAL_USER_ID);
  if (outputFormIds && outputFormIds.length) {
    formData.append('outputFormIds', outputFormIds.join(','));
  }
  const context = buildContext(patient);
  if (context) formData.append('context', JSON.stringify(context));

  const response = await fetch(`${DDE_BASE_URL.replace(/\/$/, '')}/api/submitRecordingFile`, {
    method: 'POST',
    headers: { 'x-app-secret': DDE_APP_SECRET },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Dragon Copilot submission failed (${response.status}): ${await response.text()}`);
  }
  const json = await response.json();
  return json.correlationId ?? correlationId;
}

// Fetches the Microsoft-assigned partner/org/product/EHR identifiers
// needed to launch Dragon Copilot's own web UI via its Token Launch API —
// these live only in the dde-webhook server's own .env, not the app's. The
// actual accessToken for that call comes from MsftAuth instead (the
// physician's own delegated sign-in) — Dragon Copilot's Token Launch
// rejects a server-minted app-only token outright (confirmed via a live
// 401), so dde-webhook no longer mints one here.
async function getTokenLaunchInfo() {
  const missing = missingConfigKeys();
  if (missing.length > 0) {
    throw new Error(`Dragon Copilot backend isn't configured: missing ${missing.join(', ')}`);
  }
  const response = await fetch(`${DDE_BASE_URL.replace(/\/$/, '')}/api/tokenLaunchInfo`, {
    headers: { 'x-app-secret': DDE_APP_SECRET },
  });
  if (!response.ok) {
    throw new Error(`Token Launch info fetch failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

// Opens Dragon Copilot's own web UI in a new browser tab, seeded with this
// encounter's correlationId and (if available) the Epic patient's context,
// per Microsoft's Token Launch API. That API's own docs say a real REST
// client (fetch/Postman/etc.) isn't recommended — it works via the
// POST-REDIRECT-GET pattern, so the browser itself needs to submit the
// form and follow the resulting redirect to actually show the page. A
// fetch() call would just receive the redirect response as inert data
// instead of navigating anywhere. That's also why this only works on the
// web build — there's no such form-submission mechanism natively.
//
// An embedded-iframe version was tried and could display Dragon Copilot's
// UI, but Dragon Copilot's own app redirects to a full separate window
// anyway once it detects no "native mic access" (a local desktop app +
// browser extension Dragon Copilot itself requires for in-browser
// dictation — unrelated to anything configurable here), so a real new-tab
// launch gives the same practical result with far less complexity.
async function launchDragonCopilot({ correlationId, patient, launchType = 'copilot' }) {
  if (Platform.OS !== 'web') {
    throw new Error('Launching Dragon Copilot this way only works in the web app for now.');
  }
  const [info, accessToken] = await Promise.all([getTokenLaunchInfo(), MsftAuth.getAccessToken()]);

  const payload = {
    partnerId: info.partnerId,
    orgId: info.orgId,
    productId: info.productId,
    clientName: info.clientName,
    correlationId,
    launchType,
    accessToken,
  };
  if (patient?.id) payload.patient = `Patient/${patient.id}`;
  if (patient?.['Patient Name']) payload.patientName = patient['Patient Name'];
  if (patient?.DOB) payload.patientDob = patient.DOB;
  if (patient?.MRN) payload.patientMrn = patient.MRN;
  if (patient?.Gender) payload.patientGender = patient.Gender;

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `${info.ehrBaseUrl.replace(/\/$/, '')}/api/${encodeURIComponent(info.ehr)}/token-launch`;
  form.target = '_blank';

  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'data';
  input.value = JSON.stringify(payload);
  form.appendChild(input);

  document.body.appendChild(form);
  form.submit();
  document.body.removeChild(form);
}

export const DragonCopilotBackend = {
  missingConfigKeys,
  newCorrelationId,
  submitRecording,
  uploadRecordingFile,
  startLiveRecordingStream,
  getTokenLaunchInfo,
  launchDragonCopilot,
};
