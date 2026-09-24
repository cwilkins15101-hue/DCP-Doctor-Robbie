// ---------------------------------------------------------------------------
// Dragon Copilot SDK for JavaScript — web-only ambient recording, added
// 2026-09-24 per direction from Dragon Copilot's own Microsoft contact:
// there's a backend stage (DAXCore) downstream of the raw AAS WebSocket
// we'd been hand-rolling all day, and errors happening there are invisible
// to us. This SDK is Microsoft's own tested client for the same "ambient
// audio streaming" pipeline — replaces the WebSocket send half of
// liveAasSession.js/audioStreamUpload.js for web mic recordings only.
// Everything about how results come BACK (the dde-webhook subscription,
// getResult polling, the Note/Transcript/Form Output tabs) is unchanged —
// Dragon Copilot still delivers results the same way regardless of how the
// audio was submitted.
//
// Built from Microsoft's own sample apps (github.com/microsoft/
// dragon-copilot-sdk-samples, plain-sample) since learn.microsoft.com's
// actual SDK docs aren't reachable from this environment — field names and
// call shapes below are copied as closely as possible from real sample
// source, but haven't been confirmed against a live Dragon Copilot backend
// yet. Treat anything marked "unconfirmed" as the first thing to check if
// this doesn't work as expected.
//
// Dictation mode (the SDK's other recording mode — per-text-field speech
// input) is deliberately not wired up here; Doctor Robbie only needs
// ambient (whole-encounter) recording.
import { Platform } from 'react-native';
import { MsftAuth } from './msftAuth';

const SDK_SCRIPT_URL = 'https://download.microsoft.com/download/9618a2a2-0d23-4587-aab6-2474fd8dd210/dragon-copilot-sdk-mainline.js';

const PARTNER_GUID = process.env.EXPO_PUBLIC_DRAGON_PARTNER_GUID;
const ENVIRONMENT_ID = process.env.EXPO_PUBLIC_DRAGON_ENVIRONMENT_ID; // == "customerId" in Dragon's terms
const EXTERNAL_USER_ID = process.env.EXPO_PUBLIC_DRAGON_EXTERNAL_USER_ID || 'doctor-robbie-physician';
const SPEECH_LANGUAGE = process.env.EXPO_PUBLIC_DRAGON_SPEECH_LANGUAGE || 'en-US';

function missingConfigKeys() {
  const required = { EXPO_PUBLIC_DRAGON_PARTNER_GUID: PARTNER_GUID, EXPO_PUBLIC_DRAGON_ENVIRONMENT_ID: ENVIRONMENT_ID };
  return Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

let sdkScriptPromise = null;

// Loads the SDK's own script tag once (idempotent) and resolves once
// window.DragonCopilotSDK.dragon is actually available. Not an npm
// dependency — Microsoft hosts the runtime itself; @microsoft/dragon-
// copilot-sdk-types (unused here) is types-only, per their sample's
// package.json.
function loadSdkScript() {
  if (Platform.OS !== 'web') {
    return Promise.reject(new Error('The Dragon Copilot SDK only works in the web app.'));
  }
  if (sdkScriptPromise) return sdkScriptPromise;
  sdkScriptPromise = new Promise((resolve, reject) => {
    if (window.DragonCopilotSDK?.dragon) {
      resolve(window.DragonCopilotSDK.dragon);
      return;
    }
    const script = document.createElement('script');
    script.src = SDK_SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      if (window.DragonCopilotSDK?.dragon) resolve(window.DragonCopilotSDK.dragon);
      else reject(new Error('Dragon Copilot SDK script loaded but window.DragonCopilotSDK.dragon is missing.'));
    };
    script.onerror = () => reject(new Error('Failed to load the Dragon Copilot SDK script.'));
    document.head.appendChild(script);
  });
  return sdkScriptPromise;
}

let ehrClient = null;
function getEhrClient(dragon) {
  if (!ehrClient) {
    ehrClient = new dragon.authentication.ehr.EhrAuthenticationClient({ customerId: ENVIRONMENT_ID });
  }
  return ehrClient;
}

// Bridges the SDK's token callback to Doctor Robbie's existing Microsoft
// sign-in (msftAuth.js) rather than standing up a second, parallel MSAL
// setup just for this SDK. UNCONFIRMED: the SDK calls this with a `scope`
// parameter of its own choosing, which this ignores -- msftAuth.js can
// only hand back one fixed-scope token from sign-in (it uses expo-auth-
// session, not MSAL, so it can't request an arbitrary scope on demand). If
// the exchange below rejects the token as the wrong scope/audience, this
// is the first place to look.
async function acquireAccessToken(dragon, _scope) {
  const entraToken = await MsftAuth.getAccessToken();
  return getEhrClient(dragon).acquireToken({ accessToken: entraToken });
}

let initializePromise = null;

async function ensureInitialized() {
  const missing = missingConfigKeys();
  if (missing.length > 0) {
    throw new Error(`Dragon Copilot SDK isn't configured: missing ${missing.join(', ')}`);
  }
  if (initializePromise) return initializePromise;
  initializePromise = loadSdkScript().then(async (dragon) => {
    await dragon.initialize({
      partnerGuid: PARTNER_GUID,
      environmentId: ENVIRONMENT_ID,
      applicationName: 'doctor-robbie',
      speechOptions: { language: SPEECH_LANGUAGE },
      services: 'us',
      authentication: { acquireAccessToken: (scope) => acquireAccessToken(dragon, scope) },
      isAmbientEnabled: true,
      isDictationEnabled: false,
      // Confirmed 2026-09-24 from Microsoft's own "Initialize" doc:
      // enableAll defaults to true and scans the whole page (document
      // body, absent a containerSelector) for text fields to speech-
      // enable -- dictation-mode behavior we don't want at all here, only
      // the one ambient-recording button. Without this, the SDK could be
      // silently attaching itself to Doctor Robbie's own text inputs
      // (e.g. the note-editing boxes, patient search) regardless of
      // isDictationEnabled: false.
      enableAll: false,
    });
    return dragon;
  });
  return initializePromise;
}

// Doctor Robbie's patient records are a flat { 'Patient Name', 'MRN',
// 'DOB', 'Chief Complaint' } shape (CSV or Epic FHIR-derived) -- nothing
// close to the SDK sample's fully-structured ehrData.patient (separate
// first/last name, a numeric gender code, LOINC-coded pronouns, ...).
// UNCONFIRMED which of ehrData's fields are actually required -- this
// fills in what can be confidently derived and leaves the rest out rather
// than guess at values (e.g. a gender code) with no real data behind them.
//
// outputFormIds (Voice-to-Form) confirmed 2026-09-24 from Microsoft's own
// V2F documentation: for the JavaScript SDK specifically, it's a plural
// top-level "outputFormIds" array passed directly in setSessionData's
// object -- a different field name/placement than every other modality
// (REST's "formIds", the raw WebSocket's singular "outputFormIds" nested
// differently, etc.). Sends BOTH "outputFormIds" and "outputFormId" below
// -- two different Microsoft doc pages disagree on the exact key name for
// this SDK specifically (the V2F comparison table says plural
// "outputFormIds"; the ambient-session-data reference example uses
// singular "outputFormId", itself assigned an array of multiple ids).
// Sending both costs nothing (an unrecognized key is just ignored) and
// covers whichever one the real backend actually reads -- getting this
// wrong would fail silently, the same way the WebSocket work did earlier.
function buildAmbientData(correlationId, patient, outputFormIds) {
  const fullName = patient?.['Patient Name'] || '';
  const [firstName, ...rest] = fullName.split(' ').filter(Boolean);
  const lastName = rest.join(' ') || undefined;
  return {
    correlationId,
    clientApplicationStableId: 'doctor-robbie',
    clientApplicationVersion: '1.0.0',
    localeInfo: {
      recordingLocales: [SPEECH_LANGUAGE],
      encounterReportLocale: 'en-US',
      encounterUxLocale: 'en-US',
    },
    ...(outputFormIds && outputFormIds.length ? { outputFormIds, outputFormId: outputFormIds } : {}),
    ...(patient
      ? {
          ehrData: {
            patientId: patient['MRN'] || undefined,
            mrn: patient['MRN'] || undefined,
            reasonForVisit: patient['Chief Complaint'] || undefined,
            patient: firstName
              ? {
                  firstName,
                  lastName,
                  dateOfBirth: patient['DOB'] || undefined,
                }
              : undefined,
          },
        }
      : {}),
    draftAutoCreated: false,
    recordingList: [],
    partnerId: PARTNER_GUID,
  };
}

let currentSession = null; // { correlationId, unsubscribe() }

// Starts ambient recording. Resolves once recording has actually started
// (the SDK's own recordingStarted event) -- rejects if the SDK reports a
// failure instead. onUploadStatusChanged is called with 'uploading' |
// 'uploadCompleted' | 'uploadFailed' as the SDK reports them, which is
// exactly the visibility into DAXCore's outcome that the raw WebSocket
// never gave us -- surface these to the physician/log rather than
// discarding them.
async function startAmbientRecording({ correlationId, patient, outputFormIds, onUploadStatusChanged }) {
  const dragon = await ensureInitialized();
  await dragon.recording.ambient.setSessionData(buildAmbientData(correlationId, patient, outputFormIds));

  const uploadHandler = (event) => onUploadStatusChanged?.(event?.status ?? event);
  dragon.recording.ambient.events.addEventListener('ambientRecordingUploadStatusChanged', uploadHandler);

  await new Promise((resolve, reject) => {
    const startedHandler = () => {
      cleanup();
      resolve();
    };
    const stoppedHandler = (event) => {
      // Only relevant here if recording stops/fails before ever starting.
      cleanup();
      reject(new Error(`Recording stopped before it started: ${JSON.stringify(event)}`));
    };
    function cleanup() {
      dragon.recording.events.removeEventListener('recordingStarted', startedHandler);
      dragon.recording.events.removeEventListener('recordingStopped', stoppedHandler);
    }
    dragon.recording.events.addEventListener('recordingStarted', startedHandler);
    dragon.recording.events.addEventListener('recordingStopped', stoppedHandler);
    dragon.recording.toggleRecording({ recordingMode: 'ambient' }).catch((err) => {
      cleanup();
      reject(err);
    });
  });

  currentSession = {
    correlationId,
    unsubscribe: () => dragon.recording.ambient.events.removeEventListener('ambientRecordingUploadStatusChanged', uploadHandler),
  };
}

// Stops the current ambient recording (same toggleRecording call, per
// Microsoft's own sample -- it's a toggle, not separate start/stop
// methods) and resolves once the SDK reports recordingStopped.
async function stopAmbientRecording() {
  if (!currentSession) throw new Error('No ambient recording in progress.');
  const dragon = await ensureInitialized();
  const { correlationId, unsubscribe } = currentSession;
  currentSession = null;

  await new Promise((resolve, reject) => {
    const stoppedHandler = () => {
      dragon.recording.events.removeEventListener('recordingStopped', stoppedHandler);
      resolve();
    };
    dragon.recording.events.addEventListener('recordingStopped', stoppedHandler);
    dragon.recording.toggleRecording({ recordingMode: 'ambient' }).catch((err) => {
      dragon.recording.events.removeEventListener('recordingStopped', stoppedHandler);
      reject(err);
    });
  });

  // Deliberately not unsubscribing the upload-status listener here --
  // ambientRecordingUploadStatusChanged (uploading -> completed/failed)
  // fires AFTER recording stops, so the caller still needs it for a bit
  // longer. Left for the next startAmbientRecording call (or a fresh page
  // load) to replace.
  return correlationId;
}

export const DragonCopilotSdk = {
  missingConfigKeys,
  startAmbientRecording,
  stopAmbientRecording,
};
