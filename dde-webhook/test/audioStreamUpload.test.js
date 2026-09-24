const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocketServer } = require('ws');

process.env.WEBHOOK_SHARED_SECRET = 'test-webhook-secret';
process.env.APP_SHARED_SECRET = 'test-app-secret';
process.env.ENTRA_TENANT_ID = 'tenant';
process.env.ENTRA_CLIENT_ID = 'client';
process.env.ENTRA_CLIENT_SECRET = 'secret';
process.env.AzureWebJobsStorage = 'UseDevelopmentStorage=true';
process.env.DRAGON_PARTNER_GUID = 'partner-guid';
process.env.DRAGON_ENVIRONMENT_ID = 'customer-guid';

const {
  streamRecording,
  buildTextMessage,
  parseTextMessage,
  buildDataChunkFrame,
  buildDataFormat,
  CHUNK_SIZE_BYTES,
} = require('../src/lib/audioStreamUpload');
const config = require('../src/lib/config');

test('aasWsUrl defaults to the streaming host/path with the confirmed api-version', () => {
  assert.equal(
    config.aasWsUrl(),
    'wss://streaming.ambient-audio-service.copilot.us.dragon.com/ws?api-version=1'
  );
});

// ---- Pure message-format helpers ----

test('buildTextMessage produces the documented header block above the JSON body', () => {
  const msg = buildTextMessage('RecordingOpen', { recordingId: 'r1' });
  const [headerBlock, jsonPart] = msg.split('\r\n\r\n');
  assert.match(headerBlock, /^Path=RecordingOpen\r\nX-MS-Request-Id=[0-9a-f-]{36}\r\nX-Timestamp=\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(JSON.parse(jsonPart), { recordingId: 'r1' });
});

test('parseTextMessage strips a header block when present', () => {
  const msg = buildTextMessage('RecordingClose', { recordingId: 'r1', recordingLengthSeconds: 5 });
  assert.deepEqual(parseTextMessage(msg), { recordingId: 'r1', recordingLengthSeconds: 5 });
});

test('parseTextMessage handles plain JSON with no header block (server responses)', () => {
  assert.deepEqual(parseTextMessage('{"dataStored":{"dataStored":32768}}'), {
    dataStored: { dataStored: 32768 },
  });
});

test('buildDataChunkFrame base64-encodes the audio bytes inside a JSON payload', () => {
  const buf = Buffer.from([1, 2, 3, 4]);
  const frame = buildDataChunkFrame(128, buf);
  const parsed = JSON.parse(frame.toString('utf8'));
  assert.equal(parsed.DataStart, 128);
  assert.equal(Buffer.from(parsed.Data, 'base64').compare(buf), 0);
});

test('buildDataFormat declares webmOpus for a real WebM recording (Expo web preset)', () => {
  assert.deepEqual(buildDataFormat('audio/webm'), { webmOpus: { sampleRateHz: 48000 } });
});

test('buildDataFormat falls back to byteStream for AAC/m4a (iOS/Android) or unknown types', () => {
  assert.deepEqual(buildDataFormat('audio/m4a'), { byteStream: {} });
  assert.deepEqual(buildDataFormat(undefined), { byteStream: {} });
});

// ---- Full protocol, against a real local WebSocket server ----

function startFakeAasServer() {
  const wss = new WebSocketServer({ port: 0 });
  const state = { upgradeHeaders: null, recordingOpenBody: null, dataChunks: [], recordingCloseBody: null };

  wss.on('connection', (ws, req) => {
    state.upgradeHeaders = req.headers;
    let bytesStored = 0;

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const chunk = JSON.parse(data.toString('utf8'));
        state.dataChunks.push(chunk);
        bytesStored += Buffer.from(chunk.Data, 'base64').length;
        if (state.dataChunks.length % 1 === 0) {
          ws.send(JSON.stringify({ dataStored: { dataStored: bytesStored } }));
        }
        return;
      }
      const parsed = parseTextMessage(data.toString('utf8'));
      if (data.toString('utf8').startsWith('Path=RecordingOpen')) {
        state.recordingOpenBody = parsed;
      } else if (data.toString('utf8').startsWith('Path=RecordingClose')) {
        state.recordingCloseBody = parsed;
        ws.send(JSON.stringify({ recordingCloses: { dataStored: bytesStored } }));
        ws.close(1000);
      }
    });
  });

  return { wss, state, port: () => wss.address().port };
}

test('streamRecording sends the right auth headers, RecordingOpen body, and full audio, then resolves', async () => {
  const { wss, state, port } = startFakeAasServer();
  process.env.AAS_WS_URL = `ws://127.0.0.1:${port()}/ws`;

  const audioBuffer = Buffer.alloc(CHUNK_SIZE_BYTES + 100, 7); // spans two chunks

  const result = await streamRecording({
    correlationId: 'corr-1',
    audioBuffer,
    recordingId: 1,
    externalUserId: 'user-1',
    outputFormIds: ['encounter_note_pi_mdm'],
    entraUserToken: 'fake-entra-user-token',
  });

  assert.ok(result);

  // Auth headers on the upgrade request
  assert.equal(state.upgradeHeaders.authorization, 'Bearer fake-entra-user-token');
  assert.equal(state.upgradeHeaders['customer-id'], 'customer-guid');
  assert.equal(state.upgradeHeaders['external-user-id'], 'user-1');
  assert.equal(state.upgradeHeaders['product-id'], '4f939ade-287a-416d-8484-1e64013039dd');

  // RecordingOpen body
  assert.equal(state.recordingOpenBody.ambientSessionData.correlationId, 'corr-1');
  assert.equal(state.recordingOpenBody.ambientSessionData.partnerId, 'partner-guid');
  assert.equal(state.recordingOpenBody.ambientSessionData.customerId, 'customer-guid');
  assert.deepEqual(state.recordingOpenBody.actions, ['generate-draft']);
  assert.deepEqual(state.recordingOpenBody.outputFormIds, ['encounter_note_pi_mdm']);

  // Every byte of the recording arrived, in order, with correct offsets
  const totalBytes = state.dataChunks.reduce((sum, c) => sum + Buffer.from(c.Data, 'base64').length, 0);
  assert.equal(totalBytes, audioBuffer.length);
  assert.equal(state.dataChunks[0].DataStart, 0);
  assert.equal(state.dataChunks[1].DataStart, CHUNK_SIZE_BYTES);

  // RecordingClose body
  assert.equal(state.recordingCloseBody.recordingId, state.recordingOpenBody.recordingId);

  wss.close();
  delete process.env.AAS_WS_URL;
});

test('streamRecording rejects if the server closes with a non-1000 code (RecordingOpen validation failure)', async () => {
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    // Per the docs: an invalid RecordingOpen gets no message at all, just
    // a close — simulate that here.
    ws.close(1007, 'invalid payload');
  });
  process.env.AAS_WS_URL = `ws://127.0.0.1:${wss.address().port}/ws`;

  await assert.rejects(
    () =>
      streamRecording({
        correlationId: 'corr-2',
        audioBuffer: Buffer.from([1, 2, 3]),
        entraUserToken: 'fake-entra-user-token',
      }),
    /closed unexpectedly \(code 1007\)/
  );

  wss.close();
  delete process.env.AAS_WS_URL;
});

// Regression test for a real crash seen live: the server rejecting the
// WebSocket upgrade outright (plain HTTP response, never reaching 101
// Switching Protocols) used to crash the whole Node worker process —
// ws.terminate() inside fail() emitted an 'error' event asynchronously,
// after fail() had already stripped all listeners (including the 'error'
// one) via ws.removeAllListeners(). Confirms streamRecording now rejects
// cleanly instead of taking down the process.
test('streamRecording rejects (without crashing) when the server refuses the WebSocket upgrade over plain HTTP', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
  });
  await new Promise((resolve) => server.listen(0, resolve));
  process.env.AAS_WS_URL = `ws://127.0.0.1:${server.address().port}/ws`;

  await assert.rejects(
    () =>
      streamRecording({
        correlationId: 'corr-3',
        audioBuffer: Buffer.from([1, 2, 3]),
        entraUserToken: 'fake-entra-user-token',
      }),
    /AAS WebSocket upgrade rejected \(401[^)]*\): Unauthorized/
  );

  server.close();
  delete process.env.AAS_WS_URL;
});

// Regression test for a live failure with an EMPTY response body (a plain
// 400 at the handshake, no explanation) — the error message needs to fall
// back to something other than a blank string, and surface any response
// headers the server did send, since those are the only other place a
// gateway might explain itself.
test('streamRecording surfaces response headers when the upgrade is rejected with an empty body', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'text/plain', 'x-ms-error-code': 'BadRequest' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  process.env.AAS_WS_URL = `ws://127.0.0.1:${server.address().port}/ws`;

  await assert.rejects(
    () =>
      streamRecording({
        correlationId: 'corr-4',
        audioBuffer: Buffer.from([1, 2, 3]),
        entraUserToken: 'fake-entra-user-token',
      }),
    /AAS WebSocket upgrade rejected \(400[^)]*\): \(empty body\) \[response headers:.*x-ms-error-code: BadRequest/
  );

  server.close();
  delete process.env.AAS_WS_URL;
});

// Regression test for the fix that switched this from an app-only token
// (getAasToken(), removed) to the physician's own delegated Entra token,
// forwarded from the app -- confirmed needed live (2026-09-23) by Dragon
// Copilot's own support team after every earlier attempt hung with total
// silence despite a fully protocol-correct request. Rejecting immediately
// (rather than attempting a doomed connection) turns a 60-second silent
// hang into an instant, actionable error if this is ever accidentally
// omitted again.
test('streamRecording rejects immediately if entraUserToken is missing', async () => {
  await assert.rejects(
    () => streamRecording({ correlationId: 'corr-5', audioBuffer: Buffer.from([1, 2, 3]) }),
    /requires entraUserToken/
  );
});
