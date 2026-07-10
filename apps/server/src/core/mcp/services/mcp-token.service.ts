import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
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

@Injectable()
export class McpTokenService {
  private readonly logger = new Logger(McpTokenService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly environmentService: EnvironmentService,
  ) {}

  generateToken(): string {
    return `${MCP_TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString(
      'base64url',
    )}`;
  }

  getTokenLastFour(token: string): string {
    return token.slice(-4);
  }

  hashToken(token: string): string {
    const secret = this.environmentService.getMcpTokenHashSecret();
    if (!secret) {
      throw new InternalServerErrorException(
        'MCP token hash secret is not configured',
      );
    }

    return createHmac('sha256', secret).update(token).digest('hex');
  }

  isTokenHashMatch(token: string, hash: string): boolean {
    const expected = Buffer.from(this.hashToken(token), 'hex');
    const actual = Buffer.from(hash, 'hex');

    if (expected.length !== actual.length) {
      return false;
    }

    return timingSafeEqual(expected, actual);
  }

  async createClient(input: CreateMcpClientInput): Promise<CreatedMcpClient> {
    const token = this.generateToken();
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

    const tokenHash = this.hashToken(token);
    const client = await this.db
      .selectFrom('mcpClients')
      .selectAll()
      .where('tokenHash', '=', tokenHash)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!client || !this.isTokenHashMatch(token, client.tokenHash)) {
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

    await this.touchLastUsed(client.id).catch((err) =>
      this.logger.warn({
        event: 'mcp.token.touch_last_used_failed',
        clientId: client.id,
        errorType: getMcpErrorType(err),
      }),
    );

    return client as McpAuthenticatedClient;
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
