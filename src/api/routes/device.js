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
  const parts = [];
  if (
    err.message &&
    err.message !== "unknown" &&
    err.message !== "Unknown SOAP fault"
  ) {
    parts.push(err.message);
  }
  if (err.status) parts.push(`HTTP ${err.status}`);
  if (err.code && err.code !== err.message) parts.push(err.code);
  if (parts.length > 0) return parts.join(" — ");
  if (err.faultstring) return String(err.faultstring);
  if (typeof err === "string") return err;
  const str = String(err);
  if (str !== "[object Object]") return str;
  return JSON.stringify(err);
}

// Map a raw RISPort device item to our API response shape
function formatDevice(device) {
  const ip =
    device.IpAddress?.item?.IP ||
    device.IpAddress?.item?.[0]?.IP ||
    device.IpAddress ||
    null;
  const model = parseInt(device.Model, 10) || 0;
  const webCapable = WEB_CAPABLE_MODELS.has(model) || model > 600;
  return {
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
          Object.entries(PHONE_PAGES).map(([k]) => [
            k,
            `/api/v1/device/${device.Name}/web/${k}`,
          ]),
        )
      : null,
  };
}

// Extract all devices from RISPort nested response
function extractDevices(risResult) {
  const devices = [];
  for (const node of risResult.results || []) {
    const items = node?.CmDevices?.item;
    if (!items) continue;
    const list = Array.isArray(items) ? items : [items];
    devices.push(...list.filter((d) => d.Name));
  }
  return devices;
}

function createDeviceRouter() {
  const router = express.Router();

  // Batch lookup — single RISPort call for multiple devices
  router.post("/batch", async (req, res) => {
    const { devices: deviceNames, cluster: clusterId } = req.body || {};
    if (!Array.isArray(deviceNames) || deviceNames.length === 0) {
      return res.status(400).json({ error: "devices array required" });
    }

    // Check cache for all, collect uncached
    const results = {};
    const uncached = [];
    for (const name of deviceNames) {
      const cached = getCached(`${name}:${clusterId || ""}`);
      if (cached) {
        results[name] = cached;
      } else {
        uncached.push(name);
      }
    }

    // All cached — return immediately
    if (uncached.length === 0) {
      return res.json({ devices: results });
    }

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

      // Single RISPort call with array of device names
      const risResult = await service.selectCmDevice({
        action: "SelectCmDeviceExt",
        maxReturned: 100,
        deviceClass: "Any",
        selectBy: "Name",
        selectItems: uncached,
        status: "Any",
      });

      const found = extractDevices(risResult);

      for (const name of uncached) {
        const device = found.find(
          (d) => d.Name.toUpperCase() === name.toUpperCase(),
        );
        if (device) {
          const formatted = formatDevice(device);
          setCache(`${name}:${clusterId || ""}`, formatted);
          results[name] = formatted;
        } else {
          results[name] = { found: false, deviceName: name };
        }
      }

      res.json({ devices: results });
    } catch (err) {
      const msg = extractErrorMessage(err);
      console.error(`RISPort batch query failed:`, msg);
      res.status(502).json({ error: `RISPort query failed: ${msg}` });
    }
  });

  // Single device lookup
  router.get("/:deviceName", async (req, res) => {
    const { deviceName } = req.params;
    const clusterId = req.query.cluster || "";

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

      const risResult = await service.selectCmDevice({
        action: "SelectCmDeviceExt",
        maxReturned: 10,
        deviceClass: "Any",
        selectBy: "Name",
        selectItems: deviceName,
        status: "Any",
      });

      const found = extractDevices(risResult);
      const device = found.find(
        (d) => d.Name.toUpperCase() === deviceName.toUpperCase(),
      );

      if (!device) {
        return res.json({ found: false, deviceName });
      }

      const formatted = formatDevice(device);
      setCache(cacheKey, formatted);
      res.json(formatted);
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
