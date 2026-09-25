const { TableClient } = require('@azure/data-tables');
const config = require('./config');

let tableClientPromise = null;

async function getTableClient() {
  if (!tableClientPromise) {
    tableClientPromise = (async () => {
      const client = TableClient.fromConnectionString(
        config.storageConnectionString(),
        config.resultsTableName(),
        { allowInsecureConnection: true } // needed for local Azurite emulator only
      );
      await client.createTable().catch((err) => {
        // 409 = table already exists, which is fine.
        if (err.statusCode !== 409) throw err;
      });
      return client;
    })();
  }
  return tableClientPromise;
}

// Table Storage needs a partitionKey + rowKey. A fixed partitionKey keeps
// this simple since Doctor Robbie's volume doesn't need partition-based
// scaling. Dragon Copilot delivers a recording's transcript and note as
// separate notifications, each with its own CloudEvent type (see
// Notification events docs — e.g. "encounter_data_ready_complete" vs
// "transcript_ready_complete"), so the rowKey includes that event type —
// a plain correlationId rowKey would let a later delivery silently
// overwrite an earlier one.
const PARTITION_KEY = 'session';

function rowKeyFor(correlationId, eventType) {
  return `${correlationId}::${eventType}`;
}

async function saveResult(correlationId, eventType, payload) {
  const client = await getTableClient();
  await client.upsertEntity(
    {
      partitionKey: PARTITION_KEY,
      rowKey: rowKeyFor(correlationId, eventType),
      correlationId,
      eventType,
      dataJson: JSON.stringify(payload),
      storedAt: new Date().toISOString(),
    },
    'Replace'
  );
}

// Returns a map of eventType -> { data, storedAt } for every result
// received so far for this correlationId, or null if none have arrived yet.
async function getResults(correlationId) {
  const client = await getTableClient();
  const entities = client.listEntities({
    queryOptions: { filter: `PartitionKey eq '${PARTITION_KEY}' and correlationId eq '${correlationId}'` },
  });
  const results = {};
  for await (const entity of entities) {
    results[entity.eventType] = { data: JSON.parse(entity.dataJson), storedAt: entity.storedAt };
  }
  return Object.keys(results).length > 0 ? results : null;
}

// ---------------------------------------------------------------------------
// Encounter index (2026-09-25) — lets a physician see an encounter they
// started on one device (e.g. the Android app) from another (e.g. a
// desktop browser), signed in as the same physician. A completely separate
// table from the results above: this only indexes "an encounter with this
// correlationId exists, started by this physician" -- the actual note/
// transcript/form output still lives in (and is fetched from) the results
// table via getResult, unchanged. partitionKey is externalUserId (not the
// fixed PARTITION_KEY above) specifically so "list this physician's
// encounters" is a single efficient partition-scoped query rather than a
// full table scan.
let encountersTableClientPromise = null;

async function getEncountersTableClient() {
  if (!encountersTableClientPromise) {
    encountersTableClientPromise = (async () => {
      const client = TableClient.fromConnectionString(
        config.storageConnectionString(),
        config.encountersTableName(),
        { allowInsecureConnection: true } // needed for local Azurite emulator only
      );
      await client.createTable().catch((err) => {
        if (err.statusCode !== 409) throw err;
      });
      return client;
    })();
  }
  return encountersTableClientPromise;
}

// Upserts so starting an additional recording on the same encounter
// (same correlationId) just refreshes startedAt/patient rather than
// creating a duplicate entry.
async function saveEncounter(externalUserId, correlationId, patient) {
  const client = await getEncountersTableClient();
  await client.upsertEntity(
    {
      partitionKey: externalUserId,
      rowKey: correlationId,
      correlationId,
      externalUserId,
      patientJson: patient !== undefined ? JSON.stringify(patient) : null,
      startedAt: new Date().toISOString(),
    },
    'Replace'
  );
}

// Most recent first, capped at 50 -- this is a quick-access list, not a
// full archive browser.
async function listEncounters(externalUserId) {
  const client = await getEncountersTableClient();
  const entities = client.listEntities({
    queryOptions: { filter: `PartitionKey eq '${externalUserId}'` },
  });
  const encounters = [];
  for await (const entity of entities) {
    encounters.push({
      correlationId: entity.correlationId,
      patient: entity.patientJson ? JSON.parse(entity.patientJson) : null,
      startedAt: entity.startedAt,
    });
  }
  encounters.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  return encounters.slice(0, 50);
}

module.exports = { saveResult, getResults, saveEncounter, listEncounters };
