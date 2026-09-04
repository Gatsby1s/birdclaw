import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildBridge } from "../twillot-companion/build.mjs";

const execFileAsync = promisify(execFile);
const EXTENSION_ID = "flkokionhgagpmnhlngldhbfnblmenen";
const EXTENSION_PUBLIC_KEY =
	"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAw6g2HhU4P4X4gPAWPG2ULi35lESv0eQcmMg3Bdx4dB3XAH3iU/6oHZQj+YxAeqjwdRKG8ky7fMb6UbqbT7xi/JdxQ+modyRz0vXUgv5Jvsetf0kSQqnil8JugeoFbOtbKqYOaM0Hm3skYyCVnN0yaKGNdcw1ioS0onvHg9mtLp08dwm9vE+rjzLEAPo05kuuMs9GPpKuF0zPQQOyn0g4GkFa/J2bQZbtCigj0PjJMRBTYQE+9nfnEWt4yUp+4N1pj1Vln7GvpDzTzhhkxV8H1xpZUrNAk2BEbNCULJHk3EIzdKL+58pP14jDItlspZMYgpnEVamTUB5504pk8SoQwwIDAQAB";
const UPDATE_URL =
	"https://clients2.google.com/service/update2/crx?response=redirect&prodversion=140.0.0.0&acceptformat=crx3&x=id%3Dflkokionhgagpmnhlngldhbfnblmenen%26uc";
const MAX_CRX_BYTES = 10 * 1024 * 1024;

export function extractCrxZip(crx) {
	const bytes = Buffer.from(crx);
	if (bytes.length < 12 || bytes.subarray(0, 4).toString("ascii") !== "Cr24") {
		throw new Error("Downloaded Twillot package is not a CRX file.");
	}
	if (bytes.readUInt32LE(4) !== 3) {
		throw new Error("Downloaded Twillot package is not CRX3.");
	}
	const zipOffset = 12 + bytes.readUInt32LE(8);
	if (
		zipOffset + 4 > bytes.length ||
		bytes.subarray(zipOffset, zipOffset + 4).toString("hex") !== "504b0304"
	) {
		throw new Error("Downloaded Twillot CRX has an invalid ZIP payload.");
	}
	return bytes.subarray(zipOffset);
}

async function downloadOfficialCrx(fetchImpl = fetch) {
	const response = await fetchImpl(UPDATE_URL, {
		redirect: "follow",
		headers: { "user-agent": "BirdClaw-Twillot-Cloud/1.0" },
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok) {
		throw new Error(
			`Official Twillot download failed with HTTP ${response.status}.`,
		);
	}
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_CRX_BYTES) {
		throw new Error("Official Twillot package exceeds the safe size limit.");
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length === 0 || bytes.length > MAX_CRX_BYTES) {
		throw new Error("Official Twillot package has an invalid size.");
	}
	return bytes;
}

export async function prepareTwillotExtension(options = {}) {
	const root = await mkdtemp(path.join(os.tmpdir(), "birdclaw-twillot-cloud-"));
	const source = path.join(root, "official");
	const bridge = path.join(root, "bridge");
	const rollback = path.join(root, "rollback");
	try {
		await mkdir(source, { recursive: true });
		const configuredSource = process.env.BIRDCLAW_TWILLOT_EXTENSION_SOURCE;
		if (configuredSource) {
			await buildBridge({
				source: configuredSource,
				destination: bridge,
				rollbackDestination: rollback,
			});
		} else {
			const crx = await downloadOfficialCrx(options.fetchImpl);
			const archive = path.join(root, "official.zip");
			await writeFile(archive, extractCrxZip(crx));
			await execFileAsync("unzip", ["-q", archive, "-d", source]);
			const manifestPath = path.join(source, "manifest.json");
			const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
			manifest.key = EXTENSION_PUBLIC_KEY;
			await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
			const localePath = path.join(source, "_locales/en/messages.json");
			const locale = JSON.parse(await readFile(localePath, "utf8"));
			const canonicalLocale = {
				extensionDescription: {
					description: locale.extensionDescription?.description,
					message: locale.extensionDescription?.message,
				},
				extensionName: {
					description: locale.extensionName?.description,
					message: locale.extensionName?.message,
				},
			};
			await writeFile(
				localePath,
				`${JSON.stringify(canonicalLocale, null, 3)}\n`,
			);
			await buildBridge({
				source,
				destination: bridge,
				rollbackDestination: rollback,
			});
		}
		const manifest = JSON.parse(
			await readFile(path.join(bridge, "manifest.json"), "utf8"),
		);
		if (manifest.version !== "11.0.8" || typeof manifest.key !== "string") {
			throw new Error(
				"Prepared Twillot bridge failed the final manifest check.",
			);
		}
		return {
			extensionId: EXTENSION_ID,
			bridgePath: bridge,
			cleanup: () => rm(root, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}
