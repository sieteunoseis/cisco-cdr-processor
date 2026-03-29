const express = require("express");
const { parseString, processors } = require("xml2js");
const config = require("../../config");

const PHONE_PAGES = {
  network: "/CGI/Java/Serviceability?adapter=device.statistics.port.network",
  config: "/CGI/Java/Serviceability?adapter=device.statistics.configuration",
  console: "/CGI/Java/Serviceability?adapter=device.statistics.consolelog",
  status: "/CGI/Java/Serviceability?adapter=device.settings.status.messages",
};

const WEB_CAPABLE_MODELS = new Set([
  621, 622, 623, 688, 689, 690, 683, 684, 685, 686, 687, 537, 538,
]);

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

function getClusterForDevice(clusterId) {
  if (!clusterId) return config.axl.clusters[0];
  return (
    config.axl.clusters.find((c) => c.clusterId === clusterId) ||
    config.axl.clusters[0]
  );
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseXml(xml) {
  return new Promise((resolve, reject) => {
    parseString(
      xml,
      {
        explicitArray: false,
        explicitRoot: false,
        tagNameProcessors: [processors.stripPrefix],
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
  });
}

// Direct RISPort SOAP call — bypasses cisco-risport library
async function queryRisPort(cluster, deviceNames) {
  const items = (Array.isArray(deviceNames) ? deviceNames : [deviceNames])
    .map((n) => `<soap:item><soap:Item>${escapeXml(n)}</soap:Item></soap:item>`)
    .join("");

  const xml = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soap="http://schemas.cisco.com/ast/soap">
<soapenv:Header/>
<soapenv:Body>
<soap:selectCmDeviceExt>
<soap:StateInfo></soap:StateInfo>
<soap:CmSelectionCriteria>
<soap:MaxReturnedDevices>100</soap:MaxReturnedDevices>
<soap:DeviceClass>Any</soap:DeviceClass>
<soap:Model>255</soap:Model>
<soap:Status>Any</soap:Status>
<soap:NodeName></soap:NodeName>
<soap:SelectBy>Name</soap:SelectBy>
<soap:SelectItems>${items}</soap:SelectItems>
<soap:Protocol>Any</soap:Protocol>
<soap:DownloadStatus>Any</soap:DownloadStatus>
</soap:CmSelectionCriteria>
</soap:selectCmDeviceExt>
</soapenv:Body>
</soapenv:Envelope>`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  const response = await fetch(
    `https://${cluster.host}:8443/realtimeservice2/services/RISService70`,
    {
      method: "POST",
      headers: {
        "Content-Type": "text/xml;charset=UTF-8",
        Authorization:
          "Basic " +
          Buffer.from(cluster.username + ":" + cluster.password).toString(
            "base64",
          ),
        SOAPAction:
          "http://schemas.cisco.com/ast/soap/action/#RisPort#SelectCmDeviceExt",
      },
      body: xml,
      signal: controller.signal,
    },
  );
  clearTimeout(timeout);

  if (!response.ok) {
    throw new Error(`RISPort HTTP ${response.status}`);
  }

  const text = await response.text();
  const output = await parseXml(text);

  // Check for SOAP fault
  if (output?.Body?.Fault) {
    const faultStr =
      typeof output.Body.Fault.faultstring === "string"
        ? output.Body.Fault.faultstring
        : JSON.stringify(output.Body.Fault.faultstring);
    throw new Error(faultStr);
  }

  // Extract devices from response
  const devices = [];
  const nodes =
    output?.Body?.selectCmDeviceResponse?.selectCmDeviceReturn
      ?.SelectCmDeviceResult?.CmNodes?.item;
  if (!nodes) return devices;

  const nodeList = Array.isArray(nodes) ? nodes : [nodes];
  for (const node of nodeList) {
    const items = node?.CmDevices?.item;
    if (!items) continue;
    const list = Array.isArray(items) ? items : [items];
    devices.push(...list.filter((d) => d.Name));
  }
  return devices;
}

function formatDevice(device) {
  const ip =
    device.IPAddress?.item?.IP ||
    device.IPAddress?.item?.[0]?.IP ||
    device.IpAddress?.item?.IP ||
    device.IPAddress ||
    null;
  const model = parseInt(device.Model, 10) || 0;
  const webCapable = WEB_CAPABLE_MODELS.has(model) || model > 600;
  return {
    found: true,
    deviceName: device.Name,
    ip,
    status: device.Status,
    statusReason: device.StatusReason,
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

// Extract key-value pairs from Cisco phone HTML pages
// Phones use: <TD><B>Label</B></TD><td width=20></TD><TD><B>Value</B></TD>
// Or: <TD>Label</TD><TD>Value</TD>
function parsePhonePage(page, html) {
  const pairs = [];
  // Match 3-cell rows: <TD>key</TD><td spacer></td><TD>value</TD>
  const threeCell =
    /<td[^>]*>\s*<b>\s*(.*?)\s*<\/b>\s*<\/td>\s*<td[^>]*>\s*<\/td>\s*<td[^>]*>\s*<b>\s*(.*?)\s*<\/b>\s*<\/td>/gi;
  let match;
  while ((match = threeCell.exec(html)) !== null) {
    const key = match[1].replace(/<[^>]+>/g, "").trim();
    const val = match[2].replace(/<[^>]+>/g, "").trim();
    if (key && val) {
      pairs.push({ key, val });
    }
  }

  // Also try 2-cell rows: <TD>key</TD><TD>value</TD>
  if (pairs.length === 0) {
    const twoCell = /<td[^>]*>\s*(.*?)\s*<\/td>\s*<td[^>]*>\s*(.*?)\s*<\/td>/gi;
    while ((match = twoCell.exec(html)) !== null) {
      const key = match[1].replace(/<[^>]+>/g, "").trim();
      const val = match[2].replace(/<[^>]+>/g, "").trim();
      if (key && val && key !== val && !key.startsWith("http")) {
        pairs.push({ key, val });
      }
    }
  }

  return { data: pairs };
}

function createDeviceRouter() {
  const router = express.Router();

  // Batch lookup
  router.post("/batch", async (req, res) => {
    const { devices: deviceNames, cluster: clusterId } = req.body || {};
    if (!Array.isArray(deviceNames) || deviceNames.length === 0) {
      return res.status(400).json({ error: "devices array required" });
    }

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

    if (uncached.length === 0) {
      return res.json({ devices: results });
    }

    const cluster = getClusterForDevice(clusterId);
    if (!cluster) {
      return res.status(400).json({ error: "No AXL cluster configured" });
    }

    try {
      const found = await queryRisPort(cluster, uncached);

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
      console.error("RISPort batch query failed:", err.message);
      res.status(502).json({ error: `RISPort query failed: ${err.message}` });
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
      const found = await queryRisPort(cluster, deviceName);
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
      console.error(`RISPort query failed for ${deviceName}:`, err.message);
      res.status(502).json({ error: `RISPort query failed: ${err.message}` });
    }
  });

  // Fetch phone logs or web page content via IP
  // Supports: /FS/messages, /FS/messages.0, and PHONE_PAGES keys
  router.get("/:deviceName/web/:page", async (req, res) => {
    const { deviceName, page } = req.params;
    const clusterId = req.query.cluster || "";

    // Resolve IP from cache or RISPort
    const cacheKey = `${deviceName}:${clusterId}`;
    let ip = getCached(cacheKey)?.ip;

    if (!ip) {
      const cluster = getClusterForDevice(clusterId);
      if (!cluster) {
        return res.status(400).json({ error: "No AXL cluster configured" });
      }
      try {
        const found = await queryRisPort(cluster, deviceName);
        const device = found.find(
          (d) => d.Name.toUpperCase() === deviceName.toUpperCase(),
        );
        ip =
          device?.IPAddress?.item?.IP ||
          device?.IPAddress?.item?.[0]?.IP ||
          null;
      } catch (err) {
        return res
          .status(502)
          .json({ error: `RISPort failed: ${err.message}` });
      }
    }

    if (!ip) {
      return res
        .status(404)
        .json({ error: "Device not registered or IP not found" });
    }

    // Determine URL path
    let urlPath;
    if (PHONE_PAGES[page]) {
      urlPath = PHONE_PAGES[page];
    } else if (page === "messages") {
      urlPath = "/FS/messages";
    } else if (/^messages\.\d+$/.test(page)) {
      urlPath = `/FS/${page}`;
    } else {
      return res.status(400).json({ error: `Unknown page: ${page}` });
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`http://${ip}${urlPath}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return res
          .status(response.status)
          .json({ error: `Phone returned ${response.status}` });
      }

      const text = await response.text();

      // For HTML pages, extract just the table/body content
      if (PHONE_PAGES[page]) {
        // Parse useful data from HTML
        const data = parsePhonePage(page, text);
        return res.json({ deviceName, ip, page, ...data });
      }

      // For log files, return raw text (detect fake 404s from Cisco phones)
      if (text.includes("requested URL was not found")) {
        return res
          .status(404)
          .json({ error: "Log file not available on this phone" });
      }
      res.json({ deviceName, ip, page, text });
    } catch (err) {
      if (err.name === "AbortError") {
        return res
          .status(504)
          .json({ error: "Phone web server timed out (10s)" });
      }
      console.error(`Phone fetch failed for ${deviceName}:`, err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createDeviceRouter };
