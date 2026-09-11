# KonnectVPN

A single-user, LAN-only React Native (CLI, not Expo Go) iOS app that allows a non-technical person to:
1. **Pick a country**, then see pre-configured candidate servers ranked by live-measured latency.
2. **Connect to whichever server looks best** (or the app's recommended one) with one tap.
3. **See whether the currently active server's tunnel is actually live** via a familiar consumer VPN interface (large central toggle).

The app talks **directly to the router's REST API over the home Wi-Fi** — no cloud backend, no internet-facing service, no Vercel, and no dependency on ProtonVPN's own API.

---

## Consumer UI Experience
- **Big Central Power Toggle**:
  - *Disconnected*: Dark outline, displays "Not Connected". Tapping it reconnects to the last-used server or opens the location picker if first time.
  - *Connecting*: Pulsing animated ring with indicator.
  - *Connected*: Solid emerald green fill, displays "Connected". Tapping it calls `disconnectVpn()`.
- **Current Location Row**: Shows active server flag and name (e.g. `🇬🇧 London 1`) or `Choose a location`. Tapping opens the two-tier location picker sheet.
- **Two-Tier Location Picker Sheet**:
  - *Level 1 (Countries)*: Lists countries with flag, name, and server count. Selecting a country with only one server connects immediately.
  - *Level 2 (Servers)*: Parallel latency pings (`/rest/ping`) measured by the router. Servers are sorted fastest-first, with the top server tagged **"Recommended"**.
- **Admin Console (`AdminScreen`)**:
  - Deliberately non-obvious entry point: **long-press on the app version number** at the bottom of the home screen.
  - **Biometric Gate**: Protected with Face ID / Touch ID (or fallback router password).
  - Imports standard WireGuard `.conf` files, computes `/30` subnet & gateway, allocates listen ports, and provisions the router live.

---

## Seed List vs. Locally-Persisted List (Reinstall Warning)
- `src/config/vpnConfig.ts` contains the **seed list** of manually-provisioned servers (`uk-london-1`, `uk-london-2`, `us-1`, etc.).
- New servers added through the in-app import flow in `AdminScreen` are stored in the device's local storage via `src/config/serverStore.ts`.
- **Important**: If you reinstall or wipe the app, locally-imported servers are cleared back to the static seed list in `vpnConfig.ts`.

---

## Private Key Handling
- **The private key is never saved on-device.**
- During `.conf` import in `AdminScreen`, the private key exists only as an in-memory variable for the duration of the `provisionServer()` REST call to the router. It is discarded immediately after and never stored in `AsyncStorage`, Keychain, or persistent app state.

---

## Disconnect vs. Router Reset
- **Disconnect VPN**: Tapping the active green toggle triggers `disconnectVpn()`, which runs the RouterOS script `disconnect-vpn`. This reverts active VPN routing back to direct internet.
- **Never confused with a system reset**: This has nothing to do with `/system reset-configuration` (which would wipe router configuration).
- **Preserved last-used server**: Disconnecting keeps the last connected server in memory, allowing instant one-tap reconnect.

---

## Sign Out vs. Disconnect
- **Sign Out is purely local**: Tapping the gear icon and selecting "Sign Out" clears stored credentials and returns to `LoginScreen`.
- **Hard Rule**: Signing out **never** calls `disconnectVpn()` or any router endpoint. Signing out of the app will never interrupt active internet traffic.

---

## Status Polling: Foreground Only
iOS suspends apps within seconds of backgrounding. `BGTaskScheduler` only grants opportunistic wake-ups roughly every 15+ minutes at the OS's discretion. The app polls `getConnectionStatus()` every 5 seconds **strictly while in the foreground** using `AppState`, and fires an immediate check upon returning to active.

---

## Router-Side Prerequisites Checklist
Before using the app, ensure your MikroTik router has:
1. **REST API on plain HTTP, bound to LAN only**:
   ```routeros
   /ip service set www address=172.20.0.0/24 port=80 disabled=no
   /ip service set www-ssl disabled=yes
   ```
2. **API User Permissions**:
   The user needs:
   - `read` access covering `/rest/interface/wireguard/peers`
   - `write` access covering `/interface/wireguard`, `/ip/address`, `/ip/route`, `/ip/firewall` (for `provision-server`)
   - `policy` & `test` permissions (to run the `/rest/ping` latency tool)
   - `script-run` on the three scripts: `switch-vpn`, `disconnect-vpn`, and `provision-server`.
   ```routeros
   /user group add name=vpn-app policy=read,write,policy,test,api
   /user add name=api group=vpn-app password="<your-password>"
   ```
3. **Named Scripts**:
   - `switch-vpn` (accepts `serverId`)
   - `disconnect-vpn` (disables active VPN routes)
   - `provision-server` (accepts `serverId`, `privKey`, `addr`, `netAddr`, `gateway`, `pubKey`, `endpointAddr`, `endpointPort`, `listenPort`)

---

## Pointing to a Different Router IP
Edit `ROUTER_BASE_URL` in [`src/config/vpnConfig.ts`](src/config/vpnConfig.ts) and verify `ios/konnectvpn/Info.plist` has the matching IP in `NSExceptionDomains`.
