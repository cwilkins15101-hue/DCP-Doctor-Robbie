const { app } = require('@azure/functions');
const config = require('../lib/config');
const { getDragonApiToken } = require('../lib/dragonApiAuth');
const { saveResult } = require('../lib/storage');

// Handles the Azure Event Grid / Dragon Data Exchange validation handshake.
// Required exactly as documented: echo WebHook-Request-Origin back as
// WebHook-Allowed-Origin, and declare an allowed delivery rate.
function handleOptionsValidation(request) {
  const origin = request.headers.get('webhook-request-origin');
  if (!origin) {
    return {
      status: 400,
      body: 'Webhook validation failed: missing WebHook-Request-Origin header.',
    };
  }
  return {
    status: 200,
    headers: {
      'WebHook-Allowed-Origin': origin,
      'WebHook-Allowed-Rate': '*',
    },
  };
}

async function fetchRetrievalData(retrievalUrl) {
  const token = await getDragonApiToken();
  const response = await fetch(retrievalUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Retrieval service returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

// DAX Core sometimes sends TWO supplemental_encounter_data_ready
// notifications for the same recording -- the real Voice-to-Form output,
// and a second, blank stub (an empty "resources" array, generic
// "Outpatient Note" title, no document.type) that silently overwrites the
// real one if saved unconditionally (confirmed with Microsoft, 2026-09-29
// -- believed to be a DAX Core issue, similar to the earlier WebSocket/
// DAXCore finding). Returns the parsed resources array, or null if it
// can't be determined (malformed data, or a shape this doesn't recognize)
// -- callers should fail OPEN on null rather than block a save they can't
// actually evaluate.
function parseSupplementalResources(data) {
  try {
    const inner = JSON.parse(data?.data);
    return Array.isArray(inner.resources) ? inner.resources : null;
  } catch {
    return null;
  }
}

async function handleNotification(request, context) {
  // Simplest of the three documented security options: a shared secret
  // passed as ?access_token=... when the subscription was provisioned.
  const providedSecret = request.query.get('access_token');
  if (providedSecret !== config.webhookSharedSecret()) {
    context.warn('Webhook call rejected: access_token missing or incorrect.');
    return { status: 401, body: 'Unauthorized' };
  }

  const rawBody = await request.text();
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: 'Invalid JSON body.' };
  }

  if (!event.specversion) {
    return { status: 400, body: 'Body does not conform to the CloudEvents schema.' };
  }

  const eventType = event.type;
  if (!config.recognizedEventTypes().includes(eventType)) {
    context.log(`Ignoring notification of type "${eventType}" — not in the recognized list.`);
    return { status: 200 };
  }

  const { retrievalUrl, correlationId } = event.data ?? {};
  if (!retrievalUrl || !correlationId) {
    context.warn('Notification had no retrievalUrl/correlationId — nothing to fetch.');
    return { status: 200 };
  }

  try {
    const data = await fetchRetrievalData(retrievalUrl);

    // Skip storing a blank duplicate delivery rather than let it overwrite
    // real Voice-to-Form data already saved for this correlationId (see
    // parseSupplementalResources above). Checking "resources is non-empty"
    // rather than matching a specific form's title/type protects every
    // Voice-to-Form output, not just FQHC Intake -- a real, populated form
    // response always has one resource entry per field, even when most of
    // the values inside are blank (confirmed live 2026-09-28); an empty
    // resources array is never a valid result worth keeping.
    if (eventType === 'supplemental_encounter_data_ready') {
      const resources = parseSupplementalResources(data);
      if (resources !== null && resources.length === 0) {
        context.log(
          `Ignoring a blank supplemental_encounter_data_ready payload (0 resources) for correlationId ${correlationId} -- likely a duplicate DAX Core delivery; keeping whatever was already stored.`
        );
        return { status: 200 };
      }
    }

    // Keyed by the CloudEvent's own type (e.g. "encounter_data_ready_complete"
    // vs "transcript_ready_complete") rather than a field parsed out of the
    // retrieval payload — the confirmed transcript schema doesn't carry an
    // artifact_type field at all, so that wouldn't reliably tell them apart.
    await saveResult(correlationId, eventType, {
      eventType,
      customerId: event.data.customerId,
      userId: event.data.userId,
      receivedAt: new Date().toISOString(),
      data,
    });
    context.log(`Stored "${eventType}" result for correlationId ${correlationId}.`);
  } catch (err) {
    // Log and still return 200 — Event Grid will retry deliveries on
    // failure responses, which isn't what we want for an error on our
    // side fetching data (that needs its own retry/alerting, not a
    // redelivered webhook). Adjust this if you want Event Grid's retry
    // behavior instead.
    context.error(`Failed to process notification for ${correlationId}:`, err);
  }

  return { status: 200 };
}

async function handler(request, context) {
  if (request.method === 'OPTIONS') {
    return handleOptionsValidation(request);
  }
  return handleNotification(request, context);
}

app.http('dde-webhook', {
  methods: ['OPTIONS', 'POST'],
  authLevel: 'anonymous',
  route: 'dde-webhook',
  handler,
});

module.exports = { handler, handleOptionsValidation, handleNotification };
