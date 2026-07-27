import { isIP } from 'node:net';

const DEFAULT_TRUSTED_PROXY_CIDRS = ['127.0.0.1/8', '::1/128'];

export function parseTrustedProxyCidrs(
  value = process.env.TRUSTED_PROXY_CIDRS,
): string[] {
  const entries = value
    ? value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : DEFAULT_TRUSTED_PROXY_CIDRS;

  if (entries.length === 0) {
    throw new Error('TRUSTED_PROXY_CIDRS must contain at least one IP or CIDR');
  }

  for (const entry of entries) {
    const [address, prefix, extra] = entry.split('/');
    const version = isIP(address);
    if (version === 0 || extra !== undefined) {
      throw new Error(`Invalid trusted proxy IP or CIDR: ${entry}`);
    }
    if (prefix === undefined) {
      continue;
    }

    const prefixValue = Number(prefix);
    const maxPrefix = version === 4 ? 32 : 128;
    if (
      !/^\d+$/.test(prefix) ||
      !Number.isInteger(prefixValue) ||
      prefixValue < 0 ||
      prefixValue > maxPrefix
    ) {
      throw new Error(`Invalid trusted proxy CIDR prefix: ${entry}`);
    }
  }

  return entries;
}
