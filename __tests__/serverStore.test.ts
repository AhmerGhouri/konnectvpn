import { AsyncStorage } from '../src/utils/storage';
import { getAllCountries, appendImportedServer, removeImportedServer } from '../src/config/serverStore';
import { getBundledCountriesList } from '../src/vpn_countries';

jest.mock('../src/utils/storage', () => {
  const values = new Map();
  return { AsyncStorage: {
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => { values.set(key, value); }),
    removeItem: jest.fn(async (key: string) => { values.delete(key); }),
  } };
});
jest.mock('../src/vpn_countries', () => ({ getBundledCountriesList: jest.fn(() => []) }));

const server = { id: 'test-1', label: 'Test', interfaceName: 'wg-konnect', endpointIp: '192.0.2.1' };

beforeEach(async () => {
  for (const key of ['konnectvpn_imported_servers', 'konnectvpn_imported_configs', 'konnectvpn_deleted_servers']) {
    await AsyncStorage.removeItem(key);
  }
  (getBundledCountriesList as jest.Mock).mockReturnValue([]);
});

it('has no default servers on a fresh installation', async () => {
  expect(await getAllCountries()).toEqual([]);
});

it('deletes an imported server and its configuration, then permits reimport', async () => {
  await appendImportedServer('test', 'Test country', '', server);
  await AsyncStorage.setItem('konnectvpn_imported_configs', JSON.stringify({ [server.id]: 'config' }));
  await removeImportedServer(server.id);
  expect(await getAllCountries()).toEqual([]);
  expect(JSON.parse((await AsyncStorage.getItem('konnectvpn_imported_configs'))!)).toEqual({});
  await appendImportedServer('test', 'Test country', '', server);
  expect((await getAllCountries())[0].servers).toEqual([server]);
});

it('keeps a deleted bundled server hidden when countries are reloaded', async () => {
  (getBundledCountriesList as jest.Mock).mockReturnValue([
    { code: 'test', label: 'Test country', flag: '', servers: [server] },
  ]);
  await removeImportedServer(server.id);
  expect(await getAllCountries()).toEqual([]);
  expect(await getAllCountries()).toEqual([]);
});
