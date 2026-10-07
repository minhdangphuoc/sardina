import * as assert from 'assert';
import * as net from 'node:net';
import { endpointKey, isReachable } from '../../../src/devices/reachability';

describe('device reachability probe', () => {
  it('is true for a listening port and false for a closed one', async () => {
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    assert.strictEqual(await isReachable('127.0.0.1', port, 1000), true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.strictEqual(await isReachable('127.0.0.1', port, 1000), false);
  });

  it('times out as false for an unroutable address', async () => {
    const started = Date.now();
    assert.strictEqual(await isReachable('192.0.2.1', 22, 300), false); // TEST-NET-1, never routed
    assert.ok(Date.now() - started < 2000);
  });

  it('keys endpoints only when host and port are known', () => {
    assert.strictEqual(endpointKey('192.168.2.16', 22), '192.168.2.16:22');
    assert.strictEqual(endpointKey(undefined, 22), undefined);
    assert.strictEqual(endpointKey('h', undefined), undefined);
  });
});

describe('device reachability probe, IPv6', () => {
  it('accepts a bracketed IPv6 address as sfdk prints it', async function () {
    const server = net.createServer((s) => s.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '::1', resolve);
      });
    } catch {
      this.skip(); // no IPv6 loopback on this host
    }
    const port = (server.address() as net.AddressInfo).port;
    try {
      assert.strictEqual(await isReachable('[::1]', port, 1000), true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
