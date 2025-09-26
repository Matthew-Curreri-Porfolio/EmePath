import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Create server instance
const server = new McpServer({
  name: 'mcp-demo',
  version: '1.0.0',
  capabilities: {
    tools: {
      listChanged: false,
    },
    resources: {
      listChanged: false,
      subscribe: false,
    },
  },
});

// Example tool to get current time
server.tool('getCurrentTime', async () => {
  return {
    content: [{ type: 'text', text: new Date().toISOString() }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP Server running on stdio'); // Use stderr for logging
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
