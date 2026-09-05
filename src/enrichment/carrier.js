// Stamps <field>_carrier onto CDR records by looking up the calling/called
// number's NPA-NXX in the locally-imported npanxx table (see
// npanxx-importer.js). Reflects the carrier a block was assigned to, not
// live LNP porting of an individual number.

const CARRIER_FIELDS = [
  "callingpartynumber",
  "originalcalledpartynumber",
  "finalcalledpartynumber",
  "lastredirectdn",
];

function extractNpaNxx(number) {
  if (!number) return null;
  const digits = String(number).replace(/\D/g, "");
  let tenDigit = null;
  if (digits.length === 10) tenDigit = digits;
  else if (digits.length === 11 && digits[0] === "1") tenDigit = digits.slice(1);
  if (!tenDigit) return null;
  return tenDigit.slice(0, 6);
}

function collectNumberPrefixes(records, fields = CARRIER_FIELDS) {
  const prefixes = new Set();
  for (const record of records) {
    for (const field of fields) {
      const prefix = extractNpaNxx(record[field]);
      if (prefix) prefixes.add(prefix);
    }
  }
  return prefixes;
}

function mapCarrierToRecords(records, carrierMap, fields = CARRIER_FIELDS) {
  return records.map((record) => {
    const enriched = { ...record };
    for (const field of fields) {
      const prefix = extractNpaNxx(record[field]);
      const company = prefix ? carrierMap.get(prefix) : undefined;
      if (company) enriched[`${field}_carrier`] = company;
    }
    return enriched;
  });
}

async function enrichCarrier(pool, records) {
  if (!records || records.length === 0) return records;

  const prefixes = [...collectNumberPrefixes(records)];
  if (prefixes.length === 0) return records;

  try {
    const result = await pool.query(
      "SELECT prefix, company FROM npanxx WHERE prefix = ANY($1)",
      [prefixes],
    );
    const carrierMap = new Map(result.rows.map((r) => [r.prefix, r.company]));
    return mapCarrierToRecords(records, carrierMap);
  } catch (err) {
    console.warn(`Carrier enrichment failed: ${err.message}`);
    return records;
  }
}

module.exports = {
  CARRIER_FIELDS,
  extractNpaNxx,
  collectNumberPrefixes,
  mapCarrierToRecords,
  enrichCarrier,
};
