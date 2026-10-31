// Mini Envoy companion app (Expo Go). Two screens: Health and Traffic Toggle.
// Run:  npx create-expo-app mini-envoy-app, copy this file over App.js, then npx expo start
// The phone and the laptop must be on the same Wi-Fi (or the laptop's hotspot). Start the sidecar with
//   python sidecar.py --name demo --outbound-port 8001 --config config.json --admin-host 0.0.0.0 --admin-token secret
// then type  http://<laptop-ip>:8001  into the field below. No extra packages needed.
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, SafeAreaView, ScrollView, StatusBar, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';

const C = { primary: '#0F766E', text: '#1F2937', error: '#B42318', warn: '#B54708', ok: '#166534', bg: '#F8FAFC' };

export default function App() {
  const [base, setBase] = useState('http://192.168.1.10:8001');
  const [token, setToken] = useState('secret');
  const [tab, setTab] = useState('health');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [updated, setUpdated] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${base}/__sidecar/health`);
      setData(await r.json()); setError(null); setUpdated(new Date().toLocaleTimeString());
    } catch (e) {
      setError(`Cannot reach ${base}. Check the address, Wi-Fi and that the sidecar runs with --admin-host 0.0.0.0.`);
    }
  }, [base]);

  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [load]);

  const setDrain = (u, want) => Alert.alert(
    want ? 'Drain traffic?' : 'Resume traffic?',
    want ? `New requests to ${u.name} will not be forwarded.` : `${u.name} will receive requests again.`,
    [{ text: 'Cancel', style: 'cancel' }, { text: want ? 'Drain' : 'Resume', onPress: async () => {
      try {
        const r = await fetch(`${base}/__sidecar/drain`, { method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ upstream: u.id, drained: want }) });
        if (!r.ok) throw new Error(r.status === 401 ? 'wrong token' : `HTTP ${r.status}`);
        setMessage(want ? 'Traffic drained. New requests to this upstream are paused.' : 'Traffic resumed. Requests are forwarded again.');
        load();
      } catch (e) { setMessage(`Could not change drain state: ${e.message}`); }
    } }]);

  const ups = data?.upstreams ?? [];
  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.primary} />
      <View style={s.header}><Text style={s.title}>Mini Envoy</Text><Text style={s.sub}>{data?.sidecar ?? 'not connected'}</Text></View>
      <View style={s.tabs}>
        {[['health', 'Health'], ['traffic', 'Traffic toggle']].map(([k, label]) => (
          <TouchableOpacity key={k} accessibilityRole="tab" accessibilityState={{ selected: tab === k }} onPress={() => setTab(k)}
            style={[s.tab, tab === k && s.tabOn]}><Text style={[s.tabText, tab === k && { color: '#fff' }]}>{label}</Text></TouchableOpacity>))}
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={s.label}>Sidecar address</Text>
        <TextInput style={s.input} value={base} onChangeText={setBase} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Sidecar address" />
        {tab === 'traffic' && (<><Text style={s.label}>Admin token</Text>
          <TextInput style={s.input} value={token} onChangeText={setToken} autoCapitalize="none" secureTextEntry accessibilityLabel="Admin token" /></>)}
        {error && <Text style={[s.banner, { color: C.error, borderColor: C.error }]} accessibilityLiveRegion="polite">{error}</Text>}
        {message && <Text style={[s.banner, { color: C.ok, borderColor: C.ok }]} accessibilityLiveRegion="polite">{message}</Text>}
        {!error && ups.length === 0 && <Text style={s.muted}>Loading upstreams…</Text>}

        {tab === 'health' && ups.map(u => { const down = u.health === 'Down'; return (
          <View key={u.id} style={s.card} accessibilityLiveRegion="polite">
            <View style={s.row}><Text style={s.name}>{u.name}</Text>
              <Text style={[s.badge, { color: down ? C.error : C.ok, borderColor: down ? C.error : C.ok }]}>{down ? '✖ Down' : '✔ Healthy'}</Text></View>
            <Text style={s.big}>{u.avgLatencyMs ?? '—'} ms</Text>
            <Text style={s.muted}>average latency · last {u.lastLatencyMs ?? '—'} ms · {u.requests} requests</Text>
            {u.drained && <Text style={[s.muted, { color: C.warn }]}>⏸ Traffic is drained</Text>}
            {down && <Text style={[s.muted, { color: C.error }]}>Upstream looks Down (3 failed checks). Consider draining traffic.</Text>}
          </View>); })}

        {tab === 'traffic' && ups.map(u => (
          <View key={u.id} style={s.card}>
            <View style={s.row}><View style={{ flex: 1 }}><Text style={s.name}>{u.name}</Text>
              <Text style={s.muted}>{u.drained ? '⏸ Drained: new requests are not forwarded' : '▶ Live: requests are forwarded'}</Text></View>
              <Switch value={u.drained} onValueChange={v => setDrain(u, v)} trackColor={{ true: C.primary }} accessibilityLabel={`Drain ${u.name}`} /></View>
          </View>))}
        <Text style={s.muted}>Last updated {updated ?? '—'}. Educational mock, not Envoy.</Text>
      </ScrollView>
    </SafeAreaView>);
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg }, header: { backgroundColor: C.primary, padding: 16, paddingTop: 36 },
  title: { color: '#fff', fontSize: 20, fontWeight: '700' }, sub: { color: '#CCFBF1' },
  tabs: { flexDirection: 'row', margin: 12, borderRadius: 8, borderWidth: 1, borderColor: C.primary, overflow: 'hidden' },
  tab: { flex: 1, padding: 12, alignItems: 'center', backgroundColor: '#fff' }, tabOn: { backgroundColor: C.primary },
  tabText: { color: C.primary, fontWeight: '600' }, label: { color: C.text, fontWeight: '600', marginTop: 8 },
  input: { borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, padding: 10, backgroundColor: '#fff', marginTop: 4 },
  banner: { borderWidth: 1, borderRadius: 8, padding: 10, marginTop: 12, backgroundColor: '#fff' },
  card: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0', padding: 16, marginTop: 12 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, name: { fontSize: 17, fontWeight: '700', color: C.text },
  badge: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3, fontWeight: '700' },
  big: { fontSize: 32, fontWeight: '700', color: C.text, marginTop: 8 }, muted: { color: '#475569', marginTop: 4 },
});
