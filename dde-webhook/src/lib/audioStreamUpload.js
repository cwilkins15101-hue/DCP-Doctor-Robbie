// Ambient Audio Streaming (AAS) 2.0 WebSocket client — the real-time
// streaming alternative to the REST chunked-upload flow (audioUpload.js,
// now removed). Built directly against Microsoft's "Ambient Audio
// Streaming WebSocket API reference" doc. Two documented quirks worth
// calling out since they're easy to get subtly wrong:
//   - DataChunk messages are BINARY WebSocket frames, but their content is
//     still JSON text (with the audio bytes base64-encoded inside), not
//     raw audio bytes directly — { "DataStart": <offset>, "Data": "<b64>" }.
//   - Text messages (RecordingOpen/RecordingClose) use a custom header
//     block above the JSON body (Path=/X-MS-Request-Id=/X-Timestamp=,
//     separated from the body by a blank line) — plain JSON.parse() on the
//     raw message text will fail without stripping that header first.
const crypto = require('crypto');
const WebSocket = require('ws');
const config = require('./config');
const { getAasToken } = require('./dragonApiAuth');

// No documented max/recommended size for this endpoint — kept the same as
// the REST implementation's chunk size for consistency, adjustable here if
// testing suggests a different size works better.
const CHUNK_SIZE_BYTES = 64 * 1024;

// How long to wait for the server to accept the WebSocket upgrade, and
// separately for it to close cleanly after RecordingClose, before giving
// up — the doc doesn't document either, these are conservative guesses.
const OPEN_TIMEOUT_MS = 15000;
const CLOSE_TIMEOUT_MS = 30000;

// Simple backpressure guard (per the doc's "Best practices" — don't send
// audio faster than the server can process). Not sophisticated; just
// avoids piling megabytes into ws's internal send buffer if the server
// falls behind.
const MAX_BUFFERED_BYTES = 1024 * 1024;

function newRequestId() {
  return crypto.randomUUID();
}

function buildTextMessage(path, body) {
  return (
    `Path=${path}\r\n` +
    `X-MS-Request-Id=${newRequestId()}\r\n` +
    `X-Timestamp=${new Date().toISOString()}\r\n` +
    `\r\n` +
    JSON.stringify(body)
  );
}

// Server responses may or may not carry the same header block (the doc's
// own examples show it for client-sent messages but omit it for server
// responses) — handle both so this doesn't break either way.
function parseTextMessage(raw) {
  const headerBoundary = raw.indexOf('\r\n\r\n');
  const jsonPart = headerBoundary === -1 ? raw : raw.slice(headerBoundary + 4);
  try {
    return JSON.parse(jsonPart);
  } catch {
    return null;
  }
}

function buildDataChunkFrame(dataStart, buffer) {
  return Buffer.from(JSON.stringify({ DataStart: dataStart, Data: buffer.toString('base64') }), 'utf8');
}

function waitForDrain(ws) {
  return new Promise((resolve) => {
    const check = () => {
      if (ws.bufferedAmount <= MAX_BUFFERED_BYTES) {
        resolve();
      } else {
        setTimeout(check, 20);
      }
    };
    check();
  });
}

// Streams a finished recording to Dragon Copilot over the AAS WebSocket
// API and waits for RecordingCloseResponse (confirms the server has
// stored it — actual note/transcript generation continues asynchronously,
// delivered later via the existing webhook, same as the REST flow).
//
// outputFormIds requests Voice-to-Form output instead of (or alongside)
// the standard clinical note — see "Ambient Audio Streaming WebSocket API
// reference" for the field, though the *response* payload shape for a
// custom form isn't documented yet; parsing that is a separate, later
// change once that's confirmed.
async function streamRecording({
  correlationId,
  audioBuffer,
  recordingId = 1,
  ehrInstanceId,
  externalUserId,
  outputFormIds,
}) {
  const token = await getAasToken();
  const customerId = config.dragonEnvironmentId();

  const headers = {
    Authorization: `Bearer ${token}`,
    'customer-id': customerId,
  };
  if (externalUserId) headers['external-user-id'] = externalUserId;
  headers['product-id'] = config.dragonProductId();

  const ws = new WebSocket(config.aasWsUrl(), { headers });

  return new Promise((resolve, reject) => {
    let settled = false;
    let openTimer;
    let closeTimer;

    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      clearTimeout(closeTimer);
      ws.removeAllListeners();
      try {
        ws.terminate();
      } catch {
        // already closed
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    }

    function succeed(result) {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      clearTimeout(closeTimer);
      resolve(result);
    }

    openTimer = setTimeout(
      () => fail(new Error('Timed out waiting for the AAS WebSocket to open.')),
      OPEN_TIMEOUT_MS
    );

    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        fail(new Error(`AAS WebSocket upgrade rejected (${res.statusCode}): ${body}`));
      });
    });

    ws.on('open', async () => {
      clearTimeout(openTimer);
      try {
        const recordingOpenBody = {
          recordingId: correlationId + '-' + recordingId,
          ambientSessionData: {
            productId: config.dragonProductId(),
            partnerId: config.dragonPartnerGuid(),
            customerId,
            correlationId,
            ...(externalUserId
              ? { externalIdentifiers: [{ type: 'userId', identifier: externalUserId }] }
              : {}),
            ...(ehrInstanceId ? { ehrInstanceId } : {}),
            localeInfo: {
              recordingLocales: ['en-US'],
              encounterReportLocale: 'en-US',
              encounterUxLocale: 'en-US',
            },
          },
          actions: ['generate-draft'],
          reason: 'ui',
          startingOffset: 0,
          ...(outputFormIds && outputFormIds.length ? { outputFormIds } : {}),
        };
        ws.send(buildTextMessage('RecordingOpen', recordingOpenBody));

        let offset = 0;
        for (; offset < audioBuffer.length; offset += CHUNK_SIZE_BYTES) {
          if (settled) return;
          await waitForDrain(ws);
          const slice = audioBuffer.subarray(offset, Math.min(offset + CHUNK_SIZE_BYTES, audioBuffer.length));
          ws.send(buildDataChunkFrame(offset, slice), { binary: true });
        }

        ws.send(
          buildTextMessage('RecordingClose', {
            recordingId: correlationId + '-' + recordingId,
            recordingLengthSeconds: 0,
            reason: 'ui',
          })
        );

        closeTimer = setTimeout(
          () => fail(new Error('Timed out waiting for RecordingCloseResponse from the AAS WebSocket.')),
          CLOSE_TIMEOUT_MS
        );
      } catch (err) {
        fail(err);
      }
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary || settled) return;
      const parsed = parseTextMessage(data.toString('utf8'));
      if (parsed?.recordingCloses) {
        succeed({ dataStored: parsed.recordingCloses.dataStored });
        ws.close(1000);
      }
      // DataStorageResponse (parsed?.dataStored) is just a progress ack —
      // nothing to do with it here.
    });

    ws.on('close', (code, reasonBuf) => {
      if (settled) return;
      // A clean close (1000) that arrives before we saw
      // RecordingCloseResponse still counts as success per the documented
      // lifecycle (server "closes" after confirming) — anything else is a
      // real failure, and per the doc, RecordingOpen validation failures
      // surface ONLY as a close with no prior message at all.
      if (code === 1000) {
        succeed({ dataStored: null });
      } else {
        fail(new Error(`AAS WebSocket closed unexpectedly (code ${code}): ${reasonBuf?.toString('utf8') || 'no reason given'}`));
      }
    });

    ws.on('error', (err) => fail(err));
  });
}

module.exports = { streamRecording, buildTextMessage, parseTextMessage, buildDataChunkFrame, CHUNK_SIZE_BYTES };
