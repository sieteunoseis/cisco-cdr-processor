// src/api/routes/numplan.js
const express = require("express");
const config = require("../../config");
const {
  resolvePatternRange,
  enumerateMatches,
} = require("../../lib/patternRange");
const {
  queryConfiguredNumbers,
  queryDevicesForNumber,
} = require("../../lib/numplanAxl");

const PAGE_SIZE = 100;

function getDefaultCluster() {
  return config.axl.clusters[0] || null;
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

    let resolved;
    let allMatches;
    try {
      resolved = resolvePatternRange(pattern);
      if (!resolved) {
        return res.json({ eligible: false });
      }
      allMatches = enumerateMatches(pattern, resolved.prefix, resolved.width);
    } catch {
      // Pattern doesn't compile as a regex, or is too deeply nested for the
      // tokenizer's recursion — either way, it isn't a resolvable fixed-width
      // number range.
      return res.json({ eligible: false });
    }

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
        prefix: resolved.prefix,
        totalCount,
        totalPages,
        page: clampedPage,
        seats,
      });
    } catch (err) {
      console.error("AXL numplan query failed:", err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.get("/devices", async (req, res) => {
    const { number } = req.query;
    if (typeof number !== "string" || !/^[0-9]+$/.test(number)) {
      return res.status(400).json({ error: "number must be a digit string" });
    }

    const cluster = getDefaultCluster();
    if (!cluster) {
      return res.status(503).json({ error: "No AXL cluster configured" });
    }

    try {
      const devices = await queryDevicesForNumber(cluster, number);
      res.json({ devices });
    } catch (err) {
      console.error("AXL device lookup failed:", err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createNumplanRouter };
