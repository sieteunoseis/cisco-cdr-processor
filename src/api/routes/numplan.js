// src/api/routes/numplan.js
const express = require("express");
const axlService = require("cisco-axl");
const config = require("../../config");
const {
  resolvePatternRange,
  enumerateMatches,
} = require("../../lib/patternRange");

const PAGE_SIZE = 100;

function getDefaultCluster() {
  return config.axl.clusters[0] || null;
}

async function queryConfiguredNumbers(cluster, numbers) {
  if (numbers.length === 0) return new Map();
  const quoted = numbers.map((n) => `'${n}'`).join(",");
  const service = new axlService(
    cluster.host,
    cluster.username,
    cluster.password,
    cluster.version,
  );
  const sql = `SELECT dnorpattern, description FROM numplan WHERE dnorpattern IN (${quoted})`;
  const response = await service.executeSqlQuery(sql);
  const rows = Array.isArray(response) ? response : response?.row || [];
  const found = new Map();
  for (const row of rows) {
    found.set(row.dnorpattern, row.description || null);
  }
  return found;
}

function createNumplanRouter() {
  const router = express.Router();

  router.get("/seats", async (req, res) => {
    const { pattern, page } = req.query;
    if (typeof pattern !== "string" || !pattern) {
      return res.status(400).json({ error: "pattern is required" });
    }
    const pageNum = parseInt(page, 10);
    if (!Number.isInteger(pageNum) || pageNum < 1) {
      return res
        .status(400)
        .json({ error: "page must be a positive integer" });
    }

    const resolved = resolvePatternRange(pattern);
    if (!resolved) {
      return res.json({ eligible: false });
    }

    const allMatches = enumerateMatches(
      pattern,
      resolved.prefix,
      resolved.width,
    );
    const totalCount = allMatches.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
    const clampedPage = Math.min(Math.max(pageNum, 1), totalPages);
    const start = (clampedPage - 1) * PAGE_SIZE;
    const pageNumbers = allMatches.slice(start, start + PAGE_SIZE);

    const cluster = getDefaultCluster();
    if (!cluster) {
      return res.status(503).json({ error: "No AXL cluster configured" });
    }

    try {
      const configured = await queryConfiguredNumbers(cluster, pageNumbers);
      const seats = pageNumbers.map((number) => ({
        number,
        configured: configured.has(number),
        description: configured.get(number) || null,
      }));
      res.json({
        eligible: true,
        totalCount,
        totalPages,
        page: clampedPage,
        seats,
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createNumplanRouter };
