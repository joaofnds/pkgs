import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
	oxc: false,
	test: {
		globals: true,
		environment: "node",
		pool: "forks",
	},
	plugins: [
		swc.vite({
			swcrc: false,
			jsc: {
				parser: { syntax: "typescript", decorators: true },
				transform: { legacyDecorator: true, decoratorMetadata: true },
				keepClassNames: true,
				target: "es2022",
			},
		}),
	],
});
