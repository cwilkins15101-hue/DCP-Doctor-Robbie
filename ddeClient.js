// ---------------------------------------------------------------------------
// Client for Doctor Robbie's own Dragon Data Exchange (DDE) webhook server
// (see /dde-webhook). Dragon Copilot delivers the finished transcript/note
// to that server asynchronously; this polls it for results by correlationId.
//
// Unlike dragonCopilotWeb.js, this is plain HTTP — no DOM/script/iframe
// needed — so it works the same on native (iOS/Android) and web.
// ---------------------------------------------------------------------------

const DDE_BASE_URL = process.env.EXPO_PUBLIC_DDE_SERVER_URL;
const DDE_APP_SECRET = process.env.EXPO_PUBLIC_DDE_APP_SECRET;

function missingConfigKeys() {
  const required = {
    EXPO_PUBLIC_DDE_SERVER_URL: DDE_BASE_URL,
    EXPO_PUBLIC_DDE_APP_SECRET: DDE_APP_SECRET,
  };
  return Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

// Checks once for a result. Returns null while still pending, or the
// stored payload once Dragon Copilot has delivered it via the webhook.
async function fetchResult(correlationId) {
  const missing = missingConfigKeys();
  if (missing.length > 0) {
    throw new Error(`DDE server isn't configured: missing ${missing.join(', ')}`);
  }

  const url = `${DDE_BASE_URL.replace(/\/$/, '')}/api/getResult?correlationId=${encodeURIComponent(correlationId)}`;
  const response = await fetch(url, { headers: { 'x-app-secret': DDE_APP_SECRET } });

  if (response.status === 202) return null;
  if (!response.ok) {
    throw new Error(`DDE server error ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

// Polls until the result is ready or timeoutMs elapses.
async function pollForResult(correlationId, { intervalMs = 5000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fetchResult(correlationId);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for Dragon Copilot to finish processing.');
}

export const DdeClient = { missingConfigKeys, fetchResult, pollForResult };
