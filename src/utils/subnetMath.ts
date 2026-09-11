// src/utils/subnetMath.ts
//
// Calculates network address and gateway for WireGuard point-to-point /30 subnet.
// Proton convention:
// For a /30 subnet (block of 4 IPs):
// network address = block base (e.g. 10.2.0.12)
// gateway = network + 1 (e.g. 10.2.0.13)
// client address = network + 2 (e.g. 10.2.0.14)
// broadcast = network + 3 (e.g. 10.2.0.15)

export function ipToInt(ip: string): number {
  const parts = ip.trim().split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: "${ip}"`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function intToIp(int: number): string {
  return [
    (int >>> 24) & 255,
    (int >>> 16) & 255,
    (int >>> 8) & 255,
    int & 255,
  ].join('.');
}

export function computeNetworkAndGateway(
  cidrAddress: string,
  dnsFallback?: string,
): { network: string; gateway: string } {
  const [ipPart, prefixPart] = cidrAddress.trim().split('/');
  if (!ipPart || !prefixPart) {
    throw new Error(`Invalid CIDR address format: "${cidrAddress}" (expected e.g. 10.2.0.14/30)`);
  }

  const prefix = parseInt(prefixPart, 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid prefix length in CIDR: "${cidrAddress}"`);
  }

  // For /32 point-to-point host routes, the network address is the IP itself,
  // and the gateway is the remote peer / DNS (typically 10.2.0.1 in Proton VPN).
  if (prefix === 32) {
    return {
      network: ipPart,
      gateway: dnsFallback || '10.2.0.1',
    };
  }

  const ipInt = ipToInt(ipPart);
  // Netmask calculation
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const netInt = (ipInt & mask) >>> 0;

  // Proton's convention: network + 1 is the gateway unless DNS is specified
  const gwInt = (netInt + 1) >>> 0;

  return {
    network: intToIp(netInt),
    gateway: dnsFallback || intToIp(gwInt),
  };
}
