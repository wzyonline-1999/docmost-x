import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const inputPath = path.resolve(
  rootDir,
  process.argv[2] ?? "artifacts/docmost-production.cdx.json",
);
const bom = JSON.parse(await readFile(inputPath, "utf8"));
const failures = [];

expect(bom.bomFormat === "CycloneDX", "bomFormat must be CycloneDX");
expect(bom.specVersion === "1.5", "specVersion must be 1.5");
expect(
  /^urn:uuid:[0-9a-f-]{36}$/i.test(bom.serialNumber ?? ""),
  "serialNumber must be a UUID URN",
);
expect(Number.isInteger(bom.version) && bom.version > 0, "version is invalid");
expect(
  !Number.isNaN(Date.parse(bom.metadata?.timestamp)),
  "metadata.timestamp is invalid",
);
expect(
  bom.metadata?.properties?.some(
    (property) =>
      property.name === "docmost:dependency-scope" &&
      property.value === "production",
  ),
  "production dependency scope metadata is missing",
);
expect(
  Array.isArray(bom.components) && bom.components.length >= 100,
  "components must contain the production dependency graph",
);

const rootRef = bom.metadata?.component?.["bom-ref"];
const componentRefs = new Set();

for (const component of bom.components ?? []) {
  expect(component.type === "library", "component type must be library");
  expect(Boolean(component.name), "component name is missing");
  expect(Boolean(component.version), "component version is missing");
  expect(
    component.scope === "required",
    `${component["bom-ref"] ?? "unknown component"} must be required`,
  );
  expect(
    component["bom-ref"] === component.purl,
    `${component["bom-ref"] ?? "unknown component"} has mismatched purl`,
  );
  expect(
    !componentRefs.has(component["bom-ref"]),
    `duplicate component ref ${component["bom-ref"]}`,
  );
  componentRefs.add(component["bom-ref"]);
}

const validRefs = new Set([rootRef, ...componentRefs]);
const dependencyRefs = new Set();

for (const dependency of bom.dependencies ?? []) {
  expect(
    validRefs.has(dependency.ref),
    `dependency ref ${dependency.ref} is not a component`,
  );
  expect(
    !dependencyRefs.has(dependency.ref),
    `duplicate dependency graph entry ${dependency.ref}`,
  );
  dependencyRefs.add(dependency.ref);

  for (const childRef of dependency.dependsOn ?? []) {
    expect(
      componentRefs.has(childRef),
      `${dependency.ref} depends on unknown component ${childRef}`,
    );
  }
}

expect(dependencyRefs.has(rootRef), "root dependency graph entry is missing");

if (failures.length > 0) {
  process.stderr.write(`SBOM validation failed:\n- ${failures.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Validated CycloneDX SBOM with ${componentRefs.size} production components.\n`,
  );
}

function expect(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}
