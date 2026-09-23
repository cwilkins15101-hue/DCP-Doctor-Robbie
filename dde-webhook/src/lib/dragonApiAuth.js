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
    // Delegated (user) tokens carry idtyp:"user" + a scp claim; app-only
    // (client-credentials) tokens carry a roles claim instead and no scp —
    // this is the exact distinction Dragon Copilot's support team flagged
    // (2026-09-23) as the reason the AAS WebSocket call needs a delegated
    // token specifically. Included so a live test's Log stream output
    // confirms which kind of token actually went out.
    idtyp: claims.idtyp,
    scp: claims.scp,
    roles: claims.roles,
  });
}

// Gets a bearer token for calling Dragon Copilot's Partner API (DDE
// subscriptions/retrieval, ambient-sessions).
async function getDragonApiToken() {
  const token = await getCredential().getToken(config.dragonApiScope());
  return token.token;
}

// No app-only token getter for the AAS WebSocket (used to be getAasToken(),
// removed) or for Token Launch here — both confirmed live to reject/ignore
// an app-only client-credentials token (Token Launch: a flat 401; AAS
// WebSocket: silent, indefinite non-response — see audioStreamUpload.js).
// Both need a delegated token for an actual signed-in physician, which only
// the app itself can obtain (see msftAuth.js) and forwards through its own
// request — this server never holds a physician's credentials itself.

module.exports = { getDragonApiToken, describeTokenForAllowList };
