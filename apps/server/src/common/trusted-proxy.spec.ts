import { parseTrustedProxyCidrs } from './trusted-proxy';

describe('trusted proxy configuration', () => {
  it('trusts loopback proxies only by default', () => {
    expect(parseTrustedProxyCidrs(undefined)).toEqual([
      '127.0.0.1/8',
      '::1/128',
    ]);
  });

  it('supports explicit multi-instance ingress networks', () => {
    expect(
      parseTrustedProxyCidrs('10.40.0.0/16, 172.20.1.10, fd00::/64'),
    ).toEqual(['10.40.0.0/16', '172.20.1.10', 'fd00::/64']);
  });

  it.each(['anything', '10.0.0.0/33', 'fd00::/129', '10.0.0.1/24/extra'])(
    'rejects invalid proxy entry %s',
    (value) => {
      expect(() => parseTrustedProxyCidrs(value)).toThrow(
        /Invalid trusted proxy/,
      );
    },
  );
});
