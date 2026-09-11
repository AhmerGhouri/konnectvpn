// src/config/serverStore.ts
//
// Merging the seed list with locally-persisted additions
// The device's local storage is the live source of truth.

import { COUNTRIES, type ServerEntry } from './vpnConfig';
import { AsyncStorage } from '../utils/storage';
import { getBundledCountriesList } from '../vpn_countries';

const IMPORTED_SERVERS_KEY = 'konnectvpn_imported_servers';

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

  return merged;
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
  } catch (err) {
    console.error('[serverStore] Failed to append imported server:', err);
    throw err;
  }
}
