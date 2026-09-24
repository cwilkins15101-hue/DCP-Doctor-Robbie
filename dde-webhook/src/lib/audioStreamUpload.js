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
const { describeTokenForAllowList } = require('./dragonApiAuth');

// No documented max/recommended size for this endpoint — kept the same as
// the REST implementation's chunk size for consistency, adjustable here if
// testing suggests a different size works better.
const CHUNK_SIZE_BYTES = 64 * 1024;

// How long to wait for the server to accept the WebSocket upgrade, and
// separately for it to close cleanly after RecordingClose, before giving
// up — the doc doesn't document either, these are conservative guesses.
// CLOSE_TIMEOUT_MS was raised from 30s after a live 10-second recording hit
// it live (2026-09-23) — the first submission to get all the way through
// RecordingOpen + all DataChunks cleanly, so this may just be one-off
// latency on the server's first real finalize for a new connection rather
// than a genuine hang; widened as a safety margin either way.
const OPEN_TIMEOUT_MS = 15000;
const CLOSE_TIMEOUT_MS = 60000;

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

// Declares the *actual* recorded format instead of only ever falling back
// to the generic/opaque byteStream. Checked live (2026-09-23): Expo's
// HIGH_QUALITY preset records genuine WebM/Opus on web (regardless of the
// "Recording.m4a" label the app shows), which is one of the doc's
// specifically-supported codecs — byteStream is documented as the opaque
// option for audio that doesn't fit pcm/opus/webmOpus, so a real webmOpus
// recording declared as byteStream may be handled by a more limited code
// path (accepted at the transport level but not fully processed), which
// would be consistent with every live test so far: fully accepted, then
// silence. sampleRateHz: 48000 is an educated default (the common browser
// microphone-capture default), not confirmed — Expo's web preset doesn't
// specify a sample rate itself, so this may need adjusting if still wrong.
// iOS/Android genuinely record AAC/m4a with this preset, which has no
// specific documented dataFormat option, so byteStream remains correct
// there.
function buildDataFormat(audioMimeType) {
  if (audioMimeType && audioMimeType.includes('webm')) {
    return { webmOpus: { sampleRateHz: 48000 } };
  }
  return { byteStream: {} };
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
  recordingLengthSeconds = 1,
  ehrInstanceId,
  externalUserId,
  outputFormIds,
  // The physician's own delegated Entra access token (forwarded from the
  // app's existing MsftAuth sign-in). Required — Dragon Copilot's support
  // team confirmed live (2026-09-23) that the AAS WebSocket endpoint needs
  // a real user token here, not the app-only one this used to mint via
  // getAasToken(); that mismatch is almost certainly why every earlier
  // live test hung with total silence after a fully protocol-correct
  // request (the connection/request looked fine to us, but Dragon
  // Copilot's own backend was silently never routing a response back for
  // an identity it couldn't reconcile).
  entraUserToken,
  // The recorded file's real MIME type (e.g. "audio/webm" on web,
  // "audio/m4a" on iOS/Android) — see buildDataFormat() for how this maps
  // to a specific, documented dataFormat instead of only ever falling back
  // to the generic/opaque byteStream.
  audioMimeType,
  // Azure Functions only reliably captures/correlates context.log with a
  // given invocation in the Log stream -- plain console.log turned out NOT
  // to be trustworthy here: a live test (2026-09-23) proved the WebSocket
  // open/RecordingOpen-sent/DataChunk-finished/RecordingClose-sent steps
  // all definitely happened (confirmed indirectly -- we got the 60s
  // close-wait timeout specifically, not the 15s open-wait one, which only
  // fires if 'open' never happened), yet none of those console.log lines
  // showed up in the Log stream. Defaults to console.log so tests/manual
  // calls don't need to pass one.
  log = console.log,
}) {
  if (!entraUserToken) {
    throw new Error('streamRecording requires entraUserToken (the AAS WebSocket rejects/ignores an app-only token).');
  }
  const token = entraUserToken;
  // TEMPORARY — logs this (now-switched-to-delegated) token's decoded
  // claims so a live test can confirm it actually carries "idtyp": "user"
  // and a "scp" claim (delegated), not "roles" (app-only) — the distinction
  // Dragon Copilot's support team flagged (2026-09-23) as the real cause of
  // the WebSocket hang. Only safe, non-secret identity claims are logged
  // via the existing describeTokenForAllowList helper — never the raw
  // signed token itself, which is a live credential. Safe to remove once
  // confirmed working end-to-end.
  log(`[audioStreamUpload] AAS token claims (should now be delegated/user, not app-only): ${describeTokenForAllowList(token)}`);
  const customerId = config.dragonEnvironmentId();
  // The WebSocket's own recordingId (RecordingOpen/RecordingClose) is a
  // separate value from the recordingId *parameter* above (which is just
  // this call's 1-based sequence number within the encounter, used for
  // logging/tracking). Confirmed live (2026-09-23): Dragon Copilot rejected
  // a non-GUID correlationId with "Failed to convert request to
  // RecordingOpenRequest" — after fixing correlationId to a real GUID, the
  // identical error persisted, pointing at this field, the only other
  // Microsoft-ID-shaped value still built as a hand-rolled, non-GUID string
  // (`${correlationId}-${recordingId}`). The doc's field table just says
  // "string" for this one (no explicit "(GUID)" note, unlike correlationId),
  // but the evidence says it's still Guid-typed server-side.
  const wsRecordingId = crypto.randomUUID();

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
      // Deliberately NOT calling ws.removeAllListeners() here — it used to,
      // but that strips the 'error' listener below too, and ws.terminate()
      // can itself emit 'error' asynchronously (e.g. "WebSocket was closed
      // before the connection was established") on a later tick, after this
      // function has already returned. With no listener left to catch it,
      // that crashed the whole Node worker process (confirmed live: Azure
      // Function App logs showed "Worker uncaught exception", killing every
      // in-flight request, not just this one). fail()/succeed() both no-op
      // via the settled check, so leftover listeners firing again is safe.
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
        // The 400 seen live so far has come back with an empty body, giving
        // no clue why. Response headers sometimes carry a gateway's own
        // error code/reason even when the body doesn't, so surface those
        // too rather than guessing further blind.
        const headerText = Object.entries(res.headers || {})
          .map(([key, value]) => `${key}: ${value}`)
          .join('; ');
        fail(
          new Error(
            `AAS WebSocket upgrade rejected (${res.statusCode}${res.statusMessage ? ' ' + res.statusMessage : ''}): ${body || '(empty body)'}${headerText ? ` [response headers: ${headerText}]` : ''}`
          )
        );
      });
    });

    ws.on('open', async () => {
      clearTimeout(openTimer);
      log(`[audioStreamUpload] WebSocket open (correlationId=${correlationId}, recordingId=${wsRecordingId})`);
      try {
        const dataFormat = buildDataFormat(audioMimeType);
        const recordingOpenBody = {
          recordingId: wsRecordingId,
          dataFormat,
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
        log(`[audioStreamUpload] Sent RecordingOpen (${audioBuffer.length} bytes to stream, audioMimeType=${audioMimeType}, dataFormat=${JSON.stringify(dataFormat)})`);

        let offset = 0;
        for (; offset < audioBuffer.length; offset += CHUNK_SIZE_BYTES) {
          if (settled) return;
          await waitForDrain(ws);
          const slice = audioBuffer.subarray(offset, Math.min(offset + CHUNK_SIZE_BYTES, audioBuffer.length));
          ws.send(buildDataChunkFrame(offset, slice), { binary: true });
        }
        log(`[audioStreamUpload] Finished sending all DataChunk frames (${audioBuffer.length} bytes total)`);

        ws.send(
          buildTextMessage('RecordingClose', {
            recordingId: wsRecordingId,
            recordingLengthSeconds,
            reason: 'ui',
          })
        );
        log(`[audioStreamUpload] Sent RecordingClose (recordingLengthSeconds=${recordingLengthSeconds}), waiting for RecordingCloseResponse...`);

        closeTimer = setTimeout(
          () => fail(new Error('Timed out waiting for RecordingCloseResponse from the AAS WebSocket.')),
          CLOSE_TIMEOUT_MS
        );
      } catch (err) {
        fail(err);
      }
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const raw = data.toString('utf8');
      // Logged unconditionally (even after settled) so a late-arriving
      // message that shows up just after our own timeout fires is still
      // visible in the Log stream — that would mean the server did
      // eventually respond, just slower than we waited.
      log(`[audioStreamUpload] Received text message: ${raw.slice(0, 500)}`);
      if (settled) return;
      const parsed = parseTextMessage(raw);
      if (parsed?.recordingCloses) {
        succeed({ dataStored: parsed.recordingCloses.dataStored });
        ws.close(1000);
      }
      // DataStorageResponse (parsed?.dataStored) is just a progress ack —
      // nothing to do with it here.
    });

    ws.on('close', (code, reasonBuf) => {
      log(`[audioStreamUpload] WebSocket close event: code=${code}, reason=${reasonBuf?.toString('utf8') || '(none)'}, alreadySettled=${settled}`);
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

module.exports = {
  streamRecording,
  buildTextMessage,
  parseTextMessage,
  buildDataChunkFrame,
  buildDataFormat,
  CHUNK_SIZE_BYTES,
};
