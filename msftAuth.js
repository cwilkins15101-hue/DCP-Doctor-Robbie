// ---------------------------------------------------------------------------
// Doctor Robbie's actual login — interactive Microsoft sign-in via
// Authorization Code + PKCE (expo-auth-session), a public client, no
// secret. Same Entra tenant/app registration dde-webhook already uses
// server-to-server for Ambient Audio Streaming, but this is a genuinely
// different flow: it signs in a real physician and requests a delegated
// Connector.Access scope, rather than minting an app-only token.
//
// This delegated token is required for the "Launch Dragon Copilot" button
// (Token Launch API) — confirmed by testing that Dragon Copilot rejects an
// app-only token there with 401, and by decoding a token from a working
// manual test: it carried "idtyp": "user" and a "scp" (delegated scope)
// claim, not the "roles" claim an app-only token would carry. Making this
// the app's own sign-in (rather than a separate prompt just for that
// button) means physicians authenticate once per session and that same
// token covers both identifying them in the app and launching Dragon
// Copilot later.
// ---------------------------------------------------------------------------
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

WebBrowser.maybeCompleteAuthSession();

const TENANT_ID = process.env.EXPO_PUBLIC_MSFT_TENANT_ID || '50b0f407-cfdb-4951-8ec8-ab8f9d4217ea';
const CLIENT_ID = process.env.EXPO_PUBLIC_MSFT_CLIENT_ID || 'b1fc69fc-9d91-4b8d-9151-3a1892ae17fd';
// openid/profile back the ID token (so the app can show who's signed in);
// offline_access requests a refresh token so physicians aren't re-prompted
// every ~90 minutes mid-shift; the Connector.Access scope is what Token
// Launch actually checks for.
const SCOPES = (
  process.env.EXPO_PUBLIC_MSFT_SCOPES ||
  'openid profile offline_access 40d36082-d340-492f-a5af-e42ef68f4b2b/Connector.Access'
)
  .trim()
  .split(/\s+/)
  .filter(Boolean);

const discovery = {
  authorizationEndpoint: `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`,
  tokenEndpoint: `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
};

function missingConfigKeys() {
  const required = { EXPO_PUBLIC_MSFT_CLIENT_ID: CLIENT_ID, EXPO_PUBLIC_MSFT_TENANT_ID: TENANT_ID };
  return Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

function decodeIdTokenClaims(idToken) {
  try {
    const base64 = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(globalThis.atob(padded));
  } catch {
    return null;
  }
}

// In-memory only — cleared on reload, matching the "sign in each session"
// pattern already used for Epic. { accessToken, refreshToken, expiresAt,
// name, username }
let cachedToken = null;

function hasValidToken() {
  return !!(cachedToken && cachedToken.expiresAt > Date.now());
}

function applyTokenResponse(tokenResponse) {
  const claims = tokenResponse.idToken ? decodeIdTokenClaims(tokenResponse.idToken) : null;
  cachedToken = {
    accessToken: tokenResponse.accessToken,
    // A refresh response doesn't always include a new refresh token —
    // Microsoft's rotate-or-reuse behavior varies, so keep the old one
    // unless a new one was actually issued.
    refreshToken: tokenResponse.refreshToken ?? cachedToken?.refreshToken ?? null,
    expiresAt: Date.now() + (tokenResponse.expiresIn ?? 3300) * 1000,
    name: claims?.name ?? cachedToken?.name ?? null,
    username: claims?.preferred_username ?? cachedToken?.username ?? null,
  };
  return cachedToken.accessToken;
}

async function signIn() {
  const missing = missingConfigKeys();
  if (missing.length > 0) {
    throw new Error(`Microsoft sign-in isn't configured: missing ${missing.join(', ')}`);
  }

  const redirectUri = AuthSession.makeRedirectUri();
  // Logged so it shows up in the app's own Debug Log — this exact URI must
  // be registered on the Entra app (b1fc69fc-...) as a redirect URI under
  // its "Single-page application" platform specifically — registering it
  // under "Web" instead blocks the token exchange below with a CORS error,
  // since that request is made directly from browser JS with no secret.
  console.log('Microsoft sign-in redirect URI (must be registered as a Single-page application redirect URI on the Entra app):', redirectUri);

  const request = new AuthSession.AuthRequest({
    clientId: CLIENT_ID,
    scopes: SCOPES,
    redirectUri,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
  });

  const result = await request.promptAsync(discovery);

  if (result.type === 'cancel' || result.type === 'dismiss') {
    throw new Error('Microsoft sign-in was cancelled.');
  }
  if (result.type !== 'success') {
    throw new Error(`Microsoft sign-in failed: ${result.params?.error_description || result.type}`);
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

  return applyTokenResponse(tokenResponse);
}

// Returns a valid access token — refreshes silently if expired and a
// refresh token is available, otherwise prompts an interactive sign-in.
async function getAccessToken() {
  if (hasValidToken()) return cachedToken.accessToken;
  if (cachedToken?.refreshToken) {
    try {
      const refreshed = await AuthSession.refreshAsync(
        { clientId: CLIENT_ID, refreshToken: cachedToken.refreshToken },
        discovery
      );
      return applyTokenResponse(refreshed);
    } catch {
      // Refresh token expired/revoked — fall through to a fresh sign-in.
    }
  }
  return signIn();
}

function getSignedInUser() {
  if (!hasValidToken()) return null;
  return { name: cachedToken.name, username: cachedToken.username };
}

function signOut() {
  cachedToken = null;
}

export const MsftAuth = {
  getAccessToken,
  getSignedInUser,
  hasValidToken,
  signIn,
  signOut,
  missingConfigKeys,
};
