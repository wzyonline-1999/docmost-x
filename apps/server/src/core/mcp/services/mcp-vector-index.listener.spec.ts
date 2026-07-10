import { Logger } from '@nestjs/common';
import type { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  AUTO_INDEX_DELAY_MS,
  McpVectorIndexService,
} from './mcp-vector-index.service';
import { McpVectorIndexListener } from './mcp-vector-index.listener';

describe('McpVectorIndexListener', () => {
  const environmentService = {
    isVectorSearchEnabled: jest.fn(() => true),
  };
  const vectorIndexService = {
    enqueuePageIds: jest.fn(async () => []),
  };
  let listener: McpVectorIndexListener;

  beforeEach(() => {
    jest.clearAllMocks();
    environmentService.isVectorSearchEnabled.mockReturnValue(true);
    vectorIndexService.enqueuePageIds.mockResolvedValue([]);
    listener = new McpVectorIndexListener(
      environmentService as unknown as EnvironmentService,
      vectorIndexService as unknown as McpVectorIndexService,
    );
  });

  it.each([
    [
      'created',
      'page',
      (target: McpVectorIndexListener) => target.handlePageCreated,
    ],
    [
      'updated',
      'page',
      (target: McpVectorIndexListener) => target.handlePageUpdated,
    ],
    [
      'soft deleted',
      'delete',
      (target: McpVectorIndexListener) => target.handlePageSoftDeleted,
    ],
    [
      'restored',
      'restore',
      (target: McpVectorIndexListener) => target.handlePageRestored,
    ],
  ] as const)(
    'enqueues %s page events as durable %s jobs',
    async (_eventName, jobType, getHandler) => {
      getHandler(listener).call(listener, {
        pageIds: ['page-1', 'page-2'],
        workspaceId: 'workspace-1',
      });
      await Promise.resolve();

      expect(vectorIndexService.enqueuePageIds).toHaveBeenCalledWith({
        pageIds: ['page-1', 'page-2'],
        workspaceId: 'workspace-1',
        jobType,
        delayMs: AUTO_INDEX_DELAY_MS,
      });
    },
  );

  it('does not enqueue when vector search is disabled or page ids are empty', () => {
    environmentService.isVectorSearchEnabled.mockReturnValueOnce(false);
    listener.handlePageCreated({
      pageIds: ['page-1'],
      workspaceId: 'workspace-1',
    });
    listener.handlePageCreated({ pageIds: [] });

    expect(vectorIndexService.enqueuePageIds).not.toHaveBeenCalled();
  });

  it('normalizes a missing workspace and safely contains enqueue failures', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    vectorIndexService.enqueuePageIds.mockRejectedValueOnce(
      new Error('secret-token and page content'),
    );

    listener.handlePageUpdated({ pageIds: ['page-1'] });
    await Promise.resolve();
    await Promise.resolve();

    expect(vectorIndexService.enqueuePageIds).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: null }),
    );
    expect(warn).toHaveBeenCalledWith({
      event: 'mcp.vector.enqueue_failed',
      jobType: 'page',
      errorType: 'Error',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-token');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('page content');
  });

  it('normalizes non-error rejection reasons before logging', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    vectorIndexService.enqueuePageIds.mockRejectedValueOnce('queue offline');

    listener.handlePageSoftDeleted({ pageIds: ['page-1'] });
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith({
      event: 'mcp.vector.enqueue_failed',
      jobType: 'delete',
      errorType: 'string',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('queue offline');
  });
});
