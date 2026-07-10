import { BadGatewayException } from '@nestjs/common';
import type { EnvironmentService } from '../../../integrations/environment/environment.service';
import { McpEmbeddingService } from './mcp-embedding.service';

describe('McpEmbeddingService', () => {
  const environmentService = {
    getEmbeddingApiKey: jest.fn(() => 'test-key'),
    getEmbeddingBaseUrl: jest.fn(() => 'https://embedding.example.com/v1'),
    getEmbeddingBatchSize: jest.fn(() => 2),
    getEmbeddingDimensions: jest.fn(() => 3),
    getEmbeddingMaxRetries: jest.fn(() => 0),
    getEmbeddingModel: jest.fn(() => 'test-embedding-model'),
    getEmbeddingRetryBaseDelayMs: jest.fn(() => 0),
    getEmbeddingTimeoutMs: jest.fn(() => 1000),
  };
  const metricsService = {
    observeEmbedding: jest.fn(),
  };

  let service: McpEmbeddingService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new McpEmbeddingService(
      environmentService as unknown as EnvironmentService,
      metricsService as never,
    );
    globalThis.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;
  });

  it('returns an empty list without calling the provider for empty input', async () => {
    await expect(service.createEmbeddings([])).resolves.toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('calls an OpenAI-compatible embeddings endpoint in batches', async () => {
    (globalThis.fetch as jest.MockedFunction<typeof fetch>)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { index: 0, embedding: [0.1, 0.2, 0.3] },
            { index: 1, embedding: [0.4, 0.5, 0.6] },
          ],
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ index: 0, embedding: [0.7, 0.8, 0.9] }],
        }),
      } as Response);

    await expect(
      service.createEmbeddings(['first', 'second', 'third']),
    ).resolves.toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
      [0.7, 0.8, 0.9],
    ]);

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(metricsService.observeEmbedding).toHaveBeenCalledWith(
      'success',
      expect.any(Number),
      3,
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      'https://embedding.example.com/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'test-embedding-model',
          input: ['first', 'second'],
          dimensions: 3,
        }),
      }),
    );
  });

  it('rejects vectors with unexpected dimensions', async () => {
    (
      globalThis.fetch as jest.MockedFunction<typeof fetch>
    ).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ index: 0, embedding: [0.1, 0.2] }],
      }),
    } as Response);

    await expect(service.createEmbeddings(['first'])).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('rejects invalid JSON and missing provider data with safe errors', async () => {
    (globalThis.fetch as jest.MockedFunction<typeof fetch>)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('invalid json');
        },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: [] }),
      } as Response);

    await expect(service.createEmbeddings(['first'])).rejects.toThrow(
      'returned invalid JSON',
    );
    await expect(service.createEmbeddings(['first'])).rejects.toThrow(
      'response is missing data',
    );
  });

  it('rejects a vector count that does not match the input batch', async () => {
    (
      globalThis.fetch as jest.MockedFunction<typeof fetch>
    ).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    } as Response);

    await expect(service.createEmbeddings(['first'])).rejects.toThrow(
      'returned 0 vectors for 1 inputs',
    );
  });

  it.each(['not-a-number', null, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a non-finite vector value %p',
    async (value) => {
      (
        globalThis.fetch as jest.MockedFunction<typeof fetch>
      ).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ index: 0, embedding: [0.1, 0.2, value] }],
        }),
      } as Response);

      await expect(service.createEmbeddings(['first'])).rejects.toThrow(
        'non-numeric vector value',
      );
    },
  );

  it('sorts provider vectors by index before validating dimensions', async () => {
    (
      globalThis.fetch as jest.MockedFunction<typeof fetch>
    ).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { index: 1, embedding: [0.4, 0.5, 0.6] },
          { index: 0, embedding: [0.1, 0.2, 0.3] },
        ],
      }),
    } as Response);

    await expect(
      service.createEmbeddings(['first', 'second']),
    ).resolves.toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
  });

  it('retries transient provider errors and then succeeds', async () => {
    environmentService.getEmbeddingMaxRetries.mockReturnValueOnce(1);
    (globalThis.fetch as jest.MockedFunction<typeof fetch>)
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({ error: { message: 'temporary failure' } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
        }),
      } as Response);

    await expect(service.createEmbeddings(['first'])).resolves.toEqual([
      [0.1, 0.2, 0.3],
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient provider errors', async () => {
    environmentService.getEmbeddingMaxRetries.mockReturnValueOnce(2);
    (
      globalThis.fetch as jest.MockedFunction<typeof fetch>
    ).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'bad request' } }),
    } as Response);

    await expect(service.createEmbeddings(['first'])).rejects.toThrow(
      'status 400',
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not expose provider response messages in public errors', async () => {
    (
      globalThis.fetch as jest.MockedFunction<typeof fetch>
    ).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          message: 'secret-token and submitted page content',
        },
      }),
    } as Response);

    const request = service.createEmbeddings(['restricted page content']);

    await expect(request).rejects.toThrow(
      'Embedding provider request failed with status 400',
    );
    await expect(request).rejects.not.toThrow('secret-token');
    await expect(request).rejects.not.toThrow('submitted page content');
  });

  it('aborts a provider request that exceeds the configured timeout', async () => {
    jest.useFakeTimers();
    environmentService.getEmbeddingTimeoutMs.mockReturnValueOnce(5);
    (
      globalThis.fetch as jest.MockedFunction<typeof fetch>
    ).mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );

    const request = expect(service.createEmbeddings(['first'])).rejects.toThrow(
      'timed out after 5ms',
    );
    await jest.advanceTimersByTimeAsync(5);
    await request;
    jest.useRealTimers();
  });
});
