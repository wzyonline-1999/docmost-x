export function formatPgVector(embedding: number[]): string {
  return `[${embedding.map((value) => formatPgVectorValue(value)).join(',')}]`;
}

function formatPgVectorValue(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error('Embedding contains a non-finite value');
  }

  return Number(value).toPrecision(12);
}
