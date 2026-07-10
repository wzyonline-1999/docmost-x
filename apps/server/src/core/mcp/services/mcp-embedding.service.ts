import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { McpMetricsService } from './mcp-metrics.service';

type EmbeddingApiItem = {
  embedding?: unknown;
  index?: number;
};

type EmbeddingApiResponse = {
  data?: EmbeddingApiItem[];
  error?: string | { message?: string };
};

class EmbeddingProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

class EmbeddingProviderTimeoutError extends Error {}

@Injectable()
export class McpEmbeddingService {
  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly metricsService: McpMetricsService,
  ) {}

  async createEmbeddings(inputs: string[]): Promise<number[][]> {
    if (!inputs.length) {
      return [];
    }

    const startedAt = process.hrtime.bigint();
    let outcome = 'success';

    try {
      const batchSize = Math.max(
        1,
        this.environmentService.getEmbeddingBatchSize(),
      );
      const embeddings: number[][] = [];

      for (let offset = 0; offset < inputs.length; offset += batchSize) {
        const batch = inputs.slice(offset, offset + batchSize);
        embeddings.push(...(await this.createEmbeddingBatch(batch)));
      }

      return embeddings;
    } catch (err) {
      outcome = 'failed';
      throw err;
    } finally {
      this.metricsService.observeEmbedding(
        outcome,
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
        inputs.length,
      );
    }
  }

  private async createEmbeddingBatch(inputs: string[]): Promise<number[][]> {
    const maxRetries = Math.max(
      0,
      this.environmentService.getEmbeddingMaxRetries(),
    );
    let attempt = 0;

    while (true) {
      try {
        return await this.requestEmbeddingBatch(inputs);
      } catch (err) {
        if (attempt >= maxRetries || !this.isRetryableError(err)) {
          throw this.toProviderException(err);
        }

        await this.waitBeforeRetry(attempt);
        attempt += 1;
      }
    }
  }

  private async requestEmbeddingBatch(inputs: string[]): Promise<number[][]> {
    const apiKey = this.environmentService.getEmbeddingApiKey();
    if (!apiKey) {
      throw new InternalServerErrorException(
        'Embedding API key is not configured',
      );
    }

    const dimensions = this.environmentService.getEmbeddingDimensions();
    const response = await this.fetchWithTimeout(
      this.getEmbeddingsUrl(),
      apiKey,
      inputs,
      dimensions,
    );

    const responseBody = await this.readJsonResponse(response);
    if (!response.ok) {
      throw new EmbeddingProviderHttpError(
        response.status,
        `Embedding provider request failed with status ${response.status}`,
      );
    }

    const embeddings = this.normalizeEmbeddings(responseBody);
    if (embeddings.length !== inputs.length) {
      throw new BadGatewayException(
        `Embedding provider returned ${embeddings.length} vectors for ${inputs.length} inputs`,
      );
    }

    for (const embedding of embeddings) {
      this.assertEmbeddingDimensions(embedding, dimensions);
    }

    return embeddings;
  }

  private async fetchWithTimeout(
    url: string,
    apiKey: string,
    inputs: string[],
    dimensions: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = Math.max(
      1,
      this.environmentService.getEmbeddingTimeoutMs(),
    );
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.environmentService.getEmbeddingModel(),
          input: inputs,
          dimensions,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new EmbeddingProviderTimeoutError(
          `Embedding provider timed out after ${timeoutMs}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private isRetryableError(err: unknown): boolean {
    if (
      err instanceof EmbeddingProviderTimeoutError ||
      err instanceof TypeError
    ) {
      return true;
    }

    return (
      err instanceof EmbeddingProviderHttpError &&
      (err.status === 408 || err.status === 429 || err.status >= 500)
    );
  }

  private toProviderException(err: unknown): Error {
    if (err instanceof BadGatewayException) {
      return err;
    }
    if (
      err instanceof EmbeddingProviderHttpError ||
      err instanceof EmbeddingProviderTimeoutError
    ) {
      return new BadGatewayException(err.message);
    }
    if (err instanceof TypeError) {
      return new BadGatewayException(
        'Embedding provider network request failed',
      );
    }
    return err instanceof Error
      ? err
      : new BadGatewayException('Embedding provider request failed');
  }

  private async waitBeforeRetry(attempt: number): Promise<void> {
    const baseDelayMs = Math.max(
      0,
      this.environmentService.getEmbeddingRetryBaseDelayMs(),
    );
    const delayMs = baseDelayMs * 2 ** attempt;
    if (delayMs <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private getEmbeddingsUrl(): string {
    const baseUrl = this.environmentService.getEmbeddingBaseUrl();
    if (!baseUrl) {
      throw new InternalServerErrorException(
        'Embedding base URL is not configured',
      );
    }

    const trimmed = baseUrl.replace(/\/+$/, '');
    if (trimmed.endsWith('/embeddings')) {
      return trimmed;
    }

    if (trimmed.endsWith('/v1')) {
      return `${trimmed}/embeddings`;
    }

    return `${trimmed}/v1/embeddings`;
  }

  private async readJsonResponse(
    response: Response,
  ): Promise<EmbeddingApiResponse> {
    try {
      return (await response.json()) as EmbeddingApiResponse;
    } catch (err) {
      throw new BadGatewayException('Embedding provider returned invalid JSON');
    }
  }

  private normalizeEmbeddings(response: EmbeddingApiResponse): number[][] {
    const data = response.data;
    if (!Array.isArray(data)) {
      throw new BadGatewayException(
        'Embedding provider response is missing data',
      );
    }

    return data
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item) => {
        if (!Array.isArray(item.embedding)) {
          throw new BadGatewayException(
            'Embedding provider response contains an invalid vector',
          );
        }

        return item.embedding.map((value) => {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new BadGatewayException(
              'Embedding provider response contains a non-numeric vector value',
            );
          }

          return value;
        });
      });
  }

  private assertEmbeddingDimensions(
    embedding: number[],
    expectedDimensions: number,
  ): void {
    if (embedding.length !== expectedDimensions) {
      throw new BadGatewayException(
        `Embedding provider returned ${embedding.length} dimensions, expected ${expectedDimensions}`,
      );
    }
  }
}
