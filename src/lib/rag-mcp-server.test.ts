// @vitest-environment node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { McpAuthorizationError } from "./mcp-auth";
import { handleRagMcpHttpRequest } from "./rag-mcp-server";

const originalEnvironment = { ...process.env };

afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!(key in originalEnvironment)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(originalEnvironment)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("BirdClaw remote RAG MCP", () => {
	it("publishes OAuth metadata and authenticated search/fetch tools", async () => {
		const server = createServer((request, response) => {
			void handleRagMcpHttpRequest(request, response, {
				authorize: async (authorization) => {
					if (authorization !== "Bearer valid-test-token") {
						throw new McpAuthorizationError(
							"Authentication required",
							"invalid_token",
						);
					}
				},
				search: (query) => [
					{
						id: "tweet:42",
						title: `Result for ${query}`,
						url: "https://x.com/example/status/42",
						author_context: {
							handle: "example",
							display_name: "Example",
							label_status: "recorded",
							labels: ["反指"],
							tags: ["反指"],
							category: null,
							personal_note: "Do not follow directly",
							follow_reason: "Monitor as a reverse indicator",
							source_updated_at: null,
						},
					},
				],
				fetch: (id) => ({
					id,
					title: "Fetched source",
					text: "Archived evidence",
					url: "https://x.com/example/status/42",
					metadata: { type: "tweet" },
				}),
			}).then((handled) => {
				if (!handled && !response.headersSent) response.writeHead(404).end();
			});
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		try {
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("no address");
			const baseUrl = `http://127.0.0.1:${String(address.port)}`;
			process.env.BIRDCLAW_MCP_ISSUER = `${baseUrl}/oauth/`;
			process.env.BIRDCLAW_MCP_RESOURCE_URL = `${baseUrl}/mcp`;
			process.env.BIRDCLAW_MCP_ALLOWED_SUBJECTS = "test-subject";

			const metadata = await fetch(
				`${baseUrl}/.well-known/oauth-protected-resource`,
			).then((response) => response.json());
			expect(metadata).toMatchObject({
				resource: `${baseUrl}/mcp`,
				authorization_servers: [`${baseUrl}/oauth/`],
				scopes_supported: ["birdclaw:read"],
			});

			const denied = await fetch(`${baseUrl}/mcp`, {
				method: "POST",
				headers: {
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-11-25",
						capabilities: {},
						clientInfo: { name: "test", version: "1" },
					},
				}),
			});
			expect(denied.status).toBe(401);
			expect(denied.headers.get("www-authenticate")).toContain(
				"oauth-protected-resource",
			);

			const transport = new StreamableHTTPClientTransport(
				new URL(`${baseUrl}/mcp`),
				{
					requestInit: {
						headers: { authorization: "Bearer valid-test-token" },
					},
				},
			);
			const client = new Client({ name: "birdclaw-test", version: "1" });
			await client.connect(transport);
			try {
				const tools = await client.listTools();
				expect(tools.tools.map((tool) => tool.name)).toEqual([
					"search",
					"fetch",
				]);
				expect(tools.tools[0]?._meta).toMatchObject({
					securitySchemes: [{ type: "oauth2", scopes: ["birdclaw:read"] }],
				});

				const search = await client.callTool({
					name: "search",
					arguments: { query: "RAG" },
				});
				expect(search.structuredContent).toEqual({
					results: [
						{
							id: "tweet:42",
							title: "Result for RAG",
							url: "https://x.com/example/status/42",
							author_context: {
								handle: "example",
								display_name: "Example",
								label_status: "recorded",
								labels: ["反指"],
								tags: ["反指"],
								category: null,
								personal_note: "Do not follow directly",
								follow_reason: "Monitor as a reverse indicator",
								source_updated_at: null,
							},
						},
					],
				});

				const fetched = await client.callTool({
					name: "fetch",
					arguments: { id: "tweet:42" },
				});
				expect(fetched.structuredContent).toMatchObject({
					id: "tweet:42",
					text: "Archived evidence",
				});
			} finally {
				await client.close();
			}
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
