// src/api/routerClient.ts
//
// Networking layer for the MikroTik router REST API.
// All communication is plain HTTP over the LAN — see vpnConfig.ts for why.

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
import { getNextListenPort } from '../utils/listenPortRegistry';
import type { ParsedWireGuardConfig } from '../utils/wireguardConfigParser';

const LAST_CONNECTED_SERVER_KEY = 'konnectvpn_last_connected_server';

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
  | { kind: 'connected'; activeServer: ServerEntry; lastHandshakeSecondsAgo: number }
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
  // 1. Check if configured in vpnConfig.ts
  const embedded = getUrlEmbeddedCredentials();
  if (embedded) {
    return embedded;
  }

  // 2. Otherwise read from Keychain
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
function base64Encode(input: string): string {
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

  // Clean base URL and extract/apply credentials
  const credsToUse = credentials || await getStoredCredentials() || undefined;

  // Strip any existing credentials from ROUTER_BASE_URL to form clean base
  const cleanBaseUrl = ROUTER_BASE_URL.replace(/^(https?:\/\/)[^@]+@/, '$1');

  const fullUrl = `${cleanBaseUrl}${path}`;

  // Set Authorization and Cache-Control headers
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

// ---------------------------------------------------------------------------
// MikroTik peer response shape (the fields we actually use)
// ---------------------------------------------------------------------------

interface MikroTikPeer {
  '.id': string;
  interface: string;
  'last-handshake': string; // e.g. "1m23s" or "" if never
  disabled?: boolean | string;
  [key: string]: unknown;
}

/**
 * Parse MikroTik's duration format ("1m23s", "45s", "0s", "2h3m", etc.) into seconds.
 * Returns null if the string is empty or unparseable (means no handshake ever).
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
      headers: {
        Accept: 'application/json',
      },
    },
    { username, password },
  );

  if (!response.ok) {
    throw new RouterScriptError(`Unexpected status ${response.status}`);
  }
}

/**
 * Tell the router to switch the active VPN server.
 * Enables interface, peer, IP address, NAT rule, and policy split routes for the target server.
 * Disables other VPN routes, interfaces, and NAT rules.
 */
export async function switchServer(serverId: string): Promise<void> {
  const creds = await getStoredCredentials();
  if (!creds) {
    throw new RouterAuthError();
  }

  console.log('[switchServer] Attempting to switch to serverId:', serverId);
  const targetIfName = `wg-${serverId}`;

  // 1. Manage WireGuard interfaces: enable target wg-<serverId> and disable other wg-* interfaces
  try {
    const ifacesRes = await routerFetch('/rest/interface/wireguard', { method: 'GET' }, creds);
    if (ifacesRes.ok) {
      const ifaces: any[] = await ifacesRes.json();
      for (const iface of ifaces) {
        const isTarget = iface.name === targetIfName;
        const isAppWg = String(iface.name || '').startsWith('wg-');
        if (isTarget && isItemDisabled(iface)) {
          console.log(`[switchServer] Enabling interface ${iface.name}`);
          await routerFetch(
            `/rest/interface/wireguard/${iface['.id']}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ disabled: 'false' }),
            },
            creds,
          );
        } else if (!isTarget && isAppWg && !isItemDisabled(iface)) {
          console.log(`[switchServer] Disabling interface ${iface.name}`);
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
    console.warn('[switchServer] Interface state update warning:', err);
  }

  // 2. Manage WireGuard peers: ensure peer for target interface is enabled, disable other app peers
  try {
    const peersRes = await routerFetch('/rest/interface/wireguard/peers', { method: 'GET' }, creds);
    if (peersRes.ok) {
      const peerList: any[] = await peersRes.json();
      for (const p of peerList) {
        const isTargetPeer = p.interface === targetIfName || p.comment === serverId;
        const isAppPeer = String(p.interface || '').startsWith('wg-');
        if (isTargetPeer && isItemDisabled(p)) {
          console.log(`[switchServer] Enabling peer ${p['.id']} for ${targetIfName}`);
          await routerFetch(
            `/rest/interface/wireguard/peers/${p['.id']}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ disabled: 'false' }),
            },
            creds,
          );
        } else if (isAppPeer && !isTargetPeer && !isItemDisabled(p)) {
          console.log(`[switchServer] Disabling other peer ${p['.id']} for ${p.interface}`);
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
    console.warn('[switchServer] Peer state update warning:', err);
  }

  // 3. Manage IP Address: ensure address on target interface is enabled, disable other wg- addresses
  try {
    const addrRes = await routerFetch('/rest/ip/address', { method: 'GET' }, creds);
    if (addrRes.ok) {
      const addrList: any[] = await addrRes.json();
      for (const a of addrList) {
        const isTargetAddr = a.interface === targetIfName;
        const isAppAddr = String(a.interface || '').startsWith('wg-');
        if (isTargetAddr && isItemDisabled(a)) {
          console.log(`[switchServer] Enabling IP address for ${targetIfName}`);
          await routerFetch(
            `/rest/ip/address/${a['.id']}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ disabled: 'false' }),
            },
            creds,
          );
        } else if (isAppAddr && !isTargetAddr && !isItemDisabled(a)) {
          console.log(`[switchServer] Disabling other WireGuard IP address ${a['.id']} for ${a.interface}`);
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
    console.warn('[switchServer] IP address state update warning:', err);
  }

  // 4. Manage Firewall NAT: enable NAT for target server, disable other vpn-nat-*
  try {
    const natRes = await routerFetch('/rest/ip/firewall/nat', { method: 'GET' }, creds);
    if (natRes.ok) {
      const natList: any[] = await natRes.json();
      for (const nat of natList) {
        const comment = String(nat.comment || '');
        const isTargetNat = comment === `vpn-nat-${serverId}` || nat['out-interface'] === targetIfName;
        if (isTargetNat && isItemDisabled(nat)) {
          console.log(`[switchServer] Enabling NAT rule for ${targetIfName}`);
          await routerFetch(
            `/rest/ip/firewall/nat/${nat['.id']}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ disabled: 'false' }),
            },
            creds,
          );
        } else if (comment.startsWith('vpn-nat-') && !isTargetNat && !isItemDisabled(nat)) {
          console.log(`[switchServer] Disabling other NAT rule ${nat['.id']}`);
          await routerFetch(
            `/rest/ip/firewall/nat/${nat['.id']}`,
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
    console.warn('[switchServer] NAT state update warning:', err);
  }

  // 4b. Disable 'Local Route' NAT rule so traffic goes through VPN tunnel
  try {
    const natRes2 = await routerFetch('/rest/ip/firewall/nat', { method: 'GET' }, creds);
    if (natRes2.ok) {
      const natList2: any[] = await natRes2.json();
      const localRoute = natList2.find(
        (n: any) =>
          String(n.comment || '') === 'Local Route' &&
          String(n.chain || '') === 'srcnat',
      );
      if (localRoute && !isItemDisabled(localRoute)) {
        await routerFetch(
          `/rest/ip/firewall/nat/${localRoute['.id']}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ disabled: 'true' }),
          },
          creds,
        );
        console.log('[switchServer] Disabled Local Route NAT rule');
      }
    }
  } catch (err) {
    console.warn('[switchServer] Local Route disable warning:', err);
  }

  // 5. Fetch all routes and enable target server routes, disable other vpn routes
  const routesRes = await routerFetch('/rest/ip/route', { method: 'GET' }, creds);
  if (!routesRes.ok) {
    throw new RouterScriptError(`Failed to fetch routes: HTTP ${routesRes.status}`);
  }
  const routes: any[] = await routesRes.json();

  for (const r of routes) {
    const comment = String(r.comment || '');
    const isTargetServerRoute =
      comment === `vpn-split1-${serverId}` ||
      comment === `vpn-split2-${serverId}` ||
      comment === `vpn-endpoint-${serverId}`;

    const isOtherVpnRoute = comment.startsWith('vpn-') && !isTargetServerRoute;
    const isLegacySplitRoute =
      !comment && (r['dst-address'] === '0.0.0.0/1' || r['dst-address'] === '128.0.0.0/1');

    if (isTargetServerRoute) {
      const isSplit = comment.startsWith('vpn-split');
      const patchBody: Record<string, string> = { disabled: 'false' };
      if (isSplit && r.gateway !== targetIfName) {
        patchBody.gateway = targetIfName;
      }
      if (isItemDisabled(r) || patchBody.gateway) {
        await routerFetch(
          `/rest/ip/route/${r['.id']}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patchBody),
          },
          creds,
        );
      }
    } else if (isOtherVpnRoute || isLegacySplitRoute) {
      if (!isItemDisabled(r)) {
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

  // 6. Trigger handshake immediately by pinging 1.1.1.1 through the router
  try {
    await routerFetch(
      '/rest/ping',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: '1.1.1.1',
          count: '2',
        }),
      },
      creds,
    );
  } catch {
    // Non-fatal handshake trigger
  }

  // Persist as last connected server
  await AsyncStorage.setItem(LAST_CONNECTED_SERVER_KEY, serverId);
}

/**
 * Tell the router to disconnect VPN and revert routing to direct internet.
 * Disables all active VPN split routes and VPN NAT rules.
 * Note: Keeps last connected server preserved so one-tap reconnect works.
 */
export async function disconnectVpn(): Promise<void> {
  const creds = await getStoredCredentials();
  if (!creds) {
    throw new RouterAuthError();
  }

  console.log('[disconnectVpn] Disconnecting VPN and reverting to direct internet');

  // 1. Disable all vpn- tagged routes and legacy split routes
  const routesRes = await routerFetch('/rest/ip/route', { method: 'GET' }, creds);
  if (routesRes.ok) {
    const routes: any[] = await routesRes.json();
    for (const r of routes) {
      const comment = String(r.comment || '');
      const isVpnRoute =
        comment.startsWith('vpn-') ||
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

  // 2. Disable all app-provisioned WireGuard interfaces (wg-*) to stop tunnel keepalives
  try {
    const ifacesRes = await routerFetch('/rest/interface/wireguard', { method: 'GET' }, creds);
    if (ifacesRes.ok) {
      const ifaces: any[] = await ifacesRes.json();
      for (const iface of ifaces) {
        const isAppProvisioned = String(iface.name || '').startsWith('wg-');
        if (isAppProvisioned && !isItemDisabled(iface)) {
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

  // 3. Disable all vpn-nat-* firewall rules
  try {
    const natRes = await routerFetch('/rest/ip/firewall/nat', { method: 'GET' }, creds);
    if (natRes.ok) {
      const natList: any[] = await natRes.json();
      for (const nat of natList) {
        const comment = String(nat.comment || '');
        if (comment.startsWith('vpn-nat-') && !isItemDisabled(nat)) {
          await routerFetch(
            `/rest/ip/firewall/nat/${nat['.id']}`,
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
    console.warn('[disconnectVpn] NAT disable warning:', err);
  }

  // 3b. Enable 'Local Route' NAT rule so traffic falls back to local internet
  try {
    const natRes2 = await routerFetch('/rest/ip/firewall/nat', { method: 'GET' }, creds);
    if (natRes2.ok) {
      const natList2: any[] = await natRes2.json();
      const localRoute = natList2.find(
        (n: any) =>
          String(n.comment || '') === 'Local Route' &&
          String(n.chain || '') === 'srcnat',
      );
      if (localRoute && isItemDisabled(localRoute)) {
        await routerFetch(
          `/rest/ip/firewall/nat/${localRoute['.id']}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ disabled: 'false' }),
          },
          creds,
        );
        console.log('[disconnectVpn] Enabled Local Route NAT rule');
      }
    }
  } catch (err) {
    console.warn('[disconnectVpn] Local Route enable warning:', err);
  }

  // 4. Disable all app-provisioned WireGuard peers
  try {
    const peersRes = await routerFetch('/rest/interface/wireguard/peers', { method: 'GET' }, creds);
    if (peersRes.ok) {
      const peerList: any[] = await peersRes.json();
      for (const p of peerList) {
        const isAppPeer = String(p.interface || '').startsWith('wg-');
        if (isAppPeer && !isItemDisabled(p)) {
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

  // 5. Disable all app-provisioned WireGuard IP addresses
  try {
    const addrRes = await routerFetch('/rest/ip/address', { method: 'GET' }, creds);
    if (addrRes.ok) {
      const addrList: any[] = await addrRes.json();
      for (const a of addrList) {
        const isAppAddr = String(a.interface || '').startsWith('wg-');
        if (isAppAddr && !isItemDisabled(a)) {
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
          count: String(LATENCY_PING_COUNT),
        }),
      },
      creds,
    );

    if (!response.ok) return null;

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    // The final summary item in RouterOS ping response typically contains avg-rtt / avg / rtt
    for (let i = data.length - 1; i >= 0; i--) {
      const item = data[i];
      const avg = item['avg-rtt'] || item['avg'] || item['rtt'] || item['time'];
      if (avg) {
        // Parse "24ms" or "24.5ms" or raw number
        const match = String(avg).match(/([\d.]+)\s*ms?/);
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

/**
 * Rank servers for a given country by live latency.
 * Calls pingServer() for each in parallel, sorts ascending (nulls last).
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

  const results = await Promise.all(
    servers.map(async (server) => {
      const latencyMs = await pingServer(server.endpointIp);
      return { server, latencyMs };
    }),
  );

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
 * Poll the router for current WireGuard connection status.
 * Matches interface name across all countries/servers from getAllCountries().
 * This function NEVER throws.
 */
/**
 * Poll the router for current WireGuard connection status.
 * Evaluates active routing rules and checks live handshake freshness.
 * This function NEVER throws.
 */
export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const creds = await getStoredCredentials();
  if (!creds) {
    return { kind: 'authError' };
  }

  // 1. Check active routes to see if any VPN route is enabled
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

  // Find enabled vpn-split1 route
  let activeServerId: string | null = null;
  if (Array.isArray(routes)) {
    for (const r of routes) {
      const comment = String(r.comment || '');
      if (comment.startsWith('vpn-split1-') && !isItemDisabled(r)) {
        activeServerId = comment.replace('vpn-split1-', '');
        break;
      }
    }
  }

  // If no VPN route is active, we are in direct internet mode (disconnected)
  if (!activeServerId) {
    return {
      kind: 'disconnected',
      activeServer: null,
      lastHandshakeSecondsAgo: null,
    };
  }

  // 2. Fetch peers to check handshake on the active server's interface
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

  const allCountries = await getAllCountries();
  const allServers: ServerEntry[] = [];
  for (const c of allCountries) {
    allServers.push(...c.servers);
  }

  const activeServer = allServers.find((s) => s.id === activeServerId) || {
    id: activeServerId,
    label: activeServerId,
    interfaceName: `wg-${activeServerId}`,
    endpointIp: '127.0.0.1',
  };

  const peer = Array.isArray(peers)
    ? peers.find((p) => p.interface === activeServer.interfaceName && !isItemDisabled(p))
    : undefined;
  const handshakeAgo = peer ? parseMikroTikDuration(peer['last-handshake']) : null;

  if (handshakeAgo !== null && handshakeAgo <= HANDSHAKE_STALE_THRESHOLD_SECONDS) {
    return {
      kind: 'connected',
      activeServer,
      lastHandshakeSecondsAgo: handshakeAgo,
    };
  }

  return {
    kind: 'disconnected',
    activeServer,
    lastHandshakeSecondsAgo: handshakeAgo,
  };
}

/**
 * Provisions a new WireGuard server onto the router natively via REST API.
 * Crucial: The private key is only used in this function and never saved to device storage!
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

  const { network, gateway } = computeNetworkAndGateway(
    params.parsedConfig.address,
    params.parsedConfig.dns,
  );
  const listenPort = await getNextListenPort();
  const interfaceName = `wg-${params.serverId}`;

  console.log(`[provisionServer] Provisioning ${params.serverId} (${interfaceName}) via REST API...`);

  // 1. Ensure WireGuard Interface exists
  const existingIfRes = await routerFetch(
    `/rest/interface/wireguard?name=${encodeURIComponent(interfaceName)}`,
    { method: 'GET' },
    creds,
  );
  const existingIfList: any[] = existingIfRes.ok ? await existingIfRes.json() : [];

  if (existingIfList.length > 0) {
    const id = existingIfList[0]['.id'];
    const currentPort = existingIfList[0]['listen-port'] || String(listenPort);
    console.log(`[provisionServer] Updating interface ${interfaceName} (${id})...`);
    await routerFetch(
      `/rest/interface/wireguard/${id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          'listen-port': currentPort,
          'private-key': params.parsedConfig.privateKey,
          comment: params.serverId,
        }),
      },
      creds,
    );
  } else {
    console.log(`[provisionServer] Creating interface ${interfaceName}...`);
    const createIfRes = await routerFetch(
      '/rest/interface/wireguard',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: interfaceName,
          'listen-port': String(listenPort),
          'private-key': params.parsedConfig.privateKey,
          comment: params.serverId,
          disabled: 'true',
        }),
      },
      creds,
    );
    if (!createIfRes.ok) {
      const txt = await createIfRes.text().catch(() => '');
      throw new RouterScriptError(`Failed to create interface: HTTP ${createIfRes.status} ${txt}`);
    }
  }

  // 2. Ensure WireGuard Peer exists
  const existingPeerRes = await routerFetch(
    `/rest/interface/wireguard/peers?interface=${encodeURIComponent(interfaceName)}`,
    { method: 'GET' },
    creds,
  );
  const existingPeerList: any[] = existingPeerRes.ok ? await existingPeerRes.json() : [];

  if (existingPeerList.length > 0) {
    const id = existingPeerList[0]['.id'];
    console.log(`[provisionServer] Updating peer for ${interfaceName} (${id})...`);
    await routerFetch(
      `/rest/interface/wireguard/peers/${id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          'public-key': params.parsedConfig.publicKey,
          'endpoint-address': params.parsedConfig.endpointAddress,
          'endpoint-port': String(params.parsedConfig.endpointPort),
          'allowed-address': '0.0.0.0/0',
          'persistent-keepalive': '25s',
          comment: params.serverId,
          disabled: 'true',
        }),
      },
      creds,
    );
  } else {
    console.log(`[provisionServer] Creating peer for ${interfaceName}...`);
    const createPeerRes = await routerFetch(
      '/rest/interface/wireguard/peers',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          interface: interfaceName,
          'public-key': params.parsedConfig.publicKey,
          'endpoint-address': params.parsedConfig.endpointAddress,
          'endpoint-port': String(params.parsedConfig.endpointPort),
          'allowed-address': '0.0.0.0/0',
          'persistent-keepalive': '25s',
          comment: params.serverId,
          disabled: 'true',
        }),
      },
      creds,
    );
    if (!createPeerRes.ok) {
      const txt = await createPeerRes.text().catch(() => '');
      throw new RouterScriptError(`Failed to create peer: HTTP ${createPeerRes.status} ${txt}`);
    }
  }

  // 3. Ensure IP Address exists and clean up conflicting/orphan addresses
  try {
    const allAddrsRes = await routerFetch('/rest/ip/address', { method: 'GET' }, creds);
    if (allAddrsRes.ok) {
      const allAddrs: any[] = await allAddrsRes.json();
      for (const a of allAddrs) {
        const iface = String(a.interface || '');
        const isOrphan =
          iface.startsWith('*') ||
          (a.comment === params.serverId && iface !== interfaceName);
        if (isOrphan) {
          console.log(`[provisionServer] Removing orphan IP address ${a['.id']} (${a.address} on ${iface})...`);
          await routerFetch(`/rest/ip/address/${a['.id']}`, { method: 'DELETE' }, creds);
        }
      }
    }
  } catch (err) {
    console.warn('[provisionServer] Orphan IP cleanup warning:', err);
  }

  const existingAddrRes = await routerFetch(
    `/rest/ip/address?interface=${encodeURIComponent(interfaceName)}`,
    { method: 'GET' },
    creds,
  );
  const existingAddrList: any[] = existingAddrRes.ok ? await existingAddrRes.json() : [];

  if (existingAddrList.length > 0) {
    const id = existingAddrList[0]['.id'];
    console.log(`[provisionServer] Updating IP address for ${interfaceName} (${id})...`);
    await routerFetch(
      `/rest/ip/address/${id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: params.parsedConfig.address,
          network: network,
          comment: params.serverId,
          disabled: 'true',
        }),
      },
      creds,
    );
  } else {
    console.log(`[provisionServer] Creating IP address for ${interfaceName}...`);
    const createAddrRes = await routerFetch(
      '/rest/ip/address',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          interface: interfaceName,
          address: params.parsedConfig.address,
          network: network,
          comment: params.serverId,
          disabled: 'true',
        }),
      },
      creds,
    );
    if (!createAddrRes.ok) {
      const txt = await createAddrRes.text().catch(() => '');
      throw new RouterScriptError(`Failed to create IP address: HTTP ${createAddrRes.status} ${txt}`);
    }
  }

  // 4. Ensure Firewall NAT Masquerade rule exists
  const existingNatRes = await routerFetch(
    `/rest/ip/firewall/nat?out-interface=${encodeURIComponent(interfaceName)}`,
    { method: 'GET' },
    creds,
  );
  const existingNatList: any[] = existingNatRes.ok ? await existingNatRes.json() : [];

  if (existingNatList.length === 0) {
    console.log(`[provisionServer] Creating NAT masquerade for ${interfaceName}...`);
    await routerFetch(
      '/rest/ip/firewall/nat',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chain: 'srcnat',
          action: 'masquerade',
          'out-interface': interfaceName,
          comment: `vpn-nat-${params.serverId}`,
          disabled: 'true',
        }),
      },
      creds,
    );
  } else {
    const id = existingNatList[0]['.id'];
    await routerFetch(
      `/rest/ip/firewall/nat/${id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          disabled: 'true',
        }),
      },
      creds,
    );
  }

  // 5. Ensure Split Policy Routes exist
  // Find LAN physical gateway
  let lanGateway = '172.20.0.1';
  try {
    const defaultRouteRes = await routerFetch(
      '/rest/ip/route?dst-address=0.0.0.0/0',
      { method: 'GET' },
      creds,
    );
    if (defaultRouteRes.ok) {
      const defaultRoutes: any[] = await defaultRouteRes.json();
      if (defaultRoutes.length > 0 && defaultRoutes[0].gateway) {
        lanGateway = defaultRoutes[0].gateway;
      }
    }
  } catch {
    // Keep fallback 172.20.0.1
  }

  const routesToConfigure = [
    {
      comment: `vpn-split1-${params.serverId}`,
      'dst-address': '0.0.0.0/1',
      gateway: interfaceName,
      disabled: 'true',
    },
    {
      comment: `vpn-split2-${params.serverId}`,
      'dst-address': '128.0.0.0/1',
      gateway: interfaceName,
      disabled: 'true',
    },
    {
      comment: `vpn-endpoint-${params.serverId}`,
      'dst-address': `${params.parsedConfig.endpointAddress}/32`,
      gateway: lanGateway,
      disabled: 'true',
    },
  ];

  for (const rConfig of routesToConfigure) {
    const existingRouteRes = await routerFetch(
      `/rest/ip/route?comment=${encodeURIComponent(rConfig.comment)}`,
      { method: 'GET' },
      creds,
    );
    const existingRouteList: any[] = existingRouteRes.ok ? await existingRouteRes.json() : [];

    if (existingRouteList.length > 0) {
      const id = existingRouteList[0]['.id'];
      await routerFetch(
        `/rest/ip/route/${id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rConfig),
        },
        creds,
      );
    } else {
      await routerFetch(
        '/rest/ip/route',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rConfig),
        },
        creds,
      );
    }
  }

  console.log(`[provisionServer] ✅ Successfully provisioned ${params.serverId} via REST API!`);

  // On success, save non-sensitive server descriptor to local storage
  const newServerEntry: ServerEntry = {
    id: params.serverId,
    label: params.label,
    interfaceName: interfaceName,
    endpointIp: params.parsedConfig.endpointAddress,
  };

  await appendImportedServer(
    params.countryCode,
    params.countryLabel,
    params.flag,
    newServerEntry,
  );
}
