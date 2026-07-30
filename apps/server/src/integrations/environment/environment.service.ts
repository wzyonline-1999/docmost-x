import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ms, { StringValue } from 'ms';

@Injectable()
export class EnvironmentService {
  constructor(private configService: ConfigService) {}

  getNodeEnv(): string {
    return this.configService.get<string>('NODE_ENV', 'development');
  }

  isDevelopment(): boolean {
    return this.getNodeEnv() === 'development';
  }

  getAppUrl(): string {
    const rawUrl =
      this.configService.get<string>('APP_URL') ||
      `http://localhost:${this.getPort()}`;

    const { origin } = new URL(rawUrl);
    return origin;
  }

  isHttps(): boolean {
    const appUrl = this.configService.get<string>('APP_URL');
    try {
      const url = new URL(appUrl);
      return url.protocol === 'https:';
    } catch (error) {
      return false;
    }
  }

  getSubdomainHost(): string {
    return this.configService.get<string>('SUBDOMAIN_HOST');
  }

  getPort(): number {
    return parseInt(this.configService.get<string>('PORT', '3000'));
  }

  getAppSecret(): string {
    return this.configService.get<string>('APP_SECRET');
  }

  getDatabaseURL(): string {
    return this.configService.get<string>('DATABASE_URL');
  }

  getDatabaseMaxPool(): number {
    return parseInt(this.configService.get<string>('DATABASE_MAX_POOL', '10'));
  }

  getRedisUrl(): string {
    return this.configService.get<string>(
      'REDIS_URL',
      'redis://localhost:6379',
    );
  }

  getJwtTokenExpiresIn(): string {
    return this.configService.get<string>('JWT_TOKEN_EXPIRES_IN', '90d');
  }

  getCookieExpiresIn(): Date {
    const expiresInStr = this.getJwtTokenExpiresIn();
    let msUntilExpiry: number;
    try {
      msUntilExpiry = ms(expiresInStr as StringValue);
    } catch (err) {
      msUntilExpiry = ms('90d');
    }
    return new Date(Date.now() + msUntilExpiry);
  }

  getGotenbergUrl(): string | undefined {
    return this.configService.get<string>('GOTENBERG_URL');
  }

  getStorageDriver(): string {
    return this.configService.get<string>('STORAGE_DRIVER', 'local');
  }

  getFileUploadSizeLimit(): string {
    return this.configService.get<string>('FILE_UPLOAD_SIZE_LIMIT', '50mb');
  }

  getFileImportSizeLimit(): string {
    return this.configService.get<string>('FILE_IMPORT_SIZE_LIMIT', '200mb');
  }

  getAwsS3AccessKeyId(): string {
    return this.configService.get<string>('AWS_S3_ACCESS_KEY_ID');
  }

  getAwsS3SecretAccessKey(): string {
    return this.configService.get<string>('AWS_S3_SECRET_ACCESS_KEY');
  }

  getAwsS3Region(): string {
    return this.configService.get<string>('AWS_S3_REGION');
  }

  getAwsS3Bucket(): string {
    return this.configService.get<string>('AWS_S3_BUCKET');
  }

  getAwsS3Endpoint(): string {
    return this.configService.get<string>('AWS_S3_ENDPOINT');
  }

  getAwsS3ForcePathStyle(): boolean {
    const forcePathStyle = this.configService
      .get<string>('AWS_S3_FORCE_PATH_STYLE', 'false')
      .toLowerCase();
    return forcePathStyle === 'true';
  }

  getAwsS3Url(): string {
    return this.configService.get<string>('AWS_S3_URL');
  }

  getAzureStorageAccountName(): string {
    return this.configService.get<string>('AZURE_STORAGE_ACCOUNT_NAME');
  }

  getAzureStorageContainer(): string {
    return this.configService.get<string>('AZURE_STORAGE_CONTAINER');
  }

  getAzureStorageAccountKey(): string {
    return this.configService.get<string>('AZURE_STORAGE_ACCOUNT_KEY');
  }

  getAzureStorageEndpoint(): string {
    return this.configService.get<string>('AZURE_STORAGE_ENDPOINT');
  }

  getAzureStorageUrl(): string {
    return this.configService.get<string>('AZURE_STORAGE_URL');
  }

  getMailDriver(): string {
    return this.configService.get<string>('MAIL_DRIVER', 'log');
  }

  getMailFromAddress(): string {
    return this.configService.get<string>('MAIL_FROM_ADDRESS');
  }

  getMailFromName(): string {
    return this.configService.get<string>('MAIL_FROM_NAME', 'Docmost');
  }

  getMailBlockedRecipientDomains(): string[] {
    const raw = this.configService.get<string>(
      'MAIL_BLOCKED_RECIPIENT_DOMAINS',
      '',
    );
    return raw
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  }

  getSmtpHost(): string {
    return this.configService.get<string>('SMTP_HOST');
  }

  getSmtpPort(): number {
    return parseInt(this.configService.get<string>('SMTP_PORT'));
  }

  getSmtpSecure(): boolean {
    const secure = this.configService
      .get<string>('SMTP_SECURE', 'false')
      .toLowerCase();
    return secure === 'true';
  }

  getSmtpIgnoreTLS(): boolean {
    const ignoretls = this.configService
      .get<string>('SMTP_IGNORETLS', 'false')
      .toLowerCase();
    return ignoretls === 'true';
  }

  getSmtpUsername(): string {
    return this.configService.get<string>('SMTP_USERNAME');
  }

  getSmtpPassword(): string {
    return this.configService.get<string>('SMTP_PASSWORD');
  }

  getPostmarkToken(): string {
    return this.configService.get<string>('POSTMARK_TOKEN');
  }

  getDrawioUrl(): string {
    return this.configService.get<string>('DRAWIO_URL');
  }

  isCloud(): boolean {
    const cloudConfig = this.configService
      .get<string>('CLOUD', 'false')
      .toLowerCase();
    return cloudConfig === 'true';
  }

  isSelfHosted(): boolean {
    return !this.isCloud();
  }

  getStripePublishableKey(): string {
    return this.configService.get<string>('STRIPE_PUBLISHABLE_KEY');
  }

  getStripeSecretKey(): string {
    return this.configService.get<string>('STRIPE_SECRET_KEY');
  }

  getStripeWebhookSecret(): string {
    return this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
  }

  getBillingTrialDays(): number {
    return parseInt(this.configService.get<string>('BILLING_TRIAL_DAYS', '14'));
  }

  getCollabUrl(): string {
    return this.configService.get<string>('COLLAB_URL');
  }

  isCollabDisableRedis(): boolean {
    const isStandalone = this.configService
      .get<string>('COLLAB_DISABLE_REDIS', 'false')
      .toLowerCase();
    return isStandalone === 'true';
  }

  isDisableTelemetry(): boolean {
    const disable = this.configService
      .get<string>('DISABLE_TELEMETRY', 'false')
      .toLowerCase();
    return disable === 'true';
  }

  getPostHogHost(): string {
    return this.configService.get<string>('POSTHOG_HOST');
  }

  getPostHogKey(): string {
    return this.configService.get<string>('POSTHOG_KEY');
  }

  getSearchDriver(): string {
    return this.configService
      .get<string>('SEARCH_DRIVER', 'database')
      .toLowerCase();
  }

  getTypesenseUrl(): string {
    return this.configService
      .get<string>('TYPESENSE_URL', 'http://localhost:8108')
      .toLowerCase();
  }

  getTypesenseApiKey(): string {
    return this.configService.get<string>('TYPESENSE_API_KEY');
  }

  getTypesenseLocale(): string {
    return this.configService
      .get<string>('TYPESENSE_LOCALE', 'en')
      .toLowerCase();
  }

  isMcpEnabled(): boolean {
    return (
      this.configService.get<string>('MCP_ENABLED', 'false').toLowerCase() ===
      'true'
    );
  }

  getMcpPublicBaseUrl(): string {
    return this.configService.get<string>('MCP_PUBLIC_BASE_URL');
  }

  getMcpTokenHashSecret(): string {
    return this.configService.get<string>('MCP_TOKEN_HASH_SECRET');
  }

  getMcpTokenHashPreviousSecret(): string | undefined {
    const value = this.configService
      .get<string>('MCP_TOKEN_HASH_SECRET_PREVIOUS')
      ?.trim();
    return value || undefined;
  }

  getMcpMaxBatchSize(): number {
    return parseInt(
      this.configService.get<string>('MCP_MAX_BATCH_SIZE', '20'),
      10,
    );
  }

  getMcpMaxQueryLength(): number {
    return parseInt(
      this.configService.get<string>('MCP_MAX_QUERY_LENGTH', '1000'),
      10,
    );
  }

  getMcpMaxWriteContentLength(): number {
    return parseInt(
      this.configService.get<string>('MCP_MAX_WRITE_CONTENT_LENGTH', '200000'),
      10,
    );
  }

  getMcpReadAuditSampleRate(): number {
    return parseFloat(
      this.configService.get<string>('MCP_READ_AUDIT_SAMPLE_RATE', '0'),
    );
  }

  getMcpRateLimitWindowSeconds(): number {
    return parseInt(
      this.configService.get<string>('MCP_RATE_LIMIT_WINDOW_SECONDS', '60'),
      10,
    );
  }

  getMcpRateLimitMaxRequests(): number {
    return parseInt(
      this.configService.get<string>('MCP_RATE_LIMIT_MAX_REQUESTS', '0'),
      10,
    );
  }

  getMcpMetricsToken(): string {
    return this.configService.get<string>('MCP_METRICS_TOKEN');
  }

  isVectorSearchEnabled(): boolean {
    return (
      this.configService
        .get<string>('VECTOR_SEARCH_ENABLED', 'false')
        .toLowerCase() === 'true'
    );
  }

  getEmbeddingBaseUrl(): string {
    return this.configService.get<string>('EMBEDDING_BASE_URL');
  }

  getEmbeddingApiKey(): string {
    return this.configService.get<string>('EMBEDDING_API_KEY');
  }

  getEmbeddingModel(): string {
    return this.configService.get<string>(
      'EMBEDDING_MODEL',
      'text-embedding-3-small',
    );
  }

  getEmbeddingDimensions(): number {
    return parseInt(
      this.configService.get<string>('EMBEDDING_DIMENSIONS', '1536'),
      10,
    );
  }

  getEmbeddingBatchSize(): number {
    return parseInt(
      this.configService.get<string>('EMBEDDING_BATCH_SIZE', '32'),
      10,
    );
  }

  getEmbeddingTimeoutMs(): number {
    return parseInt(
      this.configService.get<string>('EMBEDDING_TIMEOUT_MS', '30000'),
      10,
    );
  }

  getEmbeddingMaxRetries(): number {
    return parseInt(
      this.configService.get<string>('EMBEDDING_MAX_RETRIES', '3'),
      10,
    );
  }

  getEmbeddingRetryBaseDelayMs(): number {
    return parseInt(
      this.configService.get<string>('EMBEDDING_RETRY_BASE_DELAY_MS', '500'),
      10,
    );
  }

  getVectorChunkMaxChars(): number {
    return parseInt(
      this.configService.get<string>('VECTOR_CHUNK_MAX_CHARS', '4000'),
      10,
    );
  }

  getVectorChunkOverlapChars(): number {
    return parseInt(
      this.configService.get<string>('VECTOR_CHUNK_OVERLAP_CHARS', '300'),
      10,
    );
  }

  getVectorHybridSemanticWeight(): number {
    return parseFloat(
      this.configService.get<string>('VECTOR_HYBRID_SEMANTIC_WEIGHT', '0.65'),
    );
  }

  getVectorHybridKeywordWeight(): number {
    return parseFloat(
      this.configService.get<string>('VECTOR_HYBRID_KEYWORD_WEIGHT', '0.25'),
    );
  }

  getVectorHybridRecencyWeight(): number {
    return parseFloat(
      this.configService.get<string>('VECTOR_HYBRID_RECENCY_WEIGHT', '0.10'),
    );
  }

  getVectorExactChunkThreshold(): number {
    const configured = parseInt(
      this.configService.get<string>('VECTOR_EXACT_CHUNK_THRESHOLD', ''),
      10,
    );
    if (Number.isFinite(configured) && configured > 0) {
      return configured;
    }

    const legacyPageThreshold = parseInt(
      this.configService.get<string>('VECTOR_EXACT_PAGE_THRESHOLD', ''),
      10,
    );
    if (Number.isFinite(legacyPageThreshold) && legacyPageThreshold > 0) {
      return legacyPageThreshold * 10;
    }

    return 4000;
  }

  getVectorAnnCandidateMultiplier(): number {
    return parseInt(
      this.configService.get<string>('VECTOR_ANN_CANDIDATE_MULTIPLIER', '24'),
      10,
    );
  }

  getVectorAnnMaxCandidates(): number {
    return parseInt(
      this.configService.get<string>('VECTOR_ANN_MAX_CANDIDATES', '5000'),
      10,
    );
  }

  getSearchMaxQueryLength(): number {
    return parseInt(
      this.configService.get<string>('SEARCH_MAX_QUERY_LENGTH', '1000'),
      10,
    );
  }

  getVectorSearchRateLimitWindowSeconds(): number {
    return parseInt(
      this.configService.get<string>(
        'VECTOR_SEARCH_RATE_LIMIT_WINDOW_SECONDS',
        '60',
      ),
      10,
    );
  }

  getVectorSearchRateLimitMaxRequests(): number {
    return parseInt(
      this.configService.get<string>(
        'VECTOR_SEARCH_RATE_LIMIT_MAX_REQUESTS',
        '60',
      ),
      10,
    );
  }

  getAiDriver(): string {
    return this.configService.get<string>('AI_DRIVER');
  }

  getAiEmbeddingModel(): string {
    return this.configService.get<string>('AI_EMBEDDING_MODEL');
  }

  getAiCompletionModel(): string {
    return this.configService.get<string>('AI_COMPLETION_MODEL');
  }

  getAiChatModel(): string {
    return (
      this.configService.get<string>('AI_CHAT_MODEL') ||
      this.configService.get<string>('AI_COMPLETION_MODEL')
    );
  }

  getAiEmbeddingDimension(): number {
    return parseInt(
      this.configService.get<string>('AI_EMBEDDING_DIMENSION'),
      10,
    );
  }

  getAiEmbeddingSupportsMrl(): boolean | undefined {
    const val = this.configService.get<string>('AI_EMBEDDING_SUPPORTS_MRL');
    if (val === undefined || val === null || val === '') return undefined;
    return val === 'true';
  }

  getOpenAiApiKey(): string {
    return this.configService.get<string>('OPENAI_API_KEY');
  }

  getOpenAiApiUrl(): string {
    return this.configService.get<string>('OPENAI_API_URL');
  }

  getGeminiApiKey(): string {
    return this.configService.get<string>('GEMINI_API_KEY');
  }

  getOllamaApiUrl(): string {
    return this.configService.get<string>(
      'OLLAMA_API_URL',
      'http://localhost:11434',
    );
  }

  getEventStoreDriver(): string {
    return this.configService
      .get<string>('EVENT_STORE_DRIVER', 'postgres')
      .toLowerCase();
  }

  getClickHouseUrl(): string {
    return this.configService.get<string>('CLICKHOUSE_URL');
  }

  getSamlDisableRequestedAuthnContext(): boolean {
    const disabled = this.configService
      .get<string>('SAML_DISABLE_REQUESTED_AUTHN_CONTEXT', 'false')
      .toLowerCase();
    return disabled === 'true';
  }

  isIframeEmbedAllowed(): boolean {
    const allowed = this.configService
      .get<string>('IFRAME_EMBED_ALLOWED', 'false')
      .toLowerCase();
    return allowed === 'true';
  }

  getIframeAllowedOrigins(): string[] {
    const raw = this.configService.get<string>('IFRAME_ALLOWED_ORIGINS', '');
    return raw
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }
}
