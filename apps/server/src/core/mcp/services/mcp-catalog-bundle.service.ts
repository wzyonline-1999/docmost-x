import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import { validate as isValidUuid } from 'uuid';
import { jsonToMarkdown } from '../../../collaboration/collaboration.util';
import type { JsonObject } from '@docmost/db/types/db';
import {
  CATALOG_BUNDLE_SCHEMA_VERSION,
  CATALOG_DELTA_SCHEMA_VERSION,
  CATALOG_FRESHNESS_SCHEMA_VERSION,
  CATALOG_LIMITS,
  CatalogBundle,
  CatalogBundleInput,
  CatalogDelta,
  CatalogDeltaInput,
  CatalogPage,
  CatalogPageManifestItem,
  CatalogRootSelector,
  QTS_FACT_CATALOG_CONTRACT,
} from '../types/mcp-catalog.types';
import type {
  McpToolContext,
  McpToolDefinition,
} from '../types/mcp-tool.types';
import { CatalogContractRegistry } from './catalog-contract.registry';
import { McpCatalogSnapshotService } from './mcp-catalog-snapshot.service';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ENVIRONMENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type CatalogPageCandidate = {
  page: CatalogPage;
  malformed: boolean;
};

@Injectable()
export class McpCatalogBundleService {
  constructor(
    private readonly registry: CatalogContractRegistry,
    private readonly snapshotService: McpCatalogSnapshotService,
  ) {}

  listTools(): McpToolDefinition[] {
    const rootSelectorSchema = {
      oneOf: [
        {
          type: 'object',
          properties: { pageId: { type: 'string', format: 'uuid' } },
          required: ['pageId'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            documentType: { type: 'string', minLength: 1, maxLength: 128 },
            entityId: { type: 'string', minLength: 1, maxLength: 512 },
          },
          required: ['documentType', 'entityId'],
          additionalProperties: false,
        },
      ],
    };
    const commonProperties = {
      contract: { type: 'string', const: QTS_FACT_CATALOG_CONTRACT },
      catalogRootPageId: { type: 'string', format: 'uuid' },
      environment: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        pattern: ENVIRONMENT_PATTERN.source,
      },
      roots: {
        type: 'array',
        minItems: 1,
        maxItems: CATALOG_LIMITS.maxRoots,
        items: rootSelectorSchema,
      },
      challenge: {
        type: 'string',
        minLength: CATALOG_LIMITS.minChallengeBytes,
        maxLength: CATALOG_LIMITS.maxChallengeBytes,
      },
    };

    return [
      {
        name: 'resolve_catalog_bundle',
        description:
          'Resolve a permission-scoped qts-fact-catalog.v1 reference closure from one live, read-only, repeatable-read snapshot.',
        inputSchema: {
          type: 'object',
          properties: commonProperties,
          required: [
            'contract',
            'catalogRootPageId',
            'environment',
            'roots',
            'challenge',
          ],
          additionalProperties: false,
        },
      },
      {
        name: 'resolve_catalog_delta',
        description:
          'Recompute a live Catalog closure and return deterministic changes against a prior page manifest.',
        inputSchema: {
          type: 'object',
          properties: {
            ...commonProperties,
            previous: {
              type: 'object',
              properties: {
                bundleFingerprint: {
                  type: 'string',
                  pattern: SHA256_PATTERN.source,
                },
                pages: {
                  type: 'array',
                  maxItems: CATALOG_LIMITS.maxClosurePages,
                  items: {
                    type: 'object',
                    properties: {
                      pageId: { type: 'string', format: 'uuid' },
                      updatedAt: { type: 'string', format: 'date-time' },
                      contentSha256: {
                        type: 'string',
                        pattern: SHA256_PATTERN.source,
                      },
                    },
                    required: ['pageId', 'updatedAt', 'contentSha256'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['bundleFingerprint', 'pages'],
              additionalProperties: false,
            },
          },
          required: [
            'contract',
            'catalogRootPageId',
            'environment',
            'roots',
            'challenge',
            'previous',
          ],
          additionalProperties: false,
        },
      },
    ];
  }

  isCatalogTool(name: string): boolean {
    return (
      name === 'resolve_catalog_bundle' || name === 'resolve_catalog_delta'
    );
  }

  async callTool(
    name: string,
    args: JsonObject,
    context: McpToolContext,
  ): Promise<CatalogBundle | CatalogDelta> {
    if (name === 'resolve_catalog_bundle') {
      return this.resolveBundle(this.parseBundleInput(args), context);
    }
    if (name === 'resolve_catalog_delta') {
      return this.resolveDelta(this.parseDeltaInput(args), context);
    }
    throw new BadRequestException(`Unsupported Catalog tool: ${name}`);
  }

  summarize(result: CatalogBundle | CatalogDelta): string {
    if (result.schema_version === CATALOG_DELTA_SCHEMA_VERSION) {
      return [
        `Catalog delta ${result.bundle_fingerprint}`,
        `${result.current_page_manifest.length} pages`,
        `${result.changes.added.length} added`,
        `${result.changes.updated.length} updated`,
        `${result.changes.removed.length} removed`,
        result.closure_complete ? 'closure complete' : 'closure incomplete',
      ].join('; ');
    }
    return [
      `Catalog bundle ${result.bundle_fingerprint}`,
      `${result.pages.length} pages`,
      `${result.edges.length} edges`,
      result.closure_complete ? 'closure complete' : 'closure incomplete',
    ].join('; ');
  }

  private async resolveBundle(
    input: CatalogBundleInput,
    context: McpToolContext,
  ): Promise<CatalogBundle> {
    const snapshot = await this.snapshotService.capture(
      input.catalogRootPageId,
      context.client,
    );
    const candidates = snapshot.pages.map((page) =>
      this.toCatalogPageCandidate(page),
    );
    const graph = this.registry.buildBundleGraph({
      pages: candidates.map((candidate) => candidate.page),
      roots: input.roots,
      environment: input.environment,
      malformedPageIds: new Set(
        candidates
          .filter((candidate) => candidate.malformed)
          .map((candidate) => candidate.page.page_id),
      ),
    });

    if (graph.pages.length > CATALOG_LIMITS.maxClosurePages) {
      throw new PayloadTooLargeException(
        `Catalog closure exceeds ${CATALOG_LIMITS.maxClosurePages} pages`,
      );
    }
    if (graph.edges.length > CATALOG_LIMITS.maxEdges) {
      throw new PayloadTooLargeException(
        `Catalog closure exceeds ${CATALOG_LIMITS.maxEdges} edges`,
      );
    }

    const manifest = this.pageManifest(graph.pages);
    const bundleFingerprint = this.registry.computeBundleFingerprint({
      catalogRootPageId: snapshot.catalogRoot.id,
      environment: input.environment,
      roots: graph.roots,
      pages: manifest,
      edges: graph.edges,
      unresolvedReferences: graph.unresolvedReferences,
    });
    const closureComplete =
      graph.roots.every((root) => root.status === 'resolved') &&
      graph.unresolvedReferences.length === 0;

    const bundle: CatalogBundle = {
      schema_version: CATALOG_BUNDLE_SCHEMA_VERSION,
      contract: QTS_FACT_CATALOG_CONTRACT,
      catalog_root: {
        page_id: snapshot.catalogRoot.id,
        title: snapshot.catalogRoot.title,
        space_id: snapshot.catalogRoot.spaceId,
        updated_at: snapshot.catalogRoot.updatedAt.toISOString(),
      },
      environment: input.environment,
      roots: graph.roots,
      pages: graph.pages,
      edges: graph.edges,
      unresolved_references: graph.unresolvedReferences,
      closure_complete: closureComplete,
      bundle_fingerprint: bundleFingerprint,
      freshness_proof: {
        schema_version: CATALOG_FRESHNESS_SCHEMA_VERSION,
        challenge: input.challenge,
        verified_at: snapshot.snapshotAt.toISOString(),
        isolation: 'repeatable_read',
        read_only: true,
        page_manifest: manifest,
        bundle_fingerprint: bundleFingerprint,
      },
    };
    this.assertResponseSize(bundle);
    return bundle;
  }

  private async resolveDelta(
    input: CatalogDeltaInput,
    context: McpToolContext,
  ): Promise<CatalogDelta> {
    const bundle = await this.resolveBundle(input, context);
    const previousById = new Map(
      input.previous.pages.map((page) => [
        page.pageId,
        {
          page_id: page.pageId,
          updated_at: page.updatedAt,
          content_sha256: page.contentSha256,
        } satisfies CatalogPageManifestItem,
      ]),
    );
    if (previousById.size !== input.previous.pages.length) {
      throw new BadRequestException(
        'previous.pages contains duplicate pageId values',
      );
    }

    const added: CatalogPage[] = [];
    const updated: CatalogDelta['changes']['updated'] = [];
    const unchanged: CatalogPageManifestItem[] = [];
    for (const page of bundle.pages) {
      const previous = previousById.get(page.page_id);
      if (!previous) {
        added.push(page);
      } else if (
        previous.updated_at !== page.updated_at ||
        previous.content_sha256 !== page.content_sha256
      ) {
        updated.push({ previous, current: page });
      } else {
        unchanged.push(previous);
      }
      previousById.delete(page.page_id);
    }
    const removed = [...previousById.values()].sort((left, right) =>
      compareCanonicalStrings(left.page_id, right.page_id),
    );
    const currentManifest = this.pageManifest(bundle.pages);
    const delta: CatalogDelta = {
      schema_version: CATALOG_DELTA_SCHEMA_VERSION,
      contract: QTS_FACT_CATALOG_CONTRACT,
      previous_bundle_fingerprint: input.previous.bundleFingerprint,
      bundle_fingerprint: bundle.bundle_fingerprint,
      changed:
        input.previous.bundleFingerprint !== bundle.bundle_fingerprint ||
        added.length > 0 ||
        updated.length > 0 ||
        removed.length > 0,
      catalog_root: bundle.catalog_root,
      environment: bundle.environment,
      roots: bundle.roots,
      current_page_manifest: currentManifest,
      edges: bundle.edges,
      unresolved_references: bundle.unresolved_references,
      closure_complete: bundle.closure_complete,
      changes: {
        added,
        updated,
        removed,
        unchanged: unchanged.sort((left, right) =>
          compareCanonicalStrings(left.page_id, right.page_id),
        ),
      },
      freshness_proof: bundle.freshness_proof,
    };
    this.assertResponseSize(delta);
    return delta;
  }

  private parseBundleInput(args: JsonObject): CatalogBundleInput {
    if (args.contract !== QTS_FACT_CATALOG_CONTRACT) {
      throw new BadRequestException(
        `contract must be ${QTS_FACT_CATALOG_CONTRACT}`,
      );
    }
    const catalogRootPageId = this.requireString(args.catalogRootPageId);
    if (!isValidUuid(catalogRootPageId)) {
      throw new BadRequestException('catalogRootPageId must be a valid UUID');
    }
    const environment = this.requireString(args.environment);
    if (!ENVIRONMENT_PATTERN.test(environment)) {
      throw new BadRequestException('environment is invalid');
    }
    const challenge = this.requireString(args.challenge);
    const challengeBytes = Buffer.byteLength(challenge, 'utf8');
    if (
      challengeBytes < CATALOG_LIMITS.minChallengeBytes ||
      challengeBytes > CATALOG_LIMITS.maxChallengeBytes
    ) {
      throw new BadRequestException(
        `challenge must be ${CATALOG_LIMITS.minChallengeBytes}-${CATALOG_LIMITS.maxChallengeBytes} UTF-8 bytes`,
      );
    }
    if (!Array.isArray(args.roots) || args.roots.length === 0) {
      throw new BadRequestException('roots must contain at least one selector');
    }
    if (args.roots.length > CATALOG_LIMITS.maxRoots) {
      throw new BadRequestException(
        `roots supports at most ${CATALOG_LIMITS.maxRoots} selectors`,
      );
    }
    const roots = args.roots.map((root) => this.parseRootSelector(root));
    return {
      contract: QTS_FACT_CATALOG_CONTRACT,
      catalogRootPageId,
      environment,
      roots,
      challenge,
    };
  }

  private parseDeltaInput(args: JsonObject): CatalogDeltaInput {
    const common = this.parseBundleInput(args);
    if (!this.isObject(args.previous)) {
      throw new BadRequestException('previous must be an object');
    }
    const bundleFingerprint = this.requireString(
      args.previous.bundleFingerprint,
    );
    if (!SHA256_PATTERN.test(bundleFingerprint)) {
      throw new BadRequestException('previous.bundleFingerprint is invalid');
    }
    if (!Array.isArray(args.previous.pages)) {
      throw new BadRequestException('previous.pages must be an array');
    }
    if (args.previous.pages.length > CATALOG_LIMITS.maxClosurePages) {
      throw new BadRequestException(
        `previous.pages supports at most ${CATALOG_LIMITS.maxClosurePages} pages`,
      );
    }
    const pages = args.previous.pages.map((page) => {
      if (!this.isObject(page)) {
        throw new BadRequestException('previous.pages items must be objects');
      }
      const pageId = this.requireString(page.pageId);
      const updatedAt = this.requireIsoTimestamp(page.updatedAt);
      const contentSha256 = this.requireString(page.contentSha256);
      if (!isValidUuid(pageId) || !SHA256_PATTERN.test(contentSha256)) {
        throw new BadRequestException(
          'previous.pages contains an invalid item',
        );
      }
      return { pageId, updatedAt, contentSha256 };
    });
    if (new Set(pages.map((page) => page.pageId)).size !== pages.length) {
      throw new BadRequestException(
        'previous.pages contains duplicate pageId values',
      );
    }
    return {
      ...common,
      previous: { bundleFingerprint, pages },
    };
  }

  private parseRootSelector(value: unknown): CatalogRootSelector {
    if (!this.isObject(value)) {
      throw new BadRequestException('roots items must be objects');
    }
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.pageId === 'string') {
      if (!isValidUuid(value.pageId)) {
        throw new BadRequestException('roots.pageId must be a valid UUID');
      }
      return { pageId: value.pageId };
    }
    if (
      keys.length === 2 &&
      typeof value.documentType === 'string' &&
      typeof value.entityId === 'string'
    ) {
      const documentType = this.requireCanonicalString(
        value.documentType,
        'roots.documentType',
        128,
      );
      const entityId = this.requireCanonicalString(
        value.entityId,
        'roots.entityId',
        512,
      );
      return { documentType, entityId };
    }
    throw new BadRequestException(
      'Each roots item must contain pageId or documentType and entityId',
    );
  }

  private toCatalogPageCandidate(page: {
    id: string;
    title: string | null;
    parentPageId: string | null;
    spaceId: string;
    updatedAt: Date;
    content: unknown;
  }): CatalogPageCandidate {
    let markdown = '';
    let frontMatter: JsonObject = {};
    let malformed = false;
    try {
      markdown = page.content ? jsonToMarkdown(page.content) : '';
      markdown = markdown.replace(/\r\n?/g, '\n');
      if (
        Buffer.byteLength(markdown, 'utf8') >
        CATALOG_LIMITS.maxPageMarkdownBytes
      ) {
        throw new PayloadTooLargeException(
          `Catalog page ${page.id} exceeds ${CATALOG_LIMITS.maxPageMarkdownBytes} Markdown bytes`,
        );
      }
      frontMatter = this.registry.parseFrontMatter(markdown) ?? {};
    } catch (error) {
      if (error instanceof PayloadTooLargeException) throw error;
      frontMatter = {};
      malformed = true;
    }
    return {
      malformed,
      page: {
        page_id: page.id,
        title: page.title,
        parent_page_id: page.parentPageId,
        space_id: page.spaceId,
        updated_at: page.updatedAt.toISOString(),
        content_sha256: this.registry.sha256(markdown),
        front_matter: frontMatter,
        markdown,
      },
    };
  }

  private pageManifest(pages: CatalogPage[]): CatalogPageManifestItem[] {
    return pages
      .map((page) => ({
        page_id: page.page_id,
        updated_at: page.updated_at,
        content_sha256: page.content_sha256,
      }))
      .sort((left, right) =>
        compareCanonicalStrings(left.page_id, right.page_id),
      );
  }

  private assertResponseSize(value: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (bytes > CATALOG_LIMITS.maxResponseBytes) {
      throw new PayloadTooLargeException(
        `Catalog response exceeds ${CATALOG_LIMITS.maxResponseBytes} bytes`,
      );
    }
  }

  private requireCanonicalString(
    value: unknown,
    name: string,
    maxLength: number,
  ): string {
    const result = this.requireString(value);
    if (result !== result.trim() || result.length > maxLength) {
      throw new BadRequestException(`${name} must be a canonical string`);
    }
    return result;
  }

  private requireString(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new BadRequestException('A required string is missing');
    }
    return value;
  }

  private requireIsoTimestamp(value: unknown): string {
    const timestamp = this.requireString(value);
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
      throw new BadRequestException(
        'updatedAt must be a canonical ISO timestamp',
      );
    }
    return timestamp;
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}
