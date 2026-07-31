// @vitest-environment node
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
	authorizeMcpRequest,
	getMcpAuthConfig,
	mcpAuthorizationChallenge,
	mcpResourceMetadata,
	resetMcpAuthForTests,
} from "./mcp-auth";

const originalEnvironment = { ...process.env };

afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!(key in originalEnvironment)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(originalEnvironment)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	resetMcpAuthForTests();
});

describe("BirdClaw MCP OAuth resource server", () => {
	it("verifies signature, issuer, audience, scope, and the private subject allowlist", async () => {
		const { privateKey, publicKey } = await generateKeyPair("RS256");
		const jwk = await exportJWK(publicKey);
		jwk.kid = "birdclaw-test";
		jwk.use = "sig";
		const jwksServer = createServer((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ keys: [jwk] }));
		});
		await new Promise<void>((resolve) =>
			jwksServer.listen(0, "127.0.0.1", resolve),
		);
		try {
			const address = jwksServer.address();
			if (!address || typeof address === "string")
				throw new Error("no address");
			const issuer = `http://127.0.0.1:${String(address.port)}/`;
			process.env.BIRDCLAW_MCP_ISSUER = issuer;
			process.env.BIRDCLAW_MCP_RESOURCE_URL = `${issuer}mcp`;
			process.env.BIRDCLAW_MCP_AUDIENCE = `${issuer}mcp`;
			process.env.BIRDCLAW_MCP_JWKS_URL = `${issuer}.well-known/jwks.json`;
			process.env.BIRDCLAW_MCP_ALLOWED_SUBJECTS = "google-oauth2|emperor";
			const config = getMcpAuthConfig();
			const token = await new SignJWT({ scope: "openid birdclaw:read" })
				.setProtectedHeader({ alg: "RS256", kid: "birdclaw-test" })
				.setIssuer(issuer)
				.setAudience(`${issuer}mcp`)
				.setSubject("google-oauth2|emperor")
				.setIssuedAt()
				.setExpirationTime("5m")
				.sign(privateKey);

			await expect(
				authorizeMcpRequest(`Bearer ${token}`, config),
			).resolves.toMatchObject({ sub: "google-oauth2|emperor" });

			const wrongSubject = await new SignJWT({ scope: "birdclaw:read" })
				.setProtectedHeader({ alg: "RS256", kid: "birdclaw-test" })
				.setIssuer(issuer)
				.setAudience(`${issuer}mcp`)
				.setSubject("google-oauth2|intruder")
				.setIssuedAt()
				.setExpirationTime("5m")
				.sign(privateKey);
			await expect(
				authorizeMcpRequest(`Bearer ${wrongSubject}`, config),
			).rejects.toMatchObject({
				code: "insufficient_scope",
			});

			expect(mcpResourceMetadata(config)).toMatchObject({
				resource: `${issuer}mcp`,
				authorization_servers: [issuer],
				scopes_supported: ["birdclaw:read"],
			});
			expect(mcpAuthorizationChallenge(config)).toContain(
				'Bearer resource_metadata="',
			);
		} finally {
			await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
		}
	});
});
