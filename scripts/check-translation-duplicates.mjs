import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getNodeValue, parseTree, printParseErrorCode } from "jsonc-parser";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const localesDir = path.join(rootDir, "apps", "client", "public", "locales");

const localeNames = (await readdir(localesDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const failures = [];

for (const localeName of localeNames.sort()) {
  const filePath = path.join(localesDir, localeName, "translation.json");
  const source = await readFile(filePath, "utf8");
  const parseErrors = [];
  const root = parseTree(source, parseErrors, {
    allowTrailingComma: false,
    disallowComments: true,
  });

  for (const error of parseErrors) {
    failures.push(
      `${path.relative(rootDir, filePath)}:${lineAt(source, error.offset)} ` +
        printParseErrorCode(error.error),
    );
  }

  if (root) {
    findDuplicateKeys(root, source, filePath);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Translation JSON check passed for ${localeNames.length} locales.\n`,
  );
}

function findDuplicateKeys(node, source, filePath, objectPath = []) {
  if (node.type === "object") {
    const seen = new Map();
    for (const property of node.children ?? []) {
      const [keyNode, valueNode] = property.children ?? [];
      if (!keyNode || !valueNode) continue;

      const key = String(getNodeValue(keyNode));
      const previous = seen.get(key);
      if (previous) {
        const scope = objectPath.length > 0 ? objectPath.join(".") : "<root>";
        failures.push(
          `${path.relative(rootDir, filePath)}:${lineAt(source, keyNode.offset)} ` +
            `duplicate key ${JSON.stringify(key)} in ${scope}; first declared ` +
            `on line ${lineAt(source, previous.offset)}`,
        );
      } else {
        seen.set(key, keyNode);
      }

      findDuplicateKeys(valueNode, source, filePath, [...objectPath, key]);
    }
    return;
  }

  for (const child of node.children ?? []) {
    findDuplicateKeys(child, source, filePath, objectPath);
  }
}

function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}
