# Doctor Robbie DDE webhook server

Receives Dragon Data Exchange (DDE) notifications from Dragon Copilot,
fetches the associated data, and stores it so the Doctor Robbie app can
poll for it. Built as an Azure Function (Node.js, v4 programming model).

Two endpoints, once deployed:

- `POST /api/dde-webhook` — Dragon Copilot delivers notifications here.
  Also responds to `OPTIONS` for the required validation handshake.
- `GET /api/getResult?correlationId=...` — the app polls this to check
  whether a result has arrived yet.

## Status

The webhook/notification/provisioning logic is built and tested against
Microsoft's documented contract (see `test/`). **Not yet verified against
a real Dragon Copilot sandbox** — that requires deploying this and
provisioning it for real, which needs your Azure account.

One open item: the exact shape of the data returned by the retrieval
service ("Dragon standard payload") hasn't been confirmed yet, so
`getResult`'s response is stored and returned as-is (whatever JSON Dragon
Copilot's retrieval service sends back). The app's note-display screen
tries a few common field names and falls back to showing the raw JSON.

## Audio upload: WebSocket, not REST

`submitRecording` streams the finished audio file to Dragon Copilot over
the **Ambient Audio Streaming WebSocket API** (`src/lib/audioStreamUpload.js`)
rather than the older REST chunked-upload flow (`audioUpload.js`, removed) —
switched for faster downstream processing and because Voice-to-Form's
`outputFormIds` field only exists on the WebSocket API. No new required
Azure App Settings for this — it reuses the same `AAS_SCOPE`/token
acquisition as before, and the WebSocket URL defaults sensibly (derived
from `AAS_BASE_URL`). If connections fail outright, Microsoft's own doc
shows two different hostnames across its own examples; try overriding
`AAS_WS_URL` to `wss://streaming.ambient-audio-service.copilot.us.dragon.com/ws`
(note the `streaming.` subdomain) as the other candidate.

**Voice-to-Form**: `submitRecording` accepts an optional `outputFormIds`
form field (comma-separated) and passes it straight through to the
WebSocket's `RecordingOpen.outputFormIds`. The app currently offers a
handful of Microsoft-provided test IDs (`encounter_note_pi_mdm`,
`letter_to_patient`, `letter_to_pcp_gp`, `referral_letter_to_clinician`) —
the real custom form isn't provisioned yet. Not yet handled: the response
payload shape for a custom-form result isn't documented, so
`parseDragonNote` (in the app) only knows how to render the standard
clinical-note shape — a form result falls back to raw JSON until that's
confirmed and a dedicated parser is written.

## One-time setup in Azure

1. **Create a Storage Account** (any name, Standard/LRS is fine) — this is
   where the received results get stored (a small "Table Storage" table).
2. **Create a Function App**:
   - Runtime stack: Node.js (20 LTS or newer)
   - Plan: Consumption (cheapest — pay only when it runs)
   - Link it to the Storage Account from step 1
3. **Add a client secret** to the DoctorRobbie Entra app registration (or
   create a separate app registration for this server) — Azure Portal →
   Microsoft Entra ID → App registrations → DoctorRobbie → Certificates &
   secrets → New client secret. This is needed because a server calling
   an API on its own behalf needs a secret; the app's interactive sign-in
   doesn't use one.
4. In the Function App's **Configuration → Application settings**, add:
   | Name | Value |
   |---|---|
   | `WEBHOOK_SHARED_SECRET` | any long random string you generate |
   | `APP_SHARED_SECRET` | any long random string you generate (different from above) |
   | `ENTRA_TENANT_ID` | `50b0f407-cfdb-4951-8ec8-ab8f9d4217ea` |
   | `ENTRA_CLIENT_ID` | your Entra app's Client ID |
   | `ENTRA_CLIENT_SECRET` | the secret value from step 3 |
   | `DRAGON_API_SCOPE` | `105be974-d66d-43c9-b813-57a967bbfd21/.default` (same value for non-production and production, per Microsoft's docs) |

   For the "Launch Dragon Copilot" button (Token Launch API — opens Dragon
   Copilot's own web UI in a new tab, seeded with patient/encounter
   context), also add:

   | Name | Value |
   |---|---|
   | `DRAGON_PARTNER_GUID` | your Dragon Copilot partner GUID |
   | `DRAGON_ENVIRONMENT_ID` | your Dragon Copilot customer/org GUID |
   | `DRAGON_PRODUCT_ID` | your Dragon Copilot product GUID |
   | `DRAGON_EHR_ID` | defaults to `sectra` — a placeholder EHR identifier confirmed working in this sandbox. Neither this account's Clinical app connector name (`doctor-robbie`) nor its "App ID" GUID work (both got a blanket 403): Token Launch isn't provisioned for the doctor-robbie connector yet on Microsoft's side. Swap this once Microsoft provisions it and gives you the real value |

   `DRAGON_EHR_BASE_URL` and `DRAGON_CLIENT_NAME` both have working
   defaults and only need overriding if Microsoft tells you otherwise.

   This server does **not** hold the access token Token Launch actually
   needs — Dragon Copilot rejects an app-only, server-minted token for
   that call (confirmed live: 401 Unauthorized). Token Launch requires a
   delegated token for an actual signed-in physician, which the Doctor
   Robbie app gets directly via its own Microsoft sign-in (`msftAuth.js`,
   `EXPO_PUBLIC_MSFT_*` in the app's own `.env.example`) — this server only
   ever hands back the plain partner/org/product/EHR identifiers above.

## Deploying the code

From this folder:
```
npm install
```
Then deploy using whichever method you're comfortable with — the Azure
Functions Core Tools CLI (`func azure functionapp publish <your-app-name>`)
or directly from VS Code's Azure Functions extension, which is often the
easier path if this is your first deployment. Either needs the
[Azure Functions Core Tools](https://learn.microsoft.com/en-us/azure/azure-functions/functions-run-local)
installed locally (`npm install -g azure-functions-core-tools@4` — this
works from your own machine; it couldn't be installed in the sandbox this
was built in due to network restrictions there).

## Registering the webhook

Once deployed, get your Function App's **real** URL from the Azure Portal
Overview page's **"Default domain"** field — Flex Consumption apps get a
randomized hostname suffix, so it's *not* simply
`<the-name-you-typed>.azurewebsites.net`. It'll look like
`https://dr-robbie-gwctbmh0cwc2bzbz.westus3-01.azurewebsites.net`. Then:

```
cp .env.example .env
# fill in .env — WEBHOOK_URL is <your Function App's real URL>/api/dde-webhook,
# and WEBHOOK_SHARED_SECRET must match the app setting from step 4 above
npm run provision-webhook
```

This registers the webhook with Dragon Data Exchange. Re-run it any time
you change the webhook URL or want to rotate the shared secret.

Confirmed working (as of this account's setup): `DRAGON_API_BASE_URL` is
`https://partnerapi.copilot.us.dragon.com` — the "non-production" URL
originally given in the partner portal
(`partnerapi-qa.ppe.copilot.dragon.com`) does not actually resolve.

## Wiring up the app

In Doctor Robbie's own `.env`, set:
```
EXPO_PUBLIC_DDE_SERVER_URL=<your Function App's real URL, e.g. https://dr-robbie-gwctbmh0cwc2bzbz.westus3-01.azurewebsites.net>
EXPO_PUBLIC_DDE_APP_SECRET=<the APP_SHARED_SECRET value from step 4>
```

## Local testing

```
npm install
npm test
```
Runs the handler logic against mocked network calls — confirms the
webhook validation handshake, secret checks, and retrieve-and-store flow
all behave correctly, without needing real Azure resources.
`test/audioStreamUpload.test.js` goes a step further for the WebSocket
upload: it spins up a real local `ws` server implementing the documented
AAS WebSocket protocol and drives `streamRecording` against it, confirming
auth headers, the `RecordingOpen`/`DataChunk`/`RecordingClose` message
sequence, and byte-for-byte audio delivery — though it can only verify
we're speaking the protocol as documented, not that Dragon Copilot's real
server agrees with that documentation.

To run the actual Function locally (talking to a local storage emulator
instead of real Azure Table Storage), install
[Azurite](https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azurite)
and the Azure Functions Core Tools, then `npm start`.
