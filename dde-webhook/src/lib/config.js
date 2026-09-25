// Central place for all environment-driven configuration. Values come from
// Azure Function App Settings in production, or local.settings.json locally.

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required setting: ${name}`);
  }
  return value;
}

module.exports = {
  // Shared secret Dragon Copilot appends as ?access_token=... on every
  // webhook call. Set the same value when provisioning the subscription.
  webhookSharedSecret: () => required('WEBHOOK_SHARED_SECRET'),

  // Simple shared secret the Doctor Robbie app sends (as an x-app-secret
  // header) when polling for results. Separate from the webhook secret.
  appSharedSecret: () => required('APP_SHARED_SECRET'),

  // Entra app registration used to authenticate server-to-server calls to
  // the Dragon Copilot Partner API (retrieval service). This needs a
  // CLIENT SECRET (a "confidential client") — different from the public,
  // secret-less app used for interactive sign-in in the app itself. You
  // can add a client secret to the same DoctorRobbie app registration, or
  // create a separate one for this server.
  entra: () => ({
    tenantId: required('ENTRA_TENANT_ID'),
    clientId: required('ENTRA_CLIENT_ID'),
    clientSecret: required('ENTRA_CLIENT_SECRET'),
  }),

  // The audience/scope used both to provision the webhook and to fetch
  // retrieval data — this GUID App ID is explicitly documented as the
  // scope for both non-production and production (same value for both).
  // Override via app setting if that's ever confirmed to differ.
  dragonApiScope: () =>
    process.env.DRAGON_API_SCOPE || '105be974-d66d-43c9-b813-57a967bbfd21/.default',

  // Base URL for the Dragon Copilot Partner API (subscriptions,
  // ambient-sessions). Confirmed reachable; see dde-webhook/README.md.
  dragonApiBaseUrl: () =>
    process.env.DRAGON_API_BASE_URL || 'https://partnerapi.copilot.us.dragon.com',

  // A *separate* audience for the Ambient Audio Streaming (AAS) service —
  // confirmed from Microsoft's official AAS 2.0 reference docs (same value
  // for non-production and production). Different host, different token
  // than the Partner API above.
  aasScope: () =>
    process.env.AAS_SCOPE || '40d36082-d340-492f-a5af-e42ef68f4b2b/.default',
  aasBaseUrl: () =>
    process.env.AAS_BASE_URL || 'https://ambient-audio-service.copilot.us.dragon.com',

  // WebSocket variant of AAS (real-time streaming) — one documented
  // endpoint, GET /ws. Microsoft's WebSocket API reference shows two
  // different hostnames across its own examples: the plain aasBaseUrl
  // host (Authorization-header auth) vs. this "streaming." subdomain
  // (browser-oriented Sec-WebSocket-Protocol auth). Defaults to the
  // "streaming." host, confirmed live (2026-09-23): the plain host
  // rejected the WebSocket upgrade at Azure Front Door itself (its
  // response carried Front Door's own session-affinity cookies,
  // ASLBSA/ASLBSACORS, meaning the request never reached Dragon
  // Copilot's actual service) — the "streaming." host instead reached
  // the real backend (its 400 response carried a mise-correlation-id,
  // Microsoft's auth middleware, plus a helpful
  // api-supported-versions header). Override AAS_WS_URL if this ever
  // needs to change back.
  //
  // Includes ?api-version=... — omitting it gets a plain 400 Bad Request
  // at the handshake itself. Confirmed live (2026-09-23): that 400
  // response's own headers included `api-supported-versions: 1` —
  // ASP.NET-style versioning middleware telling us exactly what it
  // expects. The WebSocket endpoint uses a plain "1", NOT the
  // date-stamped "2025-07-15" the REST AAS endpoints use (a different
  // version scheme on the same family of APIs) — this is confirmed from
  // the server's own response, not guessed. Override AAS_API_VERSION if
  // this ever changes.
  aasApiVersion: () => process.env.AAS_API_VERSION || '1',
  aasWsUrl: () =>
    process.env.AAS_WS_URL ||
    `wss://streaming.${module.exports.aasBaseUrl().replace(/^https:\/\//, '').replace(/\/$/, '')}/ws?api-version=${module.exports.aasApiVersion()}`,

  // Partner/customer/product identifiers needed on every ambient-session
  // and audio-upload call.
  dragonPartnerGuid: () => required('DRAGON_PARTNER_GUID'),
  dragonEnvironmentId: () => required('DRAGON_ENVIRONMENT_ID'), // == "customerId" in Dragon's terms
  dragonProductId: () =>
    process.env.DRAGON_PRODUCT_ID || '4f939ade-287a-416d-8484-1e64013039dd',

  // Region base URL for Token Launch — "us" to match every other
  // confirmed-working endpoint for this account.
  dragonEhrBaseUrl: () =>
    process.env.DRAGON_EHR_BASE_URL || 'https://dragon-ehr.copilot.us.dragon.com',

  // The EHR system identifier Token Launch expects in its URL path
  // (/api/{ehr}/token-launch). Neither this account's Clinical app
  // connector name ("doctor-robbie") nor its "App ID" GUID work here —
  // both got a blanket 403, meaning Token Launch isn't actually
  // provisioned for the doctor-robbie connector yet on Microsoft's side.
  // "sectra" is confirmed working (a shared placeholder EHR identifier in
  // this sandbox, unrelated to Doctor Robbie specifically) — it's what's
  // used here for now so the feature keeps working end-to-end, but it
  // should be swapped for the real value once Microsoft provisions Token
  // Launch for doctor-robbie and tells us what to use instead.
  dragonEhrId: () => process.env.DRAGON_EHR_ID || 'sectra',

  // Purely descriptive — shown as "clientName" on each Token Launch call,
  // not a Microsoft-assigned identifier.
  dragonClientName: () => process.env.DRAGON_CLIENT_NAME || 'Doctor Robbie',

  // Table Storage connection — reuses the storage account every Function
  // App already has (AzureWebJobsStorage) unless overridden.
  storageConnectionString: () =>
    process.env.DDE_STORAGE_CONNECTION_STRING || required('AzureWebJobsStorage'),
  resultsTableName: () => process.env.DDE_RESULTS_TABLE || 'ddeResults',
  // Cross-device encounter index (2026-09-25, see storage.js) — separate
  // table from the results above, partitioned by physician instead.
  encountersTableName: () => process.env.DDE_ENCOUNTERS_TABLE || 'ddeEncounters',

  // Only notifications with one of these types are processed; everything
  // else is acknowledged (200) but ignored. Per Microsoft's "Notification
  // events" docs, the note and transcript arrive as separate event types
  // in the "dax" family — encounter_data_ready_complete for the note,
  // transcript_ready_complete for the transcript. encounter_data_updated
  // is included too since Doctor Robbie supports adding multiple
  // recordings to one encounter — it's unconfirmed whether a re-processed
  // note after an added recording arrives under this type or a repeat
  // encounter_data_ready_complete, so both are accepted.
  // supplemental_encounter_data_ready is Voice-to-Form's actual event type
  // for a requested custom form (e.g. a referral letter) -- confirmed live
  // 2026-09-24 from a real webhook delivery (the type wasn't documented
  // anywhere beforehand and was being silently dropped as unrecognized).
  // (Other dax event types exist too — failures, orders, audio — add them
  // here if this integration needs to react to those as well.)
  recognizedEventTypes: () =>
    (process.env.DDE_RECOGNIZED_EVENT_TYPES ||
      'encounter_data_ready_complete,transcript_ready_complete,encounter_data_updated,supplemental_encounter_data_ready')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
};
