import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The official MCP Registry listing (#111). Sources, read 2026-10-21:
// - server.json fields and limits: static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json, the
//   schema mcp-publisher v1.8.1 calls current (pkg/model/constants.go, CurrentSchemaURL).
// - npm ownership: the registry reads `mcpName` from registry.npmjs.org/<identifier>/<version> and requires it to
//   equal the server name (internal/validators/registries/npm.go in github.com/modelcontextprotocol/registry).
// - GitHub OIDC grants the namespace io.github.<repository owner>/* (internal/api/handlers/v0/auth/github_oidc.go).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const json = (path: string) => JSON.parse(read(path)) as Record<string, any>;
const pkg = json("package.json");
const server = json("server.json");
const NAME = "io.github.paureis/cloudpin";

describe("server.json for the MCP Registry", () => {
  it("uses the current schema and the GitHub namespace that OIDC login grants", () => {
    expect(server.$schema).toBe("https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
    expect(server.name).toBe(NAME);
    expect(server.repository).toEqual({ url: "https://github.com/paureis/cloudpin", source: "github" });
  });

  it("has a description within the schema's 100 characters", () => {
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it("runs the npm package's binary over stdio with the argument mcp", () => {
    expect(server.packages).toEqual([
      {
        registryType: "npm",
        registryBaseUrl: "https://registry.npmjs.org",
        identifier: pkg.name,
        version: pkg.version,
        transport: { type: "stdio" },
        packageArguments: [{ type: "positional", value: "mcp" }],
      },
    ]);
  });

  it("is claimed by package.json's mcpName, which the registry checks on npm", () => {
    expect(pkg.mcpName).toBe(NAME);
  });
});
