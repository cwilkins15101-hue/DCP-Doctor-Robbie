// ---------------------------------------------------------------------------
// Client for Doctor Robbie's own Dragon Copilot backend (see /dde-webhook).
// Submits a finished recording directly to our server, which forwards it to
// Dragon Copilot's Ambient Audio Streaming API using its own app-only
// credentials. The physician using Doctor Robbie never signs in to
// Microsoft or sees any Microsoft UI — this is a plain HTTP upload, so it
// works identically on native (iOS/Android) and web.
// ---------------------------------------------------------------------------
import { Platform } from 'react-native';

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

// Doesn't need to be a real UUID — Dragon's API only requires letters,
// numbers, underscore, hyphen, and pipe, under 128 characters.
function newCorrelationId() {
  return `doctor-robbie-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
async function submitRecording(audioUri, audioName, patient, existingCorrelationId, recordingId = 1) {
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
  const context = buildContext(patient);
  if (context) formData.append('context', JSON.stringify(context));

  const response = await fetch(`${DDE_BASE_URL.replace(/\/$/, '')}/api/submitRecording`, {
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

// Fetches what's needed to launch Dragon Copilot's own web UI via its
// Token Launch API — a server-issued access token (needs the Entra client
// secret, which the app itself never holds) plus the Microsoft-assigned
// partner/org/product/EHR identifiers, which live only in the dde-webhook
// server's own .env, not the app's.
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
// web build — there's no such form-submission/new-tab mechanism natively.
async function launchDragonCopilot({ correlationId, patient, launchType = 'copilot' }) {
  if (Platform.OS !== 'web') {
    throw new Error('Launching Dragon Copilot this way only works in the web app for now.');
  }
  const info = await getTokenLaunchInfo();

  const payload = {
    partnerId: info.partnerId,
    orgId: info.orgId,
    productId: info.productId,
    clientName: info.clientName,
    correlationId,
    launchType,
    accessToken: info.accessToken,
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
  submitRecording,
  getTokenLaunchInfo,
  launchDragonCopilot,
};
