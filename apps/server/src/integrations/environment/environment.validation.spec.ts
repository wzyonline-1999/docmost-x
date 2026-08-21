import { getEnvironmentValidationMessages } from './environment.validation';
import { generateKeyPairSync } from 'crypto';

const baseEnvironment = {
  DATABASE_URL: 'postgresql://docmost:password@127.0.0.1:5432/docmost',
  REDIS_URL: 'redis://127.0.0.1:6379',
  APP_SECRET: 'test-app-secret-that-is-at-least-32-characters',
};

describe('environment validation', () => {
  it('allows vector search without exposing the MCP transport', () => {
    expect(
      getEnvironmentValidationMessages({
        ...baseEnvironment,
        MCP_ENABLED: 'false',
        VECTOR_SEARCH_ENABLED: 'true',
        EMBEDDING_BASE_URL: 'https://embedding.example.test/v1',
        EMBEDDING_API_KEY: 'embedding-test-key',
      }),
    ).toEqual([]);
  });

  it('requires the embedding provider whenever vector search is enabled', () => {
    const messages = getEnvironmentValidationMessages({
      ...baseEnvironment,
      MCP_ENABLED: 'false',
      VECTOR_SEARCH_ENABLED: 'true',
    });

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('EMBEDDING_BASE_URL'),
        expect.stringContaining('EMBEDDING_API_KEY'),
      ]),
    );
  });

  it('allows MCP request limiting to be disabled explicitly', () => {
    expect(
      getEnvironmentValidationMessages({
        ...baseEnvironment,
        MCP_RATE_LIMIT_MAX_REQUESTS: '0',
      }),
    ).toEqual([]);
  });

  it('accepts a valid Catalog signing-key rotation configuration', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const encoded = publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64url');

    expect(
      getEnvironmentValidationMessages({
        ...baseEnvironment,
        MCP_CATALOG_SIGNING_SECRET:
          'dedicated-catalog-signing-secret-at-least-32-bytes',
        MCP_CATALOG_SIGNING_KEY_ID: 'catalog-ed25519-2026-08',
        MCP_CATALOG_PREVIOUS_PUBLIC_KEYS: JSON.stringify({
          'catalog-ed25519-2026-07': encoded,
        }),
        MCP_CATALOG_CHALLENGE_TTL_SECONDS: '86400',
        MCP_CATALOG_TICKET_TTL_SECONDS: '120',
        MCP_CATALOG_MAX_RESOLUTION_WINDOW_MS: '120000',
      }),
    ).toEqual([]);
  });

  it.each([
    ['MCP_CATALOG_SIGNING_SECRET', 'too-short'],
    ['MCP_CATALOG_CHALLENGE_TTL_SECONDS', '59'],
    ['MCP_CATALOG_CHALLENGE_TTL_SECONDS', '2592001'],
    ['MCP_CATALOG_TICKET_TTL_SECONDS', '9'],
    ['MCP_CATALOG_MAX_RESOLUTION_WINDOW_MS', '9999'],
    ['MCP_CATALOG_SIGNING_KEY_ID', 'invalid key id'],
    ['MCP_CATALOG_PREVIOUS_PUBLIC_KEYS', '{not-json'],
    ['MCP_CATALOG_PREVIOUS_PUBLIC_KEYS', '{"old-key":"not-a-key"}'],
  ])('rejects invalid Catalog setting %s=%s', (name, value) => {
    const messages = getEnvironmentValidationMessages({
      ...baseEnvironment,
      [name]: value,
    });

    expect(messages.some((message) => message.includes(name))).toBe(true);
  });

  it.each([
    ['MCP_MAX_BATCH_SIZE', '0'],
    ['MCP_READ_AUDIT_SAMPLE_RATE', '1.1'],
    ['EMBEDDING_BATCH_SIZE', '257'],
    ['EMBEDDING_TIMEOUT_MS', '0'],
    ['VECTOR_ANN_CANDIDATE_MULTIPLIER', '1'],
    ['VECTOR_SEARCH_RATE_LIMIT_MAX_REQUESTS', '0'],
  ])('rejects out-of-range %s values', (name, value) => {
    const messages = getEnvironmentValidationMessages({
      ...baseEnvironment,
      [name]: value,
    });

    expect(messages.some((message) => message.includes(name))).toBe(true);
  });

  it('rejects unsafe vector chunk and hybrid weight combinations', () => {
    const messages = getEnvironmentValidationMessages({
      ...baseEnvironment,
      VECTOR_CHUNK_MAX_CHARS: '1000',
      VECTOR_CHUNK_OVERLAP_CHARS: '1000',
      VECTOR_HYBRID_SEMANTIC_WEIGHT: '0',
      VECTOR_HYBRID_KEYWORD_WEIGHT: '0',
      VECTOR_HYBRID_RECENCY_WEIGHT: '0',
    });

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('VECTOR_CHUNK_OVERLAP_CHARS'),
        expect.stringContaining('VECTOR_HYBRID_*_WEIGHT'),
      ]),
    );
  });
});
