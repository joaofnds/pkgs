module.exports = {
	collectCoverageFrom: ["src/**/*.ts"],
	coverageDirectory: "coverage",
	coveragePathIgnorePatterns: ["node_modules/", "dist/", "test/", ".test.ts"],
	detectOpenHandles: true,
	rootDir: "./",
	testEnvironment: "node",
	testMatch: ["<rootDir>/**/*.test.ts"],
	transform: { "\\.ts$": "@swc/jest" },
	moduleNameMapper: {
		"^src/(.*)": "<rootDir>/src/$1",
		"^test/(.*)": "<rootDir>/test/$1",
	},
};
