/* Integration tests hit a real agora-server over real HTTP/WS, so they run
   in plain Node (the jest-expo preset mocks react-native networking). */
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/tests/integration.test.ts"],
  moduleNameMapper: {
    "^@agora/core$": "<rootDir>/../packages/core/src/index.ts",
  },
  transform: {
    "^.+\\.(t|j)sx?$": [
      "babel-jest",
      {
        presets: [
          ["@babel/preset-env", { targets: { node: "current" } }],
          "@babel/preset-typescript",
        ],
      },
    ],
  },
};
