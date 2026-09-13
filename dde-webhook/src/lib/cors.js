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
  'Access-Control-Allow-Headers': 'Content-Type, x-app-secret',
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
