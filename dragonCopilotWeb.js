// ---------------------------------------------------------------------------
// Real Dragon Copilot SDK for JavaScript integration — WEB ONLY.
//
// This talks to the actual Dragon Copilot SDK (loaded from Microsoft's CDN)
// instead of the placeholder mock. It only works when the app is running in
// a browser (`npm run web`), because the SDK itself requires a real DOM
// (it injects a <script> tag and hands back an <iframe> for note review).
// Callers MUST check Platform.OS === 'web' before using anything here.
//
// Modeled directly on Microsoft's own sample app:
// https://github.com/microsoft/dragon-copilot-sdk-samples/tree/main/react-sample-with-dragon-copilot
//
// This has not been run against a real Dragon Copilot sandbox — it needs
// real credentials (see .env.example) and a browser to verify against.
// ---------------------------------------------------------------------------

const SDK_SCRIPT_URL =
  'https://download.microsoft.com/download/9618a2a2-0d23-4587-aab6-2474fd8dd210/dragon-copilot-sdk-mainline.js';

const DRAGON_CONFIG = {
  partnerGuid: process.env.EXPO_PUBLIC_DRAGON_PARTNER_GUID,
  environmentId: process.env.EXPO_PUBLIC_DRAGON_ENVIRONMENT_ID,
  applicationName: 'Doctor Robbie',
  speechLanguage: process.env.EXPO_PUBLIC_DRAGON_SPEECH_LANGUAGE || 'en-US',
  dragonMedicalServer: {
    url: process.env.EXPO_PUBLIC_DRAGON_MEDICAL_SERVER_URL,
    scope: process.env.EXPO_PUBLIC_DRAGON_MEDICAL_SERVER_SCOPE,
  },
  configService: {
    url: process.env.EXPO_PUBLIC_DRAGON_CONFIG_SERVICE_URL,
    scope: process.env.EXPO_PUBLIC_DRAGON_CONFIG_SERVICE_SCOPE,
  },
  ehrIntegrationService: {
    url: process.env.EXPO_PUBLIC_DRAGON_EHR_INTEGRATION_URL,
    scope: process.env.EXPO_PUBLIC_DRAGON_EHR_INTEGRATION_SCOPE,
  },
};

const MSAL_CONFIG = {
  clientId: process.env.EXPO_PUBLIC_ENTRA_CLIENT_ID,
  authority:
    process.env.EXPO_PUBLIC_ENTRA_AUTHORITY || 'https://login.microsoftonline.com/common',
  scopes: ['user.read'],
};

// Minimal config needed just to attempt Microsoft sign-in — separate from
// the fuller check below, so a signed-in user isn't blocked from anything
// just because the SDK-only fields are still empty.
function signInMissingConfigKeys() {
  const required = { EXPO_PUBLIC_ENTRA_CLIENT_ID: MSAL_CONFIG.clientId };
  return Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

// Config keys required before the real integration can run. Anything missing
// is surfaced to the UI instead of failing deep inside an SDK call.
function missingConfigKeys() {
  const required = {
    EXPO_PUBLIC_DRAGON_PARTNER_GUID: DRAGON_CONFIG.partnerGuid,
    EXPO_PUBLIC_DRAGON_ENVIRONMENT_ID: DRAGON_CONFIG.environmentId,
    EXPO_PUBLIC_DRAGON_MEDICAL_SERVER_URL: DRAGON_CONFIG.dragonMedicalServer.url,
    EXPO_PUBLIC_ENTRA_CLIENT_ID: MSAL_CONFIG.clientId,
  };
  return Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

let scriptLoadPromise = null;
function loadSdkScript() {
  if (scriptLoadPromise) return scriptLoadPromise;
  scriptLoadPromise = new Promise((resolve, reject) => {
    if (globalThis.DragonCopilotSDK) {
      resolve(globalThis.DragonCopilotSDK);
      return;
    }
    const script = document.createElement('script');
    script.src = SDK_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve(globalThis.DragonCopilotSDK);
    script.onerror = () => reject(new Error('Failed to load the Dragon Copilot SDK script.'));
    document.head.appendChild(script);
  });
  return scriptLoadPromise;
}

let msalApp = null;
let msalAccount = null;

async function ensureMsal() {
  if (msalApp) return msalApp;
  const { PublicClientApplication } = await import('@azure/msal-browser');
  msalApp = new PublicClientApplication({
    auth: {
      clientId: MSAL_CONFIG.clientId,
      authority: MSAL_CONFIG.authority,
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: 'localStorage', storeAuthStateInCookie: false },
  });
  await msalApp.initialize();
  await msalApp.handleRedirectPromise();
  const accounts = msalApp.getAllAccounts();
  if (accounts.length > 0) msalAccount = accounts[0];
  return msalApp;
}

function isSignedIn() {
  return !!msalAccount;
}

async function signIn() {
  await ensureMsal();
  const result = await msalApp.loginPopup({ scopes: MSAL_CONFIG.scopes });
  msalAccount = result.account;
  return msalAccount;
}

// Exchanges an Entra ID token for a Dragon Copilot token, the same two-step
// pattern Microsoft's own sample uses in its acquireAccessToken callback.
let ehrClient = null;
async function acquireAccessToken(scope) {
  if (!msalAccount) throw new Error('Not signed in to Microsoft Entra yet.');
  const dragon = globalThis.DragonCopilotSDK.dragon;
  if (!ehrClient) {
    ehrClient = new dragon.authentication.ehr.EhrAuthenticationClient({
      customerId: DRAGON_CONFIG.environmentId,
    });
  }
  const response = await msalApp.acquireTokenSilent({
    scopes: [scope],
    account: msalAccount,
    forceRefresh: false,
  });
  return ehrClient.acquireToken({ accessToken: response.accessToken });
}

let initializedPromise = null;
function ensureInitialized() {
  if (initializedPromise) return initializedPromise;
  const missing = missingConfigKeys();
  if (missing.length > 0) {
    return Promise.reject(
      new Error(`Dragon Copilot SDK is missing configuration: ${missing.join(', ')}`)
    );
  }
  initializedPromise = (async () => {
    const sdk = await loadSdkScript();
    // The speech broker must be initialized before dragon.initialize().
    sdk.initSpeechBroker();
    await sdk.dragon.initialize({
      partnerGuid: DRAGON_CONFIG.partnerGuid,
      environmentId: DRAGON_CONFIG.environmentId,
      applicationName: DRAGON_CONFIG.applicationName,
      services: {
        dragonMedicalServer: DRAGON_CONFIG.dragonMedicalServer,
        configService: DRAGON_CONFIG.configService,
        ehrIntegrationService: DRAGON_CONFIG.ehrIntegrationService,
      },
      authentication: {
        acquireAccessToken,
        scopeBehavior: 'ehrScoped',
      },
      isAmbientEnabled: true,
    });
  })();
  return initializedPromise;
}

function splitPatientName(fullName) {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? 'Unknown',
    lastName: parts.slice(1).join(' '),
  };
}

// Maps a Doctor Robbie patient (parsed from the loaded CSV) into the
// encounter context Dragon Copilot expects before recording starts.
function buildSessionData(patient) {
  const { firstName, lastName } = splitPatientName(patient?.['Patient Name']);
  const patientId = patient?.['MRN'] || 'UNKNOWN';
  return {
    correlationId: `doctor-robbie-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    clientApplicationStableId: 'doctorRobbie',
    clientApplicationVersion: '1.0.0',
    localeInfo: {
      recordingLocales: [DRAGON_CONFIG.speechLanguage],
      encounterReportLocale: 'en-US',
      encounterUxLocale: 'en-US',
    },
    ehrData: {
      patientId,
      mrn: patientId,
      reasonForVisit: patient?.['Chief Complaint'] ?? '',
      patient: {
        id: patientId,
        firstName,
        lastName,
        dateOfBirth: patient?.['DOB'] || null,
      },
      version: 1,
      dataOrigin: 0,
    },
    draftAutoCreated: false,
    recordingList: [],
    partnerId: DRAGON_CONFIG.partnerGuid,
  };
}

// Returns the correlationId used for this session — the app needs it to
// later look up the result once Dragon Data Exchange delivers it.
async function setSessionData(patient) {
  await ensureInitialized();
  const dragon = globalThis.DragonCopilotSDK.dragon;
  const sessionData = buildSessionData(patient);
  await dragon.recording.ambient.setSessionData(sessionData);
  return sessionData.correlationId;
}

// Starts or stops ambient recording — the SDK doesn't expose separate
// start()/stop() calls, just a single toggle (confirmed from Microsoft's
// sample Recording.tsx component).
function toggleAmbientRecording() {
  const dragon = globalThis.DragonCopilotSDK.dragon;
  dragon.recording.toggleRecording({ recordingMode: 'ambient' });
}

// Subscribes to SDK events; returns an unsubscribe function.
function addEventListeners({ onRecordingStarted, onRecordingStopped, onUploadStatusChanged, onError } = {}) {
  const dragon = globalThis.DragonCopilotSDK.dragon;
  const cleanups = [];

  if (onRecordingStarted) {
    const handler = (event) => onRecordingStarted(event.detail);
    dragon.recording.events.addEventListener('recordingStarted', handler);
    cleanups.push(() => dragon.recording.events.removeEventListener('recordingStarted', handler));
  }
  if (onRecordingStopped) {
    const handler = () => onRecordingStopped();
    dragon.recording.events.addEventListener('recordingStopped', handler);
    cleanups.push(() => dragon.recording.events.removeEventListener('recordingStopped', handler));
  }
  if (onUploadStatusChanged) {
    const handler = (event) => onUploadStatusChanged(event.detail.status);
    dragon.recording.ambient.events.addEventListener('ambientRecordingUploadStatusChanged', handler);
    cleanups.push(() =>
      dragon.recording.ambient.events.removeEventListener('ambientRecordingUploadStatusChanged', handler)
    );
  }
  if (onError) {
    const handler = (event) => onError(event.detail);
    dragon.error.events.addEventListener('errorOccurred', handler);
    cleanups.push(() => dragon.error.events.removeEventListener('errorOccurred', handler));
  }

  return () => cleanups.forEach((cleanup) => cleanup());
}

// Returns the URL for Dragon Copilot's own note-review panel, meant to be
// rendered in an <iframe data-dragon-iframe>. The SDK auto-detects that
// attribute and takes over the iframe's content.
async function getReviewUrl() {
  await ensureInitialized();
  const dragon = globalThis.DragonCopilotSDK.dragon;
  const urls = await dragon.settingViews.getUrls();
  return urls?.baseUrl ?? null;
}

export const DragonCopilotWeb = {
  missingConfigKeys,
  signInMissingConfigKeys,
  ensureInitialized,
  isSignedIn,
  signIn,
  setSessionData,
  toggleAmbientRecording,
  addEventListeners,
  getReviewUrl,
};
