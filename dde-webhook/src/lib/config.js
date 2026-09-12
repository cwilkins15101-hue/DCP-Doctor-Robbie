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
  // retrieval data — confirmed from Microsoft's own sample code. Override
  // via app setting if your environment differs.
  dragonApiScope: () =>
    process.env.DRAGON_API_SCOPE || 'https://partnerapi-qa.ppe.copilot.dragon.com/.default',

  // Table Storage connection — reuses the storage account every Function
  // App already has (AzureWebJobsStorage) unless overridden.
  storageConnectionString: () =>
    process.env.DDE_STORAGE_CONNECTION_STRING || required('AzureWebJobsStorage'),
  resultsTableName: () => process.env.DDE_RESULTS_TABLE || 'ddeResults',

  // Only notifications with one of these types are processed; everything
  // else is acknowledged (200) but ignored. Adjust once you've confirmed
  // the exact event type(s) Doctor Robbie's product tier sends — this is
  // the one named in Microsoft's sample code.
  recognizedEventTypes: () =>
    (process.env.DDE_RECOGNIZED_EVENT_TYPES || 'encounter_data_ready_complete')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
};
