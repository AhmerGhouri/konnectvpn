// src/utils/storage.ts
//
// Lightweight key-value persistence without external native module build failures.
// Uses Keychain for storage if available, with a fast in-memory cache.

import * as Keychain from 'react-native-keychain';

const memoryCache = new Map<string, string>();

export const AsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    if (memoryCache.has(key)) {
      return memoryCache.get(key) ?? null;
    }
    try {
      const result = await Keychain.getGenericPassword({ service: `kv-${key}` });
      if (result && result.password) {
        memoryCache.set(key, result.password);
        return result.password;
      }
    } catch {
      // ignore
    }
    return null;
  },

  async setItem(key: string, value: string): Promise<void> {
    memoryCache.set(key, value);
    try {
      await Keychain.setGenericPassword('kv', value, { service: `kv-${key}` });
    } catch {
      // fallback to in-memory
    }
  },

  async removeItem(key: string): Promise<void> {
    memoryCache.delete(key);
    try {
      await Keychain.resetGenericPassword({ service: `kv-${key}` });
    } catch {
      // ignore
    }
  },
};
