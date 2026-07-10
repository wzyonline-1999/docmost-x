import { ConfigService } from '@nestjs/config';
import { EnvironmentService } from './environment.service';

describe('EnvironmentService', () => {
  const createService = (values: Record<string, string> = {}) =>
    new EnvironmentService(new ConfigService(values));

  it('keeps MCP and vector search disabled by default', () => {
    const service = createService();

    expect(service.isMcpEnabled()).toBe(false);
    expect(service.isVectorSearchEnabled()).toBe(false);
  });

  it('keeps vector search disabled unless both feature flags are explicit', () => {
    expect(
      createService({ VECTOR_SEARCH_ENABLED: 'true' }).isVectorSearchEnabled(),
    ).toBe(false);
    expect(createService({ MCP_ENABLED: 'true' }).isVectorSearchEnabled()).toBe(
      false,
    );
    expect(
      createService({
        MCP_ENABLED: 'true',
        VECTOR_SEARCH_ENABLED: 'true',
      }).isVectorSearchEnabled(),
    ).toBe(true);
  });

  it('uses the documented embedding retry and chunk defaults', () => {
    const service = createService();

    expect(service.getEmbeddingMaxRetries()).toBe(3);
    expect(service.getVectorChunkMaxChars()).toBe(4000);
  });
});
