import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from 'crypto';
import type { Redis } from 'ioredis';
import { performance } from 'perf_hooks';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  CATALOG_FRESHNESS_V2_SCHEMA_VERSION,
  CATALOG_PUBLIC_KEY_FORMAT,
  CATALOG_SIGNATURE_ALGORITHM,
  CatalogFreshnessProofV2,
  CatalogFreshnessProofV2Unsigned,
} from '../types/mcp-catalog-v2.types';

const ED25519_PKCS8_SEED_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type CatalogResolutionClock = {
  resolutionStartedAt: Date;
  monotonicStartedAt: number;
};

type SigningMaterial = {
  keyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyEncoded: string;
};

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new InternalServerErrorException(
        'Catalog proof contains a non-JSON value',
      );
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key])}`)
    .join(',')}}`;
}

@Injectable()
export class McpCatalogProofService {
  private readonly redis: Redis;
  private signingMaterial?: SigningMaterial;

  constructor(
    private readonly environmentService: EnvironmentService,
    redisService: RedisService,
  ) {
    this.redis = redisService.getOrThrow();
  }

  async beginResolution(
    clientId: string,
    challenge: string,
  ): Promise<CatalogResolutionClock> {
    const challengeHash = createHash('sha256')
      .update(clientId, 'utf8')
      .update('\0')
      .update(challenge, 'utf8')
      .digest('hex');
    let accepted: string | null;
    try {
      accepted = await this.redis.set(
        `docmost:mcp:catalog-challenge:v2:${challengeHash}`,
        '1',
        'EX',
        this.environmentService.getMcpCatalogChallengeTtlSeconds(),
        'NX',
      );
    } catch {
      throw new InternalServerErrorException(
        'Catalog challenge replay protection is unavailable',
      );
    }
    if (accepted !== 'OK') {
      throw new BadRequestException('Catalog challenge has already been used');
    }
    return {
      resolutionStartedAt: new Date(),
      monotonicStartedAt: performance.now(),
    };
  }

  signProof(
    proof: Omit<
      CatalogFreshnessProofV2Unsigned,
      | 'schema_version'
      | 'signature_algorithm'
      | 'public_key_format'
      | 'public_key'
      | 'key_id'
    >,
  ): CatalogFreshnessProofV2 {
    const material = this.getSigningMaterial();
    const unsigned: CatalogFreshnessProofV2Unsigned = {
      schema_version: CATALOG_FRESHNESS_V2_SCHEMA_VERSION,
      signature_algorithm: CATALOG_SIGNATURE_ALGORITHM,
      public_key_format: CATALOG_PUBLIC_KEY_FORMAT,
      public_key: material.publicKeyEncoded,
      key_id: material.keyId,
      ...proof,
    };
    const signature = signBytes(
      null,
      Buffer.from(canonicalJson(unsigned), 'utf8'),
      material.privateKey,
    ).toString('base64url');
    return { ...unsigned, signature };
  }

  verifyProof(proof: CatalogFreshnessProofV2): boolean {
    if (
      proof.schema_version !== CATALOG_FRESHNESS_V2_SCHEMA_VERSION ||
      proof.signature_algorithm !== CATALOG_SIGNATURE_ALGORITHM ||
      proof.public_key_format !== CATALOG_PUBLIC_KEY_FORMAT
    ) {
      return false;
    }
    const publicKeyEncoded = this.resolveTrustedPublicKey(proof.key_id);
    if (!publicKeyEncoded || publicKeyEncoded !== proof.public_key) {
      return false;
    }
    let publicKey: KeyObject;
    let signature: Buffer;
    try {
      publicKey = createPublicKey({
        key: Buffer.from(publicKeyEncoded, 'base64url'),
        format: 'der',
        type: 'spki',
      });
      signature = Buffer.from(proof.signature, 'base64url');
    } catch {
      return false;
    }
    const { signature: _signature, ...unsigned } = proof;
    return verifyBytes(
      null,
      Buffer.from(canonicalJson(unsigned), 'utf8'),
      publicKey,
      signature,
    );
  }

  elapsedMilliseconds(clock: CatalogResolutionClock): number {
    return Math.max(
      0,
      Math.round(performance.now() - clock.monotonicStartedAt),
    );
  }

  private getSigningMaterial(): SigningMaterial {
    if (this.signingMaterial) return this.signingMaterial;
    const secret = this.environmentService.getMcpCatalogSigningSecret();
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new InternalServerErrorException(
        'Catalog signing secret must contain at least 32 UTF-8 bytes',
      );
    }
    const seed = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(secret, 'utf8'),
        Buffer.from('docmost-mcp-catalog', 'utf8'),
        Buffer.from('catalog-freshness-proof.v2/ed25519', 'utf8'),
        32,
      ),
    );
    const privateKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8',
    });
    const publicKey = createPublicKey(privateKey);
    const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
    const publicKeyEncoded = Buffer.from(publicKeyDer).toString('base64url');
    const configuredKeyId = this.environmentService.getMcpCatalogSigningKeyId();
    if (configuredKeyId && !KEY_ID_PATTERN.test(configuredKeyId)) {
      throw new InternalServerErrorException(
        'Catalog signing key ID is invalid',
      );
    }
    const keyId =
      configuredKeyId ??
      `catalog-ed25519-${createHash('sha256')
        .update(publicKeyDer)
        .digest('hex')
        .slice(0, 16)}`;
    this.signingMaterial = {
      keyId,
      privateKey,
      publicKey,
      publicKeyEncoded,
    };
    return this.signingMaterial;
  }

  private resolveTrustedPublicKey(keyId: string): string | undefined {
    const active = this.getSigningMaterial();
    if (active.keyId === keyId) return active.publicKeyEncoded;
    const raw = this.environmentService.getMcpCatalogPreviousPublicKeys();
    if (!raw) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new InternalServerErrorException(
        'MCP_CATALOG_PREVIOUS_PUBLIC_KEYS must be valid JSON',
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InternalServerErrorException(
        'MCP_CATALOG_PREVIOUS_PUBLIC_KEYS must be a JSON object',
      );
    }
    const value = (parsed as Record<string, unknown>)[keyId];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
