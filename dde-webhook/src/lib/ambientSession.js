// Ambient Session Service — establishes/ends the session that the
// Ambient Audio Streaming upload (audioUpload.js) references by
// correlationId. Lives on the Dragon Copilot Partner API host, which is a
// different host/scope than the AAS audio-upload endpoints.
const config = require('./config');
const { getDragonApiToken } = require('./dragonApiAuth');

async function createAmbientSession({ correlationId, externalUserId, data, ehrInstanceId }) {
  const token = await getDragonApiToken();
  const customerId = config.dragonEnvironmentId();
  const url = `${config.dragonApiBaseUrl()}/ambient-sessions?api-version=2&customerId=${encodeURIComponent(customerId)}`;

  const body = {
    correlationId,
    productId: config.dragonProductId(),
    partnerId: config.dragonPartnerGuid(),
    customerId,
    externalUserId,
    ehrInstanceId,
    ...(data !== undefined ? { data: JSON.stringify(data) } : {}),
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
    throw new Error(`createAmbientSession failed (${response.status}): ${await response.text()}`);
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
