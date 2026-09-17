# ==============================================================================
# MikroTik RouterOS v7 - KonnectVPN Setup Script
#
# The KonnectVPN app provisions WireGuard interfaces, peers, addresses,
# NAT rules, and split routing policies directly via the RouterOS REST API.
#
# If you prefer to run RouterOS CLI commands manually via WinBox / SSH,
# this script creates the exact same setup.
# ==============================================================================

# 1. Ensure LAN REST API service is active (HTTP on port 80)
/ip service set www address=192.168.180.0/24,192.168.180.0/24 port=80 disabled=no

# 2. WireGuard Interface for UK London 1 (Listen Port: 13233)
/interface/wireguard add name="wg-uk-london-1" listen-port=13233 private-key="YBwztI7YkagZvksDJB5oOYNufsFQc/pXgYHYAgK4REM=" comment="uk-london-1"

# 3. WireGuard Peer for UK London 1 (ProtonVPN)
/interface/wireguard/peers add interface="wg-uk-london-1" public-key="q8eGv8tYlyBb5OIaIfm6ddI4/XmDZxYvMjGVf9L1vGU=" endpoint-address="149.40.48.106" endpoint-port=51820 allowed-address=0.0.0.0/0 persistent-keepalive=25s comment="uk-london-1"

# 4. IP Address on wg-uk-london-1
/ip/address add address=10.2.0.2/30 network=10.2.0.0 interface="wg-uk-london-1" comment="uk-london-1"

# 5. Outbound NAT Masquerade
/ip/firewall/nat add chain=srcnat action=masquerade out-interface="wg-uk-london-1" comment="vpn-nat-uk-london-1"

# 6. Policy Split Routes (Disabled by default, enabled when user connects)
/ip/route add dst-address=0.0.0.0/1 gateway=10.2.0.1%wg-uk-london-1 comment="vpn-split1-uk-london-1" disabled=yes
/ip/route add dst-address=128.0.0.0/1 gateway=10.2.0.1%wg-uk-london-1 comment="vpn-split2-uk-london-1" disabled=yes
/ip/route add dst-address=149.40.48.106/32 gateway=192.168.110.1 comment="vpn-endpoint-uk-london-1" disabled=yes

# 7. Helper scripts (Optional - the app handles switching via REST API natively)
/system/script add name="switch-vpn" source=":local targetServer \$serverId;\r\n:foreach r in=[/ip route find where comment~\"vpn-split1\"] do={\r\n  :local comm [/ip route get \$r comment];\r\n  :if (\$comm~\"vpn-split1-\" . \$targetServer) do={\r\n    /ip route enable \$r;\r\n  } else={\r\n    /ip route disable \$r;\r\n  }\r\n};\r\n:foreach r in=[/ip route find where comment~\"vpn-split2\"] do={\r\n  :local comm [/ip route get \$r comment];\r\n  :if (\$comm~\"vpn-split2-\" . \$targetServer) do={\r\n    /ip route enable \$r;\r\n  } else={\r\n    /ip route disable \$r;\r\n  }\r\n};\r\n:foreach r in=[/ip route find where comment~\"vpn-endpoint\"] do={\r\n  :local comm [/ip route get \$r comment];\r\n  :if (\$comm~\"vpn-endpoint-\" . \$targetServer) do={\r\n    /ip route enable \$r;\r\n  } else={\r\n    /ip route disable \$r;\r\n  }\r\n}"

/system/script add name="disconnect-vpn" source="/ip route disable [find where comment~\"vpn-split1\"];\r\n/ip route disable [find where comment~\"vpn-split2\"];\r\n/ip route disable [find where comment~\"vpn-endpoint\"];"
