const express = require("express");
const RisPortService = require("cisco-risport");
const config = require("../../config");

// Phone web server pages for newer models (78xx, 88xx, etc.)
const PHONE_PAGES = {
  network: "/CGI/Java/Serviceability?adapter=device.statistics.port.network",
  config: "/CGI/Java/Serviceability?adapter=device.statistics.configuration",
  console: "/CGI/Java/Serviceability?adapter=device.statistics.consolelog",
  status: "/CGI/Java/Serviceability?adapter=device.statistics.statusmessages",
};

// Models that support the web UI (78xx, 88xx, and newer)
const WEB_CAPABLE_MODELS = new Set([
  // 78xx
  621, 622, 623, 688, 689, 690,
  // 88xx
  683, 684, 685, 686, 687,
  // 99xx
  537, 538,
  // Webex Desk / Room
  // Add more as needed
]);

function getClusterForDevice(clusterId) {
  if (!clusterId) return config.axl.clusters[0];
  return (
    config.axl.clusters.find((c) => c.clusterId === clusterId) ||
    config.axl.clusters[0]
  );
}

// Cache RISPort results for 2 minutes to avoid rate limits (15 req/min)
const risCache = new Map();
const RIS_CACHE_TTL = 120000;

function getCached(key) {
  const entry = risCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > RIS_CACHE_TTL) {
    risCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  risCache.set(key, { data, ts: Date.now() });
}

function extractErrorMessage(err) {
  if (err.message && err.message !== "unknown") return err.message;
  if (err.faultstring) return err.faultstring;
  if (typeof err === "string") return err;
  const str = String(err);
  if (str !== "[object Object]") return str;
  return JSON.stringify(err);
}

function createDeviceRouter() {
  const router = express.Router();

  // Get device registration info from RISPort
  router.get("/:deviceName", async (req, res) => {
    const { deviceName } = req.params;
    const clusterId = req.query.cluster || "";

    // Check cache first
    const cacheKey = `${deviceName}:${clusterId}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const cluster = getClusterForDevice(clusterId);
    if (!cluster) {
      return res.status(400).json({ error: "No AXL cluster configured" });
    }

    try {
      const service = new RisPortService(
        cluster.host,
        cluster.username,
        cluster.password,
      );

      const result = await service.selectCmDevice({
        action: "SelectCmDeviceExt",
        maxReturned: 10,
        deviceClass: "Any",
        selectBy: "Name",
        selectItems: deviceName,
        status: "Any",
      });

      // Extract device from nested response
      let device = null;
      for (const node of result.results || []) {
        const items = node?.CmDevices?.item;
        if (!items) continue;
        const list = Array.isArray(items) ? items : [items];
        for (const item of list) {
          if (
            item.Name &&
            item.Name.toUpperCase() === deviceName.toUpperCase()
          ) {
            device = item;
            break;
          }
        }
        if (device) break;
      }

      if (!device) {
        return res.json({
          found: false,
          deviceName,
          message: "Device not found in RISPort",
        });
      }

      // Normalize IP
      const ip =
        device.IpAddress?.item?.IP ||
        device.IpAddress?.item?.[0]?.IP ||
        device.IpAddress ||
        null;

      const model = parseInt(device.Model, 10) || 0;
      const webCapable = WEB_CAPABLE_MODELS.has(model) || model > 600;

      const result = {
        found: true,
        deviceName: device.Name,
        ip,
        status: device.Status,
        statusReason: device.StatusReason,
        statusReasonText: device.StatusReasonText,
        model: device.Model,
        protocol: device.Protocol,
        activeLoadId: device.ActiveLoadID,
        dirNumber: device.DirNumber,
        description: device.Description,
        webCapable,
        webPages: webCapable
          ? Object.fromEntries(
              Object.entries(PHONE_PAGES).map(([k, v]) => [
                k,
                `/api/v1/device/${deviceName}/web/${k}`,
              ]),
            )
          : null,
      };
      setCache(cacheKey, result);
      res.json(result);
    } catch (err) {
      const msg = extractErrorMessage(err);
      console.error(`RISPort query failed for ${deviceName}:`, msg);
      res.status(502).json({ error: `RISPort query failed: ${msg}` });
    }
  });

  // Proxy phone web page
  router.get("/:deviceName/web/:page", async (req, res) => {
    const { deviceName, page } = req.params;
    const pagePath = PHONE_PAGES[page];
    if (!pagePath) {
      return res.status(400).json({ error: `Unknown page: ${page}` });
    }

    // First resolve IP via RISPort
    const clusterId = req.query.cluster || "";
    const cluster = getClusterForDevice(clusterId);
    if (!cluster) {
      return res.status(400).json({ error: "No AXL cluster configured" });
    }

    try {
      const service = new RisPortService(
        cluster.host,
        cluster.username,
        cluster.password,
      );

      const result = await service.selectCmDevice({
        action: "SelectCmDeviceExt",
        maxReturned: 10,
        deviceClass: "Any",
        selectBy: "Name",
        selectItems: deviceName,
      });

      let ip = null;
      for (const node of result.results || []) {
        const items = node?.CmDevices?.item;
        if (!items) continue;
        const list = Array.isArray(items) ? items : [items];
        for (const item of list) {
          if (
            item.Name &&
            item.Name.toUpperCase() === deviceName.toUpperCase()
          ) {
            ip =
              item.IpAddress?.item?.IP ||
              item.IpAddress?.item?.[0]?.IP ||
              item.IpAddress ||
              null;
            break;
          }
        }
        if (ip) break;
      }

      if (!ip) {
        return res
          .status(404)
          .json({ error: "Device not registered or IP not found" });
      }

      // Fetch from phone web server (no auth needed)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`http://${ip}${pagePath}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return res
          .status(response.status)
          .json({ error: `Phone returned ${response.status}` });
      }

      const html = await response.text();
      res.json({ deviceName, ip, page, html });
    } catch (err) {
      if (err.name === "AbortError") {
        return res
          .status(504)
          .json({ error: "Phone web server timed out (10s)" });
      }
      console.error(`Phone web fetch failed for ${deviceName}:`, err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createDeviceRouter };
