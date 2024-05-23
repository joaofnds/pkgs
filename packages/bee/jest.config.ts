import { defaults as tsjPreset } from "ts-jest/presets";

export default {
	collectCoverageFrom: ["src/**/*.ts"],
	coverageDirectory: "coverage",
	coveragePathIgnorePatterns: ["node_modules/", "dist/", "test/", ".test.ts"],
	detectOpenHandles: true,
	forceExit: true,
	moduleNameMapper: {
		"^src/(.*)": "<rootDir>/src/$1",
		"^test/(.*)": "<rootDir>/test/$1",
	},
	rootDir: "./",
	testEnvironment: "node",
	testMatch: ["<rootDir>/**/*.test.ts"],
	transform: tsjPreset.transform,
};
