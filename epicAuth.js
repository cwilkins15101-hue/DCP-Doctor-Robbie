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
import { Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

WebBrowser.maybeCompleteAuthSession();

const SANDBOX_BASE_URL = (
  process.env.EXPO_PUBLIC_EPIC_SANDBOX_URL || 'https://fhir.epic.com/interconnect-fhir-oauth'
).replace(/\/$/, '');
// Epic requires the authorize request to name the FHIR server it's for via
// an `aud` parameter (SMART App Launch's audience check) — omitting it
// causes a generic "Something went wrong trying to authorize the client"
// error before the login screen even appears.
const FHIR_BASE_URL = `${SANDBOX_BASE_URL}/api/FHIR/R4`;
const CLIENT_ID = process.env.EXPO_PUBLIC_EPIC_CLIENT_ID;
// user/* (not patient/*) scopes since this is a standalone provider launch,
// not tied to a single EHR-launched patient context — the app needs to look
// up a list of patients itself. Condition scopes back the "Problems &
// Reason for Visit" chart section; DocumentReference/Binary back both CCD
// retrieval (the $docref operation) and Clinical Notes.
const SCOPES = (
  process.env.EXPO_PUBLIC_EPIC_SCOPES ||
  'openid fhirUser online_access user/Patient.read user/Patient.search ' +
    'user/Condition.read user/Condition.search ' +
    'user/DocumentReference.read user/DocumentReference.search user/Binary.read'
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

// Kept in memory, and on web also in sessionStorage so it survives the
// full-page redirect to Epic and back (see signInViaRedirect below).
// Epic's sandbox access tokens are typically short-lived (~55 min); this
// doesn't implement the online_access refresh-token flow, so signIn() runs
// again once expired.
let cachedToken = null; // { accessToken, expiresAt }

// v2: older cached tokens predate the write scope above, so they'd be refused.
const TOKEN_KEY = 'epicAuth.token.v2';
const PENDING_KEY = 'epicAuth.pending'; // { state, codeVerifier, redirectUri }
// Set just before leaving for Epic so the app knows to pick up where it left
// off (reload the patient list) once it's back.
export const EPIC_RESUME_KEY = 'epicAuth.resume';

function storage() {
  try {
    return Platform.OS === 'web' ? globalThis.sessionStorage : null;
  } catch {
    return null;
  }
}

function readJson(key) {
  try {
    return JSON.parse(storage()?.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function persistToken() {
  try {
    if (cachedToken) storage()?.setItem(TOKEN_KEY, JSON.stringify(cachedToken));
    else storage()?.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (e.g. private mode) — in-memory token still works.
  }
}

cachedToken = readJson(TOKEN_KEY);

function hasValidToken() {
  return !!(cachedToken && cachedToken.expiresAt > Date.now());
}

function storeTokenResponse(tokenResponse) {
  // Epic only grants the scopes your app is actually allowed to use; logging
  // what came back (visible in the in-app Debug Log) shows whether write
  // permission was really granted.
  console.log('Epic sign-in granted scopes:', tokenResponse.scope ?? '(none reported)');
  cachedToken = {
    accessToken: tokenResponse.accessToken,
    expiresAt: Date.now() + (tokenResponse.expiresIn ?? 3300) * 1000,
  };
  persistToken();
  return cachedToken.accessToken;
}

// "Send to Epic" needs write permission, but Epic rejects the whole sign-in
// ("Invalid OAuth 2.0 request") if the app asks for a scope it isn't set up
// for. So write permission is opt-in: open the site with ?epicWrite=1 (asks
// for user/DocumentReference.write) or ?epicWrite=<scope> to try another
// scope name, then click Epic Patient List.
function requestedScopes() {
  if (Platform.OS !== 'web') return SCOPES;
  const param = new URLSearchParams(globalThis.location?.search ?? '').get('epicWrite');
  if (!param) return SCOPES;
  const writeScope = param === '1' ? 'user/DocumentReference.write' : param;
  return [...SCOPES, writeScope];
}

function buildRequest(redirectUri) {
  return new AuthSession.AuthRequest({
    clientId: CLIENT_ID,
    scopes: requestedScopes(),
    redirectUri,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
    extraParams: { aud: FHIR_BASE_URL },
  });
}

// Web sign-in: a full-page redirect to Epic and back, instead of the pop-up
// expo-auth-session uses by default. Epic's login pages sever the link
// between a pop-up and the page that opened it, so the opener sees the
// pop-up as closed ("Epic sign-in was cancelled.") while the pop-up itself
// lands back on this app with the code in its URL and no way to hand it
// over. Redirecting the whole page has no opener to lose.
async function signInViaRedirect(redirectUri) {
  const request = buildRequest(redirectUri);
  const authUrl = await request.makeAuthUrlAsync(discovery);
  storage().setItem(
    PENDING_KEY,
    JSON.stringify({ state: request.state, codeVerifier: request.codeVerifier, redirectUri })
  );
  storage().setItem(EPIC_RESUME_KEY, '1');
  globalThis.location.assign(authUrl);
  // The page is navigating away; never resolve so callers don't act on a
  // missing token in the meantime.
  return new Promise(() => {});
}

// If the page was just loaded as Epic's redirect back (?code=...&state=...
// matching the sign-in we started), exchange the code for a token. Returns
// the token, or null if this load isn't an Epic return.
async function completeRedirectIfPresent() {
  if (Platform.OS !== 'web') return null;
  const pending = readJson(PENDING_KEY);
  if (!pending) return null;

  const url = new URL(globalThis.location.href);
  if (url.searchParams.get('state') !== pending.state) return null;

  storage().removeItem(PENDING_KEY);
  // Strip the one-time code from the address bar and history.
  globalThis.history.replaceState({}, '', url.origin + url.pathname);

  const error = url.searchParams.get('error');
  if (error) {
    throw new Error(`Epic sign-in failed: ${url.searchParams.get('error_description') || error}`);
  }

  const tokenResponse = await AuthSession.exchangeCodeAsync(
    {
      clientId: CLIENT_ID,
      code: url.searchParams.get('code'),
      redirectUri: pending.redirectUri,
      extraParams: { code_verifier: pending.codeVerifier },
    },
    discovery
  );
  return storeTokenResponse(tokenResponse);
}

async function signIn() {
  const missing = missingConfigKeys();
  if (missing.length > 0) {
    throw new Error(`Epic sign-in isn't configured: missing ${missing.join(', ')}`);
  }

  // Drop any query string (e.g. ?epicWrite=1): Epic matches the return
  // address exactly, so it must be the same as the registered one.
  const redirectUri = AuthSession.makeRedirectUri().split('?')[0];
  // Logged so it shows up in the app's own Debug Log — the first time you
  // sign in from a new platform (web/iOS/Android), add this exact URI to
  // the Epic app registration's redirect URIs.
  console.log('Epic sign-in redirect URI (must be registered on the Epic app):', redirectUri);

  if (Platform.OS === 'web') return signInViaRedirect(redirectUri);

  const request = buildRequest(redirectUri);
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
  return storeTokenResponse(tokenResponse);
}

// Returns a valid access token, signing in first if there isn't one yet
// (or the cached one has expired).
async function getAccessToken() {
  if (hasValidToken()) return cachedToken.accessToken;
  const returned = await completeRedirectIfPresent();
  if (returned) return returned;
  return signIn();
}

function signOut() {
  cachedToken = null;
  persistToken();
}

export const EpicAuth = { getAccessToken, signIn, signOut, missingConfigKeys };
