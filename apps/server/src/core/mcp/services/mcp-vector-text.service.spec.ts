import {
  chunkVectorText,
  McpVectorTextService,
  normalizeVectorText,
} from './mcp-vector-text.service';

describe('MCP vector text helpers', () => {
  it('normalizes repeated spaces and blank lines', () => {
    expect(normalizeVectorText(' a   b \r\n\r\n\r\n c\t d ')).toBe(
      'a b\n\nc d',
    );
  });

  it('chunks text with deterministic overlap', () => {
    const chunks = chunkVectorText('abcdefghi', {
      maxChars: 4,
      overlapChars: 1,
    });

    expect(chunks.map((chunk) => chunk.content)).toEqual([
      'abcd',
      'defg',
      'ghi',
    ]);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2]);
  });

  it('clamps overlap below max chars to avoid infinite loops', () => {
    const chunks = chunkVectorText('abcdef', {
      maxChars: 3,
      overlapChars: 99,
    });

    expect(chunks.map((chunk) => chunk.content)).toEqual([
      'abc',
      'bcd',
      'cde',
      'def',
    ]);
  });

  it('builds source-aware page and attachment chunks', () => {
    const service = new McpVectorTextService({
      getVectorChunkMaxChars: () => 100,
      getVectorChunkOverlapChars: () => 0,
    } as never);

    const chunks = service.buildDocumentChunks(
      { title: 'Page title', textContent: 'Page body' },
      [
        {
          id: 'attachment-1',
          fileName: 'report.pdf',
          textContent: 'Attachment body',
        },
      ],
    );

    expect(chunks).toEqual([
      expect.objectContaining({
        chunkIndex: 0,
        sourceType: 'page',
        content: 'Page title\n\nPage body',
      }),
      expect.objectContaining({
        chunkIndex: 1,
        sourceType: 'attachment',
        attachmentId: 'attachment-1',
        attachmentFileName: 'report.pdf',
        content: 'Attachment: report.pdf\n\nAttachment body',
      }),
    ]);
  });

  it('skips attachments without extracted text', () => {
    const service = new McpVectorTextService({
      getVectorChunkMaxChars: () => 100,
      getVectorChunkOverlapChars: () => 0,
    } as never);

    const chunks = service.buildDocumentChunks(
      { title: 'Page title', textContent: null },
      [
        {
          id: 'attachment-1',
          fileName: 'image.png',
          textContent: null,
        },
        {
          id: 'attachment-2',
          fileName: 'empty.txt',
          textContent: '  \r\n ',
        },
      ],
    );

    expect(chunks).toEqual([
      expect.objectContaining({
        chunkIndex: 0,
        sourceType: 'page',
        content: 'Page title',
      }),
    ]);
  });
});
