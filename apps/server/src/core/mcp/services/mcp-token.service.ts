import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { InjectKysely } from 'nestjs-kysely';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { Redis } from 'ioredis';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { McpClient, UpdatableMcpClient } from '@docmost/db/types/entity.types';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  CreateMcpClientInput,
  CreatedMcpClient,
  McpAuthenticatedClient,
} from '../types/mcp.types';
import { getMcpErrorType } from '../utils/mcp-error.util';

const MCP_TOKEN_PREFIX = 'dmost_mcp_';
const TOKEN_RANDOM_BYTES = 32;
const LAST_USED_THROTTLE_SECONDS = 60;

@Injectable()
export class McpTokenService {
  private readonly logger = new Logger(McpTokenService.name);
  private readonly redis: Redis;

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly environmentService: EnvironmentService,
    redisService: RedisService,
  ) {
    this.redis = redisService.getOrThrow();
  }

  generateToken(): string {
    return `${MCP_TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString(
      'base64url',
    )}`;
  }

  getTokenLastFour(token: string): string {
    return token.slice(-4);
  }

  hashToken(token: string, secret?: string): string {
    const resolvedSecret =
      secret ?? this.environmentService.getMcpTokenHashSecret();
    if (!resolvedSecret) {
      throw new InternalServerErrorException(
        'MCP token hash secret is not configured',
      );
    }

    return createHmac('sha256', resolvedSecret).update(token).digest('hex');
  }

  isTokenHashMatch(token: string, hash: string, secret?: string): boolean {
    const expected = Buffer.from(this.hashToken(token, secret), 'hex');
    const actual = Buffer.from(hash, 'hex');

    if (expected.length !== actual.length) {
      return false;
    }

    return timingSafeEqual(expected, actual);
  }

  async createClient(input: CreateMcpClientInput): Promise<CreatedMcpClient> {
    const token = this.generateToken();
    const scope =
      input.scope ??
      (input.createdById && input.actorUserId === input.createdById
        ? 'personal'
        : 'workspace');
    const ownerUserId =
      scope === 'personal'
        ? (input.ownerUserId ?? input.createdById ?? null)
        : null;
    if (
      scope === 'personal' &&
      (!ownerUserId || input.actorUserId !== ownerUserId)
    ) {
      throw new BadRequestException(
        'Personal MCP clients must act as their owner',
      );
    }
    const client = await this.db
      .insertInto('mcpClients')
      .values({
        workspaceId: input.workspaceId,
        name: input.name,
        tokenHash: this.hashToken(token),
        tokenLastFour: this.getTokenLastFour(token),
        status: 'active',
        globalScopes: input.globalScopes ?? {},
        actorUserId: input.actorUserId ?? null,
        createdById: input.createdById ?? null,
        ownerUserId,
        scope,
        expiresAt: input.expiresAt ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { client, token };
  }

  async authenticateToken(token: string): Promise<McpAuthenticatedClient> {
    if (!this.environmentService.isMcpEnabled()) {
      throw new ForbiddenException('MCP is disabled');
    }

    if (!token || !token.startsWith(MCP_TOKEN_PREFIX)) {
      throw new UnauthorizedException('Invalid MCP token');
    }

    const currentTokenHash = this.hashToken(token);
    const previousSecret =
      this.environmentService.getMcpTokenHashPreviousSecret();
    const candidateHashes = [
      currentTokenHash,
      ...(previousSecret ? [this.hashToken(token, previousSecret)] : []),
    ];
    const client = await this.db
      .selectFrom('mcpClients')
      .selectAll()
      .where('tokenHash', 'in', candidateHashes)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    const matchingSecret =
      client &&
      (this.isTokenHashMatch(token, client.tokenHash)
        ? this.environmentService.getMcpTokenHashSecret()
        : previousSecret &&
            this.isTokenHashMatch(token, client.tokenHash, previousSecret)
          ? previousSecret
          : null);
    if (!client || !matchingSecret) {
      throw new UnauthorizedException('Invalid MCP token');
    }

    if (client.status === 'disabled') {
      throw new ForbiddenException('MCP token is disabled');
    }

    if (client.status === 'expired') {
      throw new UnauthorizedException('MCP token expired');
    }

    if (client.expiresAt && new Date(client.expiresAt) <= new Date()) {
      await this.markExpired(client).catch((err) =>
        this.logger.warn({
          event: 'mcp.token.mark_expired_failed',
          clientId: client.id,
          errorType: getMcpErrorType(err),
        }),
      );
      throw new UnauthorizedException('MCP token expired');
    }

    if (client.tokenHash !== currentTokenHash) {
      await this.rehashClientToken(client, currentTokenHash);
      client.tokenHash = currentTokenHash;
    }

    return client as McpAuthenticatedClient;
  }

  async recordSuccessfulUse(clientId: string): Promise<void> {
    const throttleKey = `docmost:mcp:last-used:${clientId}`;
    let acquired: string | null;
    try {
      acquired = await this.redis.set(
        throttleKey,
        '1',
        'EX',
        LAST_USED_THROTTLE_SECONDS,
        'NX',
      );
    } catch (err) {
      this.logger.warn({
        event: 'mcp.token.last_used_throttle_failed',
        clientId,
        errorType: getMcpErrorType(err),
      });
      return;
    }
    if (acquired !== 'OK') {
      return;
    }

    await this.touchLastUsed(clientId).catch(async (err) => {
      await this.redis.del(throttleKey).catch(() => undefined);
      this.logger.warn({
        event: 'mcp.token.touch_last_used_failed',
        clientId,
        errorType: getMcpErrorType(err),
      });
    });
  }

  async disableClient(clientId: string, workspaceId: string): Promise<void> {
    await this.updateClient(clientId, workspaceId, { status: 'disabled' });
  }

  private async markExpired(client: McpClient): Promise<void> {
    await this.updateClient(client.id, client.workspaceId, {
      status: 'expired',
    });
  }

  private async touchLastUsed(clientId: string): Promise<void> {
    await this.db
      .updateTable('mcpClients')
      .set({
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where('id', '=', clientId)
      .execute();
  }

  private async rehashClientToken(
    client: McpClient,
    tokenHash: string,
  ): Promise<void> {
    await this.db
      .updateTable('mcpClients')
      .set({ tokenHash, updatedAt: new Date() })
      .where('id', '=', client.id)
      .where('workspaceId', '=', client.workspaceId)
      .where('tokenHash', '=', client.tokenHash)
      .where('deletedAt', 'is', null)
      .execute();
  }

  private async updateClient(
    clientId: string,
    workspaceId: string,
    patch: UpdatableMcpClient,
  ): Promise<void> {
    await this.db
      .updateTable('mcpClients')
      .set({ ...patch, updatedAt: new Date() })
      .where('id', '=', clientId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();
  }
}
