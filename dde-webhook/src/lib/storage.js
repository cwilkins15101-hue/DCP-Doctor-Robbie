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

// Table Storage needs a partitionKey + rowKey. correlationId is unique
// enough to be the rowKey; a fixed partitionKey keeps this simple since
// Doctor Robbie's volume doesn't need partition-based scaling.
const PARTITION_KEY = 'session';

async function saveResult(correlationId, payload) {
  const client = await getTableClient();
  await client.upsertEntity(
    {
      partitionKey: PARTITION_KEY,
      rowKey: correlationId,
      dataJson: JSON.stringify(payload),
      storedAt: new Date().toISOString(),
    },
    'Replace'
  );
}

async function getResult(correlationId) {
  const client = await getTableClient();
  try {
    const entity = await client.getEntity(PARTITION_KEY, correlationId);
    return { data: JSON.parse(entity.dataJson), storedAt: entity.storedAt };
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

module.exports = { saveResult, getResult };
