import { HttpException } from '@nestjs/common';

const MAX_SAFE_ERROR_MESSAGE_LENGTH = 500;
const ERROR_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;

export function getMcpErrorType(err: unknown): string {
  if (!(err instanceof Error)) {
    return typeof err;
  }

  if (ERROR_TYPE_PATTERN.test(err.name)) {
    return err.name;
  }

  const constructorName = err.constructor?.name;
  return constructorName && ERROR_TYPE_PATTERN.test(constructorName)
    ? constructorName
    : 'Error';
}

export function getMcpSafeErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof HttpException) {
    const response = err.getResponse();
    const message =
      typeof response === 'string'
        ? response
        : response &&
            typeof response === 'object' &&
            'message' in response &&
            typeof response.message === 'string'
          ? response.message
          : null;

    if (message) {
      return message
        .replace(/[\r\n]+/g, ' ')
        .slice(0, MAX_SAFE_ERROR_MESSAGE_LENGTH);
    }
  }

  return `${fallback} (${getMcpErrorType(err)})`;
}
