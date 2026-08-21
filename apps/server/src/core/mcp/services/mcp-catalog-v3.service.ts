import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
  RequestTimeoutException,
} from '@nestjs/common';
import type { JsonObject } from '@docmost/db/types/db';
import { validate as isValidUuid } from 'uuid';
import { jsonToMarkdown } from '../../../collaboration/collaboration.util';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  CATALOG_LIMITS,
  CatalogCapturedPage,
  CatalogRootSelector,
  CatalogRootSelectorOutput,
  QTS_FACT_CATALOG_CONTRACT,
} from '../types/mcp-catalog.types';
import {
  CATALOG_PUBLIC_KEY_FORMAT,
  CATALOG_SIGNATURE_ALGORITHM,
} from '../types/mcp-catalog-v2.types';
import {
  BEGIN_CATALOG_RESOLUTION_TOOL,
  CATALOG_BUNDLE_V3_SCHEMA_VERSION,
  CATALOG_BUNDLE_V3_TOOL,
  CATALOG_DELTA_V3_SCHEMA_VERSION,
  CATALOG_DELTA_V3_TOOL,
  CATALOG_FRESHNESS_V3_SCHEMA_VERSION,
  CATALOG_REFERENCE_EXTRACTOR_V3_VERSION,
  CATALOG_RESOLUTION_TICKET_SCHEMA_VERSION,
  CatalogBundleV3,
  CatalogBundleV3Input,
  CatalogDeltaV3,
  CatalogDeltaV3Input,
  CatalogFreshnessProofV3,
  CatalogPageManifestItemV3,
  CatalogPageV3,
  CatalogResolutionTicket,
  CatalogResolutionTicketInput,
  CatalogRootChangesV3,
} from '../types/mcp-catalog-v3.types';
import type {
  McpToolContext,
  McpToolDefinition,
} from '../types/mcp-tool.types';
import { CatalogV2ContractRegistry } from './catalog-v2-contract.registry';
import { McpCatalogProofService } from './mcp-catalog-proof.service';
import { McpCatalogSnapshotService } from './mcp-catalog-snapshot.service';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ENVIRONMENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type CatalogPageCandidateV3 = {
  page: CatalogPageV3;
  missingYaml: boolean;
  invalidYaml: boolean;
};

@Injectable()
export class McpCatalogV3Service {
  constructor(
    private readonly registry: CatalogV2ContractRegistry,
    private readonly proofService: McpCatalogProofService,
    private readonly snapshotService: McpCatalogSnapshotService,
    private readonly environmentService: EnvironmentService,
  ) {}

  listTools(): McpToolDefinition[] {
    const rootSelectorSchema = this.rootSelectorSchema();
    const ticketProperties = {
      contract: { type: 'string', const: QTS_FACT_CATALOG_CONTRACT },
      catalogRootPageId: { type: 'string', format: 'uuid' },
      environment: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        pattern: ENVIRONMENT_PATTERN.source,
      },
      challenge: {
        type: 'string',
        minLength: CATALOG_LIMITS.minChallengeBytes,
        maxLength: CATALOG_LIMITS.maxChallengeBytes,
      },
    };
    const commonProperties = {
      contract: { type: 'string', const: QTS_FACT_CATALOG_CONTRACT },
      catalogRootPageId: { type: 'string', format: 'uuid' },
      environment: ticketProperties.environment,
      roots: {
        type: 'array',
        minItems: 1,
        maxItems: CATALOG_LIMITS.maxRoots,
        items: rootSelectorSchema,
      },
      ticket: this.resolutionTicketSchema(),
    };
    return [
      {
        name: BEGIN_CATALOG_RESOLUTION_TOOL,
        description:
          'Issue a signed, expiring, one-use server start ticket for one Catalog v3 resolution. The issued_at value proves only when the connector received this call.',
        inputSchema: {
          type: 'object',
          properties: ticketProperties,
          required: [
            'contract',
            'catalogRootPageId',
            'environment',
            'challenge',
          ],
          additionalProperties: false,
        },
      },
      {
        name: CATALOG_BUNDLE_V3_TOOL,
        description:
          'Resolve a permission-scoped qts-fact-catalog.v1 closure using a one-use signed ticket, front-matter-bound catalog-bundle.v3, and a signed freshness proof.',
        inputSchema: {
          type: 'object',
          properties: commonProperties,
          required: [
            'contract',
            'catalogRootPageId',
            'environment',
            'roots',
            'ticket',
          ],
          additionalProperties: false,
        },
      },
      {
        name: CATALOG_DELTA_V3_TOOL,
        description:
          'Revalidate a signed prior catalog-bundle.v3 proof with equal or expanded roots in a fresh ticket-bound snapshot and return catalog-delta.v3.',
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
                  items: this.inputManifestItemSchema(),
                },
                freshnessProof: this.freshnessProofSchema(rootSelectorSchema),
              },
              required: ['bundleFingerprint', 'pages', 'freshnessProof'],
              additionalProperties: false,
            },
          },
          required: [
            'contract',
            'catalogRootPageId',
            'environment',
            'roots',
            'ticket',
            'previous',
          ],
          additionalProperties: false,
        },
      },
    ];
  }

  isCatalogV3Tool(name: string): boolean {
    return (
      name === BEGIN_CATALOG_RESOLUTION_TOOL ||
      name === CATALOG_BUNDLE_V3_TOOL ||
      name === CATALOG_DELTA_V3_TOOL
    );
  }

  async callTool(
    name: string,
    args: JsonObject,
    context: McpToolContext,
  ): Promise<CatalogResolutionTicket | CatalogBundleV3 | CatalogDeltaV3> {
    if (name === BEGIN_CATALOG_RESOLUTION_TOOL) {
      return this.beginResolution(this.parseTicketInput(args), context);
    }
    if (name === CATALOG_BUNDLE_V3_TOOL) {
      return this.resolveBundle(this.parseBundleInput(args), context);
    }
    if (name === CATALOG_DELTA_V3_TOOL) {
      return this.resolveDelta(this.parseDeltaInput(args), context);
    }
    throw new BadRequestException(`Unsupported Catalog v3 tool: ${name}`);
  }

  summarize(
    result: CatalogResolutionTicket | CatalogBundleV3 | CatalogDeltaV3,
  ): string {
    if (result.schema_version === CATALOG_RESOLUTION_TICKET_SCHEMA_VERSION) {
      return `Catalog resolution ticket ${result.ticket_id}; expires ${result.expires_at}`;
    }
    if (result.schema_version === CATALOG_DELTA_V3_SCHEMA_VERSION) {
      return [
        `Catalog delta v3 ${result.bundle_fingerprint}`,
        `${result.current_page_manifest.length} pages`,
        `${result.root_changes.added.length} roots added`,
        `${result.changes.added.length} added`,
        `${result.changes.updated.length} updated`,
        `${result.changes.removed.length} removed`,
        result.closure_complete ? 'closure complete' : 'closure incomplete',
      ].join('; ');
    }
    return [
      `Catalog bundle v3 ${result.bundle_fingerprint}`,
      `${result.pages.length} pages`,
      `${result.edges.length} edges`,
      `${result.known_root_cause_candidates.length} known root cause candidates`,
      result.closure_complete ? 'closure complete' : 'closure incomplete',
    ].join('; ');
  }

  private async beginResolution(
    input: CatalogResolutionTicketInput,
    context: McpToolContext,
  ): Promise<CatalogResolutionTicket> {
    return this.proofService.issueResolutionTicket({
      clientId: context.client.id,
      challenge: input.challenge,
      catalogRootPageId: input.catalogRootPageId,
      environment: input.environment,
      authorizationContextSha256: this.authorizationContextHash(context),
    });
  }

  private async resolveBundle(
    input: CatalogBundleV3Input,
    context: McpToolContext,
  ): Promise<CatalogBundleV3> {
    const ticket = await this.consumeTicket(input, context);
    return this.buildBundle(input, context, ticket);
  }

  private async buildBundle(
    input: CatalogBundleV3Input,
    context: McpToolContext,
    ticket: CatalogResolutionTicket,
  ): Promise<CatalogBundleV3> {
    const snapshot = await this.snapshotService.capture(
      input.catalogRootPageId,
      context.client,
    );
    const fetchedAt = snapshot.snapshotAt.toISOString();
    const candidates = snapshot.pages.map((page) =>
      this.toCatalogPageCandidate(page, fetchedAt),
    );
    const graph = this.registry.buildGraph({
      pages: candidates.map((candidate) => candidate.page),
      roots: input.roots,
      environment: input.environment,
      malformedPageIds: new Set(
        candidates
          .filter((candidate) => candidate.missingYaml || candidate.invalidYaml)
          .map((candidate) => candidate.page.page_id),
      ),
      invalidYamlPageIds: new Set(
        candidates
          .filter((candidate) => candidate.invalidYaml)
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

    const pages = graph.pages as CatalogPageV3[];
    const unresolvedReferences = graph.unresolvedReferences.map((reference) =>
      reference.reason === 'reverse_validation_failed' &&
      reference.relation === 'query_profile_set.fact_source'
        ? {
            ...reference,
            relation: 'query_profile_set.fact_source.reverse_validation',
          }
        : reference,
    );
    const manifest = this.pageManifest(pages);
    const bundleFingerprint = this.computeBundleFingerprint({
      catalogRootPageId: snapshot.catalogRoot.id,
      environment: input.environment,
      roots: graph.roots,
      knownRootCauseCandidates: graph.knownRootCauseCandidates,
      pages: manifest,
      edges: graph.edges,
      unresolvedReferences,
      closureStatus: graph.closureStatus,
    });
    const verifiedAt = new Date();
    const resolutionElapsedMs =
      verifiedAt.getTime() - Date.parse(ticket.issued_at);
    const fetchedAtMs = Date.parse(fetchedAt);
    if (
      fetchedAtMs < Date.parse(ticket.issued_at) ||
      fetchedAtMs > verifiedAt.getTime()
    ) {
      throw new BadRequestException(
        'Catalog snapshot timestamp is outside the signed resolution window',
      );
    }
    if (
      resolutionElapsedMs < 0 ||
      resolutionElapsedMs >
        this.environmentService.getMcpCatalogMaxResolutionWindowMs() ||
      verifiedAt.getTime() > Date.parse(ticket.expires_at)
    ) {
      throw new RequestTimeoutException(
        'Catalog resolution exceeds the configured trusted window',
      );
    }
    const proof = this.proofService.signProofV3({
      resolution_ticket_id: ticket.ticket_id,
      challenge: ticket.challenge,
      resolution_started_at: ticket.issued_at,
      verified_at: verifiedAt.toISOString(),
      resolution_elapsed_ms: resolutionElapsedMs,
      snapshot_fetched_at: fetchedAt,
      catalog_root_page_id: snapshot.catalogRoot.id,
      environment: input.environment,
      authorization_context_sha256: this.authorizationContextHash(context),
      requested_roots: this.registry.canonicalRequestedRoots(input.roots),
      isolation: 'repeatable_read',
      read_only: true,
      page_manifest: manifest,
      reference_extractor_version: CATALOG_REFERENCE_EXTRACTOR_V3_VERSION,
      bundle_fingerprint: bundleFingerprint,
    });
    const bundle: CatalogBundleV3 = {
      schema_version: CATALOG_BUNDLE_V3_SCHEMA_VERSION,
      contract: QTS_FACT_CATALOG_CONTRACT,
      catalog_root: {
        page_id: snapshot.catalogRoot.id,
        title: snapshot.catalogRoot.title,
        space_id: snapshot.catalogRoot.spaceId,
        updated_at: snapshot.catalogRoot.updatedAt.toISOString(),
      },
      environment: input.environment,
      roots: graph.roots,
      known_root_cause_candidates: graph.knownRootCauseCandidates,
      pages,
      edges: graph.edges,
      unresolved_references: unresolvedReferences,
      closure_status: graph.closureStatus,
      closure_complete: graph.closureComplete,
      reference_extractor_version: CATALOG_REFERENCE_EXTRACTOR_V3_VERSION,
      bundle_fingerprint: bundleFingerprint,
      freshness_proof: proof,
    };
    this.assertResponseSize(bundle);
    return bundle;
  }

  private async resolveDelta(
    input: CatalogDeltaV3Input,
    context: McpToolContext,
  ): Promise<CatalogDeltaV3> {
    this.assertPreviousProof(input, context);
    const ticket = await this.consumeTicket(input, context);
    const bundle = await this.buildBundle(input, context, ticket);
    const previousById = new Map(
      input.previous.pages.map((page) => [
        page.pageId,
        {
          page_id: page.pageId,
          updated_at: page.updatedAt,
          content_sha256: page.contentSha256,
          front_matter_sha256: page.frontMatterSha256,
        } satisfies CatalogPageManifestItemV3,
      ]),
    );
    const added: CatalogPageV3[] = [];
    const updated: CatalogDeltaV3['changes']['updated'] = [];
    const unchanged: CatalogPageManifestItemV3[] = [];
    for (const page of bundle.pages) {
      const previous = previousById.get(page.page_id);
      if (!previous) {
        added.push(page);
      } else if (
        previous.updated_at !== page.updated_at ||
        previous.content_sha256 !== page.content_sha256 ||
        previous.front_matter_sha256 !== page.front_matter_sha256
      ) {
        updated.push({ previous, current: page });
      } else {
        unchanged.push(previous);
      }
      previousById.delete(page.page_id);
    }
    const removed = [...previousById.values()].sort((left, right) =>
      this.compare(left.page_id, right.page_id),
    );
    const previousRoots = input.previous.freshnessProof.requested_roots;
    const currentRoots = this.registry.canonicalRequestedRoots(input.roots);
    const rootChanges = this.computeRootChanges(previousRoots, currentRoots);
    const delta: CatalogDeltaV3 = {
      schema_version: CATALOG_DELTA_V3_SCHEMA_VERSION,
      contract: QTS_FACT_CATALOG_CONTRACT,
      previous_bundle_fingerprint: input.previous.bundleFingerprint,
      bundle_fingerprint: bundle.bundle_fingerprint,
      changed:
        input.previous.bundleFingerprint !== bundle.bundle_fingerprint ||
        added.length > 0 ||
        updated.length > 0 ||
        removed.length > 0 ||
        rootChanges.added.length > 0,
      catalog_root: bundle.catalog_root,
      environment: bundle.environment,
      roots: bundle.roots,
      root_changes: rootChanges,
      known_root_cause_candidates: bundle.known_root_cause_candidates,
      current_page_manifest: this.pageManifest(bundle.pages),
      edges: bundle.edges,
      unresolved_references: bundle.unresolved_references,
      closure_status: bundle.closure_status,
      closure_complete: bundle.closure_complete,
      reference_extractor_version: bundle.reference_extractor_version,
      changes: {
        added,
        updated,
        removed,
        unchanged: unchanged.sort((left, right) =>
          this.compare(left.page_id, right.page_id),
        ),
      },
      freshness_proof: bundle.freshness_proof,
    };
    this.assertResponseSize(delta);
    return delta;
  }

  private assertPreviousProof(
    input: CatalogDeltaV3Input,
    context: McpToolContext,
  ): void {
    const proof = input.previous.freshnessProof;
    if (!this.proofService.verifyProofV3(proof)) {
      throw new BadRequestException('previous freshness proof is invalid');
    }
    if (proof.challenge === input.ticket.challenge) {
      throw new BadRequestException(
        'Delta challenge must differ from the previous proof challenge',
      );
    }
    if (
      proof.bundle_fingerprint !== input.previous.bundleFingerprint ||
      proof.catalog_root_page_id !== input.catalogRootPageId ||
      proof.environment !== input.environment ||
      proof.authorization_context_sha256 !==
        this.authorizationContextHash(context) ||
      proof.reference_extractor_version !==
        CATALOG_REFERENCE_EXTRACTOR_V3_VERSION
    ) {
      throw new BadRequestException(
        'previous freshness proof does not match the requested Catalog scope',
      );
    }
    const requestedRoots = this.registry.canonicalRequestedRoots(input.roots);
    const requestedRootKeys = new Set(
      requestedRoots.map((root) => this.registry.canonicalJson(root)),
    );
    if (
      proof.requested_roots.some(
        (root) => !requestedRootKeys.has(this.registry.canonicalJson(root)),
      )
    ) {
      throw new BadRequestException(
        'previous freshness proof roots must be a subset of current roots',
      );
    }
    const previousManifest = input.previous.pages
      .map((page) => ({
        page_id: page.pageId,
        updated_at: page.updatedAt,
        content_sha256: page.contentSha256,
        front_matter_sha256: page.frontMatterSha256,
      }))
      .sort((left, right) => this.compare(left.page_id, right.page_id));
    if (
      this.registry.canonicalJson(proof.page_manifest) !==
      this.registry.canonicalJson(previousManifest)
    ) {
      throw new BadRequestException(
        'previous page manifest does not match its freshness proof',
      );
    }
  }

  private async consumeTicket(
    input: CatalogBundleV3Input,
    context: McpToolContext,
  ): Promise<CatalogResolutionTicket> {
    return this.proofService.consumeResolutionTicket(
      context.client.id,
      input.ticket,
      {
        catalogRootPageId: input.catalogRootPageId,
        environment: input.environment,
        authorizationContextSha256: this.authorizationContextHash(context),
      },
    );
  }

  private parseTicketInput(args: JsonObject): CatalogResolutionTicketInput {
    this.assertExactKeys(
      args,
      ['contract', 'catalogRootPageId', 'environment', 'challenge'],
      'Catalog resolution start arguments',
    );
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
    return {
      contract: QTS_FACT_CATALOG_CONTRACT,
      catalogRootPageId,
      environment,
      challenge,
    };
  }

  private parseBundleInput(
    args: JsonObject,
    additionalKeys: string[] = [],
  ): CatalogBundleV3Input {
    this.assertExactKeys(
      args,
      [
        'contract',
        'catalogRootPageId',
        'environment',
        'roots',
        'ticket',
        ...additionalKeys,
      ],
      'Catalog v3 arguments',
    );
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
    if (!Array.isArray(args.roots) || args.roots.length === 0) {
      throw new BadRequestException('roots must contain at least one selector');
    }
    if (args.roots.length > CATALOG_LIMITS.maxRoots) {
      throw new BadRequestException(
        `roots supports at most ${CATALOG_LIMITS.maxRoots} selectors`,
      );
    }
    if (!this.isObject(args.ticket)) {
      throw new BadRequestException('ticket must be an object');
    }
    const roots = args.roots.map((root) => this.parseRootSelector(root));
    if (this.registry.canonicalRequestedRoots(roots).length !== roots.length) {
      throw new BadRequestException('roots contains duplicate selectors');
    }
    return {
      contract: QTS_FACT_CATALOG_CONTRACT,
      catalogRootPageId,
      environment,
      roots,
      ticket: args.ticket as unknown as CatalogResolutionTicket,
    };
  }

  private parseDeltaInput(args: JsonObject): CatalogDeltaV3Input {
    const common = this.parseBundleInput(args, ['previous']);
    if (!this.isObject(args.previous)) {
      throw new BadRequestException('previous must be an object');
    }
    this.assertExactKeys(
      args.previous,
      ['bundleFingerprint', 'pages', 'freshnessProof'],
      'previous',
    );
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
    const pages = args.previous.pages.map((value) => {
      if (!this.isObject(value)) {
        throw new BadRequestException('previous.pages items must be objects');
      }
      this.assertExactKeys(
        value,
        ['pageId', 'updatedAt', 'contentSha256', 'frontMatterSha256'],
        'previous.pages item',
      );
      const pageId = this.requireString(value.pageId);
      const updatedAt = this.requireIsoTimestamp(value.updatedAt);
      const contentSha256 = this.requireString(value.contentSha256);
      const frontMatterSha256 = this.requireString(value.frontMatterSha256);
      if (
        !isValidUuid(pageId) ||
        !SHA256_PATTERN.test(contentSha256) ||
        !SHA256_PATTERN.test(frontMatterSha256)
      ) {
        throw new BadRequestException(
          'previous.pages contains an invalid item',
        );
      }
      return { pageId, updatedAt, contentSha256, frontMatterSha256 };
    });
    if (new Set(pages.map((page) => page.pageId)).size !== pages.length) {
      throw new BadRequestException(
        'previous.pages contains duplicate pageId values',
      );
    }
    if (!this.isObject(args.previous.freshnessProof)) {
      throw new BadRequestException(
        'previous.freshnessProof must be an object',
      );
    }
    return {
      ...common,
      previous: {
        bundleFingerprint,
        pages,
        freshnessProof: args.previous
          .freshnessProof as unknown as CatalogFreshnessProofV3,
      },
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
      return {
        documentType: this.requireCanonicalString(
          value.documentType,
          'roots.documentType',
          128,
        ),
        entityId: this.requireCanonicalString(
          value.entityId,
          'roots.entityId',
          512,
        ),
      };
    }
    throw new BadRequestException(
      'Each roots item must contain pageId or documentType and entityId',
    );
  }

  private toCatalogPageCandidate(
    captured: CatalogCapturedPage,
    fetchedAt: string,
  ): CatalogPageCandidateV3 {
    let markdown = '';
    let frontMatter: JsonObject = {};
    let missingYaml = false;
    let invalidYaml = false;
    try {
      markdown = captured.content ? jsonToMarkdown(captured.content) : '';
      if (
        Buffer.byteLength(markdown, 'utf8') >
        CATALOG_LIMITS.maxPageMarkdownBytes
      ) {
        throw new PayloadTooLargeException(
          `Catalog page ${captured.id} exceeds ${CATALOG_LIMITS.maxPageMarkdownBytes} Markdown bytes`,
        );
      }
      const parsed = this.registry.parseFirstYamlBlock(markdown);
      missingYaml = parsed === null;
      frontMatter = parsed ?? {};
    } catch (error) {
      if (error instanceof PayloadTooLargeException) throw error;
      invalidYaml = this.registry.hasYamlFence(markdown);
      missingYaml = !invalidYaml;
      frontMatter = {};
    }
    return {
      missingYaml,
      invalidYaml,
      page: {
        page_id: captured.id,
        title: captured.title,
        parent_page_id: captured.parentPageId,
        space_id: captured.spaceId,
        updated_at: captured.updatedAt.toISOString(),
        content_sha256: this.registry.sha256(markdown),
        front_matter_sha256: this.registry.sha256(
          this.registry.canonicalJson(frontMatter),
        ),
        fetched_at: fetchedAt,
        front_matter: frontMatter,
        markdown,
      },
    };
  }

  private authorizationContextHash(context: McpToolContext): string {
    return this.registry.sha256(
      [
        context.client.workspaceId,
        context.client.id,
        context.client.actorUserId ?? '',
      ].join('\0'),
    );
  }

  private rootSelectorSchema(): Record<string, unknown> {
    return {
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
  }

  private outputRootSelectorSchema(): Record<string, unknown> {
    return {
      oneOf: [
        {
          type: 'object',
          properties: { page_id: { type: 'string', format: 'uuid' } },
          required: ['page_id'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            document_type: { type: 'string', minLength: 1 },
            entity_id: { type: 'string', minLength: 1 },
          },
          required: ['document_type', 'entity_id'],
          additionalProperties: false,
        },
      ],
    };
  }

  private inputManifestItemSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        pageId: { type: 'string', format: 'uuid' },
        updatedAt: { type: 'string', format: 'date-time' },
        contentSha256: { type: 'string', pattern: SHA256_PATTERN.source },
        frontMatterSha256: {
          type: 'string',
          pattern: SHA256_PATTERN.source,
        },
      },
      required: ['pageId', 'updatedAt', 'contentSha256', 'frontMatterSha256'],
      additionalProperties: false,
    };
  }

  private outputManifestItemSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        page_id: { type: 'string', format: 'uuid' },
        updated_at: { type: 'string', format: 'date-time' },
        content_sha256: { type: 'string', pattern: SHA256_PATTERN.source },
        front_matter_sha256: {
          type: 'string',
          pattern: SHA256_PATTERN.source,
        },
      },
      required: [
        'page_id',
        'updated_at',
        'content_sha256',
        'front_matter_sha256',
      ],
      additionalProperties: false,
    };
  }

  private freshnessProofSchema(
    _rootSelectorSchema: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        schema_version: {
          type: 'string',
          const: CATALOG_FRESHNESS_V3_SCHEMA_VERSION,
        },
        signature_algorithm: {
          type: 'string',
          const: CATALOG_SIGNATURE_ALGORITHM,
        },
        public_key_format: {
          type: 'string',
          const: CATALOG_PUBLIC_KEY_FORMAT,
        },
        public_key: { type: 'string', minLength: 32, maxLength: 256 },
        key_id: { type: 'string', minLength: 1, maxLength: 128 },
        resolution_ticket_id: { type: 'string', format: 'uuid' },
        challenge: {
          type: 'string',
          minLength: CATALOG_LIMITS.minChallengeBytes,
          maxLength: CATALOG_LIMITS.maxChallengeBytes,
        },
        resolution_started_at: { type: 'string', format: 'date-time' },
        verified_at: { type: 'string', format: 'date-time' },
        resolution_elapsed_ms: {
          type: 'integer',
          minimum: 0,
          maximum: 300_000,
        },
        snapshot_fetched_at: { type: 'string', format: 'date-time' },
        catalog_root_page_id: { type: 'string', format: 'uuid' },
        environment: { type: 'string', minLength: 1, maxLength: 64 },
        authorization_context_sha256: {
          type: 'string',
          pattern: SHA256_PATTERN.source,
        },
        requested_roots: {
          type: 'array',
          minItems: 1,
          maxItems: CATALOG_LIMITS.maxRoots,
          items: this.outputRootSelectorSchema(),
        },
        isolation: { type: 'string', const: 'repeatable_read' },
        read_only: { type: 'boolean', const: true },
        page_manifest: {
          type: 'array',
          maxItems: CATALOG_LIMITS.maxClosurePages,
          items: this.outputManifestItemSchema(),
        },
        reference_extractor_version: {
          type: 'string',
          const: CATALOG_REFERENCE_EXTRACTOR_V3_VERSION,
        },
        bundle_fingerprint: {
          type: 'string',
          pattern: SHA256_PATTERN.source,
        },
        signature: { type: 'string', minLength: 64, maxLength: 256 },
      },
      required: [
        'schema_version',
        'signature_algorithm',
        'public_key_format',
        'public_key',
        'key_id',
        'resolution_ticket_id',
        'challenge',
        'resolution_started_at',
        'verified_at',
        'resolution_elapsed_ms',
        'snapshot_fetched_at',
        'catalog_root_page_id',
        'environment',
        'authorization_context_sha256',
        'requested_roots',
        'isolation',
        'read_only',
        'page_manifest',
        'reference_extractor_version',
        'bundle_fingerprint',
        'signature',
      ],
      additionalProperties: false,
    };
  }

  private resolutionTicketSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        schema_version: {
          type: 'string',
          const: CATALOG_RESOLUTION_TICKET_SCHEMA_VERSION,
        },
        signature_algorithm: {
          type: 'string',
          const: CATALOG_SIGNATURE_ALGORITHM,
        },
        public_key_format: {
          type: 'string',
          const: CATALOG_PUBLIC_KEY_FORMAT,
        },
        public_key: { type: 'string', minLength: 32, maxLength: 256 },
        key_id: { type: 'string', minLength: 1, maxLength: 128 },
        ticket_id: { type: 'string', format: 'uuid' },
        issued_at: { type: 'string', format: 'date-time' },
        expires_at: { type: 'string', format: 'date-time' },
        challenge: {
          type: 'string',
          minLength: CATALOG_LIMITS.minChallengeBytes,
          maxLength: CATALOG_LIMITS.maxChallengeBytes,
        },
        catalog_root_page_id: { type: 'string', format: 'uuid' },
        environment: { type: 'string', minLength: 1, maxLength: 64 },
        authorization_context_sha256: {
          type: 'string',
          pattern: SHA256_PATTERN.source,
        },
        signature: { type: 'string', minLength: 64, maxLength: 256 },
      },
      required: [
        'schema_version',
        'signature_algorithm',
        'public_key_format',
        'public_key',
        'key_id',
        'ticket_id',
        'issued_at',
        'expires_at',
        'challenge',
        'catalog_root_page_id',
        'environment',
        'authorization_context_sha256',
        'signature',
      ],
      additionalProperties: false,
    };
  }

  private pageManifest(pages: CatalogPageV3[]): CatalogPageManifestItemV3[] {
    return pages
      .map((page) => ({
        page_id: page.page_id,
        updated_at: page.updated_at,
        content_sha256: page.content_sha256,
        front_matter_sha256: page.front_matter_sha256,
      }))
      .sort((left, right) => this.compare(left.page_id, right.page_id));
  }

  private computeBundleFingerprint(input: {
    catalogRootPageId: string;
    environment: string;
    roots: CatalogBundleV3['roots'];
    knownRootCauseCandidates: CatalogBundleV3['known_root_cause_candidates'];
    pages: CatalogPageManifestItemV3[];
    edges: CatalogBundleV3['edges'];
    unresolvedReferences: CatalogBundleV3['unresolved_references'];
    closureStatus: CatalogBundleV3['closure_status'];
  }): string {
    const sortCanonical = <T>(values: T[]): T[] =>
      [...values].sort((left, right) =>
        this.compare(
          this.registry.canonicalJson(left),
          this.registry.canonicalJson(right),
        ),
      );
    return this.registry.sha256(
      this.registry.canonicalJson({
        contract: QTS_FACT_CATALOG_CONTRACT,
        schema_version: CATALOG_BUNDLE_V3_SCHEMA_VERSION,
        catalog_root_page_id: input.catalogRootPageId,
        environment: input.environment,
        roots: sortCanonical(input.roots),
        known_root_cause_candidates: sortCanonical(
          input.knownRootCauseCandidates,
        ),
        page_manifest: sortCanonical(input.pages),
        edges: sortCanonical(input.edges),
        unresolved_references: sortCanonical(input.unresolvedReferences),
        closure_status: input.closureStatus,
        reference_extractor_version: CATALOG_REFERENCE_EXTRACTOR_V3_VERSION,
      }),
    );
  }

  private computeRootChanges(
    previous: CatalogRootSelectorOutput[],
    current: CatalogRootSelectorOutput[],
  ): CatalogRootChangesV3 {
    const previousByKey = new Map(
      previous.map((root) => [this.registry.canonicalJson(root), root]),
    );
    const currentByKey = new Map(
      current.map((root) => [this.registry.canonicalJson(root), root]),
    );
    const removed = [...previousByKey]
      .filter(([key]) => !currentByKey.has(key))
      .map(([, root]) => root);
    if (removed.length > 0) {
      throw new BadRequestException(
        'Catalog delta v3 only supports equal or expanded roots',
      );
    }
    const added = [...currentByKey]
      .filter(([key]) => !previousByKey.has(key))
      .map(([, root]) => root);
    const unchanged = [...currentByKey]
      .filter(([key]) => previousByKey.has(key))
      .map(([, root]) => root);
    const sort = (values: CatalogRootSelectorOutput[]) =>
      [...values].sort((left, right) =>
        this.compare(
          this.registry.canonicalJson(left),
          this.registry.canonicalJson(right),
        ),
      );
    return { added: sort(added), removed: [], unchanged: sort(unchanged) };
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

  private assertExactKeys(
    value: Record<string, unknown>,
    expectedKeys: string[],
    name: string,
  ): void {
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    if (
      actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])
    ) {
      throw new BadRequestException(
        `${name} contains unsupported or missing fields`,
      );
    }
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

  private requireString(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new BadRequestException('A required string is missing');
    }
    return value;
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
  }
}
