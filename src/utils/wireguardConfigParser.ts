// src/utils/wireguardConfigParser.ts
//
// Parser for Proton / standard WireGuard .conf files (INI-style format).

export type ParsedWireGuardConfig = {
  privateKey: string;
  address: string; // e.g. "10.2.0.14/30"
  dns?: string;
  publicKey: string;
  endpointAddress: string;
  endpointPort: number;
  allowedIps: string;
  persistentKeepalive?: number;
};

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export function parseWireGuardConfig(fileContents: string): ParsedWireGuardConfig {
  if (!fileContents || typeof fileContents !== 'string') {
    throw new ParseError('Configuration file is empty or could not be read.');
  }

  const lines = fileContents.split(/\r?\n/);
  let currentSection = '';

  const config: Partial<ParsedWireGuardConfig> = {};

  for (let rawLine of lines) {
    // Strip comments (# or ;) and whitespace
    const commentIndex = rawLine.search(/[#;]/);
    if (commentIndex !== -1) {
      rawLine = rawLine.substring(0, commentIndex);
    }
    const line = rawLine.trim();
    if (!line) continue;

    // Check section header
    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1).trim().toLowerCase();
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim().toLowerCase();
    const value = line.slice(eqIndex + 1).trim();

    if (currentSection === 'interface') {
      if (key === 'privatekey') {
        config.privateKey = value;
      } else if (key === 'address') {
        // May contain multiple addresses (e.g. IPv4 and IPv6) - take the IPv4 one
        const addrs = value.split(',').map((a) => a.trim());
        const ipv4 = addrs.find((a) => a.includes('.') && a.includes('/')) || addrs[0];
        config.address = ipv4;
      } else if (key === 'dns') {
        config.dns = value;
      }
    } else if (currentSection === 'peer') {
      if (key === 'publickey') {
        config.publicKey = value;
      } else if (key === 'endpoint') {
        // Split "146.70.x.x:51820" or "[ipv6]:51820"
        const lastColon = value.lastIndexOf(':');
        if (lastColon === -1) {
          throw new ParseError(`Endpoint "${value}" is missing a port number (expected IP:port).`);
        }
        const host = value.slice(0, lastColon).trim().replace(/^\[|\]$/g, '');
        const portStr = value.slice(lastColon + 1).trim();
        const port = parseInt(portStr, 10);
        if (isNaN(port) || port <= 0 || port > 65535) {
          throw new ParseError(`Invalid endpoint port "${portStr}" in Endpoint.`);
        }
        config.endpointAddress = host;
        config.endpointPort = port;
      } else if (key === 'allowedips') {
        config.allowedIps = value;
      } else if (key === 'persistentkeepalive') {
        const pka = parseInt(value, 10);
        if (!isNaN(pka)) {
          config.persistentKeepalive = pka;
        }
      }
    }
  }

  // Validate required fields
  if (!config.privateKey) {
    throw new ParseError('Missing required field "PrivateKey" in [Interface] section.');
  }
  if (!config.address) {
    throw new ParseError('Missing required field "Address" in [Interface] section.');
  }
  if (!config.publicKey) {
    throw new ParseError('Missing required field "PublicKey" in [Peer] section.');
  }
  if (!config.endpointAddress || !config.endpointPort) {
    throw new ParseError('Missing or invalid "Endpoint" (IP:port) in [Peer] section.');
  }
  if (!config.allowedIps) {
    // Default allowed IPs for full tunnel if missing
    config.allowedIps = '0.0.0.0/0';
  }

  return config as ParsedWireGuardConfig;
}
