const { ClientSecretCredential } = require('@azure/identity');
const config = require('./config');

let credential = null;
function getCredential() {
  if (!credential) {
    const { tenantId, clientId, clientSecret } = config.entra();
    credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
  }
  return credential;
}

// Gets a bearer token for calling Dragon Copilot's Partner API (DDE
// subscriptions/retrieval, ambient-sessions).
async function getDragonApiToken() {
  const token = await getCredential().getToken(config.dragonApiScope());
  return token.token;
}

// Gets a bearer token for the Ambient Audio Streaming (AAS) service —
// a different audience/resource than the Partner API above, confirmed
// from Microsoft's AAS 2.0 reference docs.
async function getAasToken() {
  const token = await getCredential().getToken(config.aasScope());
  return token.token;
}

module.exports = { getDragonApiToken, getAasToken };
