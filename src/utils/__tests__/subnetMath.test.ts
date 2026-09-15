// src/utils/__tests__/subnetMath.test.ts
import { computeNetworkAndGateway } from '../subnetMath';

describe('computeNetworkAndGateway', () => {
  it('computes network and gateway for 10.2.0.14/30', () => {
    // 10.2.0.12 network, 10.2.0.13 gateway, 10.2.0.14 client, 10.2.0.15 broadcast
    const res = computeNetworkAndGateway('10.2.0.14/30');
    expect(res.network).toBe('10.2.0.12');
    expect(res.gateway).toBe('10.2.0.13');
  });

  it('computes network and gateway for 10.2.0.2/30', () => {
    // 10.2.0.0 network, 10.2.0.1 gateway, 10.2.0.2 client
    const res = computeNetworkAndGateway('10.2.0.2/30');
    expect(res.network).toBe('10.2.0.0');
    expect(res.gateway).toBe('10.2.0.1');
  });

  it('computes network and gateway for 172.16.10.6/30', () => {
    // 172.16.10.4 network, 172.16.10.5 gateway, 172.16.10.6 client
    const res = computeNetworkAndGateway('172.16.10.6/30');
    expect(res.network).toBe('172.16.10.4');
    expect(res.gateway).toBe('172.16.10.5');
  });

  it('computes network and gateway for 10.2.0.2/32', () => {
    const res = computeNetworkAndGateway('10.2.0.2/32');
    expect(res.network).toBe('10.2.0.1');
    expect(res.gateway).toBe('10.2.0.1');
  });

  it('uses dnsFallback if provided for /32', () => {
    const res = computeNetworkAndGateway('10.2.0.2/32', '10.2.0.254');
    expect(res.network).toBe('10.2.0.254');
    expect(res.gateway).toBe('10.2.0.254');
  });

  it('throws on invalid CIDR', () => {
    expect(() => computeNetworkAndGateway('invalid')).toThrow();
    expect(() => computeNetworkAndGateway('10.2.0.14')).toThrow();
    expect(() => computeNetworkAndGateway('10.2.0.500/30')).toThrow();
  });
});
