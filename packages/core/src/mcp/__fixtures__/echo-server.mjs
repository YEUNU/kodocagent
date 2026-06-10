/**
 * 테스트용 echo MCP 서버 픽스처
 * @modelcontextprotocol/sdk McpServer + StdioServerTransport 사용
 *
 * 제공 툴: echo — { message: string } → "[echo] <message>"
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "echo-fixture",
  version: "1.0.0",
});

server.registerTool(
  "echo",
  {
    description: "주어진 메시지를 그대로 반환한다",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: `[echo] ${message}` }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
