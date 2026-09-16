// Ambient Audio Streaming (AAS) 2.0 REST client — uploads a recording as a
// sequence of chunks, then finalizes to trigger Dragon Copilot processing.
// Built directly against Microsoft's AAS 2.0 API reference. Two documented
// quirks worth calling out since they're easy to get subtly wrong:
//   - chunkId numbering starts at 1, but chunk 1 must carry NO audio data
//     (it's a metadata-only placeholder) — actual audio starts at chunkId 2.
//   - every request needs a fresh `x-correlation-id` header for tracing —
//     this is NOT the same value as the session's correlationId.
const crypto = require('crypto');
const config = require('./config');
const { getAasToken } = require('./dragonApiAuth');

// AAS's docs don't state an exact max chunk size (unlike the separate
// "Audio service" API, which documents 100KB) — this is a conservative
// assumption to validate against real uploads, not a confirmed limit.
const CHUNK_SIZE_BYTES = 64 * 1024;

function newTraceId() {
  return crypto.randomUUID();
}

async function storeChunk({ correlationId, recordingId, chunkId, buffer, isLast, ehrInstanceId, externalUserId }) {
  const token = await getAasToken();
  const customerId = config.dragonEnvironmentId();
  const url = `${config.aasBaseUrl()}/audio/storeChunk?api-version=2025-07-15&customerId=${encodeURIComponent(customerId)}`;

  const metadata = {
    productId: config.dragonProductId(),
    partnerId: config.dragonPartnerGuid(),
    customerId,
    correlationId,
    recordingId,
    chunkId,
    isLast: !!isLast,
    ...(ehrInstanceId ? { ehrInstanceId } : {}),
    ...(externalUserId ? { externalUserId } : {}),
  };

  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  if (buffer && buffer.length > 0) {
    form.append('content', new Blob([buffer]), 'chunk.bin');
  }

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-correlation-id': newTraceId(),
    },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`storeChunk failed (chunkId ${chunkId}, ${response.status}): ${await response.text()}`);
  }
  return response.json();
}

async function finalizeUpload({ correlationId, recordingId, totalChunks, ehrInstanceId, externalUserId }) {
  const token = await getAasToken();
  const customerId = config.dragonEnvironmentId();
  const url = `${config.aasBaseUrl()}/audio/finalizeUpload?api-version=2025-07-15&customerId=${encodeURIComponent(customerId)}`;

  const body = {
    correlationId,
    customerId,
    partnerId: config.dragonPartnerGuid(),
    productId: config.dragonProductId(),
    recordingId,
    totalChunks,
    ...(ehrInstanceId ? { ehrInstanceId } : {}),
    ...(externalUserId ? { externalUserId } : {}),
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-correlation-id': newTraceId(),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`finalizeUpload failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

// Splits a full audio buffer into chunks per AAS's documented rules and
// uploads them sequentially, then finalizes. recordingId lets one session
// (correlationId/encounter) hold multiple takes — Doctor Robbie increments
// it for each additional recording added to the same encounter; reusing
// recordingId 1 would look like re-finalizing the same take rather than a
// new one.
async function uploadRecording({ correlationId, audioBuffer, recordingId = 1, ehrInstanceId, externalUserId }) {
  // chunkId 1 carries no audio data, per the documented contract.
  await storeChunk({ correlationId, recordingId, chunkId: 1, buffer: null, ehrInstanceId, externalUserId });

  const chunks = [];
  for (let offset = 0; offset < audioBuffer.length; offset += CHUNK_SIZE_BYTES) {
    chunks.push(audioBuffer.subarray(offset, offset + CHUNK_SIZE_BYTES));
  }
  if (chunks.length === 0) chunks.push(Buffer.alloc(0));

  for (let i = 0; i < chunks.length; i++) {
    await storeChunk({
      correlationId,
      recordingId,
      chunkId: i + 2,
      buffer: chunks[i],
      isLast: i === chunks.length - 1,
      ehrInstanceId,
      externalUserId,
    });
  }

  // totalChunks counts every storeChunk call made, including the empty
  // chunkId-1 placeholder — the docs specify this must match the number
  // of chunks actually sent.
  const totalChunks = chunks.length + 1;
  return finalizeUpload({ correlationId, recordingId, totalChunks, ehrInstanceId, externalUserId });
}

module.exports = { storeChunk, finalizeUpload, uploadRecording, CHUNK_SIZE_BYTES };
