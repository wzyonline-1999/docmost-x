import { BadRequestException, Logger } from '@nestjs/common';
import { McpCatalogProofService } from './mcp-catalog-proof.service';

const ROOT_ID = '11111111-1111-4111-8111-111111111111';
const PAGE_ID = '22222222-2222-4222-8222-222222222222';

function environment(
  secret = 'catalog-signing-secret-with-more-than-32-bytes',
  previousPublicKeys?: string,
) {
  return {
    getMcpCatalogSigningSecret: jest.fn(() => secret),
    getMcpCatalogSigningKeyId: jest.fn(() => undefined),
    getMcpCatalogPreviousPublicKeys: jest.fn(() => previousPublicKeys),
    getMcpCatalogChallengeTtlSeconds: jest.fn(() => 86400),
  };
}

function createHarness(
  env = environment(),
  redisSet = jest.fn().mockResolvedValue('OK'),
) {
  const redis = { set: redisSet };
  const service = new McpCatalogProofService(
    env as never,
    {
      getOrThrow: () => redis,
    } as never,
  );
  return { service, redis, env };
}

function proofInput() {
  return {
    challenge: 'diagnosis-unique-0001',
    resolution_started_at: '2026-08-21T00:00:00.000Z',
    verified_at: '2026-08-21T00:00:01.000Z',
    resolution_elapsed_ms: 1000,
    catalog_root_page_id: ROOT_ID,
    environment: 'prod',
    authorization_context_sha256: 'a'.repeat(64),
    requested_roots: [{ page_id: PAGE_ID } as const],
    isolation: 'repeatable_read' as const,
    read_only: true as const,
    page_manifest: [
      {
        page_id: PAGE_ID,
        updated_at: '2026-08-21T00:00:00.000Z',
        content_sha256: 'b'.repeat(64),
      },
    ],
    reference_extractor_version: 'qts-fact-catalog-extractor.v2.0.0' as const,
    bundle_fingerprint: 'c'.repeat(64),
  };
}

describe('McpCatalogProofService', () => {
  it('reports the non-sensitive signing anchor during application startup', () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const { service } = createHarness();

    service.onModuleInit();

    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload).toEqual({
      event: 'mcp.catalog.signing_key.ready',
      signatureAlgorithm: 'ed25519',
      publicKeyFormat: 'spki-der-base64url',
      keyId: expect.stringMatching(/^catalog-ed25519-/),
      publicKey: expect.any(String),
    });
    expect(JSON.stringify(payload)).not.toContain(
      'catalog-signing-secret-with-more-than-32-bytes',
    );
    log.mockRestore();
  });

  it('uses Redis NX replay protection before returning a trusted start clock', async () => {
    const { service, redis } = createHarness();

    const clock = await service.beginResolution(
      'client-1',
      'diagnosis-unique-0001',
    );

    expect(clock.resolutionStartedAt).toBeInstanceOf(Date);
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^docmost:mcp:catalog-challenge:v2:[a-f0-9]{64}$/),
      '1',
      'EX',
      86400,
      'NX',
    );
  });

  it('rejects a reused challenge and fails closed when replay storage is unavailable', async () => {
    const reused = createHarness(
      environment(),
      jest.fn().mockResolvedValue(null),
    ).service;
    await expect(
      reused.beginResolution('client-1', 'diagnosis-unique-0001'),
    ).rejects.toThrow(BadRequestException);

    const unavailable = createHarness(
      environment(),
      jest.fn().mockRejectedValue(new Error('redis down')),
    ).service;
    await expect(
      unavailable.beginResolution('client-1', 'diagnosis-unique-0002'),
    ).rejects.toThrow('replay protection is unavailable');
  });

  it('signs and verifies a canonical Ed25519 freshness proof', () => {
    const { service } = createHarness();
    const proof = service.signProof(proofInput());

    expect(proof).toMatchObject({
      schema_version: 'catalog-freshness-proof.v2',
      signature_algorithm: 'ed25519',
      public_key_format: 'spki-der-base64url',
      challenge: 'diagnosis-unique-0001',
      key_id: expect.stringMatching(/^catalog-ed25519-/),
      signature: expect.any(String),
    });
    expect(service.verifyProof(proof)).toBe(true);
  });

  it.each([
    ['bundle_fingerprint', 'd'.repeat(64)],
    ['challenge', 'diagnosis-tampered-0001'],
    ['resolution_elapsed_ms', 9999],
    ['authorization_context_sha256', 'e'.repeat(64)],
  ] as const)('rejects proof tampering in %s', (field, value) => {
    const { service } = createHarness();
    const proof = service.signProof(proofInput());

    expect(service.verifyProof({ ...proof, [field]: value })).toBe(false);
  });

  it('verifies a rotated proof only while its old public key remains trusted', () => {
    const oldService = createHarness(
      environment('old-catalog-signing-secret-with-more-than-32-bytes'),
    ).service;
    const oldProof = oldService.signProof(proofInput());
    const previousKeys = JSON.stringify({
      [oldProof.key_id]: oldProof.public_key,
    });
    const newService = createHarness(
      environment(
        'new-catalog-signing-secret-with-more-than-32-bytes',
        previousKeys,
      ),
    ).service;

    expect(newService.verifyProof(oldProof)).toBe(true);
    expect(
      createHarness(
        environment('new-catalog-signing-secret-with-more-than-32-bytes'),
      ).service.verifyProof(oldProof),
    ).toBe(false);
  });

  it('derives the same signing identity on independent replicas sharing a secret', () => {
    const first = createHarness().service.signProof(proofInput());
    const second = createHarness().service.signProof(proofInput());

    expect(second.key_id).toBe(first.key_id);
    expect(second.public_key).toBe(first.public_key);
    expect(second.signature).toBe(first.signature);
  });
});
