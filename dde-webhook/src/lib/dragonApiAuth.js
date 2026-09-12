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

// Gets a bearer token for calling Dragon Copilot's Partner API (used for
// both provisioning and retrieval calls, per Microsoft's sample code).
async function getDragonApiToken() {
  const token = await getCredential().getToken(config.dragonApiScope());
  return token.token;
}

module.exports = { getDragonApiToken };
