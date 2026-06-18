import type { Command } from "commander";
import { maybeAutoSyncBackup, maybeAutoUpdateBackup } from "#/lib/backup";

export interface CliCommandContext {
	program: Command;
	print: (data: unknown, asJson: boolean) => void;
	asJson: () => boolean;
	autoSyncAfterWrite: () => Promise<void>;
	autoUpdateBeforeRead: () => Promise<void>;
	parseNonNegativeIntegerOption: (
		value: string | undefined,
		option: string,
	) => number | undefined;
	parsePositiveIntegerOption: (
		value: string | undefined,
		option: string,
	) => number | undefined;
}

export function print(data: unknown, asJson: boolean) {
	if (asJson) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}
	console.log(data);
}

export function printError(error: string) {
	console.error(JSON.stringify({ error }));
}

export function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export function parseNonNegativeIntegerOption(
	value: string | undefined,
	option: string,
) {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		printError(`${option} must be a non-negative integer`);
		process.exitCode = 1;
		return undefined;
	}
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isSafeInteger(parsed)) {
		printError(`${option} must be a non-negative integer`);
		process.exitCode = 1;
		return undefined;
	}
	return parsed;
}

export function parsePositiveIntegerOption(
	value: string | undefined,
	option: string,
) {
	const parsed = parseNonNegativeIntegerOption(value, option);
	if (parsed === undefined) return undefined;
	if (parsed < 1) {
		printError(`${option} must be at least 1`);
		process.exitCode = 1;
		return undefined;
	}
	return parsed;
}

async function autoUpdateBeforeRead() {
	try {
		const result = await maybeAutoUpdateBackup();
		if (!result.ok) {
			console.error(`birdclaw backup auto-sync failed: ${result.error}`);
		}
	} catch (error) {
		console.error(`birdclaw backup auto-sync failed: ${errorMessage(error)}`);
	}
}

async function autoSyncAfterWrite() {
	try {
		const result = await maybeAutoSyncBackup();
		if (!result.ok) {
			console.error(`birdclaw backup sync failed: ${result.error}`);
		}
	} catch (error) {
		console.error(`birdclaw backup sync failed: ${errorMessage(error)}`);
	}
}

export function createCommandContext(program: Command): CliCommandContext {
	return {
		program,
		print,
		asJson: () => program.opts().json ?? false,
		autoSyncAfterWrite,
		autoUpdateBeforeRead,
		parseNonNegativeIntegerOption,
		parsePositiveIntegerOption,
	};
}
