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
  randomUUID,
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
import {
  CATALOG_FRESHNESS_V3_SCHEMA_VERSION,
  CATALOG_RESOLUTION_TICKET_SCHEMA_VERSION,
  CatalogFreshnessProofV3,
  CatalogFreshnessProofV3Unsigned,
  CatalogResolutionTicket,
  CatalogResolutionTicketUnsigned,
} from '../types/mcp-catalog-v3.types';

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

  async issueResolutionTicket(input: {
    clientId: string;
    challenge: string;
    catalogRootPageId: string;
    environment: string;
    authorizationContextSha256: string;
  }): Promise<CatalogResolutionTicket> {
    const clock = await this.reserveChallenge(
      'v3',
      input.clientId,
      input.challenge,
    );
    const ttlSeconds = this.environmentService.getMcpCatalogTicketTtlSeconds();
    const material = this.getSigningMaterial();
    const unsigned: CatalogResolutionTicketUnsigned = {
      schema_version: CATALOG_RESOLUTION_TICKET_SCHEMA_VERSION,
      signature_algorithm: CATALOG_SIGNATURE_ALGORITHM,
      public_key_format: CATALOG_PUBLIC_KEY_FORMAT,
      public_key: material.publicKeyEncoded,
      key_id: material.keyId,
      ticket_id: randomUUID(),
      issued_at: clock.resolutionStartedAt.toISOString(),
      expires_at: new Date(
        clock.resolutionStartedAt.getTime() + ttlSeconds * 1_000,
      ).toISOString(),
      challenge: input.challenge,
      catalog_root_page_id: input.catalogRootPageId,
      environment: input.environment,
      authorization_context_sha256: input.authorizationContextSha256,
    };
    const ticket = this.signValue(
      unsigned,
      material,
    ) as CatalogResolutionTicket;
    const storedValue = this.ticketStorageValue(input.clientId, ticket);
    let accepted: string | null;
    try {
      accepted = await this.redis.set(
        this.ticketRedisKey(ticket.ticket_id),
        storedValue,
        'EX',
        ttlSeconds,
        'NX',
      );
    } catch {
      throw new InternalServerErrorException(
        'Catalog resolution ticket storage is unavailable',
      );
    }
    if (accepted !== 'OK') {
      throw new InternalServerErrorException(
        'Catalog resolution ticket could not be issued',
      );
    }
    return ticket;
  }

  async consumeResolutionTicket(
    clientId: string,
    ticket: CatalogResolutionTicket,
    expected: {
      catalogRootPageId: string;
      environment: string;
      authorizationContextSha256: string;
    },
  ): Promise<CatalogResolutionTicket> {
    if (!this.verifyResolutionTicket(ticket)) {
      throw new BadRequestException('Catalog resolution ticket is invalid');
    }
    const now = Date.now();
    const issuedAt = Date.parse(ticket.issued_at);
    const expiresAt = Date.parse(ticket.expires_at);
    const maxWindowMs =
      this.environmentService.getMcpCatalogMaxResolutionWindowMs();
    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      issuedAt > now + 1_000 ||
      expiresAt <= now ||
      expiresAt <= issuedAt ||
      now - issuedAt > maxWindowMs
    ) {
      throw new BadRequestException(
        'Catalog resolution ticket is expired or outside the trusted window',
      );
    }
    if (
      ticket.catalog_root_page_id !== expected.catalogRootPageId ||
      ticket.environment !== expected.environment ||
      ticket.authorization_context_sha256 !==
        expected.authorizationContextSha256
    ) {
      throw new BadRequestException(
        'Catalog resolution ticket does not match the requested scope',
      );
    }
    let storedValue: string | null;
    try {
      storedValue = await this.redis.getdel(
        this.ticketRedisKey(ticket.ticket_id),
      );
    } catch {
      throw new InternalServerErrorException(
        'Catalog resolution ticket replay protection is unavailable',
      );
    }
    if (storedValue !== this.ticketStorageValue(clientId, ticket)) {
      throw new BadRequestException(
        'Catalog resolution ticket was not issued for this client or was already used',
      );
    }
    return ticket;
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

  signProofV3(
    proof: Omit<
      CatalogFreshnessProofV3Unsigned,
      | 'schema_version'
      | 'signature_algorithm'
      | 'public_key_format'
      | 'public_key'
      | 'key_id'
    >,
  ): CatalogFreshnessProofV3 {
    const material = this.getSigningMaterial();
    const unsigned: CatalogFreshnessProofV3Unsigned = {
      schema_version: CATALOG_FRESHNESS_V3_SCHEMA_VERSION,
      signature_algorithm: CATALOG_SIGNATURE_ALGORITHM,
      public_key_format: CATALOG_PUBLIC_KEY_FORMAT,
      public_key: material.publicKeyEncoded,
      key_id: material.keyId,
      ...proof,
    };
    return this.signValue(unsigned, material) as CatalogFreshnessProofV3;
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

  verifyProofV3(proof: CatalogFreshnessProofV3): boolean {
    return this.verifySignedValue(proof, CATALOG_FRESHNESS_V3_SCHEMA_VERSION);
  }

  verifyResolutionTicket(ticket: CatalogResolutionTicket): boolean {
    return this.verifySignedValue(
      ticket,
      CATALOG_RESOLUTION_TICKET_SCHEMA_VERSION,
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

  private async reserveChallenge(
    version: string,
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
        `docmost:mcp:catalog-challenge:${version}:${challengeHash}`,
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

  private signValue(
    unsigned: Record<string, unknown>,
    material: SigningMaterial,
  ): Record<string, unknown> & { signature: string } {
    const signature = signBytes(
      null,
      Buffer.from(canonicalJson(unsigned), 'utf8'),
      material.privateKey,
    ).toString('base64url');
    return { ...unsigned, signature };
  }

  private verifySignedValue(
    value: Record<string, unknown> & {
      schema_version: string;
      signature_algorithm: string;
      public_key_format: string;
      public_key: string;
      key_id: string;
      signature: string;
    },
    schemaVersion: string,
  ): boolean {
    if (
      value.schema_version !== schemaVersion ||
      value.signature_algorithm !== CATALOG_SIGNATURE_ALGORITHM ||
      value.public_key_format !== CATALOG_PUBLIC_KEY_FORMAT
    ) {
      return false;
    }
    const publicKeyEncoded = this.resolveTrustedPublicKey(value.key_id);
    if (!publicKeyEncoded || publicKeyEncoded !== value.public_key)
      return false;
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(publicKeyEncoded, 'base64url'),
        format: 'der',
        type: 'spki',
      });
      const { signature, ...unsigned } = value;
      return verifyBytes(
        null,
        Buffer.from(canonicalJson(unsigned), 'utf8'),
        publicKey,
        Buffer.from(signature, 'base64url'),
      );
    } catch {
      return false;
    }
  }

  private ticketRedisKey(ticketId: string): string {
    return `docmost:mcp:catalog-ticket:v1:${ticketId}`;
  }

  private ticketStorageValue(
    clientId: string,
    ticket: CatalogResolutionTicket,
  ): string {
    return createHash('sha256')
      .update(clientId, 'utf8')
      .update('\0')
      .update(canonicalJson(ticket), 'utf8')
      .digest('hex');
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
