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
// correlationId to poll for results with (see ddeClient.js).
async function submitRecording(audioUri, audioName, patient) {
  const missing = missingConfigKeys();
  if (missing.length > 0) {
    throw new Error(`Dragon Copilot backend isn't configured: missing ${missing.join(', ')}`);
  }

  const correlationId = newCorrelationId();
  const formData = new FormData();

  if (Platform.OS === 'web') {
    const fileRes = await fetch(audioUri);
    const blob = await fileRes.blob();
    formData.append('audio', blob, audioName ?? 'recording.m4a');
  } else {
    formData.append('audio', { uri: audioUri, name: audioName ?? 'recording.m4a', type: 'audio/m4a' });
  }

  formData.append('correlationId', correlationId);
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

export const DragonCopilotBackend = { missingConfigKeys, submitRecording };
