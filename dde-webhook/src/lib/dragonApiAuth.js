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

// TEMPORARY — decodes the claims Dragon Copilot's partner relations team
// needs to add this token issuer to the Dragon Copilot allow list (see
// "Allow list" in the Dragon Copilot APIs for partners docs): the `iss`
// value, and the claim (name + value) that identifies this app. Callers
// fold this into an error message that's already logged via context.error,
// since plain console.log output isn't reliably showing up in this Function
// App's logs. Safe to remove once you're on the allow list.
function decodeJwtClaims(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function describeTokenForAllowList(token) {
  const claims = decodeJwtClaims(token);
  if (!claims) return 'could not decode token claims';
  return JSON.stringify({
    iss: claims.iss,
    aud: claims.aud,
    appid: claims.appid,
    azp: claims.azp,
    tid: claims.tid,
  });
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

// Deliberately no app-only token getter for Token Launch (Connector.Access)
// here — confirmed via a live 401 that Dragon Copilot's Token Launch API
// rejects an app-only client-credentials token outright. It requires a
// delegated token for an actual signed-in physician, which only the app
// itself can obtain (see msftAuth.js) — this server never holds a
// physician's credentials.

module.exports = { getDragonApiToken, getAasToken, describeTokenForAllowList };
