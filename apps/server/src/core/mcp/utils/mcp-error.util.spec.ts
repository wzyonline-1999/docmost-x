import { BadGatewayException } from '@nestjs/common';
import { getMcpErrorType, getMcpSafeErrorMessage } from './mcp-error.util';

describe('MCP error helpers', () => {
  it('preserves controlled HTTP exception messages as a single line', () => {
    expect(
      getMcpSafeErrorMessage(
        new BadGatewayException('Vector provider\nis unavailable'),
        'Vector operation failed',
      ),
    ).toBe('Vector provider is unavailable');
  });

  it('does not expose messages from unexpected exceptions', () => {
    const message = getMcpSafeErrorMessage(
      new Error('secret-token and page content'),
      'Vector operation failed',
    );

    expect(message).toBe('Vector operation failed (Error)');
    expect(message).not.toContain('secret-token');
    expect(message).not.toContain('page content');
  });

  it('normalizes error types without trusting a malicious error name', () => {
    const error = new Error('hidden');
    error.name = 'Error secret-token\ncontent';

    expect(getMcpErrorType(error)).toBe('Error');
    expect(getMcpErrorType('rejected')).toBe('string');
  });
});
