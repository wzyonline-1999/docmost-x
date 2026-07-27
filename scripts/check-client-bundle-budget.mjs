import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";

const KiB = 1024;
const budgets = {
  initialJavaScript: {
    gzip: 450 * KiB,
    brotli: 380 * KiB,
  },
  initialCss: {
    gzip: 45 * KiB,
    brotli: 36 * KiB,
  },
  largestJavaScriptChunk: {
    gzip: 800 * KiB,
    brotli: 660 * KiB,
  },
};

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distDir = path.join(rootDir, "apps", "client", "dist");
const assetsDir = path.join(distDir, "assets");
const indexHtml = await readFile(path.join(distDir, "index.html"), "utf8");
const initialAssets = [...indexHtml.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
  .map((match) => match[1].split(/[?#]/, 1)[0])
  .filter((assetPath) => assetPath.startsWith("/assets/"))
  .map((assetPath) => assetPath.slice(1));

const initialJavaScript = await summarize(
  initialAssets.filter((assetPath) => assetPath.endsWith(".js")),
);
const initialCss = await summarize(
  initialAssets.filter((assetPath) => assetPath.endsWith(".css")),
);
const javaScriptChunks = (await readdir(assetsDir))
  .filter((fileName) => fileName.endsWith(".js"))
  .map((fileName) => path.posix.join("assets", fileName));
const chunkSizes = await Promise.all(
  javaScriptChunks.map(async (assetPath) => ({
    assetPath,
    ...(await compressedSize(assetPath)),
  })),
);
const largestJavaScriptChunk = chunkSizes.reduce((largest, current) =>
  current.gzip > largest.gzip ? current : largest,
);

const checks = [
  {
    label: "Initial JavaScript",
    actual: initialJavaScript,
    budget: budgets.initialJavaScript,
  },
  {
    label: "Initial CSS",
    actual: initialCss,
    budget: budgets.initialCss,
  },
  {
    label: `Largest JavaScript chunk (${largestJavaScriptChunk.assetPath})`,
    actual: largestJavaScriptChunk,
    budget: budgets.largestJavaScriptChunk,
  },
];
const failures = [];

for (const check of checks) {
  process.stdout.write(
    `${check.label}: ${format(check.actual.gzip)} gzip, ` +
      `${format(check.actual.brotli)} brotli\n`,
  );

  for (const algorithm of ["gzip", "brotli"]) {
    if (check.actual[algorithm] > check.budget[algorithm]) {
      failures.push(
        `${check.label} ${algorithm} size ${format(check.actual[algorithm])} ` +
          `exceeds ${format(check.budget[algorithm])}`,
      );
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`Bundle budget failed:\n- ${failures.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Client bundle budget passed.\n");
}

async function summarize(assetPaths) {
  if (assetPaths.length === 0) {
    throw new Error("No matching initial assets were found in index.html");
  }

  const sizes = await Promise.all(assetPaths.map(compressedSize));
  return sizes.reduce(
    (total, current) => ({
      gzip: total.gzip + current.gzip,
      brotli: total.brotli + current.brotli,
    }),
    { gzip: 0, brotli: 0 },
  );
}

async function compressedSize(assetPath) {
  const absolutePath = path.resolve(distDir, assetPath);
  if (!absolutePath.startsWith(`${distDir}${path.sep}`)) {
    throw new Error(
      `Asset path escapes the client dist directory: ${assetPath}`,
    );
  }

  const source = await readFile(absolutePath);
  return {
    gzip: gzipSync(source, { level: 9 }).byteLength,
    brotli: brotliCompressSync(source, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      },
    }).byteLength,
  };
}

function format(bytes) {
  return `${(bytes / KiB).toFixed(1)} KiB`;
}
