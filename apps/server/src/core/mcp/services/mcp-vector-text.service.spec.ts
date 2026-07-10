import {
  chunkVectorText,
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
});
