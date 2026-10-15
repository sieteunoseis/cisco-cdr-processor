const config = require("../config");
const { insertCdrRecords } = require("./cdr-writer");
const { insertCmrRecords } = require("./cmr-writer");
const { enrichCdrRecords } = require("../enrichment/enricher");
const { enrichCarrier } = require("../enrichment/carrier");

// Shared by the file watcher and manual import so both paths enrich and
// insert records identically.
async function cdrWriter(pool, records) {
  const enriched = await enrichCdrRecords(pool, records, config.axl);
  const withCarrier = await enrichCarrier(pool, enriched);
  return insertCdrRecords(pool, withCarrier);
}

const writers = { cdrWriter, cmrWriter: insertCmrRecords };

module.exports = { writers };
