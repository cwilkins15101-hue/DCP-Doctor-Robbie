// ---------------------------------------------------------------------------
// Provider-facing standalone OAuth 2.0 sign-in for the Epic on FHIR sandbox
// (see the "Sandbox Test Data" reference — test logins FHIR/FHIRTWO with
// password EpicFhir11!). Uses a plain Authorization Code + PKCE flow via
// expo-auth-session rather than a separate SDK — the same approach used for
// Doctor Robbie's earlier (since-removed) Entra sign-in attempt.
//
// The Epic on FHIR sandbox is a PUBLIC client flow: no client secret is
// used, only a Client ID from a "Non-Production" app registered at
// https://fhir.epic.com/Developer (instant, no approval needed for sandbox
// use).
// ---------------------------------------------------------------------------
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

WebBrowser.maybeCompleteAuthSession();

const SANDBOX_BASE_URL = (
  process.env.EXPO_PUBLIC_EPIC_SANDBOX_URL || 'https://fhir.epic.com/interconnect-fhir-oauth'
).replace(/\/$/, '');
const CLIENT_ID = process.env.EXPO_PUBLIC_EPIC_CLIENT_ID;
// user/* (not patient/*) scopes since this is a standalone provider launch,
// not tied to a single EHR-launched patient context — the app needs to look
// up a list of patients itself.
const SCOPES = (
  process.env.EXPO_PUBLIC_EPIC_SCOPES ||
  'openid fhirUser online_access user/Patient.read user/Patient.search'
)
  .trim()
  .split(/\s+/)
  .filter(Boolean);

const discovery = {
  authorizationEndpoint: `${SANDBOX_BASE_URL}/oauth2/authorize`,
  tokenEndpoint: `${SANDBOX_BASE_URL}/oauth2/token`,
};

function missingConfigKeys() {
  const required = { EXPO_PUBLIC_EPIC_CLIENT_ID: CLIENT_ID };
  return Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

// In-memory only — cleared on reload, matching the "sign in each session"
// pattern used elsewhere in this prototype. Epic's sandbox access tokens
// are typically short-lived (~55 min); this doesn't implement the
// online_access refresh-token flow, so signIn() runs again once expired.
let cachedToken = null; // { accessToken, expiresAt }

function hasValidToken() {
  return !!(cachedToken && cachedToken.expiresAt > Date.now());
}

async function signIn() {
  const missing = missingConfigKeys();
  if (missing.length > 0) {
    throw new Error(`Epic sign-in isn't configured: missing ${missing.join(', ')}`);
  }

  const redirectUri = AuthSession.makeRedirectUri();
  // Logged so it shows up in the app's own Debug Log — the first time you
  // sign in from a new platform (web/iOS/Android), add this exact URI to
  // the Epic app registration's redirect URIs.
  console.log('Epic sign-in redirect URI (must be registered on the Epic app):', redirectUri);

  const request = new AuthSession.AuthRequest({
    clientId: CLIENT_ID,
    scopes: SCOPES,
    redirectUri,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
  });

  const result = await request.promptAsync(discovery);

  if (result.type === 'cancel' || result.type === 'dismiss') {
    throw new Error('Epic sign-in was cancelled.');
  }
  if (result.type !== 'success') {
    throw new Error(`Epic sign-in failed: ${result.params?.error_description || result.type}`);
  }

  const tokenResponse = await AuthSession.exchangeCodeAsync(
    {
      clientId: CLIENT_ID,
      code: result.params.code,
      redirectUri,
      extraParams: { code_verifier: request.codeVerifier },
    },
    discovery
  );

  cachedToken = {
    accessToken: tokenResponse.accessToken,
    expiresAt: Date.now() + (tokenResponse.expiresIn ?? 3300) * 1000,
  };
  return cachedToken.accessToken;
}

// Returns a valid access token, signing in first if there isn't one yet
// (or the cached one has expired).
async function getAccessToken() {
  if (hasValidToken()) return cachedToken.accessToken;
  return signIn();
}

function signOut() {
  cachedToken = null;
}

export const EpicAuth = { getAccessToken, signIn, signOut, missingConfigKeys };
