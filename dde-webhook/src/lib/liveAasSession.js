// True live streaming via many small, ordinary HTTP requests instead of one
// continuous streaming request body (streamRecordingLive.js/_setup.js,
// removed 2026-09-24) -- a single long-lived streaming fetch() upload from
// the browser to Azure Functions proved unreliable across several live
// tests (an HTTP/2 requirement, then a CORS-labeled timeout, then a
// silent indefinite hang -- in every case the request never even reached
// the Function App). Ordinary POST requests are the same simple mechanism
// that's worked reliably all session for every other endpoint.
//
// The tradeoff: Dragon Copilot's AAS WebSocket connection now has to stay
// open ACROSS several separate HTTP invocations (streamStart, N x
// streamChunk, streamFinish) instead of living inside one. This module
// holds that connection in an in-memory Map, keyed by correlationId --
// fine for this prototype's single-tester setup, but Azure Functions gives
// no guarantee that the same warm instance handles every request for a
// given correlationId once there's real concurrent load across multiple
// instances. A production, multi-physician deployment would need shared
// external state (e.g. Redis) instead of a plain in-process Map.
const crypto = require('crypto');
const WebSocket = require('ws');
const config = require('./config');
const { buildTextMessage, parseTextMessage, buildDataChunkFrame, waitForDrain } = require('./audioStreamUpload');

const sessions = new Map();

const OPEN_TIMEOUT_MS = 15000;
const CLOSE_TIMEOUT_MS = 60000;
// Safety net only -- cleans up a session whose recording was abandoned
// (app crashed, physician navigated away) without ever calling
// finishSession, so the WebSocket connection doesn't leak forever.
const ABANDONED_SESSION_TIMEOUT_MS = 5 * 60 * 1000;

// Starts (or returns the existing) AAS WebSocket session for a
// correlationId. Resolves once RecordingOpen has been sent -- i.e. once
// it's actually safe to start sending DataChunk frames. Declared async so
// the missing-entraUserToken check below rejects the returned promise
// instead of throwing synchronously -- callers always treat this as a
// promise (including assert.rejects in tests), and a synchronous throw
// from a non-async function doesn't behave the same way.
async function startSession({
  correlationId,
  recordingId = 1,
  ehrInstanceId,
  externalUserId,
  outputFormIds,
  entraUserToken,
  log = console.log,
}) {
  const existing = sessions.get(correlationId);
  if (existing) return existing.openPromise;

  if (!entraUserToken) {
    throw new Error('startSession requires entraUserToken (the AAS WebSocket rejects/ignores an app-only token).');
  }

  const customerId = config.dragonEnvironmentId();
  const wsRecordingId = crypto.randomUUID();
  const headers = {
    Authorization: `Bearer ${entraUserToken}`,
    'customer-id': customerId,
  };
  if (externalUserId) headers['external-user-id'] = externalUserId;
  headers['product-id'] = config.dragonProductId();

  const ws = new WebSocket(config.aasWsUrl(), { headers });
  const session = { ws, wsRecordingId, offset: 0, settled: false, closeDeferred: null, log };
  sessions.set(correlationId, session);

  function cleanup() {
    if (session.abandonedTimer) clearTimeout(session.abandonedTimer);
    if (session.closeTimer) clearTimeout(session.closeTimer);
    sessions.delete(correlationId);
  }

  session.openPromise = new Promise((resolve, reject) => {
    const openTimer = setTimeout(() => {
      failOpen(new Error('Timed out waiting for the AAS WebSocket to open.'));
    }, OPEN_TIMEOUT_MS);

    function failOpen(err) {
      if (session.settled) return;
      session.settled = true;
      clearTimeout(openTimer);
      cleanup();
      try {
        ws.terminate();
      } catch {
        // already closed
      }
      reject(err);
    }

    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        const headerText = Object.entries(res.headers || {})
          .map(([key, value]) => `${key}: ${value}`)
          .join('; ');
        failOpen(
          new Error(
            `AAS WebSocket upgrade rejected (${res.statusCode}${res.statusMessage ? ' ' + res.statusMessage : ''}): ${body || '(empty body)'}${headerText ? ` [response headers: ${headerText}]` : ''}`
          )
        );
      });
    });

    ws.on('open', () => {
      clearTimeout(openTimer);
      log(`[liveAasSession] WebSocket open (correlationId=${correlationId}, recordingId=${wsRecordingId})`);
      try {
        const recordingOpenBody = {
          recordingId: wsRecordingId,
          dataFormat: { pcm: { sampleRateHz: 16000, bitcount: 16, channels: 1 } },
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
        log('[liveAasSession] Sent RecordingOpen (dataFormat=pcm 16-bit/16kHz/mono)');
        resolve(session);
      } catch (err) {
        failOpen(err);
      }
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const raw = data.toString('utf8');
      log(`[liveAasSession] Received text message: ${raw.slice(0, 500)}`);
      const parsed = parseTextMessage(raw);
      if (parsed?.recordingCloses && session.closeDeferred) {
        session.settled = true;
        cleanup();
        session.closeDeferred.resolve({ dataStored: parsed.recordingCloses.dataStored });
        ws.close(1000);
      }
    });

    ws.on('close', (code, reasonBuf) => {
      log(
        `[liveAasSession] WebSocket close event: code=${code}, reason=${reasonBuf?.toString('utf8') || '(none)'}, settled=${session.settled}`
      );
      if (session.settled) return;
      session.settled = true;
      cleanup();
      const reason = reasonBuf?.toString('utf8') || 'no reason given';
      if (code === 1000) {
        if (session.closeDeferred) session.closeDeferred.resolve({ dataStored: null });
        else resolve(session); // shouldn't normally happen before any close was requested
      } else {
        const err = new Error(`AAS WebSocket closed unexpectedly (code ${code}): ${reason}`);
        if (session.closeDeferred) session.closeDeferred.reject(err);
        else reject(err);
      }
    });

    ws.on('error', (err) => failOpen(err));
  });

  session.abandonedTimer = setTimeout(() => {
    if (session.settled) return;
    session.settled = true;
    cleanup();
    try {
      ws.terminate();
    } catch {
      // already closed
    }
  }, ABANDONED_SESSION_TIMEOUT_MS);

  return session.openPromise;
}

// Forwards one chunk of raw PCM audio to an already-started session.
async function pushChunk({ correlationId, buffer, log = console.log, ...openParams }) {
  let session = sessions.get(correlationId);
  if (!session) {
    // First chunk can race ahead of streamStart's response reaching the
    // client in rare cases -- start the session lazily rather than fail.
    await startSession({ correlationId, log, ...openParams });
    session = sessions.get(correlationId);
  } else {
    await session.openPromise;
  }
  if (session.settled) {
    throw new Error(`AAS session for ${correlationId} already closed/failed; cannot send more audio.`);
  }
  await waitForDrain(session.ws);
  session.ws.send(buildDataChunkFrame(session.offset, buffer), { binary: true });
  session.offset += buffer.length;
}

// Ends an already-started session: sends RecordingClose and waits for
// RecordingCloseResponse (or a timeout/failure).
function finishSession({ correlationId, recordingLengthSeconds }) {
  const session = sessions.get(correlationId);
  if (!session) {
    return Promise.reject(
      new Error(`No active AAS session for correlationId ${correlationId} (already finished, or no audio was ever sent).`)
    );
  }

  return session.openPromise.then(
    () =>
      new Promise((resolve, reject) => {
        if (session.settled) {
          reject(new Error('AAS session already closed/failed before RecordingClose could be sent.'));
          return;
        }
        session.closeDeferred = { resolve, reject };
        session.closeTimer = setTimeout(() => {
          if (session.settled) return;
          session.settled = true;
          sessions.delete(correlationId);
          try {
            session.ws.terminate();
          } catch {
            // already closed
          }
          reject(new Error('Timed out waiting for RecordingCloseResponse from the AAS WebSocket.'));
        }, CLOSE_TIMEOUT_MS);

        session.ws.send(
          buildTextMessage('RecordingClose', {
            recordingId: session.wsRecordingId,
            recordingLengthSeconds: Math.max(1, recordingLengthSeconds || 1),
            reason: 'ui',
          })
        );
        session.log(
          `[liveAasSession] Sent RecordingClose (recordingLengthSeconds=${recordingLengthSeconds}), waiting for RecordingCloseResponse...`
        );
      })
  );
}

module.exports = { startSession, pushChunk, finishSession };
