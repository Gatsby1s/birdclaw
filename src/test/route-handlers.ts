type RouteMethod = "GET" | "POST" | "PATCH" | "DELETE";

type RouteHandler = (context: {
	request: Request;
}) => Response | Promise<Response>;

interface RouteWithServerHandlers {
	options: {
		server?: {
			handlers?: unknown;
		};
	};
}

export function getRouteHandler(
	route: RouteWithServerHandlers,
	method: RouteMethod,
): RouteHandler {
	const handlers = route.options.server?.handlers;
	if (!handlers || typeof handlers === "function") {
		throw new Error(`Route ${method} handler missing`);
	}

	const handler = (handlers as Partial<Record<RouteMethod, RouteHandler>>)[
		method
	];
	if (!handler) {
		throw new Error(`Route ${method} handler missing`);
	}

	return handler;
}
