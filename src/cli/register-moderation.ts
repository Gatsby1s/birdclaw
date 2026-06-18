import { registerModerationCommands as registerCommands } from "#/cli-moderation";
import { importBlocklist } from "#/lib/blocklist";
import type { ActionsTransport } from "#/lib/config";
import type { CliCommandContext } from "./command-context";

export function registerModerationCommands(context: CliCommandContext) {
	registerCommands({
		program: context.program,
		print: context.print,
		asJson: context.asJson,
		importBlocklist,
		resolveActionOptions: (options: { transport?: string }) => ({
			transport: options.transport as ActionsTransport | undefined,
		}),
	});
}
