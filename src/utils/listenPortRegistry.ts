// src/utils/listenPortRegistry.ts
//
// Reads a persisted counter from storage (seeded at 13233), returns it,
// and increments the stored value for next time.

import { AsyncStorage } from './storage';

const LISTEN_PORT_KEY = 'konnectvpn_next_listen_port';
const SEED_PORT = 13233;

export async function getNextListenPort(): Promise<number> {
  const stored = await AsyncStorage.getItem(LISTEN_PORT_KEY);
  let currentPort = stored ? parseInt(stored, 10) : SEED_PORT;
  if (isNaN(currentPort) || currentPort < 1024) {
    currentPort = SEED_PORT;
  }

  // Increment and persist for next time
  const nextPort = currentPort + 1;
  await AsyncStorage.setItem(LISTEN_PORT_KEY, String(nextPort));

  return currentPort;
}

export async function setListenPortCounter(port: number): Promise<void> {
  await AsyncStorage.setItem(LISTEN_PORT_KEY, String(port));
}
