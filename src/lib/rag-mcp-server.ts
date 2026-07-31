import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
	authorizeMcpRequest,
	getMcpAuthConfig,
	McpAuthConfigurationError,
	McpAuthorizationError,
	mcpAuthorizationChallenge,
	mcpResourceMetadata,
	type McpAuthConfig,
} from "./mcp-auth";
import {
	fetchRagTweet,
	searchRagTweets,
	type RagFetchResult,
	type RagSearchResult,
} from "./rag-mcp-store";

const SEARCH_DESCRIPTION =
	"Search the private BirdClaw tweet archive. Use this before fetch to find stable tweet document IDs relevant to a question. Every result includes mandatory author_context from the owner's X Remark records (labels, personal note, and why the author is followed). Always surface this context when judging a claim, especially warning labels such as 反指. Returns at most 10 results with canonical source URLs.";
const FETCH_DESCRIPTION =
	"Fetch one BirdClaw tweet document by the stable ID returned from search. Returns the full archived tweet plus available parent, quote, and reply context, mandatory author judgment context for every included author, and a canonical source URL for citations. Never omit recorded labels, notes, or follow reasons when presenting the source.";
const packageVersion = (
	JSON.parse(
		readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
	) as { version?: string }
).version;

const searchInputSchema = z.object({
	query: z.string().trim().min(1).max(1_000),
});
const fetchInputSchema = z.object({
	id: z.string().trim().min(1).max(2_000),
});

const oauthSecuritySchemes = [
	{ type: "oauth2", scopes: ["birdclaw:read"] },
] as const;

const searchTool = {
	name: "search",
	title: "Search BirdClaw",
	description: SEARCH_DESCRIPTION,
	inputSchema: {
		type: "object",
		properties: { query: { type: "string", minLength: 1, maxLength: 1_000 } },
		required: ["query"],
		additionalProperties: false,
	},
	outputSchema: {
		type: "object",
		properties: {
			results: {
				type: "array",
				items: {
					type: "object",
					properties: {
						id: { type: "string" },
						title: { type: "string" },
						url: { type: "string", format: "uri" },
						author_context: {
							type: "object",
							properties: {
								handle: { type: "string" },
								display_name: { type: "string" },
								label_status: {
									type: "string",
									enum: ["recorded", "unlabeled"],
								},
								labels: { type: "array", items: { type: "string" } },
								tags: { type: "array", items: { type: "string" } },
								category: { type: ["string", "null"] },
								personal_note: { type: ["string", "null"] },
								follow_reason: { type: ["string", "null"] },
								source_updated_at: { type: ["string", "null"] },
							},
							required: [
								"handle",
								"display_name",
								"label_status",
								"labels",
								"tags",
								"category",
								"personal_note",
								"follow_reason",
								"source_updated_at",
							],
							additionalProperties: false,
						},
					},
					required: ["id", "title", "url", "author_context"],
					additionalProperties: false,
				},
			},
		},
		required: ["results"],
		additionalProperties: false,
	},
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	securitySchemes: oauthSecuritySchemes,
	_meta: { securitySchemes: oauthSecuritySchemes },
};

const fetchTool = {
	name: "fetch",
	title: "Fetch BirdClaw source",
	description: FETCH_DESCRIPTION,
	inputSchema: {
		type: "object",
		properties: { id: { type: "string", minLength: 1, maxLength: 2_000 } },
		required: ["id"],
		additionalProperties: false,
	},
	outputSchema: {
		type: "object",
		properties: {
			id: { type: "string" },
			title: { type: "string" },
			text: { type: "string" },
			url: { type: "string", format: "uri" },
			metadata: { type: "object", additionalProperties: true },
		},
		required: ["id", "title", "text", "url", "metadata"],
		additionalProperties: false,
	},
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	securitySchemes: oauthSecuritySchemes,
	_meta: { securitySchemes: oauthSecuritySchemes },
};

export interface RagMcpDependencies {
	authorize?: (
		authorization: string | string[] | undefined,
		config: McpAuthConfig,
	) => Promise<unknown>;
	search?: (query: string) => RagSearchResult[];
	fetch?: (id: string) => RagFetchResult | null;
}

function textResult<T extends object>(payload: T) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload) }],
		structuredContent: payload as Record<string, unknown>,
	};
}

export function createRagMcpProtocolServer(
	dependencies: Pick<RagMcpDependencies, "search" | "fetch"> = {},
) {
	const search = dependencies.search ?? searchRagTweets;
	const fetch = dependencies.fetch ?? fetchRagTweet;
	const server = new Server(
		{ name: "birdclaw-rag", version: packageVersion ?? "0.0.0" },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [searchTool, fetchTool],
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		if (request.params.name === "search") {
			const parsed = searchInputSchema.safeParse(request.params.arguments);
			if (!parsed.success) {
				return {
					content: [
						{ type: "text", text: "search requires a non-empty query" },
					],
					isError: true,
				};
			}
			const payload = { results: search(parsed.data.query) };
			return textResult(payload);
		}

		if (request.params.name === "fetch") {
			const parsed = fetchInputSchema.safeParse(request.params.arguments);
			if (!parsed.success) {
				return {
					content: [{ type: "text", text: "fetch requires a document id" }],
					isError: true,
				};
			}
			const document = fetch(parsed.data.id);
			if (!document) {
				return {
					content: [
						{
							type: "text",
							text: `No BirdClaw document found for ${parsed.data.id}`,
						},
					],
					isError: true,
				};
			}
			return textResult(document);
		}

		return {
			content: [
				{ type: "text", text: `Unknown BirdClaw tool: ${request.params.name}` },
			],
			isError: true,
		};
	});
	return server;
}

function sendJson(
	response: ServerResponse,
	status: number,
	payload: Record<string, unknown>,
	headers: Record<string, string> = {},
) {
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.setHeader("cache-control", "private, no-store");
	response.setHeader("x-content-type-options", "nosniff");
	for (const [name, value] of Object.entries(headers)) {
		response.setHeader(name, value);
	}
	response.end(JSON.stringify(payload));
}

function isMetadataPath(pathname: string) {
	return (
		pathname === "/.well-known/oauth-protected-resource" ||
		pathname === "/.well-known/oauth-protected-resource/mcp"
	);
}

export async function handleRagMcpHttpRequest(
	request: IncomingMessage,
	response: ServerResponse,
	dependencies: RagMcpDependencies = {},
) {
	const url = new URL(request.url ?? "/", "http://local");
	if (url.pathname !== "/mcp" && !isMetadataPath(url.pathname)) return false;

	let config: McpAuthConfig;
	try {
		config = getMcpAuthConfig();
	} catch (error) {
		if (!(error instanceof McpAuthConfigurationError)) throw error;
		sendJson(response, 503, {
			ok: false,
			message: "BirdClaw RAG MCP authentication is not configured",
		});
		return true;
	}

	if (isMetadataPath(url.pathname)) {
		if (request.method !== "GET") {
			sendJson(
				response,
				405,
				{ error: "method_not_allowed" },
				{ allow: "GET" },
			);
			return true;
		}
		sendJson(response, 200, mcpResourceMetadata(config));
		return true;
	}

	const authorize = dependencies.authorize ?? authorizeMcpRequest;
	try {
		await authorize(request.headers.authorization, config);
	} catch (error) {
		const authError =
			error instanceof McpAuthorizationError
				? error
				: new McpAuthorizationError("Authentication failed", "invalid_token");
		sendJson(
			response,
			401,
			{ error: authError.code, error_description: authError.message },
			{ "www-authenticate": mcpAuthorizationChallenge(config, authError) },
		);
		return true;
	}

	if (request.method !== "POST") {
		sendJson(response, 405, { error: "method_not_allowed" }, { allow: "POST" });
		return true;
	}

	const server = createRagMcpProtocolServer(dependencies);
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	try {
		await server.connect(transport);
		await transport.handleRequest(request, response);
	} finally {
		await transport.close();
		await server.close();
	}
	return true;
}
