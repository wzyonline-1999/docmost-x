import type { Json } from '@docmost/db/types/db';

export type McpVectorTextChunk = {
  chunkIndex: number;
  content: string;
  contentHash: string;
  startOffset: number;
  endOffset: number;
  charLength: number;
  sourceType?: 'page' | 'attachment';
  attachmentId?: string;
  attachmentFileName?: string;
};

export type McpVectorPageInput = {
  pageId: string;
  workspaceId: string;
  spaceId?: string | null;
  requestedByClientId?: string | null;
  requestedByUserId?: string | null;
};

export type McpVectorIndexJobType =
  | 'page'
  | 'space'
  | 'workspace'
  | 'delete'
  | 'restore';

export type McpVectorIndexJobStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type McpVectorIndexResult = {
  jobId: string;
  jobType: McpVectorIndexJobType;
  pageId: string;
  workspaceId: string;
  spaceId: string | null;
  status: 'succeeded' | 'failed';
  chunkCount: number;
  embeddedCount: number;
  deleted: boolean;
  skipped?: boolean;
  skippedReason?: string;
};

export type McpVectorQueuedJob = {
  jobId: string;
  jobType: McpVectorIndexJobType;
  pageId?: string | null;
  spaceId?: string | null;
  workspaceId: string;
  status: 'queued';
};

export type McpVectorQueueJobData = {
  indexJobId: string;
};

export type McpVectorBatchIndexInput = {
  workspaceId: string;
  spaceId?: string | null;
  spaceIds?: string[];
  requestedByClientId?: string | null;
  requestedByUserId?: string | null;
  limit?: number;
};

export type McpVectorBatchIndexResult = {
  jobId: string;
  jobType: 'space' | 'workspace';
  workspaceId: string;
  spaceId?: string | null;
  status: 'waiting' | 'succeeded' | 'failed' | 'paused' | 'cancelled';
  queuedPageCount: number;
  scannedPageCount?: number;
  batchCount?: number;
};

export type McpVectorIndexStats = Json & {
  chunkCount?: number;
  embeddedCount?: number;
  reusedCount?: number;
  model?: string;
  dimensions?: number;
  contentLength?: number;
  attachmentCount?: number;
  attachmentChunkCount?: number;
  deleted?: boolean;
  skipped?: boolean;
  skippedReason?: string;
  queuedPageCount?: number;
  scannedPageCount?: number;
  batchCount?: number;
  lastCursor?: string | null;
  childCounts?: Record<string, number>;
};
