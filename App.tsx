/**
 * KonnectVPN — MikroTik WireGuard VPN Client
 *
 * Single-user, LAN-only React Native iOS app for monitoring,
 * latency-ranking, and switching WireGuard VPN candidate servers on a MikroTik router.
 *
 * @format
 */

import React, { useState, useEffect, useCallback } from 'react';
import { StatusBar, StyleSheet, View, ActivityIndicator } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { hasCredentials } from './src/api/routerClient';
import LoginScreen from './src/screens/LoginScreen';
import HomeScreen from './src/screens/HomeScreen';
import AdminScreen from './src/screens/AdminScreen';

type Screen = 'loading' | 'login' | 'home' | 'admin';

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');

  // Check for stored or configured credentials on mount
  useEffect(() => {
    (async () => {
      const stored = await hasCredentials();
      setScreen(stored ? 'home' : 'login');
    })();
  }, []);

  const handleLoginSuccess = useCallback(() => {
    setScreen('home');
  }, []);

  const handleLogout = useCallback(() => {
    setScreen('login');
  }, []);

  const handleOpenAdmin = useCallback(() => {
    setScreen('admin');
  }, []);

  const handleCloseAdmin = useCallback(() => {
    setScreen('home');
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      {screen === 'loading' && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color="#6366F1" size="large" />
        </View>
      )}
      {screen === 'login' && (
        <LoginScreen onLoginSuccess={handleLoginSuccess} />
      )}
      {screen === 'home' && (
        <HomeScreen onLogout={handleLogout} onOpenAdmin={handleOpenAdmin} />
      )}
      {screen === 'admin' && (
        <AdminScreen onClose={handleCloseAdmin} />
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: '#0B1120',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
