export const DEFAULT_ENDPOINT =
	"https://birdclaw-production.up.railway.app/api/integrations/twillot-history";

export function normalizeEndpoint(value = DEFAULT_ENDPOINT) {
	const url = new URL(value);
	const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
		url.hostname,
	);
	if (url.pathname !== "/api/integrations/twillot-history") {
		throw new Error("BirdClaw Twillot endpoint has an unexpected path.");
	}
	if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
		throw new Error("BirdClaw Twillot endpoint must use HTTPS.");
	}
	url.search = "";
	url.hash = "";
	return url.toString();
}

export function followingEndpoint(historyEndpoint) {
	const url = new URL(normalizeEndpoint(historyEndpoint));
	url.pathname = "/api/integrations/twillot-following";
	return url.toString();
}
