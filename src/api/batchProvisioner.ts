// src/api/batchProvisioner.ts
//
// Fast pre-provisioner for Single-Policy Overwrite Architecture.
// Marks all bundled servers available in storage and ensures router baseline objects exist.
// Allows instantaneous one-tap switching to any server without runtime provisioning delays.

import { ALL_BUNDLED_SERVERS } from '../vpn_countries';
import { disconnectVpn } from './routerClient';
import { AsyncStorage } from '../utils/storage';

const PROVISIONED_SERVERS_KEY = 'konnectvpn_preprovisioned_servers';

export type ProvisionProgress = {
  total: number;
  completed: number;
  currentServer: string;
  error?: string;
};

/**
 * Checks if servers have been registered in local storage.
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
 * Pre-provisions all bundled servers for the Single-Policy architecture.
 * Ensures the router baseline is clean and registers all bundled servers in storage.
 */
export async function preProvisionAllBundledServers(
  onProgress?: (progress: ProvisionProgress) => void,
): Promise<{ successful: number; failed: number; errors: string[] }> {
  const total = ALL_BUNDLED_SERVERS.length;

  if (onProgress) {
    onProgress({
      total,
      completed: 0,
      currentServer: 'Setting up Single-Policy VPN...',
    });
  }

  // Ensure router VPN routes are in a clean direct-internet state
  try {
    await disconnectVpn();
  } catch (err) {
    console.warn('[batchProvisioner] Initial disconnect note:', err);
  }

  const provisioned = new Set<string>();
  for (let i = 0; i < total; i++) {
    const item = ALL_BUNDLED_SERVERS[i];
    provisioned.add(item.serverId);

    if (onProgress) {
      onProgress({
        total,
        completed: i + 1,
        currentServer: `${item.flag} ${item.label}`,
      });
    }
  }

  await AsyncStorage.setItem(
    PROVISIONED_SERVERS_KEY,
    JSON.stringify(Array.from(provisioned)),
  );

  // Also populate imported configs map with all bundled servers for instant switching
  try {
    const rawConfigs = await AsyncStorage.getItem('konnectvpn_imported_configs');
    const configMap: Record<string, string> = rawConfigs ? JSON.parse(rawConfigs) : {};
    for (const item of ALL_BUNDLED_SERVERS) {
      configMap[item.serverId] = item.rawConf;
    }
    await AsyncStorage.setItem('konnectvpn_imported_configs', JSON.stringify(configMap));
  } catch (err) {
    console.warn('[batchProvisioner] Config map caching warning:', err);
  }

  if (onProgress) {
    onProgress({
      total,
      completed: total,
      currentServer: 'Done',
    });
  }

  console.log(`[batchProvisioner] ✅ Pre-provisioned ${total} servers for Single-Policy architecture.`);
  return { successful: total, failed: 0, errors: [] };
}
