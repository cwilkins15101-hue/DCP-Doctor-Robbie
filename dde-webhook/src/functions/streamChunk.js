// Called repeatedly during a live-streaming recording (web only,
// 2026-09-24), once per chunk of raw PCM audio as it's captured — an
// ordinary small POST, not part of one continuous upload. See
// liveAasSession.js for why. The whole request body is audio bytes; no
// other fields belong here.
const { app } = require('@azure/functions');
const config = require('../lib/config');
const liveAasSession = require('../lib/liveAasSession');
const { handleCorsPreflight, withCors } = require('../lib/cors');

async function handler(request, context) {
  const preflight = handleCorsPreflight(request);
  if (preflight) {
    return preflight;
  }

  const providedSecret = request.headers.get('x-app-secret');
  if (providedSecret !== config.appSharedSecret()) {
    return withCors({ status: 401, body: 'Unauthorized' });
  }

  const authHeader = request.headers.get('authorization') || '';
  const entraUserToken = authHeader.replace(/^Bearer\s+/i, '') || undefined;
  if (!entraUserToken) {
    return withCors({
      status: 401,
      body: 'Missing Authorization header (expected the physician\'s Entra sign-in token).',
    });
  }

  const correlationId = request.query.get('correlationId');
  if (!correlationId) {
    return withCors({ status: 400, body: 'Missing correlationId query param.' });
  }

  const buffer = Buffer.from(await request.arrayBuffer());
  if (buffer.length === 0) {
    return withCors({ status: 400, body: 'Empty chunk body.' });
  }

  // Only used if this chunk is (unexpectedly) the one that ends up starting
  // the session — see liveAasSession.pushChunk's lazy-start fallback.
  const recordingId = parseInt(request.query.get('recordingId'), 10) || 1;
  const externalUserId = request.query.get('externalUserId') || undefined;
  const ehrInstanceId = request.query.get('ehrInstanceId') || undefined;
  const outputFormIdsRaw = request.query.get('outputFormIds');
  const outputFormIds = outputFormIdsRaw
    ? outputFormIdsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  try {
    await liveAasSession.pushChunk({
      correlationId,
      buffer,
      recordingId,
      externalUserId,
      ehrInstanceId,
      outputFormIds,
      entraUserToken,
      log: context.log.bind(context),
    });
  } catch (err) {
    context.error(`streamChunk failed for correlationId ${correlationId}:`, err);
    return withCors({ status: 502, jsonBody: { error: String(err?.message ?? err) } });
  }

  return withCors({ status: 200, jsonBody: { received: buffer.length } });
}

app.http('streamChunk', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'streamChunk',
  handler,
});

module.exports = { handler };
