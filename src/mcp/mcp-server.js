const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

function createServerInstance(pool) {
  const server = new McpServer({
    name: "cisco-cdr",
    version: "0.1.0",
  });

  const tools = [
    require("./tools/cdr-search"),
    require("./tools/cdr-trace"),
    require("./tools/cdr-quality"),
    require("./tools/cdr-stats"),
    require("./tools/cdr-health"),
    require("./tools/numplan-available"),
  ];

  for (const tool of tools) {
    const schema = tool.inputSchema.shape
      ? tool.inputSchema.shape
      : tool.inputSchema;
    server.tool(tool.name, tool.description, schema, async (params) => {
      return tool.handler(params, pool);
    });
  }

  return server;
}

async function createMcpServer(app, pool) {
  // Stateless mode: each POST creates a fresh server + transport
  app.post("/mcp", async (req, res) => {
    try {
      const server = createServerInstance(pool);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "MCP server error" });
      }
    }
  });

  app.get("/mcp", (req, res) => {
    res.writeHead(405).end("Method Not Allowed");
  });

  app.delete("/mcp", (req, res) => {
    res.writeHead(405).end("Method Not Allowed");
  });
}

module.exports = { createMcpServer };
