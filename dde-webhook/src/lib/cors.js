// Shared CORS handling for the two endpoints the Doctor Robbie app calls
// directly from the browser (submitRecording, getResult). Wildcard origin is
// fine here since both endpoints are already gated by the x-app-secret
// shared secret regardless of where the request comes from.
//
// webhookReceiver.js does NOT use this — its OPTIONS handling answers Dragon
// Data Exchange's own Event Grid validation handshake (server-to-server),
// which is a different protocol from browser CORS preflight.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // Authorization added when submitRecording started forwarding the
  // physician's delegated Entra token (2026-09-23) — without this, the
  // browser blocks the actual request at the CORS preflight stage before
  // it ever reaches the server, silently (a browser-console-only error,
  // not an HTTP response), since a custom Authorization header on a
  // cross-origin request must be explicitly allow-listed here.
  'Access-Control-Allow-Headers': 'Content-Type, x-app-secret, Authorization',
};

function handleCorsPreflight(request) {
  if (request.method === 'OPTIONS') {
    return { status: 204, headers: CORS_HEADERS };
  }
  return null;
}

function withCors(response) {
  return { ...response, headers: { ...CORS_HEADERS, ...response.headers } };
}

module.exports = { CORS_HEADERS, handleCorsPreflight, withCors };
