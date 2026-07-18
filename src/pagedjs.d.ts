declare module "pagedjs" {
	type Stylesheet = string | Record<string, string>;

	export class Previewer {
		preview(
			content: Node | string,
			stylesheets?: Stylesheet[],
			renderTo?: HTMLElement,
		): Promise<{ total: number }>;
	}
}
