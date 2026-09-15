// src/utils/listenPortRegistry.ts
//
// KonnectVPN deliberately enables only one WireGuard interface at a time.
// All configured locations can therefore share one known listen port.
export const VPN_LISTEN_PORT = 13231;

export async function getNextListenPort(): Promise<number> {
  return VPN_LISTEN_PORT;
}

/** @deprecated All KonnectVPN interfaces use VPN_LISTEN_PORT. */
export async function setListenPortCounter(_port: number): Promise<void> {
  // Retained as a no-op for compatibility with older callers.
}
