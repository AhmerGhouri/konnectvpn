// src/api/routerClient.ts
//
// Networking layer for the MikroTik router REST API.
// Implements Single-Policy Overwrite Architecture (wg-konnect).
// Exactly one WireGuard interface, one peer, one address, one NAT rule, and 3 routes.
// Switching servers removes the app-managed policy before recreating it.

import * as Keychain from 'react-native-keychain';
import {
  ROUTER_BASE_URL,
  ROUTER_USER,
  ROUTER_PASSWORD,
  SCRIPT_NAME,
  HANDSHAKE_STALE_THRESHOLD_SECONDS,
  LATENCY_PING_COUNT,
  type ServerEntry,
  type CountryCode,
} from '../config/vpnConfig';
import { getAllCountries, appendImportedServer } from '../config/serverStore';
import { AsyncStorage } from '../utils/storage';
import { computeNetworkAndGateway } from '../utils/subnetMath';
import { ALL_BUNDLED_SERVERS } from '../vpn_countries';
import { parseWireGuardConfig, type ParsedWireGuardConfig } from '../utils/wireguardConfigParser';

const LAST_CONNECTED_SERVER_KEY = 'konnectvpn_last_connected_server';
const IMPORTED_CONFIGS_KEY = 'konnectvpn_imported_configs';

export const KONNECT_WG_INTERFACE = 'wg-konnect';
export const KONNECT_PORT = '13231';
export const KONNECT_MTU = '1420';
export const KONNECT_NAT_COMMENT = 'konnect-vpn-nat';
export const KONNECT_SPLIT1_COMMENT = 'konnect-vpn-split1';
export const KONNECT_SPLIT2_COMMENT = 'konnect-vpn-split2';
export const KONNECT_ENDPOINT_COMMENT = 'konnect-vpn-endpoint';
export const KONNECT_ADDR_COMMENT = 'konnect-vpn-address';

// ---------------------------------------------------------------------------
// Error types — the UI switches on these to show the right plain-language copy
// ---------------------------------------------------------------------------

export class RouterUnreachableError extends Error {
  readonly displayMessage =
    "Can't reach the router — make sure you're on your home Wi-Fi.";
  constructor(cause?: unknown) {
    super('Router unreachable');
    this.name = 'RouterUnreachableError';
    if (cause) {
      this.cause = cause;
    }
  }
}

export class RouterAuthError extends Error {
  readonly displayMessage =
    'Login failed — double-check the username and password.';
  constructor() {
    super('Router auth failed (401)');
    this.name = 'RouterAuthError';
  }
}

export class RouterScriptError extends Error {
  readonly displayMessage =
    'Something went wrong on the router — the VPN switch script reported an error.';
  constructor(detail?: string) {
    super(detail ?? 'Router script error');
    this.name = 'RouterScriptError';
  }
}

// ---------------------------------------------------------------------------
// Connection status — discriminated union, never throws from poll loop
// ---------------------------------------------------------------------------

export type ConnectionStatus =
  | { kind: 'connected'; activeServer: ServerEntry; lastHandshakeSecondsAgo: number | null }
  | { kind: 'disconnected'; activeServer: ServerEntry | null; lastHandshakeSecondsAgo: number | null }
  | { kind: 'unreachable' }
  | { kind: 'authError' };

export type RankedServer = {
  server: ServerEntry;
  latencyMs: number | null;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse embedded credentials if present in ROUTER_BASE_URL e.g. http://user:pass@host:port */
function getUrlEmbeddedCredentials(): { username: string; password: string } | null {
  try {
    const match = ROUTER_BASE_URL.match(/^[a-zA-Z]+:\/\/([^:]+):([^@]+)@/);
    if (match) {
      return {
        username: decodeURIComponent(match[1]),
        password: decodeURIComponent(match[2]),
      };
    }
  } catch { }
  if (ROUTER_USER && ROUTER_PASSWORD && (ROUTER_PASSWORD as string) !== 'YOUR_PASSWORD') {
    return { username: ROUTER_USER, password: ROUTER_PASSWORD };
  }
  return null;
}

/** Read credentials from the config or iOS Keychain. */
async function getStoredCredentials(): Promise<{ username: string; password: string } | null> {
  const embedded = getUrlEmbeddedCredentials();
  if (embedded) {
    return embedded;
  }

  const result = await Keychain.getGenericPassword({ service: 'konnectvpn-router' });
  if (result === false) {
    return null;
  }
  return { username: result.username, password: result.password };
}

/**
 * Reliable base64 encoder that doesn't depend on Hermes's btoa.
 * Handles all Latin-1 characters correctly.
 */
export function base64Encode(input: string): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let i = 0; i < input.length;) {
    const a = input.charCodeAt(i++);
    const b = i < input.length ? input.charCodeAt(i++) : NaN;
    const c = i < input.length ? input.charCodeAt(i++) : NaN;

    const enc1 = a >> 2;
    const enc2 = ((a & 3) << 4) | (isNaN(b) ? 0 : b >> 4);
    const enc3 = isNaN(b) ? 64 : ((b & 15) << 2) | (isNaN(c) ? 0 : c >> 6);
    const enc4 = isNaN(c) ? 64 : c & 63;

    output +=
      chars[enc1] +
      chars[enc2] +
      (enc3 === 64 ? '=' : chars[enc3]) +
      (enc4 === 64 ? '=' : chars[enc4]);
  }
  return output;
}

/** Build an HTTP Basic Auth header value. */
function basicAuthHeader(username: string, password: string): string {
  const raw = `${username}:${password}`;
  const encoded = base64Encode(raw);
  return `Basic ${encoded}`;
}

/**
 * Wrapper around fetch with an 8-second timeout via AbortController.
 * Throws RouterUnreachableError on network / timeout failure,
 * RouterAuthError on 401/403.
 */
async function routerFetch(
  path: string,
  options: RequestInit,
  credentials?: { username: string; password: string },
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  const credsToUse = credentials || await getStoredCredentials() || undefined;
  const cleanBaseUrl = ROUTER_BASE_URL.replace(/^(https?:\/\/)[^@]+@/, '$1');
  const fullUrl = `${cleanBaseUrl}${path}`;

  const combinedHeaders: Record<string, string> = {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    ...((options.headers || {}) as Record<string, string>),
  };

  if (credsToUse) {
    combinedHeaders.Authorization = basicAuthHeader(credsToUse.username, credsToUse.password);
  }

  try {
    const response = await fetch(fullUrl, {
      ...options,
      headers: combinedHeaders,
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new RouterAuthError();
    }

    return response;
  } catch (err) {
    if (err instanceof RouterAuthError) {
      throw err;
    }
    throw new RouterUnreachableError(err);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Robust check for RouterOS disabled field which can be boolean true or string 'true'.
 */
function isItemDisabled(item: any): boolean {
  return item?.disabled === true || item?.disabled === 'true';
}

/** Return the active, non-VPN default gateway used to reach Proton endpoints. */
function getWanDefaultGateway(routes: any[]): string | null {
  const route = routes.find((r) =>
    r['dst-address'] === '0.0.0.0/0' &&
    !isItemDisabled(r) &&
    String(r.comment || '').indexOf('vpn-') !== 0 &&
    String(r.comment || '').indexOf('konnect-') !== 0 &&
    typeof r.gateway === 'string' &&
    r.gateway.trim() !== '',
  );
  return route ? String(route.gateway) : null;
}

// ---------------------------------------------------------------------------
// MikroTik peer response shape
// ---------------------------------------------------------------------------

interface MikroTikPeer {
  '.id': string;
  interface: string;
  'last-handshake': string;
  disabled?: boolean | string;
  [key: string]: unknown;
}

/**
 * Parse MikroTik's duration format ("1m23s", "45s", "0s", "2h3m", etc.) into seconds.
 * Returns null if the string is empty or unparseable.
 */
function parseMikroTikDuration(duration: string): number | null {
  if (!duration || duration.trim() === '') {
    return null;
  }

  let seconds = 0;
  let hasMatch = false;
  const regex = /(\d+)([wdhms])/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(duration)) !== null) {
    hasMatch = true;
    const value = parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
      case 'w': seconds += value * 604800; break;
      case 'd': seconds += value * 86400; break;
      case 'h': seconds += value * 3600; break;
      case 'm': seconds += value * 60; break;
      case 's': seconds += value; break;
    }
  }

  return hasMatch ? seconds : null;
}

/**
 * Retrieve parsed WireGuard configuration for any serverId (bundled or imported).
 */
export async function getServerWireGuardConfig(serverId: string): Promise<ParsedWireGuardConfig | null> {
  // 1. Direct exact match in bundled servers
  let bundled = ALL_BUNDLED_SERVERS.find((s) => s.serverId === serverId);

  // 2. Normalized match (e.g. 'uk-endinburg-2' vs 'uk-edinburgh-2')
  if (!bundled) {
    const norm = serverId.toLowerCase().replace(/[^a-z0-9]/g, '');
    bundled = ALL_BUNDLED_SERVERS.find(
      (s) => s.serverId.toLowerCase().replace(/[^a-z0-9]/g, '') === norm,
    );
  }

  // 3. Known aliases
  if (!bundled) {
    if (serverId.includes('edinburg') || serverId.includes('edinburgh')) {
      bundled = ALL_BUNDLED_SERVERS.find((s) => s.serverId.includes('edinburg') || s.serverId.includes('edinburgh'));
    } else if (serverId.includes('london')) {
      bundled = ALL_BUNDLED_SERVERS.find((s) => s.serverId.includes('london'));
    }
  }

  if (bundled) {
    try {
      return parseWireGuardConfig(bundled.rawConf);
    } catch (err) {
      console.error(`[getServerWireGuardConfig] Failed to parse bundled conf for ${serverId}:`, err);
    }
  }

  // 4. Check imported configurations from local storage
  try {
    const raw = await AsyncStorage.getItem(IMPORTED_CONFIGS_KEY);
    if (raw) {
      const map: Record<string, string> = JSON.parse(raw);
      if (map[serverId]) {
        return parseWireGuardConfig(map[serverId]);
      }
      const lower = serverId.toLowerCase();
      for (const [k, v] of Object.entries(map)) {
        if (k.toLowerCase() === lower || k.toLowerCase().replace(/[^a-z0-9]/g, '') === lower.replace(/[^a-z0-9]/g, '')) {
          return parseWireGuardConfig(v);
        }
      }
    }
  } catch (err) {
    console.error(`[getServerWireGuardConfig] Failed to load imported conf for ${serverId}:`, err);
  }

  // 5. Fallback by country prefix (e.g. 'uk-something' -> first available UK server)
  const prefix = serverId.split('-')[0].toLowerCase();
  const countryFallback = ALL_BUNDLED_SERVERS.find(
    (s) => s.countryCode.toLowerCase() === prefix || s.serverId.toLowerCase().startsWith(prefix),
  );
  if (countryFallback) {
    console.warn(`[getServerWireGuardConfig] Server "${serverId}" not matched, falling back to ${countryFallback.serverId}`);
    try {
      return parseWireGuardConfig(countryFallback.rawConf);
    } catch { }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Store credentials in Keychain. */
export async function saveCredentials(username: string, password: string): Promise<void> {
  await Keychain.setGenericPassword(username, password, {
    service: 'konnectvpn-router',
  });
}

/** Remove stored credentials from Keychain. */
export async function clearCredentials(): Promise<void> {
  await Keychain.resetGenericPassword({ service: 'konnectvpn-router' });
}

/** Check whether credentials are stored or configured. */
export async function hasCredentials(): Promise<boolean> {
  const creds = await getStoredCredentials();
  return creds !== null;
}

/** Get last connected serverId. */
export async function getLastConnectedServerId(): Promise<string | null> {
  return await AsyncStorage.getItem(LAST_CONNECTED_SERVER_KEY);
}

/**
 * Validate credentials by hitting the peers endpoint.
 * Used ONLY by LoginScreen — throws on failure.
 */
export async function validateCredentials(
  username: string,
  password: string,
): Promise<void> {
  const response = await routerFetch(
    '/rest/interface/wireguard/peers',
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
    },
    { username, password },
  );

  if (!response.ok) {
    throw new RouterScriptError(`Unexpected status ${response.status}`);
  }
}

/**
 * Switch active VPN server using Single-Policy Overwrite Architecture.
 * Overwrites wg-konnect interface, single peer, IP address, NAT rule, and 3 routes.
 * Zero competing interfaces or port conflicts.
 */
export async function switchServer(serverId: string): Promise<void> {
  const creds = await getStoredCredentials();
  if (!creds) {
    throw new RouterAuthError();
  }

  console.log('[switchServer] Replacing single-policy with server:', serverId);

  // 1. Retrieve WireGuard config
  const config = await getServerWireGuardConfig(serverId);
  if (!config) {
    throw new RouterScriptError(`Configuration for server "${serverId}" not found. Please sync servers or re-import.`);
  }

  const { network } = computeNetworkAndGateway(config.address, config.dns);

  // 2. Discover WAN default gateway for the endpoint route
  const routesRes = await routerFetch('/rest/ip/route', { method: 'GET' }, creds);
  if (!routesRes.ok) {
    throw new RouterScriptError(`Failed to fetch routes: HTTP ${routesRes.status}`);
  }
  let routes: any[] = await routesRes.json();
  const wanGateway = getWanDefaultGateway(routes);
  if (!wanGateway) {
    throw new RouterScriptError('Could not find an active WAN default route. Ensure router is connected to the internet.');
  }

  // Remove the previous app-managed policy before creating the selected one.
  // Read all affected resources first so a failed read cannot start a partial cleanup.
  const policyComments = [KONNECT_SPLIT1_COMMENT, KONNECT_SPLIT2_COMMENT, KONNECT_ENDPOINT_COMMENT];
  const policyResources: { path: string; items: any[] }[] = [{
    path: '/rest/ip/route',
    items: routes.filter((route) => policyComments.includes(String(route.comment || ''))),
  }];
  for (const resource of [
    { path: '/rest/interface/wireguard/peers', matches: (item: any) => item.interface === KONNECT_WG_INTERFACE },
    { path: '/rest/ip/address', matches: (item: any) => item.interface === KONNECT_WG_INTERFACE && item.dynamic !== 'true' },
    { path: '/rest/ip/firewall/nat', matches: (item: any) => item.comment === KONNECT_NAT_COMMENT },
    { path: '/rest/interface/wireguard', matches: (item: any) => item.name === KONNECT_WG_INTERFACE },
  ]) {
    const response = await routerFetch(resource.path, { method: 'GET' }, creds);
    if (!response.ok) {
      throw new RouterScriptError(`Failed to read existing VPN policy: HTTP ${response.status}`);
    }
    const items: any[] = await response.json();
    policyResources.push({ path: resource.path, items: items.filter(resource.matches) });
  }
  for (const resource of policyResources) {
    for (const item of resource.items) {
      const response = await routerFetch(`${resource.path}/${item['.id']}`, { method: 'DELETE' }, creds);
      if (!response.ok) {
        throw new RouterScriptError(`Failed to remove existing VPN policy: HTTP ${response.status}`);
      }
    }
  }
  // Do not reuse deleted route IDs in the existing creation flow below.
  routes = routes.filter((route) => !policyComments.includes(String(route.comment || '')));

  // 3. Overwrite / Ensure WireGuard Interface (wg-konnect)
  const ifacesRes = await routerFetch('/rest/interface/wireguard', { method: 'GET' }, creds);
  const ifaces: any[] = ifacesRes.ok ? await ifacesRes.json() : [];
  const mainIface = ifaces.find((i) => i.name === KONNECT_WG_INTERFACE);

  // Disable any legacy wg-* interfaces that might exist
  for (const iface of ifaces) {
    const isLegacy = iface.name !== KONNECT_WG_INTERFACE && String(iface.name || '').startsWith('wg-');
    if (isLegacy && !isItemDisabled(iface)) {
      console.log(`[switchServer] Disabling legacy interface ${iface.name}`);
      await routerFetch(
        `/rest/interface/wireguard/${iface['.id']}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disabled: 'true' }),
        },
        creds,
      );
    }
  }

  if (mainIface) {
    console.log(`[switchServer] Updating interface ${KONNECT_WG_INTERFACE} (${mainIface['.id']})`);
    await routerFetch(
      `/rest/interface/wireguard/${mainIface['.id']}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          'private-key': config.privateKey,
          'listen-port': KONNECT_PORT,
          mtu: KONNECT_MTU,
          comment: serverId,
          disabled: 'false',
        }),
      },
      creds,
    );
  } else {
    console.log(`[switchServer] Creating interface ${KONNECT_WG_INTERFACE}`);
    const createRes = await routerFetch(
      '/rest/interface/wireguard',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: KONNECT_WG_INTERFACE,
          'private-key': config.privateKey,
          'listen-port': KONNECT_PORT,
          mtu: KONNECT_MTU,
          comment: serverId,
          disabled: 'false',
        }),
      },
      creds,
    );
    if (!createRes.ok) {
      throw new RouterScriptError(`Failed to create interface ${KONNECT_WG_INTERFACE}: HTTP ${createRes.status}`);
    }
  }

  // 4. Overwrite / Ensure WireGuard Peer on wg-konnect
  const peersRes = await routerFetch('/rest/interface/wireguard/peers', { method: 'GET' }, creds);
  const peers: any[] = peersRes.ok ? await peersRes.json() : [];
  const mainPeer = peers.find((p) => p.interface === KONNECT_WG_INTERFACE);

  // Disable any legacy peers on other wg- interfaces
  for (const p of peers) {
    if (p.interface !== KONNECT_WG_INTERFACE && String(p.interface || '').startsWith('wg-') && !isItemDisabled(p)) {
      await routerFetch(
        `/rest/interface/wireguard/peers/${p['.id']}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disabled: 'true' }),
        },
        creds,
      );
    }
  }

  const peerPayload = {
    interface: KONNECT_WG_INTERFACE,
    'public-key': config.publicKey,
    'endpoint-address': config.endpointAddress,
    'endpoint-port': String(config.endpointPort),
    'allowed-address': '0.0.0.0/0,::/0',
    'persistent-keepalive': '25s',
    comment: serverId,
    disabled: 'false',
  };

  if (mainPeer) {
    console.log(`[switchServer] Updating peer on ${KONNECT_WG_INTERFACE} (${mainPeer['.id']})`);
    const response = await routerFetch(
      `/rest/interface/wireguard/peers/${mainPeer['.id']}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(peerPayload),
      },
      creds,
    );
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new RouterScriptError(`Failed to configure WireGuard peer: ${error?.detail || error?.message || `HTTP ${response.status}`}`);
    }
  } else {
    console.log(`[switchServer] Creating peer on ${KONNECT_WG_INTERFACE}`);
    const response = await routerFetch(
      '/rest/interface/wireguard/peers',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(peerPayload),
      },
      creds,
    );
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new RouterScriptError(`Failed to configure WireGuard peer: ${error?.detail || error?.message || `HTTP ${response.status}`}`);
    }
  }

  // 5. Overwrite / Ensure IP Address on wg-konnect
  const addrsRes = await routerFetch('/rest/ip/address', { method: 'GET' }, creds);
  const addrs: any[] = addrsRes.ok ? await addrsRes.json() : [];
  const mainAddr = addrs.find((a) => a.interface === KONNECT_WG_INTERFACE);

  // Disable any legacy addresses
  for (const a of addrs) {
    if (a.interface !== KONNECT_WG_INTERFACE && String(a.interface || '').startsWith('wg-') && !isItemDisabled(a)) {
      await routerFetch(
        `/rest/ip/address/${a['.id']}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disabled: 'true' }),
        },
        creds,
      );
    }
  }

  const addrPayload = {
    interface: KONNECT_WG_INTERFACE,
    address: config.address,
    network: network,
    comment: KONNECT_ADDR_COMMENT,
    disabled: 'false',
  };

  if (mainAddr) {
    console.log(`[switchServer] Updating IP address on ${KONNECT_WG_INTERFACE} (${mainAddr['.id']})`);
    const response = await routerFetch(
      `/rest/ip/address/${mainAddr['.id']}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addrPayload),
      },
      creds,
    );
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new RouterScriptError(`Failed to configure VPN address: ${error?.detail || error?.message || `HTTP ${response.status}`}`);
    }
  } else {
    console.log(`[switchServer] Creating IP address on ${KONNECT_WG_INTERFACE}`);
    const response = await routerFetch(
      '/rest/ip/address',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addrPayload),
      },
      creds,
    );
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new RouterScriptError(`Failed to configure VPN address: ${error?.detail || error?.message || `HTTP ${response.status}`}`);
    }
  }

  // 6. Overwrite / Ensure NAT masquerade rule for wg-konnect
  const natsRes = await routerFetch('/rest/ip/firewall/nat', { method: 'GET' }, creds);
  const nats: any[] = natsRes.ok ? await natsRes.json() : [];
  const mainNat = nats.find(
    (n) => String(n.comment || '') === KONNECT_NAT_COMMENT || n['out-interface'] === KONNECT_WG_INTERFACE,
  );

  // Disable legacy NAT rules
  for (const n of nats) {
    const comment = String(n.comment || '');
    const isLegacyVpnNat = comment.startsWith('vpn-nat-') || (comment.includes('vpn') && comment !== KONNECT_NAT_COMMENT);
    if (isLegacyVpnNat && !isItemDisabled(n)) {
      await routerFetch(
        `/rest/ip/firewall/nat/${n['.id']}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disabled: 'true' }),
        },
        creds,
      );
    }
  }

  if (mainNat) {
    console.log(`[switchServer] Enabling NAT rule for ${KONNECT_WG_INTERFACE} (${mainNat['.id']})`);
    await routerFetch(
      `/rest/ip/firewall/nat/${mainNat['.id']}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: 'false', 'out-interface': KONNECT_WG_INTERFACE }),
      },
      creds,
    );
  } else {
    console.log(`[switchServer] Creating NAT rule for ${KONNECT_WG_INTERFACE}`);
    await routerFetch(
      '/rest/ip/firewall/nat',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chain: 'srcnat',
          action: 'masquerade',
          'out-interface': KONNECT_WG_INTERFACE,
          comment: KONNECT_NAT_COMMENT,
          disabled: 'false',
        }),
      },
      creds,
    );
  }

  // Ensure 'Local Route' NAT rule is enabled
  const localRouteNat = nats.find((n) => String(n.comment || '') === 'Local Route' && String(n.chain || '') === 'srcnat');
  if (localRouteNat && isItemDisabled(localRouteNat)) {
    await routerFetch(
      `/rest/ip/firewall/nat/${localRouteNat['.id']}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: 'false' }),
      },
      creds,
    );
  }

  // 7. Overwrite / Ensure Split Policy Routes
  // Disable any legacy routes
  for (const r of routes) {
    const comment = String(r.comment || '');
    const isLegacyVpnRoute =
      (comment.startsWith('vpn-split') || comment.startsWith('vpn-endpoint')) &&
      comment !== KONNECT_SPLIT1_COMMENT &&
      comment !== KONNECT_SPLIT2_COMMENT &&
      comment !== KONNECT_ENDPOINT_COMMENT;
    const isUntaggedSplit =
      !comment && (r['dst-address'] === '0.0.0.0/1' || r['dst-address'] === '128.0.0.0/1');
    if ((isLegacyVpnRoute || isUntaggedSplit) && !isItemDisabled(r)) {
      await routerFetch(
        `/rest/ip/route/${r['.id']}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disabled: 'true' }),
        },
        creds,
      );
    }
  }

  // Endpoint exception route must be enabled first so handshake traffic bypasses the tunnel
  const endpointRoute = routes.find((r) => String(r.comment || '') === KONNECT_ENDPOINT_COMMENT);
  const endpointPayload = {
    'dst-address': `${config.endpointAddress}/32`,
    gateway: wanGateway,
    comment: KONNECT_ENDPOINT_COMMENT,
    disabled: 'false',
  };
  if (endpointRoute) {
    await routerFetch(
      `/rest/ip/route/${endpointRoute['.id']}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(endpointPayload),
      },
      creds,
    );
  } else {
    await routerFetch(
      '/rest/ip/route',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(endpointPayload),
      },
      creds,
    );
  }

  // Split routes 0.0.0.0/1 and 128.0.0.0/1 pointing to wg-konnect
  const splitRoutesConfig = [
    { comment: KONNECT_SPLIT1_COMMENT, 'dst-address': '0.0.0.0/1' },
    { comment: KONNECT_SPLIT2_COMMENT, 'dst-address': '128.0.0.0/1' },
  ];

  for (const s of splitRoutesConfig) {
    const existing = routes.find((r) => String(r.comment || '') === s.comment);
    const payload = {
      'dst-address': s['dst-address'],
      gateway: KONNECT_WG_INTERFACE,
      comment: s.comment,
      disabled: 'false',
    };
    if (existing) {
      await routerFetch(
        `/rest/ip/route/${existing['.id']}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        creds,
      );
    } else {
      await routerFetch(
        '/rest/ip/route',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        creds,
      );
    }
  }

  // 8. Ensure TCP MSS clamping mangle rule exists for MTU 1420
  try {
    const mangleRes = await routerFetch('/rest/ip/firewall/mangle', { method: 'GET' }, creds);
    if (mangleRes.ok) {
      const mangleList: any[] = await mangleRes.json();
      const mssRule = mangleList.find((m) => String(m.comment || '') === 'konnect-vpn-mss');
      if (mssRule) {
        // Recreating wg-konnect changes its internal ID; rebind the existing rule.
        await routerFetch(`/rest/ip/firewall/mangle/${mssRule['.id']}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 'out-interface': KONNECT_WG_INTERFACE }),
        }, creds);
      } else {
        await routerFetch(
          '/rest/ip/firewall/mangle',
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chain: 'forward',
              action: 'change-mss',
              'new-mss': 'clamp-to-pmtu',
              passthrough: 'yes',
              protocol: 'tcp',
              'tcp-flags': 'syn',
              'out-interface': KONNECT_WG_INTERFACE,
              comment: 'konnect-vpn-mss',
            }),
          },
          creds,
        );
      }
    }
  } catch {
    // Non-fatal
  }

  // 9. Trigger handshake immediately by pinging WireGuard gateway
  try {
    await routerFetch(
      '/rest/ping',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: '10.2.0.1', count: '1' }),
      },
      creds,
    );
  } catch {
    // Non-fatal handshake trigger
  }

  // 10. Persist last connected server ID
  await AsyncStorage.setItem(LAST_CONNECTED_SERVER_KEY, serverId);
  console.log(`[switchServer] ✅ Successfully switched to server ${serverId}`);
}

/**
 * Disconnect VPN and revert routing to direct internet.
 * Disables split routes, wg-konnect interface, peer, address, and NAT rule.
 * Direct internet via WAN route takes over immediately.
 */
export async function disconnectVpn(): Promise<void> {
  const creds = await getStoredCredentials();
  if (!creds) {
    throw new RouterAuthError();
  }

  console.log('[disconnectVpn] Disabling VPN policy and reverting to direct internet');

  // 1. Disable split routes and endpoint exception route
  try {
    const routesRes = await routerFetch('/rest/ip/route', { method: 'GET' }, creds);
    if (routesRes.ok) {
      const routes: any[] = await routesRes.json();
      for (const r of routes) {
        const comment = String(r.comment || '');
        const isVpnRoute =
          comment === KONNECT_SPLIT1_COMMENT ||
          comment === KONNECT_SPLIT2_COMMENT ||
          comment === KONNECT_ENDPOINT_COMMENT ||
          comment.startsWith('vpn-') ||
          comment.startsWith('konnect-vpn-') ||
          r['dst-address'] === '0.0.0.0/1' ||
          r['dst-address'] === '128.0.0.0/1';

        if (isVpnRoute && !isItemDisabled(r)) {
          await routerFetch(
            `/rest/ip/route/${r['.id']}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ disabled: 'true' }),
            },
            creds,
          );
        }
      }
    }
  } catch (err) {
    console.warn('[disconnectVpn] Routes disable warning:', err);
  }

  // 2. Disable wg-konnect and any legacy wg- interfaces
  try {
    const ifacesRes = await routerFetch('/rest/interface/wireguard', { method: 'GET' }, creds);
    if (ifacesRes.ok) {
      const ifaces: any[] = await ifacesRes.json();
      for (const iface of ifaces) {
        if (String(iface.name || '').startsWith('wg-') && !isItemDisabled(iface)) {
          await routerFetch(
            `/rest/interface/wireguard/${iface['.id']}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ disabled: 'true' }),
            },
            creds,
          );
        }
      }
    }
  } catch (err) {
    console.warn('[disconnectVpn] Interface disable warning:', err);
  }

  // 3. Disable NAT rule for wg-konnect and enable Local Route
  try {
    const natRes = await routerFetch('/rest/ip/firewall/nat', { method: 'GET' }, creds);
    if (natRes.ok) {
      const natList: any[] = await natRes.json();
      for (const nat of natList) {
        const comment = String(nat.comment || '');
        if ((comment === KONNECT_NAT_COMMENT || comment.startsWith('vpn-nat-')) && !isItemDisabled(nat)) {
          await routerFetch(
            `/rest/ip/firewall/nat/${nat['.id']}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ disabled: 'true' }),
            },
            creds,
          );
        } else if (comment === 'Local Route' && isItemDisabled(nat)) {
          await routerFetch(
            `/rest/ip/firewall/nat/${nat['.id']}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ disabled: 'false' }),
            },
            creds,
          );
        }
      }
    }
  } catch (err) {
    console.warn('[disconnectVpn] NAT warning:', err);
  }

  // 4. Disable peers
  try {
    const peersRes = await routerFetch('/rest/interface/wireguard/peers', { method: 'GET' }, creds);
    if (peersRes.ok) {
      const peerList: any[] = await peersRes.json();
      for (const p of peerList) {
        if (String(p.interface || '').startsWith('wg-') && !isItemDisabled(p)) {
          await routerFetch(
            `/rest/interface/wireguard/peers/${p['.id']}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ disabled: 'true' }),
            },
            creds,
          );
        }
      }
    }
  } catch (err) {
    console.warn('[disconnectVpn] Peer disable warning:', err);
  }

  // 5. Disable IP address
  try {
    const addrRes = await routerFetch('/rest/ip/address', { method: 'GET' }, creds);
    if (addrRes.ok) {
      const addrList: any[] = await addrRes.json();
      for (const a of addrList) {
        if (String(a.interface || '').startsWith('wg-') && !isItemDisabled(a)) {
          await routerFetch(
            `/rest/ip/address/${a['.id']}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ disabled: 'true' }),
            },
            creds,
          );
        }
      }
    }
  } catch (err) {
    console.warn('[disconnectVpn] IP address disable warning:', err);
  }

  console.log('[disconnectVpn] ✅ Successfully disconnected VPN');
}

/**
 * Poll the router for current WireGuard connection status.
 * Evaluates whether konnect-vpn-split1 is enabled and reads peer handshake.
 * This function NEVER throws.
 */
export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const creds = await getStoredCredentials();
  if (!creds) {
    return { kind: 'authError' };
  }

  // 1. Check if VPN split route is enabled
  let routes: any[] = [];
  try {
    const routesRes = await routerFetch(
      '/rest/ip/route',
      { method: 'GET', headers: { Accept: 'application/json' } },
      creds,
    );
    if (routesRes.ok) {
      routes = await routesRes.json();
    }
  } catch (err) {
    if (err instanceof RouterAuthError) return { kind: 'authError' };
    return { kind: 'unreachable' };
  }

  const split1 = Array.isArray(routes)
    ? routes.find((r) => {
      const comment = String(r.comment || '');
      return (
        (comment === KONNECT_SPLIT1_COMMENT || comment.startsWith('vpn-split1-')) &&
        !isItemDisabled(r)
      );
    })
    : null;

  if (!split1) {
    return {
      kind: 'disconnected',
      activeServer: null,
      lastHandshakeSecondsAgo: null,
    };
  }

  // 2. Determine active server
  const allCountries = await getAllCountries();
  const allServers: ServerEntry[] = [];
  for (const c of allCountries) {
    allServers.push(...c.servers);
  }

  let activeServerId: string | null = null;
  const comment = String(split1.comment || '');
  if (comment.startsWith('vpn-split1-')) {
    activeServerId = comment.replace('vpn-split1-', '');
  }

  // 3. Query peer on wg-konnect to get handshake
  let peers: MikroTikPeer[] = [];
  try {
    const peersRes = await routerFetch(
      '/rest/interface/wireguard/peers',
      { method: 'GET', headers: { Accept: 'application/json' } },
      creds,
    );
    if (peersRes.ok) {
      peers = await peersRes.json();
    }
  } catch (err) {
    if (err instanceof RouterAuthError) return { kind: 'authError' };
    return { kind: 'unreachable' };
  }

  const peer = Array.isArray(peers)
    ? peers.find((p) => p.interface === KONNECT_WG_INTERFACE || !isItemDisabled(p))
    : undefined;

  if (!activeServerId && peer && typeof peer.comment === 'string' && peer.comment.trim() !== '') {
    activeServerId = peer.comment.trim();
  }
  if (!activeServerId) {
    activeServerId = await getLastConnectedServerId();
  }

  const activeServer: ServerEntry =
    allServers.find((s) => s.id === activeServerId) || {
      id: activeServerId || 'konnect-vpn',
      label: activeServerId || 'VPN Server',
      interfaceName: KONNECT_WG_INTERFACE,
      endpointIp: typeof peer?.['endpoint-address'] === 'string' ? peer['endpoint-address'] : '127.0.0.1',
    };

  const handshakeAgo = peer ? parseMikroTikDuration(peer['last-handshake']) : null;

  return {
    kind: 'connected',
    activeServer,
    lastHandshakeSecondsAgo: handshakeAgo,
  };
}

/**
 * Probe server's public endpoint IP via router's built-in /rest/ping tool.
 * Returns average RTT in milliseconds, or null if ping fails. Never throws.
 */
export async function pingServer(endpointIp: string): Promise<number | null> {
  try {
    const creds = await getStoredCredentials();
    if (!creds) return null;

    const response = await routerFetch(
      '/rest/ping',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          address: endpointIp,
          count: '1',
        }),
      },
      creds,
    );

    if (!response.ok) return null;

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    for (let i = data.length - 1; i >= 0; i--) {
      const item = data[i];
      const avg = item['avg-rtt'] || item['avg'] || item['rtt'] || item['time'];
      if (avg) {
        const match = String(avg).match(/^([\d.]+)\s*ms/i) || String(avg).match(/([\d.]+)\s*ms/i);
        if (match) {
          return Math.round(parseFloat(match[1]));
        }
        const num = parseFloat(String(avg));
        if (!isNaN(num)) {
          return Math.round(num);
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Check internet reachability from the router, independently of VPN handshake status. */
export async function checkRouterInternet(): Promise<boolean | null> {
  const creds = await getStoredCredentials();
  if (!creds) return null;
  let completedChecks = 0;
  for (const address of ['1.1.1.1', '8.8.8.8']) {
    try {
      const response = await routerFetch('/rest/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, count: '1' }),
      }, creds);
      if (!response.ok) continue;
      const results = await response.json();
      if (!Array.isArray(results) || results.length === 0) continue;
      if (results.some((result) => Number(result.received) > 0)) return true;
      if (results.some((result) => Number(result.sent) > 0)) completedChecks += 1;
    } catch {
      // A router/API error is not proof that the router has no internet.
    }
  }
  return completedChecks === 2 ? false : null;
}

/**
 * Rank servers for a given country by live latency.
 * Deduplicates by endpoint IP to avoid RouterOS ping serialization delays.
 */
export async function rankServers(
  countryCode: CountryCode | string,
  serversToRank?: ServerEntry[],
): Promise<RankedServer[]> {
  let servers = serversToRank;
  if (!servers || servers.length === 0) {
    const allCountries = await getAllCountries();
    const country = allCountries.find(
      (c) => c.code.toLowerCase() === countryCode.toLowerCase(),
    );
    servers = country?.servers || [];
  }

  if (servers.length === 0) {
    return [];
  }

  // Deduplicate pings by endpointIp so we don't bombard the router with concurrent ping requests
  const uniqueIps = Array.from(new Set(servers.map((s) => s.endpointIp)));
  const ipLatencyMap = new Map<string, number | null>();

  // Ping unique IPs sequentially with count: 1 to ensure instant response
  for (const ip of uniqueIps) {
    const latency = await pingServer(ip);
    ipLatencyMap.set(ip, latency);
  }

  const results: RankedServer[] = servers.map((server) => ({
    server,
    latencyMs: ipLatencyMap.get(server.endpointIp) ?? null,
  }));

  // Sort ascending by latency, nulls last
  results.sort((a, b) => {
    if (a.latencyMs === null && b.latencyMs === null) return 0;
    if (a.latencyMs === null) return 1;
    if (b.latencyMs === null) return -1;
    return a.latencyMs - b.latencyMs;
  });

  return results;
}

/**
 * Provisions a new WireGuard server into local app state and ensures router baseline objects exist.
 */
export async function provisionServer(params: {
  parsedConfig: ParsedWireGuardConfig;
  serverId: string;
  countryCode: string;
  countryLabel: string;
  flag: string;
  label: string;
}): Promise<void> {
  const creds = await getStoredCredentials();
  if (!creds) {
    throw new RouterAuthError();
  }

  // Store raw/parsed config in AsyncStorage so switchServer can access it anytime
  try {
    const raw = await AsyncStorage.getItem(IMPORTED_CONFIGS_KEY);
    const map: Record<string, string> = raw ? JSON.parse(raw) : {};
    map[params.serverId] = `[Interface]\nPrivateKey = ${params.parsedConfig.privateKey}\nAddress = ${params.parsedConfig.address}\nDNS = ${params.parsedConfig.dns}\n\n[Peer]\nPublicKey = ${params.parsedConfig.publicKey}\nEndpoint = ${params.parsedConfig.endpointAddress}:${params.parsedConfig.endpointPort}\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n`;
    await AsyncStorage.setItem(IMPORTED_CONFIGS_KEY, JSON.stringify(map));
  } catch (err) {
    console.warn('[provisionServer] Storage warning:', err);
  }

  // Ensure single wg-konnect base interface exists on router (disabled)
  try {
    const ifacesRes = await routerFetch('/rest/interface/wireguard', { method: 'GET' }, creds);
    if (ifacesRes.ok) {
      const ifaces: any[] = await ifacesRes.json();
      const exists = ifaces.some((i) => i.name === KONNECT_WG_INTERFACE);
      if (!exists) {
        await routerFetch(
          '/rest/interface/wireguard',
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: KONNECT_WG_INTERFACE,
              'listen-port': KONNECT_PORT,
              mtu: KONNECT_MTU,
              'private-key': params.parsedConfig.privateKey,
              comment: 'konnect-vpn-interface',
              disabled: 'true',
            }),
          },
          creds,
        );
      }
    }
  } catch {
    // Non-fatal
  }

  // Save server descriptor to local storage for picker UI
  const newServerEntry: ServerEntry = {
    id: params.serverId,
    label: params.label,
    interfaceName: KONNECT_WG_INTERFACE,
    endpointIp: params.parsedConfig.endpointAddress,
  };

  await appendImportedServer(
    params.countryCode,
    params.countryLabel,
    params.flag,
    newServerEntry,
  );
}
