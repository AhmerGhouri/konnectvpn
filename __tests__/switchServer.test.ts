import { switchServer, checkRouterInternet } from '../src/api/routerClient';

jest.mock('react-native-keychain', () => ({
  getGenericPassword: jest.fn(async () => ({ username: 'test', password: 'test' })),
}));
jest.mock('../src/config/vpnConfig', () => ({ ROUTER_BASE_URL: 'http://router.test' }));
jest.mock('../src/config/serverStore', () => ({ getAllCountries: jest.fn(), appendImportedServer: jest.fn() }));
jest.mock('../src/utils/storage', () => ({ AsyncStorage: { getItem: jest.fn(async () => null), setItem: jest.fn() } }));
jest.mock('../src/vpn_countries', () => ({ ALL_BUNDLED_SERVERS: [{
  serverId: 'test-new', countryCode: 'test',
  rawConf: '[Interface]\nPrivateKey = test-private\nAddress = 10.2.0.2/32\nDNS = 10.2.0.1, 2a07:b944::2:1\n[Peer]\nPublicKey = test-public\nEndpoint = 192.0.2.10:51820',
}] }));

let resources: Record<string, any[]>;
let failedRead: string | undefined;
let failedDelete: string | undefined;
let failedPut: string | undefined;
const fetchMock = jest.fn();
const originalFetch = globalThis.fetch;
beforeEach(() => {
  failedRead = undefined;
  failedDelete = undefined;
  failedPut = undefined;
  resources = {
    '/rest/ip/route': [
      { '.id': 'wan', 'dst-address': '0.0.0.0/0', gateway: '192.0.2.1' },
      ...['split1', 'split2', 'endpoint'].map((name) => ({ '.id': name, comment: `konnect-vpn-${name}` })),
    ],
    '/rest/interface/wireguard': [{ '.id': 'wg', name: 'wg-konnect' }],
    '/rest/interface/wireguard/peers': [{ '.id': 'peer', interface: 'wg-konnect' }, { '.id': 'other-peer', interface: 'other' }],
    '/rest/ip/address': [{ '.id': 'addr', interface: 'wg-konnect', comment: 'konnect-vpn-address' }, { '.id': 'lan', interface: 'ether2' }],
    '/rest/ip/firewall/nat': [{ '.id': 'nat', comment: 'konnect-vpn-nat', 'out-interface': 'wg-konnect' }, { '.id': 'wan-nat', comment: 'Local Route', chain: 'srcnat' }],
    '/rest/ip/firewall/mangle': [{ '.id': 'mss', comment: 'konnect-vpn-mss' }],
  };
  fetchMock.mockReset().mockImplementation(async (url: string, options: any) => {
    const path = url.replace('http://router.test', '');
    const failed = options.method === 'GET' && path === failedRead || options.method === 'DELETE' && path === failedDelete || options.method === 'PUT' && path === failedPut;
    if (options.method === 'DELETE' && !failed) {
      const base = path.slice(0, path.lastIndexOf('/'));
      resources[base] = resources[base].filter((item) => item['.id'] !== path.split('/').pop());
    }
    return { ok: !failed, status: failed ? 500 : 200, json: async () => resources[path] || [] };
  });
  globalThis.fetch = fetchMock;
});
afterAll(() => { globalThis.fetch = originalFetch; });

it('deletes only the previous app policy before recreating it without stale route IDs', async () => {
  await switchServer('test-new');
  const calls = fetchMock.mock.calls.map(([url, options]) => ({ path: url.replace('http://router.test', ''), method: options.method }));
  expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([
    '/rest/ip/route/split1', '/rest/ip/route/split2', '/rest/ip/route/endpoint',
    '/rest/interface/wireguard/peers/peer', '/rest/ip/address/addr', '/rest/ip/firewall/nat/nat', '/rest/interface/wireguard/wg',
  ]);
  const writes = calls.filter((call) => ['DELETE', 'PUT', 'PATCH'].includes(call.method));
  expect(writes.slice(0, 7).every((call) => call.method === 'DELETE')).toBe(true);
  expect(calls.filter((call) => call.method === 'PUT').map((call) => call.path)).toEqual([
    '/rest/interface/wireguard', '/rest/interface/wireguard/peers', '/rest/ip/address', '/rest/ip/firewall/nat',
    '/rest/ip/route', '/rest/ip/route', '/rest/ip/route',
  ]);
  expect(calls.filter((call) => call.method === 'PATCH').map((call) => call.path)).toEqual(['/rest/ip/firewall/mangle/mss']);
});

it('does not delete anything if a policy read fails', async () => {
  failedRead = '/rest/ip/firewall/nat';
  await expect(switchServer('test-new')).rejects.toThrow('Failed to read existing VPN policy');
  expect(fetchMock.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
});

it('stops the switch when deletion fails', async () => {
  failedDelete = '/rest/ip/route/split1';
  await expect(switchServer('test-new')).rejects.toThrow('Failed to remove existing VPN policy');
  expect(fetchMock.mock.calls.some(([, options]) => ['PATCH', 'PUT'].includes(options.method))).toBe(false);
});

it('creates the address with a single IPv4 network for dual-stack DNS configurations', async () => {
  await switchServer('test-new');
  const call = fetchMock.mock.calls.find(([url, options]) => url.endsWith('/rest/ip/address') && options.method === 'PUT');
  expect(JSON.parse(call![1].body)).toMatchObject({ address: '10.2.0.2/32', network: '10.2.0.1' });
});

it.each(['/rest/interface/wireguard/peers', '/rest/ip/address'])('reports rejected creation of %s instead of continuing', async (path) => {
  failedPut = path;
  await expect(switchServer('test-new')).rejects.toThrow('Failed to configure');
  expect(fetchMock.mock.calls.some(([url, options]) => url.endsWith('/rest/ip/firewall/nat') && options.method === 'PUT')).toBe(false);
});

describe('router internet checks', () => {
  const pingResponse = (sent: string, received: string) => ({ ok: true, json: async () => [{ sent, received }] });

  it('uses router ping and succeeds when the first target replies', async () => {
    fetchMock.mockResolvedValue(pingResponse('1', '1'));
    expect(await checkRouterInternet()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://router.test/rest/ping');
    expect(JSON.parse(options.body)).toEqual({ address: '1.1.1.1', count: '1' });
  });

  it('tries Google when Cloudflare times out', async () => {
    fetchMock.mockResolvedValueOnce(pingResponse('1', '0')).mockResolvedValueOnce(pingResponse('1', '1'));
    expect(await checkRouterInternet()).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).address).toBe('8.8.8.8');
  });

  it('reports unavailable only when both targets receive no replies', async () => {
    fetchMock.mockResolvedValue(pingResponse('1', '0'));
    expect(await checkRouterInternet()).toBe(false);
  });

  it('reports unknown when the router cannot be reached', async () => {
    fetchMock.mockRejectedValue(new Error('Network unavailable'));
    expect(await checkRouterInternet()).toBeNull();
  });
});

it('rebinds the MSS rule after recreating the WireGuard interface', async () => {
  resources['/rest/ip/firewall/mangle'][0]['out-interface'] = '*deleted';
  resources['/rest/ip/firewall/mangle'][0].invalid = 'true';
  await switchServer('test-new');
  const call = fetchMock.mock.calls.find(([url, options]) => url.endsWith('/rest/ip/firewall/mangle/mss') && options.method === 'PATCH');
  expect(JSON.parse(call![1].body)).toEqual({ 'out-interface': 'wg-konnect' });
});
