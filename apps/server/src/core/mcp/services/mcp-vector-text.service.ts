import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import type { JSONContent } from '@tiptap/core';
import type { Json } from '@docmost/db/types/db';
import { jsonToText } from '../../../collaboration/collaboration.util';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { McpVectorTextChunk } from '../types/vector.types';
import { getMcpErrorType } from '../utils/mcp-error.util';

export type VectorPageTextSource = {
  title?: string | null;
  content?: Json | null;
  textContent?: string | null;
};

const BOUNDARY_PATTERNS = [
  '\n\n',
  '\n',
  '。',
  '！',
  '？',
  '. ',
  '! ',
  '? ',
  '; ',
];

export function normalizeVectorText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function hashVectorChunk(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function chunkVectorText(
  text: string,
  opts: { maxChars: number; overlapChars: number },
): McpVectorTextChunk[] {
  const normalized = normalizeVectorText(text);
  if (!normalized) {
    return [];
  }

  const maxChars = Math.max(1, opts.maxChars);
  const overlapChars = Math.min(
    Math.max(0, opts.overlapChars),
    Math.max(0, maxChars - 1),
  );
  const chunks: McpVectorTextChunk[] = [];
  let startOffset = 0;

  while (startOffset < normalized.length) {
    const desiredEndOffset = Math.min(
      startOffset + maxChars,
      normalized.length,
    );
    const endOffset =
      desiredEndOffset === normalized.length
        ? desiredEndOffset
        : findChunkBoundary(normalized, startOffset, desiredEndOffset);
    const rawContent = normalized.slice(startOffset, endOffset);
    const content = rawContent.trim();

    if (content) {
      chunks.push({
        chunkIndex: chunks.length,
        content,
        contentHash: hashVectorChunk(content),
        startOffset,
        endOffset,
        charLength: content.length,
      });
    }

    if (endOffset >= normalized.length) {
      break;
    }

    startOffset = Math.max(endOffset - overlapChars, startOffset + 1);
  }

  return chunks;
}

function findChunkBoundary(
  text: string,
  startOffset: number,
  desiredEndOffset: number,
): number {
  const minBoundaryOffset =
    startOffset + Math.floor((desiredEndOffset - startOffset) * 0.6);

  for (const pattern of BOUNDARY_PATTERNS) {
    const searchOffset = Math.max(
      startOffset,
      desiredEndOffset - pattern.length,
    );
    const boundaryOffset = text.lastIndexOf(pattern, searchOffset);
    if (boundaryOffset > minBoundaryOffset) {
      return boundaryOffset + pattern.length;
    }
  }

  return desiredEndOffset;
}

@Injectable()
export class McpVectorTextService {
  private readonly logger = new Logger(McpVectorTextService.name);

  constructor(private readonly environmentService: EnvironmentService) {}

  buildPageText(page: VectorPageTextSource): string {
    const body = this.extractPlainText(page);
    const title = normalizeVectorText(page.title ?? '');
    const parts = [title, body].filter(Boolean);

    return normalizeVectorText(parts.join('\n\n'));
  }

  chunkPageText(text: string): McpVectorTextChunk[] {
    return chunkVectorText(text, {
      maxChars: this.environmentService.getVectorChunkMaxChars(),
      overlapChars: this.environmentService.getVectorChunkOverlapChars(),
    });
  }

  private extractPlainText(page: VectorPageTextSource): string {
    if (page.textContent) {
      return normalizeVectorText(page.textContent);
    }

    if (!page.content || typeof page.content !== 'object') {
      return '';
    }

    try {
      return normalizeVectorText(jsonToText(page.content as JSONContent));
    } catch (err) {
      this.logger.warn({
        event: 'mcp.vector.text_extract_failed',
        errorType: getMcpErrorType(err),
      });
      return '';
    }
  }
}
