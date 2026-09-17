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

  // WireGuard DNS may list IPv4 and IPv6 resolvers; RouterOS network needs one IPv4 address.
  const dnsGateway = dnsFallback?.split(',').map((value) => value.trim()).find((value) => {
    const octets = value.split('.');
    return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
  });

  // For /32 point-to-point host routes, the network address in RouterOS is the remote peer / gateway
  // (typically 10.2.0.1 in Proton VPN) so RouterOS creates an on-link connected route to the peer.
  if (prefix === 32) {
    const gw = dnsGateway || '10.2.0.1';
    return {
      network: gw,
      gateway: gw,
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
    gateway: dnsGateway || intToIp(gwInt),
  };
}
