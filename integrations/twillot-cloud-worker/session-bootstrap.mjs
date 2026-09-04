import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ALLOWED_COOKIE_HOSTS = ["x.com", "twillot.com"];
const ALLOWED_ORIGINS = new Set(["https://x.com", "https://www.twillot.com"]);

function allowedCookieDomain(domain) {
	const normalized = String(domain || "")
		.trim()
		.replace(/^\./, "")
		.toLowerCase();
	return ALLOWED_COOKIE_HOSTS.some(
		(host) => normalized === host || normalized.endsWith(`.${host}`),
	);
}

export function parseSessionBootstrap(encoded) {
	if (typeof encoded !== "string" || !encoded.trim()) return null;
	let parsed;
	try {
		parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	} catch {
		throw new Error("Twillot session bootstrap is not valid base64 JSON.");
	}
	if (parsed?.version !== 1 || !Array.isArray(parsed.cookies)) {
		throw new Error("Twillot session bootstrap has an unsupported schema.");
	}
	if (parsed.cookies.length > 500) {
		throw new Error("Twillot session bootstrap contains too many cookies.");
	}
	const cookies = parsed.cookies.map((cookie) => {
		if (
			!cookie ||
			typeof cookie.name !== "string" ||
			!cookie.name ||
			cookie.name.length > 256 ||
			typeof cookie.value !== "string" ||
			cookie.value.length > 16_384 ||
			!allowedCookieDomain(cookie.domain) ||
			typeof cookie.path !== "string" ||
			!cookie.path.startsWith("/")
		) {
			throw new Error("Twillot session bootstrap contains an invalid cookie.");
		}
		return {
			name: cookie.name,
			value: cookie.value,
			domain: cookie.domain,
			path: cookie.path,
			...(typeof cookie.expires === "number"
				? { expires: cookie.expires }
				: {}),
			...(typeof cookie.httpOnly === "boolean"
				? { httpOnly: cookie.httpOnly }
				: {}),
			...(typeof cookie.secure === "boolean" ? { secure: cookie.secure } : {}),
			...(cookie.sameSite === "Strict" ||
			cookie.sameSite === "Lax" ||
			cookie.sameSite === "None"
				? { sameSite: cookie.sameSite }
				: {}),
		};
	});
	const origins = Array.isArray(parsed.origins)
		? parsed.origins.map((origin) => {
				if (
					!origin ||
					!ALLOWED_ORIGINS.has(origin.origin) ||
					!Array.isArray(origin.localStorage) ||
					origin.localStorage.length > 500
				) {
					throw new Error(
						"Twillot session bootstrap contains an invalid origin.",
					);
				}
				return {
					origin: origin.origin,
					localStorage: origin.localStorage.map((item) => {
						if (
							!item ||
							typeof item.name !== "string" ||
							item.name.length > 1_024 ||
							typeof item.value !== "string" ||
							item.value.length > 1_000_000
						) {
							throw new Error(
								"Twillot session bootstrap contains invalid local storage.",
							);
						}
						return { name: item.name, value: item.value };
					}),
				};
			})
		: [];
	return { version: 1, cookies, origins };
}

async function exists(target) {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

export async function applySessionBootstrap(
	context,
	profileDir,
	encoded = process.env.BIRDCLAW_TWILLOT_BOOTSTRAP_B64,
) {
	const bootstrap = parseSessionBootstrap(encoded);
	if (!bootstrap) return { applied: false, reason: "not-configured" };
	const marker = path.join(profileDir, ".birdclaw-session-bootstrap-v1");
	const digest = createHash("sha256").update(encoded).digest("hex");
	if (await exists(marker)) {
		const appliedDigest = await readFile(marker, "utf8")
			.then((value) => value.trim())
			.catch(() => "");
		if (appliedDigest === digest) {
			return { applied: false, reason: "already-applied" };
		}
	}
	await context.addCookies(bootstrap.cookies);
	for (const origin of bootstrap.origins) {
		const page = await context.newPage();
		try {
			await page.goto(origin.origin, { waitUntil: "domcontentloaded" });
			await page.evaluate((entries) => {
				for (const entry of entries) {
					localStorage.setItem(entry.name, entry.value);
				}
			}, origin.localStorage);
		} finally {
			await page.close();
		}
	}
	const xPage = await context.newPage();
	try {
		await xPage.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
		await xPage.waitForTimeout(3_000);
	} finally {
		await xPage.close();
	}
	await writeFile(marker, `${digest}\n`, { mode: 0o600 });
	return {
		applied: true,
		cookieCount: bootstrap.cookies.length,
		originCount: bootstrap.origins.length,
	};
}
