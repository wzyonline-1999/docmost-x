import {
  IsIn,
  IsNotEmpty,
  IsNotIn,
  IsNumberString,
  IsOptional,
  IsString,
  IsUrl,
  MinLength,
  ValidateIf,
  validateSync,
} from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { IsISO6391 } from '../../common/validators/is-iso6391';

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
  @IsNumberString()
  MCP_MAX_QUERY_LENGTH: string;

  @IsOptional()
  @IsNumberString()
  MCP_MAX_WRITE_CONTENT_LENGTH: string;

  @IsOptional()
  @IsString()
  MCP_READ_AUDIT_SAMPLE_RATE: string;

  @IsOptional()
  @IsNumberString()
  MCP_RATE_LIMIT_WINDOW_SECONDS: string;

  @IsOptional()
  @IsNumberString()
  MCP_RATE_LIMIT_MAX_REQUESTS: string;

  @IsOptional()
  @MinLength(32)
  @IsString()
  MCP_METRICS_TOKEN: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  @IsString()
  VECTOR_SEARCH_ENABLED: string;

  @ValidateIf(
    (obj) => obj.MCP_ENABLED === 'true' && obj.VECTOR_SEARCH_ENABLED === 'true',
  )
  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  EMBEDDING_BASE_URL: string;

  @ValidateIf(
    (obj) => obj.MCP_ENABLED === 'true' && obj.VECTOR_SEARCH_ENABLED === 'true',
  )
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
  EMBEDDING_BATCH_SIZE: string;

  @IsOptional()
  @IsNumberString()
  EMBEDDING_TIMEOUT_MS: string;

  @IsOptional()
  @IsNumberString()
  EMBEDDING_MAX_RETRIES: string;

  @IsOptional()
  @IsNumberString()
  EMBEDDING_RETRY_BASE_DELAY_MS: string;

  @IsOptional()
  @IsNumberString()
  VECTOR_CHUNK_MAX_CHARS: string;

  @IsOptional()
  @IsNumberString()
  VECTOR_CHUNK_OVERLAP_CHARS: string;

  @IsOptional()
  @IsNumberString()
  VECTOR_HYBRID_SEMANTIC_WEIGHT: string;

  @IsOptional()
  @IsNumberString()
  VECTOR_HYBRID_KEYWORD_WEIGHT: string;

  @IsOptional()
  @IsNumberString()
  VECTOR_HYBRID_RECENCY_WEIGHT: string;

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

export function validate(config: Record<string, any>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config);

  const errors = validateSync(validatedConfig);

  if (errors.length > 0) {
    console.error(
      'The Environment variables has failed the following validations:',
    );

    errors.map((error) => {
      console.error(JSON.stringify(error.constraints));
    });

    console.error(
      'Please fix the environment variables and try again. Exiting program...',
    );
    process.exit(1);
  }

  return validatedConfig;
}
