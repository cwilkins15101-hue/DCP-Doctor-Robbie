const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');

process.env.WEBHOOK_SHARED_SECRET = 'test-webhook-secret';
process.env.APP_SHARED_SECRET = 'test-app-secret';
process.env.ENTRA_TENANT_ID = 'tenant';
process.env.ENTRA_CLIENT_ID = 'client';
process.env.ENTRA_CLIENT_SECRET = 'secret';
process.env.AzureWebJobsStorage = 'UseDevelopmentStorage=true';
process.env.DRAGON_PARTNER_GUID = 'partner-guid';
process.env.DRAGON_ENVIRONMENT_ID = 'customer-guid';

const { parseTextMessage } = require('../src/lib/audioStreamUpload');
const { startSession, pushChunk, finishSession } = require('../src/lib/liveAasSession');

function startFakeAasServer() {
  const wss = new WebSocketServer({ port: 0 });
  const state = { connectionCount: 0, upgradeHeaders: null, recordingOpenBody: null, dataChunks: [], recordingCloseBody: null };

  wss.on('connection', (ws, req) => {
    state.connectionCount += 1;
    state.upgradeHeaders = req.headers;
    let bytesStored = 0;

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const chunk = JSON.parse(data.toString('utf8'));
        state.dataChunks.push(chunk);
        bytesStored += Buffer.from(chunk.Data, 'base64').length;
        ws.send(JSON.stringify({ dataStored: { dataStored: bytesStored } }));
        return;
      }
      const raw = data.toString('utf8');
      const parsed = parseTextMessage(raw);
      if (raw.startsWith('Path=RecordingOpen')) {
        state.recordingOpenBody = parsed;
      } else if (raw.startsWith('Path=RecordingClose')) {
        state.recordingCloseBody = parsed;
        ws.send(JSON.stringify({ recordingCloses: { dataStored: bytesStored } }));
        ws.close(1000);
      }
    });
  });

  return { wss, state, port: () => wss.address().port };
}

test('startSession + pushChunk + finishSession completes a full live session over several separate calls', async () => {
  const { wss, state, port } = startFakeAasServer();
  process.env.AAS_WS_URL = `ws://127.0.0.1:${port()}/ws`;

  const openParams = {
    correlationId: 'live-session-1',
    externalUserId: 'user-1',
    entraUserToken: 'fake-entra-user-token',
  };

  await startSession(openParams);

  // Each chunk arrives via its own, separate call -- simulating separate
  // HTTP requests, not one continuous stream.
  await pushChunk({ correlationId: 'live-session-1', buffer: Buffer.from([1, 2, 3]) });
  await pushChunk({ correlationId: 'live-session-1', buffer: Buffer.from([4, 5]) });

  // Asserted only after finishSession resolves, not right after each send --
  // ws.send() resolves once queued client-side, not once the server has
  // actually received/processed it, so checking server-observed state
  // immediately after would race. finishSession only resolves once the
  // server's own recordingCloses response arrives, which (since WebSocket
  // preserves message order on one connection) guarantees every earlier
  // message was already received and handled by then.
  const result = await finishSession({ correlationId: 'live-session-1', recordingLengthSeconds: 7 });
  assert.ok(result);

  assert.deepEqual(state.recordingOpenBody.dataFormat, { pcm: { sampleRateHz: 16000, bitcount: 16, channels: 1 } });
  assert.equal(state.upgradeHeaders.authorization, 'Bearer fake-entra-user-token');
  assert.equal(state.dataChunks.length, 2);
  assert.equal(state.dataChunks[0].DataStart, 0);
  assert.equal(state.dataChunks[1].DataStart, 3);
  assert.equal(state.recordingCloseBody.recordingLengthSeconds, 7);
  assert.equal(state.recordingCloseBody.recordingId, state.recordingOpenBody.recordingId);

  wss.close();
  delete process.env.AAS_WS_URL;
});

test('startSession called twice for the same correlationId reuses one connection, not two', async () => {
  const { wss, state, port } = startFakeAasServer();
  process.env.AAS_WS_URL = `ws://127.0.0.1:${port()}/ws`;

  const openParams = { correlationId: 'live-session-2', entraUserToken: 'fake-entra-user-token' };
  await Promise.all([startSession(openParams), startSession(openParams)]);

  assert.equal(state.connectionCount, 1);

  await finishSession({ correlationId: 'live-session-2', recordingLengthSeconds: 1 });
  wss.close();
  delete process.env.AAS_WS_URL;
});

test('pushChunk lazily starts a session if none exists yet (first chunk arriving before streamStart is observed)', async () => {
  const { wss, state, port } = startFakeAasServer();
  process.env.AAS_WS_URL = `ws://127.0.0.1:${port()}/ws`;

  await pushChunk({
    correlationId: 'live-session-3',
    buffer: Buffer.from([9, 9]),
    entraUserToken: 'fake-entra-user-token',
  });

  await finishSession({ correlationId: 'live-session-3', recordingLengthSeconds: 1 });

  assert.equal(state.dataChunks.length, 1);
  assert.ok(state.recordingOpenBody);
  wss.close();
  delete process.env.AAS_WS_URL;
});

test('finishSession rejects clearly for a correlationId with no active session', async () => {
  await assert.rejects(
    () => finishSession({ correlationId: 'never-started', recordingLengthSeconds: 1 }),
    /No active AAS session/
  );
});

test('startSession rejects immediately if entraUserToken is missing', async () => {
  await assert.rejects(
    () => startSession({ correlationId: 'live-session-4' }),
    /requires entraUserToken/
  );
});
