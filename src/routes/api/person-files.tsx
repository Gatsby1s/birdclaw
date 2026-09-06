import { createFileRoute } from "@tanstack/react-router";
import { getNativeDb, getReadDb } from "#/lib/db";
import { jsonResponse, sensitiveRequestErrorResponse } from "#/lib/http-effect";
import {
	downloadPersonFile,
	uploadPersonFile,
	PersonFileError,
} from "#/lib/person-archive-files";
async function download({ request }: { request: Request }) {
	const denied = sensitiveRequestErrorResponse(request);
	if (denied) return denied;
	return downloadPersonFile(
		getReadDb({ seedDemoData: false }),
		new URL(request.url).searchParams.get("id") ?? "",
		request,
	);
}
export const Route = createFileRoute("/api/person-files")({
	server: {
		handlers: {
			GET: download,
			HEAD: download,
			POST: async ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return denied;
				try {
					return jsonResponse({
						ok: true,
						item: await uploadPersonFile(
							getNativeDb({ seedDemoData: false }),
							request,
						),
					});
				} catch (error) {
					return jsonResponse(
						{
							ok: false,
							message:
								error instanceof PersonFileError
									? error.message
									: "文件处理失败，请检查人物、文件格式和资料链接。",
						},
						{ status: error instanceof PersonFileError ? error.status : 400 },
					);
				}
			},
		},
	},
});
