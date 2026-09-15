// src/screens/AdminScreen.tsx
//
// Admin Screen (biometric-gated, reachable only via hidden entry point):
// - Gated behind Touch ID / Face ID via react-native-keychain
// - Pick or paste a WireGuard .conf file
// - Validates & parses config
// - Shows confirmation preview (keys obscured/truncated, full private key NOT displayed)
// - User specifies target Country (code, label, flag) and Display Label
// - Calls provisionServer() on the router
// - Never stores the private key on-device past the single provisioning call

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  parseWireGuardConfig,
  type ParsedWireGuardConfig,
  ParseError,
} from '../utils/wireguardConfigParser';
import { provisionServer } from '../api/routerClient';
import { clearImportedServers } from '../config/serverStore';

interface AdminScreenProps {
  onClose: () => void;
}

export default function AdminScreen({ onClose }: AdminScreenProps) {
  const insets = useSafeAreaInsets();

  // Import form state
  const [confText, setConfText] = useState('');
  const [parsedConfig, setParsedConfig] = useState<ParsedWireGuardConfig | null>(null);
  const [parseErrorMessage, setParseErrorMessage] = useState<string | null>(null);

  // Additional required fields
  const [serverId, setServerId] = useState('');
  const [countryCode, setCountryCode] = useState('uk');
  const [countryLabel, setCountryLabel] = useState('United Kingdom');
  const [countryFlag, setCountryFlag] = useState('🇬🇧');
  const [serverLabel, setServerLabel] = useState('');

  // Execution state
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Parse WireGuard Config
  // -------------------------------------------------------------------------
  const handleParseConfig = useCallback(() => {
    setParseErrorMessage(null);
    setParsedConfig(null);

    if (!confText.trim()) {
      setParseErrorMessage('Please paste or enter the WireGuard .conf content.');
      return;
    }

    try {
      const parsed = parseWireGuardConfig(confText);
      setParsedConfig(parsed);

      // Auto-suggest serverId and label if not set
      if (!serverId) {
        const cleanHost = parsed.endpointAddress.replace(/\./g, '-');
        setServerId(`srv-${cleanHost}`);
      }
      if (!serverLabel) {
        setServerLabel(`Server ${parsed.endpointAddress}`);
      }
    } catch (err: any) {
      if (err instanceof ParseError) {
        setParseErrorMessage(err.message);
      } else {
        setParseErrorMessage('Failed to parse configuration file.');
      }
    }
  }, [confText, serverId, serverLabel]);

  // -------------------------------------------------------------------------
  // Provision Server
  // -------------------------------------------------------------------------
  const handleConfirmAndAdd = useCallback(async () => {
    if (!parsedConfig) return;
    if (!serverId.trim() || !serverLabel.trim() || !countryCode.trim()) {
      Alert.alert('Missing Information', 'Please complete all server details.');
      return;
    }

    setIsProvisioning(true);
    setProvisionError(null);

    try {
      await provisionServer({
        parsedConfig,
        serverId: serverId.trim(),
        countryCode: countryCode.trim(),
        countryLabel: countryLabel.trim() || countryCode.toUpperCase(),
        flag: countryFlag.trim() || '🌐',
        label: serverLabel.trim(),
      });

      Alert.alert(
        'Server Provisioned',
        `Server "${serverLabel}" was successfully added to the router and available in location picker.`,
        [{ text: 'OK', onPress: onClose }],
      );
    } catch (err: any) {
      setProvisionError(err.message || 'Provisioning failed on router.');
    } finally {
      setIsProvisioning(false);
    }
  }, [parsedConfig, serverId, serverLabel, countryCode, countryLabel, countryFlag, onClose]);

  const handleClearStorage = useCallback(() => {
    Alert.alert(
      'Clear Keychain Server Entries',
      'This will delete all imported servers, raw configs, and pre-provisioned server records stored in Keychain.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear All',
          style: 'destructive',
          onPress: async () => {
            try {
              await clearImportedServers();
              Alert.alert('Success', 'All imported server entries removed from Keychain.');
            } catch (err: any) {
              Alert.alert('Error', err?.message || 'Failed to clear Keychain entries');
            }
          },
        },
      ],
    );
  }, []);

  // Obscure key utility
  const obscureKey = (key: string) => {
    if (key.length <= 8) return '••••••••';
    return `${key.slice(0, 4)}••••••••${key.slice(-4)}`;
  };

  // -------------------------------------------------------------------------
  // Render: Import Server Form
  // -------------------------------------------------------------------------
  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Import Server (.conf)</Text>
        <Pressable onPress={onClose} hitSlop={8}>
          <Text style={styles.doneText}>Close</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
        {/* Step 1: WireGuard Config Input */}
        <Text style={styles.sectionHeading}>1. WireGuard Configuration (.conf)</Text>
        <Text style={styles.helperText}>
          Paste the contents of your Proton WireGuard config file below:
        </Text>

        <TextInput
          style={styles.confTextInput}
          placeholder={`[Interface]\nPrivateKey = ...\nAddress = 10.2.0.14/30\n\n[Peer]\nPublicKey = ...\nEndpoint = 146.70.x.x:51820`}
          placeholderTextColor="#475569"
          multiline
          value={confText}
          onChangeText={setConfText}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Pressable style={styles.parseButton} onPress={handleParseConfig}>
          <Text style={styles.parseButtonText}>Parse & Validate Config</Text>
        </Pressable>

        {parseErrorMessage && (
          <View style={styles.errorBox}>
            <Text style={styles.errorBoxText}>{parseErrorMessage}</Text>
          </View>
        )}

        {/* Step 2: Confirmation Preview & Additional Details */}
        {parsedConfig && (
          <View style={styles.previewContainer}>
            <Text style={styles.sectionHeading}>2. Parsed Configuration Preview</Text>

            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Endpoint:</Text>
              <Text style={styles.infoValue}>
                {parsedConfig.endpointAddress}:{parsedConfig.endpointPort}
              </Text>
            </View>

            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Client Address:</Text>
              <Text style={styles.infoValue}>{parsedConfig.address}</Text>
            </View>

            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Public Key:</Text>
              <Text style={styles.infoValue}>{obscureKey(parsedConfig.publicKey)}</Text>
            </View>

            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Private Key:</Text>
              <Text style={styles.infoValue}>
                {obscureKey(parsedConfig.privateKey)}{' '}
                <Text style={styles.privateKeyNotice}>(Used once, never saved)</Text>
              </Text>
            </View>

            {/* Step 3: Server Metadata */}
            <Text style={[styles.sectionHeading, { marginTop: 24 }]}>
              3. Server Details for Router
            </Text>

            <Text style={styles.fieldLabel}>Server ID (matches RouterOS comments):</Text>
            <TextInput
              style={styles.input}
              value={serverId}
              onChangeText={setServerId}
              placeholder="e.g. uk-london-3"
              placeholderTextColor="#64748B"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.fieldLabel}>Display Label:</Text>
            <TextInput
              style={styles.input}
              value={serverLabel}
              onChangeText={setServerLabel}
              placeholder="e.g. London 3"
              placeholderTextColor="#64748B"
            />

            <View style={styles.rowInputs}>
              <View style={{ flex: 1, marginRight: 8 }}>
                <Text style={styles.fieldLabel}>Country Code:</Text>
                <TextInput
                  style={styles.input}
                  value={countryCode}
                  onChangeText={setCountryCode}
                  placeholder="uk"
                  placeholderTextColor="#64748B"
                  autoCapitalize="none"
                />
              </View>

              <View style={{ width: 70, marginRight: 8 }}>
                <Text style={styles.fieldLabel}>Flag:</Text>
                <TextInput
                  style={styles.input}
                  value={countryFlag}
                  onChangeText={setCountryFlag}
                  placeholder="🇬🇧"
                  placeholderTextColor="#64748B"
                />
              </View>

              <View style={{ flex: 2 }}>
                <Text style={styles.fieldLabel}>Country Name:</Text>
                <TextInput
                  style={styles.input}
                  value={countryLabel}
                  onChangeText={setCountryLabel}
                  placeholder="United Kingdom"
                  placeholderTextColor="#64748B"
                />
              </View>
            </View>

            {provisionError && (
              <View style={styles.errorBox}>
                <Text style={styles.errorBoxText}>{provisionError}</Text>
              </View>
            )}

            {/* Speed bump Confirm & Add */}
            <Pressable
              style={[styles.confirmButton, isProvisioning && styles.buttonDisabled]}
              onPress={handleConfirmAndAdd}
              disabled={isProvisioning}
            >
              {isProvisioning ? (
                <ActivityIndicator color="#FFF" size="small" />
              ) : (
                <Text style={styles.confirmButtonText}>Confirm & Add to Router</Text>
              )}
            </Pressable>
          </View>
        )}

        {/* Keychain Storage Management */}
        <View style={styles.manageStorageBox}>
          <Text style={styles.sectionHeading}>Manage Keychain Storage</Text>
          <Text style={styles.helperText}>
            Remove imported server records, cached WireGuard configurations, and router provisioning history from device Keychain:
          </Text>
          <Pressable style={styles.dangerButton} onPress={handleClearStorage}>
            <Text style={styles.dangerButtonText}>🗑️ Clear Server Entries from Keychain</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0B1120',
  },
  manageStorageBox: {
    marginTop: 36,
    paddingTop: 24,
    borderTopWidth: 1,
    borderTopColor: '#1E293B',
    marginBottom: 20,
  },
  dangerButton: {
    backgroundColor: '#7F1D1D',
    borderWidth: 1,
    borderColor: '#EF4444',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 12,
  },
  dangerButtonText: {
    color: '#FEE2E2',
    fontSize: 15,
    fontWeight: '600',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1E2A42',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#F1F5F9',
  },
  doneText: {
    fontSize: 16,
    color: '#6366F1',
    fontWeight: '600',
  },
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  sectionHeading: {
    fontSize: 16,
    fontWeight: '700',
    color: '#F1F5F9',
    marginBottom: 8,
  },
  helperText: {
    fontSize: 13,
    color: '#94A3B8',
    marginBottom: 12,
  },
  confTextInput: {
    backgroundColor: '#141D2F',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1E2A42',
    padding: 14,
    color: '#E2E8F0',
    fontFamily: 'Courier',
    fontSize: 12,
    minHeight: 140,
    textAlignVertical: 'top',
  },
  parseButton: {
    backgroundColor: '#4F46E5',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 14,
  },
  parseButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  errorBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
  },
  errorBoxText: {
    color: '#FCA5A5',
    fontSize: 13,
  },
  previewContainer: {
    marginTop: 24,
    backgroundColor: '#141D2F',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#1E2A42',
    padding: 18,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1E2A42',
  },
  infoLabel: {
    fontSize: 13,
    color: '#94A3B8',
    fontWeight: '500',
  },
  infoValue: {
    fontSize: 13,
    color: '#E2E8F0',
    fontWeight: '600',
  },
  privateKeyNotice: {
    fontSize: 11,
    color: '#10B981',
  },
  fieldLabel: {
    fontSize: 12,
    color: '#94A3B8',
    marginTop: 12,
    marginBottom: 6,
    fontWeight: '600',
  },
  input: {
    backgroundColor: '#0F1724',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1E2A42',
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#F1F5F9',
    fontSize: 14,
  },
  rowInputs: {
    flexDirection: 'row',
  },
  confirmButton: {
    backgroundColor: '#10B981',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 24,
  },
  confirmButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
});
