// src/api/batchProvisioner.ts
//
// Automatically provisions all bundled .conf files to the router ahead of time (Option A).
// Allows one-tap live switching to any server without runtime provisioning delays.

import { ALL_BUNDLED_SERVERS } from '../vpn_countries';
import { parseWireGuardConfig } from '../utils/wireguardConfigParser';
import { provisionServer } from './routerClient';
import { AsyncStorage } from '../utils/storage';

const PROVISIONED_SERVERS_KEY = 'konnectvpn_preprovisioned_servers';

export type ProvisionProgress = {
  total: number;
  completed: number;
  currentServer: string;
  error?: string;
};

/**
 * Checks if a server has already been provisioned in this setup.
 */
export async function getProvisionedServerIds(): Promise<Set<string>> {
  const raw = await AsyncStorage.getItem(PROVISIONED_SERVERS_KEY);
  if (!raw) return new Set();
  try {
    const list: string[] = JSON.parse(raw);
    return new Set(list);
  } catch {
    return new Set();
  }
}

/**
 * Pre-provisions all bundled servers to the router.
 */
export async function preProvisionAllBundledServers(
  onProgress?: (progress: ProvisionProgress) => void,
): Promise<{ successful: number; failed: number; errors: string[] }> {
  const provisioned = await getProvisionedServerIds();
  const errors: string[] = [];
  let successful = 0;
  let failed = 0;

  const total = ALL_BUNDLED_SERVERS.length;

  for (let i = 0; i < total; i++) {
    const item = ALL_BUNDLED_SERVERS[i];

    if (onProgress) {
      onProgress({
        total,
        completed: i,
        currentServer: `${item.flag} ${item.label}`,
      });
    }

    // Provision each bundled server onto the router (provisionServer is idempotent)

    try {
      console.log('[batchProvisioner] Parsing config for:', item.serverId);
      const parsed = parseWireGuardConfig(item.rawConf);
      console.log('[batchProvisioner] Successfully parsed config:', {
        endpoint: `${parsed.endpointAddress}:${parsed.endpointPort}`,
        address: parsed.address,
      });

      console.log('[batchProvisioner] Calling provisionServer on router...');
      await provisionServer({
        parsedConfig: parsed,
        serverId: item.serverId,
        countryCode: item.countryCode,
        countryLabel: item.countryLabel,
        flag: item.flag,
        label: item.label,
      });

      console.log('[batchProvisioner] ✅ Server provisioned successfully:', item.serverId);
      provisioned.add(item.serverId);
      await AsyncStorage.setItem(
        PROVISIONED_SERVERS_KEY,
        JSON.stringify(Array.from(provisioned)),
      );
      successful++;
    } catch (err: any) {
      console.error('[batchProvisioner] ❌ Provisioning failed for:', item.serverId, err);
      failed++;
      errors.push(`${item.label}: ${err?.message || 'Provisioning failed'}`);
    }
  }

  if (onProgress) {
    onProgress({
      total,
      completed: total,
      currentServer: 'Done',
    });
  }

  return { successful, failed, errors };
}
