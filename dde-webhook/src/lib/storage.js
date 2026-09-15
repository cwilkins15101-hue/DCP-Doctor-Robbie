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
// separate artifacts (see Dragon Copilot APIs for partners docs), so the
// rowKey includes the artifact type — a plain correlationId rowKey would
// let a later delivery silently overwrite an earlier one.
const PARTITION_KEY = 'session';

function rowKeyFor(correlationId, artifactType) {
  return `${correlationId}::${artifactType}`;
}

async function saveResult(correlationId, artifactType, payload) {
  const client = await getTableClient();
  await client.upsertEntity(
    {
      partitionKey: PARTITION_KEY,
      rowKey: rowKeyFor(correlationId, artifactType),
      correlationId,
      artifactType,
      dataJson: JSON.stringify(payload),
      storedAt: new Date().toISOString(),
    },
    'Replace'
  );
}

// Returns a map of artifactType -> { data, storedAt } for every artifact
// received so far for this correlationId, or null if none have arrived yet.
async function getResults(correlationId) {
  const client = await getTableClient();
  const entities = client.listEntities({
    queryOptions: { filter: `PartitionKey eq '${PARTITION_KEY}' and correlationId eq '${correlationId}'` },
  });
  const results = {};
  for await (const entity of entities) {
    results[entity.artifactType] = { data: JSON.parse(entity.dataJson), storedAt: entity.storedAt };
  }
  return Object.keys(results).length > 0 ? results : null;
}

module.exports = { saveResult, getResults };
