import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	render as testingLibraryRender,
	type RenderOptions,
} from "@testing-library/react";
import type { ReactNode } from "react";

export function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				gcTime: Infinity,
				retry: false,
			},
			mutations: {
				retry: false,
			},
		},
	});
}

export function renderWithQueryClient(
	ui: ReactNode,
	options?: Omit<RenderOptions, "wrapper"> & {
		queryClient?: QueryClient;
	},
) {
	const { queryClient = createTestQueryClient(), ...renderOptions } =
		options ?? {};
	const result = testingLibraryRender(ui, {
		...renderOptions,
		wrapper: ({ children }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		),
	});
	return { ...result, queryClient };
}
