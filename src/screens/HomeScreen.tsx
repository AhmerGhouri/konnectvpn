// src/screens/HomeScreen.tsx
//
// Consumer VPN UI:
// - Central circular power toggle (Connected, Connecting, Disconnected)
// - Current location row (opens 2-level bottom sheet / overlay)
// - 2-tier location picker (Country list -> Ranked candidate server list)
// - Status detail line with friendly plain-language copy
// - Settings gear (local sign-out without disconnecting VPN)
// - Hidden entry point (long press on version) for Admin Screen

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  Animated,
  Modal,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getConnectionStatus,
  switchServer,
  disconnectVpn,
  rankServers,
  getLastConnectedServerId,
  clearCredentials,
  type ConnectionStatus,
  type RankedServer,
  RouterUnreachableError,
  RouterAuthError,
} from '../api/routerClient';
import {
  getAllCountries,
  type CountryWithServers,
} from '../config/serverStore';
import {
  STATUS_POLL_INTERVAL_MS,
  type ServerEntry,
} from '../config/vpnConfig';
import {
  preProvisionAllBundledServers,
  type ProvisionProgress,
} from '../api/batchProvisioner';
import { ALL_BUNDLED_SERVERS } from '../vpn_countries';

interface HomeScreenProps {
  onLogout: () => void;
  onOpenAdmin: () => void;
}

export default function HomeScreen({ onLogout, onOpenAdmin }: HomeScreenProps) {
  const insets = useSafeAreaInsets();

  // Connection status from the router
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [isActionInFlight, setIsActionInFlight] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Picker modal state
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [countriesList, setCountriesList] = useState<CountryWithServers[]>([]);
  const [selectedCountry, setSelectedCountry] = useState<CountryWithServers | null>(null);
  const [rankedServers, setRankedServers] = useState<RankedServer[]>([]);
  const [isRankingLoading, setIsRankingLoading] = useState(false);
  const [rankingCache, setRankingCache] = useState<Record<string, RankedServer[]>>({});

  // Settings dropdown state
  const [showSettings, setShowSettings] = useState(false);

  // Pulse animation for central button
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (isActionInFlight) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 0.6,
            duration: 700,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 700,
            useNativeDriver: true,
          }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isActionInFlight, pulseAnim]);

  // -------------------------------------------------------------------------
  // Foreground Polling
  // -------------------------------------------------------------------------
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollStatus = useCallback(async () => {
    const result = await getConnectionStatus();
    setStatus(result);

    if (result.kind === 'authError') {
      setStatusMessage('Session expired — tap to sign in again');
    } else if (result.kind === 'unreachable') {
      setStatusMessage("Can't reach your router — check you're on home Wi-Fi");
    } else if (result.kind === 'disconnected') {
      if (result.activeServer) {
        setStatusMessage('Connection lost — tap to retry');
      } else {
        setStatusMessage(null);
      }
    } else {
      // Connected
      setStatusMessage(null);
    }
  }, []);

  const startPolling = useCallback(() => {
    pollStatus();
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = setInterval(pollStatus, STATUS_POLL_INTERVAL_MS);
  }, [pollStatus]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    startPolling();
    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        startPolling();
      } else {
        stopPolling();
      }
    });

    return () => {
      stopPolling();
      sub.remove();
    };
  }, [startPolling, stopPolling]);

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Location Picker sheet handlers
  // -------------------------------------------------------------------------
  const openLocationPicker = useCallback(async () => {
    const list = await getAllCountries();
    setCountriesList(list);
    setSelectedCountry(null);
    setRankedServers([]);
    setIsPickerOpen(true);
  }, []);

  // -------------------------------------------------------------------------
  // Central Toggle Handler (Connect / Disconnect)
  // -------------------------------------------------------------------------
  const handleCentralToggle = useCallback(async () => {
    if (isActionInFlight) return;

    if (status?.kind === 'authError') {
      await clearCredentials();
      onLogout();
      return;
    }

    if (status?.kind === 'connected') {
      // Tapping while connected calls disconnectVpn()
      setIsActionInFlight(true);
      setStatusMessage('Disconnecting...');
      try {
        await disconnectVpn();
        await pollStatus();
      } catch (err: any) {
        setStatusMessage(err.displayMessage || 'Failed to disconnect');
      } finally {
        setIsActionInFlight(false);
      }
    } else {
      // Disconnected: Reconnect to last-used server or open location picker
      const lastServerId = await getLastConnectedServerId();
      if (lastServerId) {
        setIsActionInFlight(true);
        setStatusMessage('Connecting...');
        try {
          await switchServer(lastServerId);
          await pollStatus();
        } catch (err: any) {
          if (err instanceof RouterUnreachableError) {
            setStatusMessage("Can't reach your router — check you're on home Wi-Fi");
          } else if (err instanceof RouterAuthError) {
            setStatusMessage('Session expired — tap to sign in again');
          } else {
            setStatusMessage(err.displayMessage || 'Connection failed');
          }
        } finally {
          setIsActionInFlight(false);
        }
      } else {
        // First connection ever -> Open location picker
        openLocationPicker();
      }
    }
  }, [isActionInFlight, status, onLogout, pollStatus, openLocationPicker]);

  const handleSelectCountry = useCallback(
    async (country: CountryWithServers) => {
      // Countries with only one server skip ranking and connect immediately
      if (country.servers.length === 1) {
        const singleServer = country.servers[0];
        setIsPickerOpen(false);
        setIsActionInFlight(true);
        setStatusMessage(`Connecting to ${country.flag} ${singleServer.label}...`);
        try {
          await switchServer(singleServer.id);
          await pollStatus();
        } catch (err: any) {
          setStatusMessage(err.displayMessage || 'Connection failed');
        } finally {
          setIsActionInFlight(false);
        }
        return;
      }

      // Level 2: Multiple servers -> display servers immediately and rank in background
      setSelectedCountry(country);
      const fallbackList = country.servers.map((s) => ({ server: s, latencyMs: null }));
      if (rankingCache[country.code]) {
        setRankedServers(rankingCache[country.code]);
      } else {
        setRankedServers(fallbackList);
        setIsRankingLoading(true);
        try {
          const ranked = await rankServers(country.code, country.servers);
          setRankedServers(ranked);
          setRankingCache((prev) => ({ ...prev, [country.code]: ranked }));
        } catch {
          // Keep fallback list
        } finally {
          setIsRankingLoading(false);
        }
      }
    },
    [rankingCache, pollStatus],
  );

  const handleSelectServer = useCallback(
    async (server: ServerEntry, flag: string) => {
      setIsPickerOpen(false);
      setIsActionInFlight(true);
      setStatusMessage(`Connecting to ${flag} ${server.label}...`);
      try {
        await switchServer(server.id);
        await pollStatus();
      } catch (err: any) {
        setStatusMessage(err.displayMessage || 'Connection failed');
      } finally {
        setIsActionInFlight(false);
      }
    },
    [pollStatus],
  );

  // -------------------------------------------------------------------------
  // Sign Out Handler (Purely local, NEVER calls disconnectVpn)
  // -------------------------------------------------------------------------
  const handleSignOut = useCallback(async () => {
    setShowSettings(false);
    await clearCredentials();
    onLogout();
  }, [onLogout]);

  // Batch provisioning state
  const [isBatchSyncing, setIsBatchSyncing] = useState(false);
  const [batchProgress, setBatchProgress] = useState<ProvisionProgress | null>(null);

  const handleBatchProvision = useCallback(async () => {
    setShowSettings(false);
    setIsBatchSyncing(true);
    setBatchProgress({ total: ALL_BUNDLED_SERVERS.length, completed: 0, currentServer: 'Starting...' });

    try {
      const result = await preProvisionAllBundledServers((p) => {
        setBatchProgress(p);
      });

      // Refresh countries list
      const updated = await getAllCountries();
      setCountriesList(updated);

      if (result.failed > 0) {
        const firstError = result.errors[0] || 'Unknown error';
        setStatusMessage(`Sync failed: ${firstError}`);
        console.error('[handleBatchProvision] Errors:', result.errors);
      } else {
        setStatusMessage(`All ${result.successful} servers are synced & ready!`);
      }
    } catch (err: any) {
      console.error('[handleBatchProvision] Unexpected error:', err);
      setStatusMessage(`Sync failed: ${err?.message || 'Check router connection'}`);
    } finally {
      setIsBatchSyncing(false);
      setBatchProgress(null);
    }
  }, []);

  // Derived state for toggle button
  const isConnected = status?.kind === 'connected';
  const buttonStateText = isActionInFlight
    ? 'Connecting...'
    : isConnected
    ? 'Connected'
    : 'Not Connected';

  // Active server label calculation
  let activeLocationText = 'Choose a location';
  let activeFlag = '🌐';
  if (status?.kind === 'connected' && status.activeServer) {
    activeLocationText = status.activeServer.label;
    // Find flag from seed or storage
    const match = countriesList.find((c) =>
      c.servers.some((s) => s.id === status.activeServer?.id),
    );
    if (match) activeFlag = match.flag;
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>KonnectVPN</Text>
        </View>

        <Pressable
          style={styles.settingsIconBtn}
          onPress={() => setShowSettings(!showSettings)}
          hitSlop={12}
        >
          <Text style={styles.settingsIcon}>⚙️</Text>
        </Pressable>
      </View>

      {/* Settings Popover */}
      {showSettings && (
        <View style={styles.settingsDropdown}>
          <Pressable style={styles.settingsItemBtn} onPress={handleBatchProvision}>
            <Text style={styles.settingsItemText}>⚡ Sync All Servers to Router</Text>
          </Pressable>
          <View style={styles.dropdownDivider} />
          <Pressable style={styles.signOutBtn} onPress={handleSignOut}>
            <Text style={styles.signOutText}>Sign Out</Text>
          </Pressable>
        </View>
      )}

      {/* Batch Provisioning Modal */}
      <Modal visible={isBatchSyncing} transparent={true} animationType="fade">
        <View style={styles.syncModalBackdrop}>
          <View style={styles.syncCard}>
            <ActivityIndicator size="large" color="#6366F1" />
            <Text style={styles.syncTitle}>Provisioning Servers on Router</Text>
            <Text style={styles.syncSubtitle}>
              Creating WireGuard interfaces & routing policies...
            </Text>
            {batchProgress && (
              <View style={styles.progressWrap}>
                <Text style={styles.progressItem}>
                  {batchProgress.currentServer}
                </Text>
                <Text style={styles.progressCount}>
                  {batchProgress.completed} of {batchProgress.total} completed
                </Text>
              </View>
            )}
          </View>
        </View>
      </Modal>

      {/* Main VPN Dashboard Area */}
      <View style={styles.dashboard}>
        {/* Big Central Power Button */}
        <View style={styles.toggleContainer}>
          <Animated.View
            style={[
              styles.powerOuterRing,
              isConnected && styles.ringConnected,
              isActionInFlight && styles.ringConnecting,
              { transform: [{ scale: pulseAnim }] },
            ]}
          >
            <Pressable
              style={({ pressed }) => [
                styles.powerButton,
                isConnected && styles.powerButtonConnected,
                isActionInFlight && styles.powerButtonConnecting,
                pressed && styles.powerButtonPressed,
              ]}
              onPress={handleCentralToggle}
              disabled={isActionInFlight}
            >
              {isActionInFlight ? (
                <ActivityIndicator size="large" color="#FFFFFF" />
              ) : (
                <Text style={[styles.powerIcon, isConnected && styles.powerIconConnected]}>
                  ⏻
                </Text>
              )}
            </Pressable>
          </Animated.View>

          {/* Connected / Not Connected Label */}
          <Text
            style={[
              styles.toggleStateLabel,
              isConnected && styles.stateLabelConnected,
              isActionInFlight && styles.stateLabelConnecting,
            ]}
          >
            {buttonStateText}
          </Text>
        </View>

        {/* Current Location Row (Tappable to open picker) */}
        <Pressable style={styles.locationRow} onPress={openLocationPicker}>
          <View style={styles.locationInfo}>
            <Text style={styles.locationFlag}>{activeFlag}</Text>
            <View>
              <Text style={styles.locationCaption}>Current Location</Text>
              <Text style={styles.locationValue}>{activeLocationText}</Text>
            </View>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        {/* Status Detail Line */}
        {statusMessage ? (
          <Pressable onPress={() => status?.kind === 'authError' && handleSignOut()}>
            <Text style={styles.statusDetailText}>{statusMessage}</Text>
          </Pressable>
        ) : (
          <Text style={styles.statusDetailPlaceholder}> </Text>
        )}
      </View>

      {/* Non-obvious Entry Point for Admin Screen: Long press on version */}
      <View style={styles.footer}>
        <Pressable onLongPress={onOpenAdmin} delayLongPress={800}>
          <Text style={styles.versionText}>v1.0.0 (build 14)</Text>
        </Pressable>
      </View>

      {/* Location Picker Sheet Modal */}
      <Modal
        visible={isPickerOpen}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setIsPickerOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.sheetContainer, { paddingBottom: insets.bottom + 16 }]}>
            {/* Sheet Header */}
            <View style={styles.sheetHeader}>
              {selectedCountry ? (
                <Pressable
                  style={styles.backBtn}
                  onPress={() => setSelectedCountry(null)}
                  hitSlop={8}
                >
                  <Text style={styles.backBtnText}>‹ Countries</Text>
                </Pressable>
              ) : (
                <Text style={styles.sheetTitle}>Select Location</Text>
              )}

              <Pressable
                style={styles.closeBtn}
                onPress={() => setIsPickerOpen(false)}
                hitSlop={8}
              >
                <Text style={styles.closeBtnText}>Done</Text>
              </Pressable>
            </View>

            {/* Level 1: Country List */}
            {!selectedCountry && (
              <ScrollView style={styles.pickerList}>
                {countriesList.map((c) => (
                  <Pressable
                    key={c.code}
                    style={({ pressed }) => [
                      styles.countryItem,
                      pressed && styles.itemPressed,
                    ]}
                    onPress={() => handleSelectCountry(c)}
                  >
                    <View style={styles.itemLeft}>
                      <Text style={styles.itemFlag}>{c.flag}</Text>
                      <Text style={styles.itemTitle}>{c.label}</Text>
                    </View>
                    <View style={styles.itemRight}>
                      {c.servers.length > 1 && (
                        <Text style={styles.serverCountText}>
                          {c.servers.length} servers
                        </Text>
                      )}
                      <Text style={styles.chevron}>›</Text>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            )}

            {/* Level 2: Server List for Country */}
            {selectedCountry && (
              <View style={styles.serverLevelContainer}>
                <View style={styles.countryHeaderBanner}>
                  <Text style={styles.level2Flag}>{selectedCountry.flag}</Text>
                  <Text style={styles.level2CountryName}>{selectedCountry.label}</Text>
                  {isRankingLoading && (
                    <View style={styles.headerRankingIndicator}>
                      <ActivityIndicator color="#6366F1" size="small" />
                      <Text style={styles.headerRankingText}>Pinging...</Text>
                    </View>
                  )}
                </View>

                <ScrollView
                  style={styles.pickerList}
                  contentContainerStyle={styles.pickerListContent}
                >
                  {rankedServers.map((item, idx) => {
                    const isRecommended = idx === 0 && item.latencyMs !== null;
                    const isUnavailable = item.latencyMs === null;

                    return (
                      <Pressable
                        key={item.server.id}
                        style={({ pressed }) => [
                          styles.serverItem,
                          pressed && styles.itemPressed,
                        ]}
                        onPress={() =>
                          handleSelectServer(item.server, selectedCountry.flag)
                        }
                      >
                        <View style={styles.itemLeft}>
                          <Text style={styles.serverItemTitle}>
                            {item.server.label}
                          </Text>
                          {isRecommended && (
                            <View style={styles.recommendedBadge}>
                              <Text style={styles.recommendedText}>Recommended</Text>
                            </View>
                          )}
                        </View>

                        <View style={styles.itemRight}>
                          {isRankingLoading && item.latencyMs === null ? (
                            <ActivityIndicator size="small" color="#6366F1" />
                          ) : (
                            <Text
                              style={[
                                styles.latencyText,
                                isUnavailable && styles.latencyUnavailable,
                              ]}
                            >
                              {item.latencyMs !== null
                                ? `${item.latencyMs} ms`
                                : 'Unavailable'}
                            </Text>
                          )}
                        </View>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const COLORS = {
  bg: '#0B1120',
  cardBg: '#141D2F',
  border: '#1E2A42',
  textPrimary: '#F1F5F9',
  textSecondary: '#94A3B8',
  accent: '#6366F1',
  connected: '#10B981',
  connectedGlow: 'rgba(16, 185, 129, 0.25)',
  disconnected: '#64748B',
  connecting: '#F59E0B',
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.textPrimary,
    letterSpacing: 0.5,
  },
  settingsIconBtn: {
    padding: 8,
  },
  settingsIcon: {
    fontSize: 20,
  },
  settingsDropdown: {
    position: 'absolute',
    top: 55,
    right: 20,
    backgroundColor: COLORS.cardBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    zIndex: 100,
    padding: 6,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 8,
    minWidth: 220,
  },
  settingsItemBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  settingsItemText: {
    color: '#6366F1',
    fontSize: 14,
    fontWeight: '600',
  },
  dropdownDivider: {
    height: 1,
    backgroundColor: COLORS.border,
    marginVertical: 4,
  },
  signOutBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  signOutText: {
    color: '#EF4444',
    fontSize: 14,
    fontWeight: '600',
  },
  // Batch sync modal
  syncModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  syncCard: {
    backgroundColor: '#1E293B',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#334155',
    padding: 24,
    alignItems: 'center',
    width: '100%',
    maxWidth: 320,
  },
  syncTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#F8FAFC',
    marginTop: 16,
    textAlign: 'center',
  },
  syncSubtitle: {
    fontSize: 13,
    color: '#94A3B8',
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 16,
  },
  progressWrap: {
    width: '100%',
    backgroundColor: '#0F172A',
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
  },
  progressItem: {
    fontSize: 14,
    fontWeight: '600',
    color: '#38BDF8',
  },
  progressCount: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 4,
  },

  // Central Power Button Area
  dashboard: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  toggleContainer: {
    alignItems: 'center',
    marginBottom: 40,
  },
  powerOuterRing: {
    width: 170,
    height: 170,
    borderRadius: 85,
    backgroundColor: 'rgba(30, 41, 59, 0.7)',
    borderWidth: 3,
    borderColor: COLORS.disconnected,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringConnected: {
    borderColor: COLORS.connected,
    backgroundColor: COLORS.connectedGlow,
    shadowColor: COLORS.connected,
    shadowOpacity: 0.8,
    shadowRadius: 20,
  },
  ringConnecting: {
    borderColor: COLORS.connecting,
  },
  powerButton: {
    width: 130,
    height: 130,
    borderRadius: 65,
    backgroundColor: '#1E293B',
    alignItems: 'center',
    justifyContent: 'center',
  },
  powerButtonConnected: {
    backgroundColor: COLORS.connected,
  },
  powerButtonConnecting: {
    backgroundColor: '#334155',
  },
  powerButtonPressed: {
    transform: [{ scale: 0.95 }],
  },
  powerIcon: {
    fontSize: 54,
    color: '#94A3B8',
    fontWeight: '700',
  },
  powerIconConnected: {
    color: '#FFFFFF',
  },
  toggleStateLabel: {
    marginTop: 18,
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
  stateLabelConnected: {
    color: COLORS.connected,
  },
  stateLabelConnecting: {
    color: COLORS.connecting,
  },

  // Location Row
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    backgroundColor: COLORS.cardBg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  locationInfo: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  locationFlag: {
    fontSize: 28,
    marginRight: 14,
  },
  locationCaption: {
    fontSize: 12,
    color: COLORS.textSecondary,
    fontWeight: '500',
  },
  locationValue: {
    fontSize: 17,
    color: COLORS.textPrimary,
    fontWeight: '600',
    marginTop: 2,
  },
  chevron: {
    fontSize: 22,
    color: COLORS.textSecondary,
    fontWeight: '300',
  },

  // Status Detail Line
  statusDetailText: {
    marginTop: 18,
    fontSize: 13,
    color: '#F59E0B',
    textAlign: 'center',
    fontWeight: '500',
  },
  statusDetailPlaceholder: {
    marginTop: 18,
    fontSize: 13,
  },

  // Footer version
  footer: {
    alignItems: 'center',
    paddingBottom: 10,
  },
  versionText: {
    fontSize: 12,
    color: '#475569',
  },

  // Location Picker Sheet Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: '#0F172A',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    height: '75%',
    maxHeight: '85%',
    paddingTop: 16,
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  backBtn: {
    paddingVertical: 4,
  },
  backBtnText: {
    fontSize: 16,
    color: COLORS.accent,
    fontWeight: '600',
  },
  closeBtn: {
    paddingVertical: 4,
  },
  closeBtnText: {
    fontSize: 16,
    color: COLORS.accent,
    fontWeight: '600',
  },
  pickerList: {
    flex: 1,
    paddingHorizontal: 16,
  },
  pickerListContent: {
    paddingBottom: 36,
  },
  headerRankingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 'auto',
  },
  headerRankingText: {
    marginLeft: 6,
    fontSize: 12,
    color: '#818CF8',
  },
  countryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1E293B',
  },
  itemPressed: {
    backgroundColor: 'rgba(99, 102, 241, 0.1)',
    borderRadius: 8,
  },
  itemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  itemRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  itemFlag: {
    fontSize: 24,
    marginRight: 14,
  },
  itemTitle: {
    fontSize: 16,
    color: COLORS.textPrimary,
    fontWeight: '500',
  },
  serverCountText: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginRight: 6,
  },

  // Level 2
  serverLevelContainer: {
    flex: 1,
  },
  countryHeaderBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: '#1E293B',
  },
  level2Flag: {
    fontSize: 22,
    marginRight: 10,
  },
  level2CountryName: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  rankingLoading: {
    paddingVertical: 36,
    alignItems: 'center',
  },
  rankingLoadingText: {
    marginTop: 12,
    fontSize: 14,
    color: COLORS.textSecondary,
  },
  serverItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 15,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1E293B',
  },
  serverItemTitle: {
    fontSize: 16,
    color: COLORS.textPrimary,
    fontWeight: '500',
  },
  recommendedBadge: {
    marginLeft: 10,
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.4)',
  },
  recommendedText: {
    fontSize: 11,
    color: '#34D399',
    fontWeight: '600',
  },
  latencyText: {
    fontSize: 14,
    color: '#34D399',
    fontWeight: '600',
  },
  latencyUnavailable: {
    color: '#64748B',
    fontWeight: '400',
  },
});
