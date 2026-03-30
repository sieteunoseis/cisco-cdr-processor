const fs = require("fs");
const path = require("path");

const SQL_DIR = path.join(__dirname, "../../sql");

async function tableExists(pool, tableName) {
  const result = await pool.query(
    "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)",
    [tableName],
  );
  return result.rows[0].exists;
}

async function initSchema(pool) {
  const cdrExists = await tableExists(pool, "cdr");

  if (!cdrExists) {
    console.log("Fresh install — creating schema...");
    const createSql = fs.readFileSync(
      path.join(SQL_DIR, "CreateSchema.sql"),
      "utf8",
    );
    await pool.query(createSql);
    console.log("Schema created.");

    const populateSql = fs.readFileSync(
      path.join(SQL_DIR, "PopulateSchema.sql"),
      "utf8",
    );
    await pool.query(populateSql);
    console.log("Lookup tables populated.");
  } else {
    console.log("Existing database detected.");
  }

  const migrationSql = fs.readFileSync(
    path.join(SQL_DIR, "Migration001_enrichment.sql"),
    "utf8",
  );
  await pool.query(migrationSql);

  const viewsSql = fs.readFileSync(
    path.join(SQL_DIR, "Migration002_views.sql"),
    "utf8",
  );
  await pool.query(viewsSql);

  const starredSql = fs.readFileSync(
    path.join(SQL_DIR, "Migration003_starred_calls.sql"),
    "utf8",
  );
  await pool.query(starredSql);

  const snapshotsSql = fs.readFileSync(
    path.join(SQL_DIR, "Migration004_snapshots.sql"),
    "utf8",
  );
  await pool.query(snapshotsSql);
  console.log("Migrations applied.");
}

module.exports = { initSchema, tableExists };
