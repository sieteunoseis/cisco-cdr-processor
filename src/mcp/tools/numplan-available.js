const { z } = require("zod");
const config = require("../../config");
const {
  resolvePatternRange,
  enumerateMatches,
} = require("../../lib/patternRange");
const { queryConfiguredNumbers } = require("../../lib/numplanAxl");

module.exports = {
  name: "numplan_find_available",
  description:
    'Find an unconfigured (available) directory number within a labeled number-bank range, by searching the shared CDR label rules for a name match (e.g. "urology" matches a label like "OHSU Urology Adventist"). Returns the first N available numbers in that label\'s range, or a message listing candidate labels if the search text is ambiguous or matches nothing.',
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        'Text to search for in label names, e.g. "urology", "call park", "MWI"',
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("How many available numbers to return (default 1)"),
  }),
  async handler(params, pool) {
    const { query, count = 1 } = params;

    const result = await pool.query(
      "SELECT label, pattern FROM label_rules WHERE enabled = true AND label ILIKE $1 ORDER BY label",
      [`%${query}%`],
    );

    const distinctLabels = [...new Set(result.rows.map((r) => r.label))];
    if (distinctLabels.length === 0) {
      return {
        content: [
          { type: "text", text: `No label rule found matching "${query}".` },
        ],
      };
    }
    if (distinctLabels.length > 1) {
      return {
        content: [
          {
            type: "text",
            text: `"${query}" matches multiple labels, please be more specific: ${distinctLabels.join(", ")}`,
          },
        ],
      };
    }

    const label = distinctLabels[0];
    const matchingRows = result.rows.filter((r) => r.label === label);

    const cluster = config.axl.clusters[0];
    if (!cluster) {
      return {
        content: [{ type: "text", text: "No AXL cluster configured." }],
      };
    }

    const available = [];
    for (const row of matchingRows) {
      const resolved = resolvePatternRange(row.pattern);
      if (!resolved) continue;
      const allMatches = enumerateMatches(
        row.pattern,
        resolved.prefix,
        resolved.width,
      );
      const configured = await queryConfiguredNumbers(cluster, allMatches);
      for (const number of allMatches) {
        if (!configured.has(number)) {
          available.push(number);
          if (available.length >= count) break;
        }
      }
      if (available.length >= count) break;
    }

    if (available.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Label "${label}" has no available numbers (or isn't a fixed-width number range this tool can enumerate).`,
          },
        ],
      };
    }

    return {
      content: [
        { type: "text", text: JSON.stringify({ label, available }, null, 2) },
      ],
    };
  },
};
