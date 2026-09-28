// Fills the FQHC Sliding Fee Scale template with a completed FQHC Intake
// form's values and returns the resulting .xlsx as a download -- POST
// /api/exportFqhcForm, called from the Form Output tab's "Export" button
// (App.js, web only). See fqhcExport.js for the actual cell mapping.
const { app } = require('@azure/functions');
const config = require('../lib/config');
const { buildFqhcExport } = require('../lib/fqhcExport');
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

  let body;
  try {
    body = await request.json();
  } catch {
    return withCors({ status: 400, body: 'Expected a JSON body.' });
  }

  const fields = body?.fields;
  if (!fields || typeof fields !== 'object') {
    return withCors({ status: 400, body: '"fields" object is required.' });
  }

  let buffer;
  try {
    buffer = await buildFqhcExport(fields);
  } catch (err) {
    context.error('exportFqhcForm failed:', err);
    return withCors({ status: 502, jsonBody: { error: String(err?.message ?? err) } });
  }

  return withCors({
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="fqhc-sliding-fee-scale.xlsx"',
    },
    body: buffer,
  });
}

app.http('exportFqhcForm', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'exportFqhcForm',
  handler,
});

module.exports = { handler };
