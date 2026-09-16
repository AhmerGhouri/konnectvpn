// src/config/serverStore.ts
//
// Merging the seed list with locally-persisted additions
// The device's local storage is the live source of truth.

import { COUNTRIES, type ServerEntry } from './vpnConfig';
import { AsyncStorage } from '../utils/storage';
import { getBundledCountriesList } from '../vpn_countries';

const IMPORTED_SERVERS_KEY = 'konnectvpn_imported_servers';
const DELETED_SERVERS_KEY = 'konnectvpn_deleted_servers';

export type CountryWithServers = {
  code: string;
  label: string;
  flag: string;
  servers: ServerEntry[];
};

type ImportedRecord = {
  countryCode: string;
  countryLabel: string;
  flag: string;
  server: ServerEntry;
};

/**
 * Reads bundled .conf servers and any app-imported servers from storage,
 * merges them into countries.
 */
export async function getAllCountries(): Promise<CountryWithServers[]> {
  const bundled = getBundledCountriesList();

  // Start with bundled countries if present, otherwise fallback to seed COUNTRIES
  const baseList = bundled.length > 0 ? bundled : COUNTRIES;

  const merged: CountryWithServers[] = baseList.map((c) => ({
    code: c.code,
    label: c.label,
    flag: c.flag,
    servers: [...c.servers],
  }));

  try {
    const raw = await AsyncStorage.getItem(IMPORTED_SERVERS_KEY);
    if (raw) {
      const records: ImportedRecord[] = JSON.parse(raw);
      for (const item of records) {
        let country = merged.find((c) => c.code.toLowerCase() === item.countryCode.toLowerCase());
        if (!country) {
          country = {
            code: item.countryCode,
            label: item.countryLabel,
            flag: item.flag,
            servers: [],
          };
          merged.push(country);
        }

        // Avoid duplicate server id
        const exists = country.servers.some((s) => s.id === item.server.id);
        if (!exists) {
          country.servers.push(item.server);
        }
      }
    }
  } catch (err) {
    console.error('[serverStore] Failed to load imported servers:', err);
  }

  const deletedRaw = await AsyncStorage.getItem(DELETED_SERVERS_KEY);
  const deletedIds: string[] = deletedRaw ? JSON.parse(deletedRaw) : [];
  return merged
    .map((country) => ({
      ...country,
      servers: country.servers.filter((server) => !deletedIds.includes(server.id)),
    }))
    .filter((country) => country.servers.length > 0);
}

/**
 * Persists a single new server (non-sensitive fields only) into
 * storage under the given country.
 */
export async function appendImportedServer(
  countryCode: string,
  countryLabel: string,
  flag: string,
  server: ServerEntry,
): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(IMPORTED_SERVERS_KEY);
    const records: ImportedRecord[] = raw ? JSON.parse(raw) : [];

    // Filter out if existing id
    const filtered = records.filter((r) => r.server.id !== server.id);
    filtered.push({
      countryCode,
      countryLabel,
      flag,
      server,
    });

    await AsyncStorage.setItem(IMPORTED_SERVERS_KEY, JSON.stringify(filtered));
    const deletedRaw = await AsyncStorage.getItem(DELETED_SERVERS_KEY);
    const deletedIds: string[] = deletedRaw ? JSON.parse(deletedRaw) : [];
    await AsyncStorage.setItem(
      DELETED_SERVERS_KEY,
      JSON.stringify(deletedIds.filter((id) => id !== server.id)),
    );
  } catch (err) {
    console.error('[serverStore] Failed to append imported server:', err);
    throw err;
  }
}

/**
 * Removes a server locally, including hiding bundled entries on this device.
 */
export async function removeImportedServer(serverId: string): Promise<void> {
  try {
    const deletedRaw = await AsyncStorage.getItem(DELETED_SERVERS_KEY);
    const deletedIds: string[] = deletedRaw ? JSON.parse(deletedRaw) : [];
    if (!deletedIds.includes(serverId)) {
      await AsyncStorage.setItem(DELETED_SERVERS_KEY, JSON.stringify([...deletedIds, serverId]));
    }
    const raw = await AsyncStorage.getItem(IMPORTED_SERVERS_KEY);
    if (raw) {
      const records: ImportedRecord[] = JSON.parse(raw);
      const filtered = records.filter((r) => r.server.id !== serverId);
      await AsyncStorage.setItem(IMPORTED_SERVERS_KEY, JSON.stringify(filtered));
    }

    const rawConfigs = await AsyncStorage.getItem('konnectvpn_imported_configs');
    if (rawConfigs) {
      const configs = JSON.parse(rawConfigs);
      if (configs[serverId]) {
        delete configs[serverId];
        await AsyncStorage.setItem('konnectvpn_imported_configs', JSON.stringify(configs));
      }
    }

    console.log(`[serverStore] ✅ Removed server "${serverId}" from Keychain.`);
  } catch (err) {
    console.error(`[serverStore] Failed to remove server "${serverId}":`, err);
    throw err;
  }
}

/**
 * Removes all imported server entries and cached configurations from storage / Keychain.
 */
export async function clearImportedServers(): Promise<void> {
  try {
    await AsyncStorage.removeItem(IMPORTED_SERVERS_KEY);
    await AsyncStorage.removeItem('konnectvpn_imported_configs');
    await AsyncStorage.removeItem('konnectvpn_preprovisioned_servers');
    await AsyncStorage.removeItem('konnectvpn_last_connected_server');
    console.log('[serverStore] ✅ Successfully cleared all server entries from Keychain.');
  } catch (err) {
    console.error('[serverStore] Failed to clear imported servers:', err);
    throw err;
  }
}

