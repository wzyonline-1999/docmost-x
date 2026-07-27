import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputPath = path.resolve(
  rootDir,
  process.argv[2] ?? "artifacts/docmost-production.cdx.json",
);
const rootPackage = JSON.parse(
  await readFile(path.join(rootDir, "package.json"), "utf8"),
);
const lockfile = parse(
  await readFile(path.join(rootDir, "pnpm-lock.yaml"), "utf8"),
);
const packages = lockfile.packages ?? {};
const snapshots = lockfile.snapshots ?? {};
const importers = lockfile.importers ?? {};
const snapshotKeysByPackage = new Map();

for (const snapshotKey of Object.keys(snapshots)) {
  const packageKey = stripDependencyContext(snapshotKey);
  const candidates = snapshotKeysByPackage.get(packageKey) ?? [];
  candidates.push(snapshotKey);
  snapshotKeysByPackage.set(packageKey, candidates);
}

const visitedSnapshots = new Set();
const productionPackageKeys = new Set();
const dependencyEdges = new Map();

for (const importer of Object.values(importers)) {
  for (const section of ["dependencies", "optionalDependencies"]) {
    for (const [name, dependency] of Object.entries(importer[section] ?? {})) {
      visitDependency(name, getVersion(dependency));
    }
  }
}

const components = [...productionPackageKeys]
  .map(createComponent)
  .sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"]));
const componentRefs = new Set(
  components.map((component) => component["bom-ref"]),
);
const rootRef = packageUrl(rootPackage.name, rootPackage.version);
const dependencies = [
  {
    ref: rootRef,
    dependsOn: [...componentRefs].sort(),
  },
  ...[...dependencyEdges.entries()]
    .filter(([ref]) => componentRefs.has(ref))
    .map(([ref, dependsOn]) => ({
      ref,
      dependsOn: [...dependsOn]
        .filter((dependencyRef) => componentRefs.has(dependencyRef))
        .sort(),
    }))
    .sort((left, right) => left.ref.localeCompare(right.ref)),
];
const bom = {
  $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "application",
      "bom-ref": rootRef,
      name: rootPackage.name,
      version: rootPackage.version,
      purl: rootRef,
    },
    properties: [
      {
        name: "docmost:dependency-scope",
        value: "production",
      },
      {
        name: "docmost:source-lockfile",
        value: "pnpm-lock.yaml",
      },
    ],
  },
  components,
  dependencies,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(bom, null, 2)}\n`);
process.stdout.write(
  `Wrote ${components.length} production components to ` +
    `${path.relative(rootDir, outputPath)}.\n`,
);

function visitDependency(name, version, parentRef) {
  if (
    typeof version !== "string" ||
    version.startsWith("link:") ||
    version.startsWith("workspace:")
  ) {
    return;
  }

  const snapshotKey = resolveSnapshotKey(name, version);
  if (!snapshotKey) {
    throw new Error(
      `Unable to resolve production dependency ${name}@${version}`,
    );
  }

  const packageKey = stripDependencyContext(snapshotKey);
  const dependencyRef = packageUrlFromKey(packageKey);
  productionPackageKeys.add(packageKey);

  if (parentRef) {
    const children = dependencyEdges.get(parentRef) ?? new Set();
    children.add(dependencyRef);
    dependencyEdges.set(parentRef, children);
  }

  if (visitedSnapshots.has(snapshotKey)) {
    return;
  }
  visitedSnapshots.add(snapshotKey);

  const snapshot = snapshots[snapshotKey] ?? {};
  for (const section of ["dependencies", "optionalDependencies"]) {
    for (const [childName, childVersion] of Object.entries(
      snapshot[section] ?? {},
    )) {
      visitDependency(childName, getVersion(childVersion), dependencyRef);
    }
  }
}

function resolveSnapshotKey(name, version) {
  const exactKey = `${name}@${version}`;
  if (snapshots[exactKey]) {
    return exactKey;
  }

  const packageKey = stripDependencyContext(exactKey);
  const candidates = snapshotKeysByPackage.get(packageKey) ?? [];
  if (candidates.length === 1) {
    return candidates[0];
  }

  return candidates.find((candidate) => candidate.startsWith(exactKey));
}

function createComponent(packageKey) {
  const { name, version } = splitPackageKey(packageKey);
  const packageMetadata = packages[packageKey] ?? {};
  const component = {
    type: "library",
    "bom-ref": packageUrl(name, version),
    group: name.startsWith("@") ? name.slice(1).split("/", 1)[0] : undefined,
    name: name.startsWith("@") ? name.split("/").slice(1).join("/") : name,
    version,
    scope: "required",
    purl: packageUrl(name, version),
  };
  const hash = sriHash(packageMetadata.resolution?.integrity);

  if (hash) {
    component.hashes = [hash];
  }

  return Object.fromEntries(
    Object.entries(component).filter(([, value]) => value !== undefined),
  );
}

function sriHash(integrity) {
  if (typeof integrity !== "string") {
    return undefined;
  }

  const separator = integrity.indexOf("-");
  const algorithm = integrity.slice(0, separator).toLowerCase();
  const encoded = integrity.slice(separator + 1);
  const algorithmNames = {
    sha256: "SHA-256",
    sha384: "SHA-384",
    sha512: "SHA-512",
  };

  if (!algorithmNames[algorithm] || !encoded) {
    return undefined;
  }

  return {
    alg: algorithmNames[algorithm],
    content: Buffer.from(encoded, "base64").toString("hex"),
  };
}

function packageUrlFromKey(packageKey) {
  const { name, version } = splitPackageKey(packageKey);
  return packageUrl(name, version);
}

function packageUrl(name, version) {
  if (name.startsWith("@")) {
    const [scope, ...packageName] = name.slice(1).split("/");
    return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(
      packageName.join("/"),
    )}@${encodeURIComponent(version)}`;
  }

  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function splitPackageKey(packageKey) {
  const separator = packageKey.lastIndexOf("@");
  if (separator <= 0 || separator === packageKey.length - 1) {
    throw new Error(`Unsupported pnpm package key: ${packageKey}`);
  }

  return {
    name: packageKey.slice(0, separator),
    version: packageKey.slice(separator + 1),
  };
}

function stripDependencyContext(snapshotKey) {
  const contextStart = snapshotKey.indexOf("(");
  return contextStart === -1 ? snapshotKey : snapshotKey.slice(0, contextStart);
}

function getVersion(dependency) {
  return typeof dependency === "string" ? dependency : dependency?.version;
}
