import {
  IsIn,
  IsNotEmpty,
  IsNotIn,
  IsNumberString,
  IsOptional,
  IsString,
  IsUrl,
  MinLength,
  registerDecorator,
  ValidateIf,
  ValidationArguments,
  validateSync,
} from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { createPublicKey } from 'crypto';
import { IsISO6391 } from '../../common/validators/is-iso6391';

const CATALOG_SIGNING_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function IsNumericStringInRange(
  min: number,
  max: number,
  options: { integer?: boolean } = {},
): PropertyDecorator {
  const integer = options.integer ?? true;

  return (target, propertyKey) => {
    registerDecorator({
      name: 'isNumericStringInRange',
      target: target.constructor,
      propertyName: String(propertyKey),
      constraints: [min, max, integer],
      validator: {
        validate(value: unknown) {
          if (
            typeof value !== 'string' ||
            value.length === 0 ||
            value.trim() !== value
          ) {
            return false;
          }

          const numericValue = Number(value);
          return (
            Number.isFinite(numericValue) &&
            (!integer || Number.isInteger(numericValue)) &&
            numericValue >= min &&
            numericValue <= max
          );
        },
        defaultMessage(args: ValidationArguments) {
          const [minimum, maximum, mustBeInteger] = args.constraints as [
            number,
            number,
            boolean,
          ];
          return `${args.property} must be ${mustBeInteger ? 'an integer' : 'a number'} between ${minimum} and ${maximum}`;
        },
      },
    });
  };
}

export class EnvironmentVariables {
  @IsNotEmpty()
  @IsUrl(
    {
      protocols: ['postgres', 'postgresql'],
      require_tld: false,
      allow_underscores: true,
    },
    { message: 'DATABASE_URL must be a valid postgres connection string' },
  )
  DATABASE_URL: string;

  @IsNotEmpty()
  @IsUrl(
    {
      protocols: ['redis', 'rediss'],
      require_tld: false,
      allow_underscores: true,
    },
    { message: 'REDIS_URL must be a valid redis connection string' },
  )
  REDIS_URL: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  APP_URL: string;

  @IsNotEmpty()
  @MinLength(32)
  @IsNotIn(['REPLACE_WITH_LONG_SECRET'])
  APP_SECRET: string;

  @IsOptional()
  @IsIn(['smtp', 'postmark'])
  MAIL_DRIVER: string;

  @IsOptional()
  @IsIn(['local', 's3', 'azure'])
  STORAGE_DRIVER: string;

  @IsOptional()
  @ValidateIf((obj) => obj.COLLAB_URL != '' && obj.COLLAB_URL != null)
  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  COLLAB_URL: string;

  @IsOptional()
  CLOUD: boolean;

  @IsOptional()
  @IsUrl(
    { protocols: [], require_tld: true },
    {
      message:
        'SUBDOMAIN_HOST must be a valid FQDN domain without the http protocol. e.g example.com',
    },
  )
  @ValidateIf((obj) => obj.CLOUD === 'true'.toLowerCase())
  SUBDOMAIN_HOST: string;

  @IsOptional()
  @IsIn(['database', 'typesense'])
  @IsString()
  SEARCH_DRIVER: string;

  @IsOptional()
  @IsUrl(
    {
      protocols: ['http', 'https'],
      require_tld: false,
      allow_underscores: true,
    },
    {
      message:
        'TYPESENSE_URL must be a valid typesense url e.g http://localhost:8108',
    },
  )
  @ValidateIf((obj) => obj.SEARCH_DRIVER === 'typesense')
  TYPESENSE_URL: string;

  @ValidateIf((obj) => obj.SEARCH_DRIVER === 'typesense')
  @IsNotEmpty()
  @IsString()
  TYPESENSE_API_KEY: string;

  @IsOptional()
  @ValidateIf((obj) => obj.SEARCH_DRIVER === 'typesense')
  @IsISO6391()
  @IsString()
  TYPESENSE_LOCALE: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  @IsString()
  MCP_ENABLED: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  MCP_PUBLIC_BASE_URL: string;

  @ValidateIf((obj) => obj.MCP_ENABLED === 'true')
  @IsNotEmpty()
  @MinLength(32)
  @IsString()
  MCP_TOKEN_HASH_SECRET: string;

  @IsOptional()
  @MinLength(32)
  @IsString()
  MCP_TOKEN_HASH_SECRET_PREVIOUS: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(1, 100)
  MCP_MAX_BATCH_SIZE: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(1, 10_000)
  MCP_MAX_QUERY_LENGTH: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(1, 5_000_000)
  MCP_MAX_WRITE_CONTENT_LENGTH: string;

  @IsOptional()
  @IsString()
  @IsNumericStringInRange(0, 1, { integer: false })
  MCP_READ_AUDIT_SAMPLE_RATE: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(1, 3_600)
  MCP_RATE_LIMIT_WINDOW_SECONDS: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(0, 100_000)
  MCP_RATE_LIMIT_MAX_REQUESTS: string;

  @IsOptional()
  @MinLength(32)
  @IsString()
  MCP_METRICS_TOKEN: string;

  @IsOptional()
  @MinLength(32)
  @IsString()
  MCP_CATALOG_SIGNING_SECRET: string;

  @IsOptional()
  @IsString()
  MCP_CATALOG_SIGNING_KEY_ID: string;

  @IsOptional()
  @IsString()
  MCP_CATALOG_PREVIOUS_PUBLIC_KEYS: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(60, 2_592_000)
  MCP_CATALOG_CHALLENGE_TTL_SECONDS: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(10, 600)
  MCP_CATALOG_TICKET_TTL_SECONDS: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(10_000, 300_000)
  MCP_CATALOG_MAX_RESOLUTION_WINDOW_MS: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  @IsString()
  VECTOR_SEARCH_ENABLED: string;

  @ValidateIf((obj) => obj.VECTOR_SEARCH_ENABLED === 'true')
  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  EMBEDDING_BASE_URL: string;

  @ValidateIf((obj) => obj.VECTOR_SEARCH_ENABLED === 'true')
  @IsString()
  @IsNotEmpty()
  EMBEDDING_API_KEY: string;

  @IsOptional()
  @IsString()
  EMBEDDING_MODEL: string;

  @IsOptional()
  @IsIn(['1536'], {
    message:
      'EMBEDDING_DIMENSIONS must be 1536; changing dimensions requires a database migration and full vector reindex',
  })
  @IsString()
  EMBEDDING_DIMENSIONS: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(1, 256)
  EMBEDDING_BATCH_SIZE: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(100, 120_000)
  EMBEDDING_TIMEOUT_MS: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(0, 10)
  EMBEDDING_MAX_RETRIES: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(0, 30_000)
  EMBEDDING_RETRY_BASE_DELAY_MS: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(256, 32_000)
  VECTOR_CHUNK_MAX_CHARS: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(0, 31_999)
  VECTOR_CHUNK_OVERLAP_CHARS: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(0, 1, { integer: false })
  VECTOR_HYBRID_SEMANTIC_WEIGHT: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(0, 1, { integer: false })
  VECTOR_HYBRID_KEYWORD_WEIGHT: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(0, 1, { integer: false })
  VECTOR_HYBRID_RECENCY_WEIGHT: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(1, 100_000)
  VECTOR_EXACT_PAGE_THRESHOLD: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(1, 1_000_000)
  VECTOR_EXACT_CHUNK_THRESHOLD: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(2, 200)
  VECTOR_ANN_CANDIDATE_MULTIPLIER: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(100, 100_000)
  VECTOR_ANN_MAX_CANDIDATES: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(1, 10_000)
  SEARCH_MAX_QUERY_LENGTH: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(1, 3_600)
  VECTOR_SEARCH_RATE_LIMIT_WINDOW_SECONDS: string;

  @IsOptional()
  @IsNumberString()
  @IsNumericStringInRange(1, 100_000)
  VECTOR_SEARCH_RATE_LIMIT_MAX_REQUESTS: string;

  @IsOptional()
  @IsString()
  TRUSTED_PROXY_CIDRS: string;

  @IsOptional()
  @ValidateIf((obj) => obj.AI_DRIVER)
  @IsIn(['openai', 'openai-compatible', 'gemini', 'ollama'])
  @IsString()
  AI_DRIVER: string;

  @IsOptional()
  @IsString()
  AI_EMBEDDING_MODEL: string;

  @ValidateIf((obj) => obj.AI_EMBEDDING_DIMENSION)
  @IsIn(['768', '1024', '1536', '2000', '3072'])
  @IsString()
  AI_EMBEDDING_DIMENSION: string;

  @IsOptional()
  @ValidateIf((obj) => obj.AI_EMBEDDING_SUPPORTS_MRL)
  @IsIn(['true', 'false'])
  @IsString()
  AI_EMBEDDING_SUPPORTS_MRL: string;

  @ValidateIf((obj) => obj.AI_DRIVER)
  @IsString()
  @IsNotEmpty()
  AI_COMPLETION_MODEL: string;

  @IsOptional()
  @ValidateIf(
    (obj) =>
      obj.AI_DRIVER && ['openai', 'openai-compatible'].includes(obj.AI_DRIVER),
  )
  @IsString()
  @IsNotEmpty()
  OPENAI_API_KEY: string;

  @IsOptional()
  @ValidateIf(
    (obj) =>
      obj.AI_DRIVER === 'openai-compatible' ||
      (obj.AI_DRIVER === 'openai' && obj.OPENAI_API_URL),
  )
  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  OPENAI_API_URL: string;

  @ValidateIf((obj) => obj.AI_DRIVER && obj.AI_DRIVER === 'gemini')
  @IsString()
  @IsNotEmpty()
  GEMINI_API_KEY: string;

  @ValidateIf((obj) => obj.AI_DRIVER && obj.AI_DRIVER === 'ollama')
  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  OLLAMA_API_URL: string;

  @IsOptional()
  @IsIn(['postgres', 'clickhouse'])
  @IsString()
  EVENT_STORE_DRIVER: string;

  @ValidateIf((obj) => obj.EVENT_STORE_DRIVER === 'clickhouse')
  @IsNotEmpty()
  @IsUrl(
    { protocols: ['http', 'https'], require_tld: false },
    {
      message:
        'CLICKHOUSE_URL must be a valid URL e.g http://user:password@localhost:8123/docmost',
    },
  )
  CLICKHOUSE_URL: string;
}

function inspectEnvironment(config: Record<string, any>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config);
  const errors = validateSync(validatedConfig);
  const messages = errors.flatMap((error) =>
    Object.values(error.constraints ?? {}),
  );

  const chunkMax = Number(config.VECTOR_CHUNK_MAX_CHARS ?? 4_000);
  const chunkOverlap = Number(config.VECTOR_CHUNK_OVERLAP_CHARS ?? 300);
  if (
    Number.isFinite(chunkMax) &&
    Number.isFinite(chunkOverlap) &&
    chunkOverlap >= chunkMax
  ) {
    messages.push(
      'VECTOR_CHUNK_OVERLAP_CHARS must be smaller than VECTOR_CHUNK_MAX_CHARS',
    );
  }

  const hybridWeights = [
    Number(config.VECTOR_HYBRID_SEMANTIC_WEIGHT ?? 0.65),
    Number(config.VECTOR_HYBRID_KEYWORD_WEIGHT ?? 0.25),
    Number(config.VECTOR_HYBRID_RECENCY_WEIGHT ?? 0.1),
  ];
  if (
    hybridWeights.every(Number.isFinite) &&
    hybridWeights.reduce((total, value) => total + value, 0) <= 0
  ) {
    messages.push('At least one VECTOR_HYBRID_*_WEIGHT must be greater than 0');
  }

  const catalogSigningKeyId = config.MCP_CATALOG_SIGNING_KEY_ID;
  if (
    typeof catalogSigningKeyId === 'string' &&
    catalogSigningKeyId.length > 0 &&
    !CATALOG_SIGNING_KEY_ID_PATTERN.test(catalogSigningKeyId)
  ) {
    messages.push(
      'MCP_CATALOG_SIGNING_KEY_ID must contain only letters, digits, dot, underscore, colon, or hyphen',
    );
  }

  const previousCatalogKeys = config.MCP_CATALOG_PREVIOUS_PUBLIC_KEYS;
  if (
    typeof previousCatalogKeys === 'string' &&
    previousCatalogKeys.trim().length > 0 &&
    !isValidCatalogPublicKeyMap(previousCatalogKeys)
  ) {
    messages.push(
      'MCP_CATALOG_PREVIOUS_PUBLIC_KEYS must be a JSON object of valid key IDs to canonical Ed25519 SPKI DER base64url public keys',
    );
  }

  return { validatedConfig, messages };
}

function isValidCatalogPublicKeyMap(source: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  for (const [keyId, encoded] of Object.entries(parsed)) {
    if (
      !CATALOG_SIGNING_KEY_ID_PATTERN.test(keyId) ||
      typeof encoded !== 'string' ||
      encoded.length === 0
    ) {
      return false;
    }
    try {
      const decoded = Buffer.from(encoded, 'base64url');
      if (
        decoded.length === 0 ||
        decoded.toString('base64url') !== encoded ||
        createPublicKey({ key: decoded, format: 'der', type: 'spki' })
          .asymmetricKeyType !== 'ed25519'
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export function getEnvironmentValidationMessages(
  config: Record<string, any>,
): string[] {
  return inspectEnvironment(config).messages;
}

export function validate(config: Record<string, any>) {
  const { validatedConfig, messages } = inspectEnvironment(config);

  if (messages.length > 0) {
    console.error(
      'The Environment variables has failed the following validations:',
    );

    messages.forEach((message) => console.error(message));

    console.error(
      'Please fix the environment variables and try again. Exiting program...',
    );
    process.exit(1);
  }

  return validatedConfig;
}
