import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

test("core files exist", () => {
  const required = [
    "src/index.ts",
    "package.json",
    "README.md",
    "LICENSE",
    "SECURITY.md",
  ];
  for (const rel of required) {
    assert.equal(fs.existsSync(path.join(repoRoot, rel)), true, `${rel} must exist`);
  }
});

test("README includes security and setup sections", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /Quick (Start|Demo)/i);
  assert.match(readme, /Security/i);
  assert.match(readme, /Commercial Setup/i);
});
