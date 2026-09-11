// src/screens/LoginScreen.tsx
//
// Shown on first launch or when credentials have been cleared.
// Validates against the router before storing, so we never save bad creds.

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  validateCredentials,
  saveCredentials,
  RouterUnreachableError,
  RouterAuthError,
} from '../api/routerClient';
import { ROUTER_BASE_URL } from '../config/vpnConfig';

interface LoginScreenProps {
  onLoginSuccess: () => void;
}

export default function LoginScreen({ onLoginSuccess }: LoginScreenProps) {
  const insets = useSafeAreaInsets();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = useCallback(async () => {
    const trimmedUser = username.trim();
    if (!trimmedUser || !password) {
      setError('Please enter both a username and password.');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      console.log('[LoginScreen] handleConnect called for user:', trimmedUser);
      await validateCredentials(trimmedUser, password);
      await saveCredentials(trimmedUser, password);
      console.log('[LoginScreen] ✅  Login + save succeeded');
      onLoginSuccess();
    } catch (err) {
      console.error('[LoginScreen] !!!  Login error type:', (err as any)?.name);
      console.error('[LoginScreen] !!!  Login error message:', (err as any)?.message);
      console.error('[LoginScreen] !!!  Login error cause:', (err as any)?.cause);
      console.error('[LoginScreen] !!!  Full error:', err);
      if (err instanceof RouterAuthError) {
        setError('Wrong username or password — please try again.');
      } else if (err instanceof RouterUnreachableError) {
        setError(
          "Can't reach the router. Make sure you're connected to your home Wi-Fi.",
        );
      } else {
        setError('Something unexpected went wrong. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  }, [username, password, onLoginSuccess]);

  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.logoText}>🔒</Text>
          <Text style={styles.title}>KonnectVPN</Text>
          <Text style={styles.subtitle}>
            Enter your MikroTik router credentials to get started.
          </Text>
        </View>

        {/* Form */}
        <View style={styles.card}>
          <Text style={styles.inputLabel}>Username</Text>
          <TextInput
            style={styles.input}
            value={username}
            onChangeText={setUsername}
            placeholder="admin"
            placeholderTextColor="#5a6478"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            textContentType="username"
            returnKeyType="next"
            editable={!isLoading}
          />

          <Text style={[styles.inputLabel, { marginTop: 16 }]}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor="#5a6478"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={handleConnect}
            editable={!isLoading}
          />

          {error && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <Pressable
            style={({ pressed }) => [
              styles.button,
              pressed && styles.buttonPressed,
              isLoading && styles.buttonDisabled,
            ]}
            onPress={handleConnect}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.buttonText}>Connect</Text>
            )}
          </Pressable>
        </View>

        {/* Footer hint */}
        <Text style={styles.footerHint}>
          Connecting to {ROUTER_BASE_URL}
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const COLORS = {
  bg: '#0B1120',
  cardBg: '#141D2F',
  cardBorder: '#1E2A42',
  inputBg: '#0F1724',
  inputBorder: '#1E2A42',
  inputText: '#E2E8F0',
  accent: '#6366F1',
  accentPressed: '#4F46E5',
  textPrimary: '#F1F5F9',
  textSecondary: '#94A3B8',
  errorBg: 'rgba(239, 68, 68, 0.12)',
  errorBorder: 'rgba(239, 68, 68, 0.3)',
  errorText: '#FCA5A5',
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
  },
  logoText: {
    fontSize: 48,
    marginBottom: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: COLORS.textPrimary,
    letterSpacing: 0.3,
  },
  subtitle: {
    fontSize: 15,
    color: COLORS.textSecondary,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 22,
    paddingHorizontal: 16,
  },
  card: {
    backgroundColor: COLORS.cardBg,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    padding: 24,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  input: {
    backgroundColor: COLORS.inputBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: COLORS.inputText,
  },
  errorBanner: {
    marginTop: 16,
    backgroundColor: COLORS.errorBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.errorBorder,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  errorText: {
    fontSize: 14,
    color: COLORS.errorText,
    lineHeight: 20,
  },
  button: {
    marginTop: 24,
    backgroundColor: COLORS.accent,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  buttonPressed: {
    backgroundColor: COLORS.accentPressed,
    transform: [{ scale: 0.98 }],
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#fff',
  },
  footerHint: {
    textAlign: 'center',
    marginTop: 24,
    fontSize: 12,
    color: COLORS.textSecondary,
    opacity: 0.6,
  },
});
