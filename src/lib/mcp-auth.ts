import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const DEFAULT_SCOPE = "birdclaw:read";

export interface McpAuthConfig {
	issuer: string;
	resource: string;
	audience: string;
	jwksUrl: string;
	scope: string;
	allowedSubjects: Set<string>;
}

export class McpAuthConfigurationError extends Error {}

export class McpAuthorizationError extends Error {
	constructor(
		message: string,
		readonly code: "invalid_token" | "insufficient_scope",
	) {
		super(message);
	}
}

const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function requiredUrl(name: string, value: string | undefined) {
	const normalized = value?.trim();
	if (!normalized) {
		throw new McpAuthConfigurationError(`${name} is required for the RAG MCP`);
	}
	let url: URL;
	try {
		url = new URL(normalized);
	} catch {
		throw new McpAuthConfigurationError(`${name} must be an absolute URL`);
	}
	const loopback =
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "[::1]";
	if (url.protocol !== "https:" && !loopback) {
		throw new McpAuthConfigurationError(`${name} must use HTTPS`);
	}
	return url.toString();
}

function splitList(value: string | undefined) {
	return new Set(
		(value ?? "")
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean),
	);
}

export function getMcpAuthConfig(): McpAuthConfig {
	const issuer = requiredUrl(
		"BIRDCLAW_MCP_ISSUER",
		process.env.BIRDCLAW_MCP_ISSUER,
	);
	const resource = requiredUrl(
		"BIRDCLAW_MCP_RESOURCE_URL",
		process.env.BIRDCLAW_MCP_RESOURCE_URL,
	);
	const audience = process.env.BIRDCLAW_MCP_AUDIENCE?.trim() || resource;
	const jwksUrl =
		process.env.BIRDCLAW_MCP_JWKS_URL?.trim() ||
		new URL(".well-known/jwks.json", issuer).toString();
	const scope = process.env.BIRDCLAW_MCP_SCOPE?.trim() || DEFAULT_SCOPE;
	const allowedSubjects = splitList(process.env.BIRDCLAW_MCP_ALLOWED_SUBJECTS);
	if (allowedSubjects.size === 0) {
		throw new McpAuthConfigurationError(
			"BIRDCLAW_MCP_ALLOWED_SUBJECTS must name at least one authorized identity",
		);
	}
	return { issuer, resource, audience, jwksUrl, scope, allowedSubjects };
}

export function mcpResourceMetadata(config: McpAuthConfig) {
	return {
		resource: config.resource,
		authorization_servers: [config.issuer],
		scopes_supported: [config.scope],
		bearer_methods_supported: ["header"],
		resource_documentation: "https://github.com/Gatsby1s/birdclaw",
	};
}

export function mcpResourceMetadataUrl(config: McpAuthConfig) {
	return new URL(
		"/.well-known/oauth-protected-resource",
		config.resource,
	).toString();
}

function quoteChallengeValue(value: string) {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function mcpAuthorizationChallenge(
	config: McpAuthConfig,
	error?: McpAuthorizationError,
) {
	const parts = [
		`resource_metadata="${quoteChallengeValue(mcpResourceMetadataUrl(config))}"`,
		`scope="${quoteChallengeValue(config.scope)}"`,
	];
	if (error) {
		parts.push(`error="${error.code}"`);
		parts.push(`error_description="${quoteChallengeValue(error.message)}"`);
	}
	return `Bearer ${parts.join(", ")}`;
}

function bearerToken(authorization: string | string[] | undefined) {
	const value = Array.isArray(authorization) ? authorization[0] : authorization;
	const match = value?.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || "";
}

function tokenScopes(payload: JWTPayload) {
	const scopes = new Set<string>();
	if (typeof payload.scope === "string") {
		for (const scope of payload.scope.split(/\s+/)) {
			if (scope) scopes.add(scope);
		}
	}
	const permissions = payload.permissions;
	if (Array.isArray(permissions)) {
		for (const permission of permissions) {
			if (typeof permission === "string") scopes.add(permission);
		}
	}
	return scopes;
}

function remoteJwks(url: string) {
	let jwks = jwksByUrl.get(url);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(url), {
			cooldownDuration: 30_000,
			timeoutDuration: 5_000,
		});
		jwksByUrl.set(url, jwks);
	}
	return jwks;
}

export async function authorizeMcpRequest(
	authorization: string | string[] | undefined,
	config: McpAuthConfig,
) {
	const token = bearerToken(authorization);
	if (!token) {
		throw new McpAuthorizationError(
			"Authentication required to access the private BirdClaw archive",
			"invalid_token",
		);
	}

	let payload: JWTPayload;
	try {
		({ payload } = await jwtVerify(token, remoteJwks(config.jwksUrl), {
			issuer: config.issuer,
			audience: config.audience,
			algorithms: ["RS256"],
		}));
	} catch {
		throw new McpAuthorizationError(
			"The access token is missing, expired, or invalid",
			"invalid_token",
		);
	}

	if (!payload.sub || !config.allowedSubjects.has(payload.sub)) {
		throw new McpAuthorizationError(
			"This identity is not allowed to access the private BirdClaw archive",
			"insufficient_scope",
		);
	}
	if (!tokenScopes(payload).has(config.scope)) {
		throw new McpAuthorizationError(
			`The access token needs the ${config.scope} scope`,
			"insufficient_scope",
		);
	}
	return payload;
}

export function resetMcpAuthForTests() {
	jwksByUrl.clear();
}
