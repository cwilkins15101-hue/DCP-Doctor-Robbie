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

// TEMPORARY — logs the claims Dragon Copilot's partner relations team needs
// to add this token issuer to the Dragon Copilot allow list (see "Allow
// list" in the Dragon Copilot APIs for partners docs): the `iss` value, and
// the claim (name + value) that identifies this app. Logs once per claim
// set per cold start, via console.log so it shows up in the Function's
// invocation logs. Safe to remove once you're on the allow list.
const loggedTokenLabels = new Set();
function decodeJwtClaims(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
function logTokenClaimsForAllowList(label, token) {
  if (loggedTokenLabels.has(label)) return;
  loggedTokenLabels.add(label);
  const claims = decodeJwtClaims(token);
  if (!claims) return;
  console.log(`DRAGON ALLOW-LIST INFO (${label}):`, JSON.stringify({
    iss: claims.iss,
    aud: claims.aud,
    appid: claims.appid,
    azp: claims.azp,
    tid: claims.tid,
  }));
}

// Gets a bearer token for calling Dragon Copilot's Partner API (DDE
// subscriptions/retrieval, ambient-sessions).
async function getDragonApiToken() {
  const token = await getCredential().getToken(config.dragonApiScope());
  logTokenClaimsForAllowList('Partner API', token.token);
  return token.token;
}

// Gets a bearer token for the Ambient Audio Streaming (AAS) service —
// a different audience/resource than the Partner API above, confirmed
// from Microsoft's AAS 2.0 reference docs.
async function getAasToken() {
  const token = await getCredential().getToken(config.aasScope());
  logTokenClaimsForAllowList('AAS', token.token);
  return token.token;
}

module.exports = { getDragonApiToken, getAasToken };
