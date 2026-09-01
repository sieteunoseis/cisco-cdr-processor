function parseAxlClusters() {
  const clusters = [];
  for (let i = 1; i <= 5; i++) {
    const host = process.env[`AXL_HOST_${i}`];
    if (!host) continue;
    const username = process.env[`AXL_USERNAME_${i}`] || "";
    const password = process.env[`AXL_PASSWORD_${i}`] || "";
    if (!username || !password) {
      console.warn(
        `AXL cluster ${i}: host set but missing username or password, skipping`,
      );
      continue;
    }
    clusters.push({
      host,
      username,
      password,
      version: process.env[`AXL_VERSION_${i}`] || "15.0",
      clusterId: process.env[`AXL_CLUSTER_ID_${i}`] || "",
    });
  }
  return clusters;
}

const config = {
  database: {
    url:
      process.env.DATABASE_URL ||
      "postgresql://cdr:cdr_password@localhost:5432/callmanager",
  },
  axl: {
    clusters: parseAxlClusters(),
    cacheTtl: parseInt(process.env.AXL_CACHE_TTL || "86400", 10) || 86400,
  },
  cdr: {
    incomingDir: process.env.CDR_INCOMING_DIR || "/data/incoming",
    retentionDays: parseInt(process.env.CDR_RETENTION_DAYS || "90", 10),
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    apiKeySid: process.env.TWILIO_API_KEY_SID || "",
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET || "",
    // Comma-separated list of Twilio Lookup v1 add-ons to query per spam
    // check, e.g. "icehook_scout,nomorobo". Short aliases are resolved to
    // their actual add-on unique_name in spam.js.
    spamProviders: (process.env.TWILIO_SPAM_PROVIDER || "nomorobo_spamscore")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  },
  server: {
    port: parseInt(process.env.MCP_PORT || "3000", 10),
  },
  logLevel: process.env.LOG_LEVEL || "info",
};

module.exports = config;
