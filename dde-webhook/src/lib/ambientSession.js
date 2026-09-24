// Ambient Session Service — establishes/ends the session that the
// Ambient Audio Streaming upload (audioStreamUpload.js) references by
// correlationId. Lives on the Dragon Copilot Partner API host, which is a
// different host/scope than the AAS audio-upload endpoint.
const config = require('./config');
const { getDragonApiToken, describeTokenForAllowList } = require('./dragonApiAuth');

// outputFormIds requests Voice-to-Form output(s) instead of (or alongside)
// the standard clinical note. Confirmed 2026-09-24 from Microsoft's V2F
// onboarding guide: for this REST modality (Ambient Session Create) it goes
// as a top-level "formIds" key inside the *stringified* data field -- a
// different field name and a different place than the AAS WebSocket, which
// takes it as its own outputFormIds field on the RecordingOpen message
// (see liveAasSession.js) and does NOT read it from here. Only merged in
// when passed, so existing callers (streamStart.js, which sets it on
// RecordingOpen instead) are unaffected.
async function createAmbientSession({ correlationId, externalUserId, data, ehrInstanceId, outputFormIds }) {
  const token = await getDragonApiToken();
  const customerId = config.dragonEnvironmentId();
  const url = `${config.dragonApiBaseUrl()}/ambient-sessions?api-version=2&customerId=${encodeURIComponent(customerId)}`;

  const sessionData =
    outputFormIds && outputFormIds.length ? { ...(data || {}), formIds: outputFormIds } : data;

  const body = {
    correlationId,
    productId: config.dragonProductId(),
    partnerId: config.dragonPartnerGuid(),
    customerId,
    externalUserId,
    ehrInstanceId,
    ...(sessionData !== undefined ? { data: JSON.stringify(sessionData) } : {}),
  };

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // TEMPORARY — includes the token's claims (for the Dragon Copilot
    // partner allow-list request) directly in the error, since that's
    // reliably visible via context.error. Remove once allow-listed.
    throw new Error(
      `createAmbientSession failed (${response.status}): ${await response.text()} | token claims: ${describeTokenForAllowList(token)}`
    );
  }
  return response.json();
}

async function endAmbientSession(correlationId) {
  const token = await getDragonApiToken();
  const customerId = config.dragonEnvironmentId();
  const url = `${config.dragonApiBaseUrl()}/ambient-sessions/${encodeURIComponent(correlationId)}?api-version=2&customerId=${encodeURIComponent(customerId)}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`endAmbientSession failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

module.exports = { createAmbientSession, endAmbientSession };
