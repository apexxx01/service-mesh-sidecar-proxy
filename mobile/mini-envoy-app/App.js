// Mini Envoy companion app (Expo Go). Two screens: Health and Traffic Toggle.
// Start the sidecar with --admin-host 0.0.0.0 --admin-token secret, then type http://<laptop-ip>:8001 below.
// Phone and laptop must be on the same Wi-Fi (or the phone's hotspot).
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, RefreshControl, SafeAreaView, ScrollView, StatusBar, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';

const C = { primary: '#0F766E', text: '#1F2937', error: '#B42318', warn: '#B54708', ok: '#166534', bg: '#F8FAFC', muted: '#475569' };
const POLL_OK_MS = 3000;    // refresh every 3 s while connected (PRD)
const POLL_ERROR_MS = 10000; // slow down after a failure so we don't spam a dead address

export default function App() {
  const [base, setBase] = useState('');           // empty on first launch: user types their laptop IP
  const [token, setToken] = useState('secret');
  const [tab, setTab] = useState('health');
  const [status, setStatus] = useState('idle');   // idle | loading | ok | error
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [updated, setUpdated] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const url = base.trim().replace(/\/+$/, '');

  const load = useCallback(async () => {
    if (!url) { setStatus('idle'); return; }
    setStatus(s => (s === 'ok' ? 'ok' : 'loading'));   // keep showing data while re-polling
    try {
      const r = await fetch(`${url}/__sidecar/health`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json()); setError(null); setStatus('ok'); setUpdated(new Date().toLocaleTimeString());
    } catch (e) {
      setStatus('error');
      setError(`Cannot reach ${url}. Check the address, that the phone and laptop share Wi-Fi, and that the sidecar runs with --admin-host 0.0.0.0. (${e.message})`);
    }
  }, [url]);

  // poll: fast while connected, slower after an error, not at all without an address
  useEffect(() => {
    if (!url) { setStatus('idle'); return; }
    load();
    const t = setInterval(load, status === 'error' ? POLL_ERROR_MS : POLL_OK_MS);
    return () => clearInterval(t);
  }, [load, url, status === 'error']);

  const onPull = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const setDrain = (u, want) => Alert.alert(
    want ? `Drain ${u.name}?` : `Resume ${u.name}?`,
    want ? 'New requests to this upstream will get 503 "drained" until you turn this off.' : `${u.name} will receive requests again.`,
    [{ text: 'Cancel', style: 'cancel' }, { text: want ? 'Drain' : 'Resume', style: want ? 'destructive' : 'default', onPress: async () => {
      try {
        const r = await fetch(`${url}/__sidecar/drain`, { method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ upstream: u.id, drained: want }) });
        if (!r.ok) throw new Error(r.status === 401 ? 'wrong admin token' : `HTTP ${r.status}`);
        setMessage({ ok: true, text: want ? 'Traffic drained. New requests to this upstream are paused.' : 'Traffic resumed. Requests are forwarded again.' });
        load();
      } catch (e) { setMessage({ ok: false, text: `Could not change drain state: ${e.message}` }); }
    } }]);

  const ups = data?.upstreams ?? [];

  // one place that decides what the user sees when there is no data to show
  const stateView = () => {
    if (status === 'idle') return <Text style={s.info}>Enter your laptop's address above, for example http://192.168.43.120:8001 (run ipconfig on the laptop to find it).</Text>;
    if (status === 'loading' && !data) return <View style={s.center}><ActivityIndicator size="large" color={C.primary} /><Text style={s.muted}>Connecting to the sidecar…</Text></View>;
    if (status === 'error') return (
      <View style={[s.banner, { borderColor: C.error }]} accessibilityLiveRegion="polite">
        <Text style={{ color: C.error }}>✖ {error}</Text>
        <TouchableOpacity style={s.retry} onPress={load} accessibilityRole="button"><Text style={s.retryText}>Try again</Text></TouchableOpacity>
      </View>);
    if (status === 'ok' && ups.length === 0) return <Text style={s.info}>Connected, but the sidecar has no upstreams in config.json.</Text>;
    return null;
  };

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.primary} />
      <View style={s.header}>
        <Text style={s.title}>Mini Envoy</Text>
        <Text style={s.sub}>{status === 'ok' ? `● Connected to ${data?.sidecar}` : status === 'error' ? '○ Not connected' : '○ No address yet'}</Text>
      </View>
      <View style={s.tabs} accessibilityRole="tablist">
        {[['health', 'Health'], ['traffic', 'Traffic toggle']].map(([k, label]) => (
          <TouchableOpacity key={k} accessibilityRole="tab" accessibilityState={{ selected: tab === k }} onPress={() => setTab(k)}
            style={[s.tab, tab === k && s.tabOn]}><Text style={[s.tabText, tab === k && { color: '#fff' }]}>{label}</Text></TouchableOpacity>))}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPull} colors={[C.primary]} tintColor={C.primary} />}>
        <Text style={s.label}>Sidecar address</Text>
        <TextInput style={s.input} value={base} onChangeText={setBase} placeholder="http://192.168.x.x:8001"
          autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel="Sidecar address" />
        {tab === 'traffic' && (<><Text style={s.label}>Admin token</Text>
          <TextInput style={s.input} value={token} onChangeText={setToken} autoCapitalize="none" secureTextEntry accessibilityLabel="Admin token" /></>)}

        {message && <Text style={[s.banner, { color: message.ok ? C.ok : C.error, borderColor: message.ok ? C.ok : C.error }]}
          accessibilityLiveRegion="polite" onPress={() => setMessage(null)}>{message.ok ? '✔ ' : '✖ '}{message.text}</Text>}
        {stateView()}

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
          <TouchableOpacity key={u.id} style={s.card} activeOpacity={0.7} onPress={() => setDrain(u, !u.drained)}
            accessibilityRole="switch" accessibilityState={{ checked: u.drained }} accessibilityLabel={`Drain ${u.name}`}>
            <View style={s.row}>
              <View style={{ flex: 1, paddingRight: 12 }}><Text style={s.name}>{u.name}</Text>
                <Text style={s.muted}>{u.drained ? '⏸ Drained: new requests are not forwarded' : '▶ Live: requests are forwarded'}</Text></View>
              <Switch value={u.drained} onValueChange={v => setDrain(u, v)} trackColor={{ true: C.primary }} style={{ transform: [{ scale: 1.2 }] }} />
            </View>
          </TouchableOpacity>))}

        <Text style={[s.muted, { marginTop: 16 }]}>Last updated {updated ?? '—'} · pull down to refresh. Educational mock, not Envoy.</Text>
      </ScrollView>
    </SafeAreaView>);
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg }, header: { backgroundColor: C.primary, padding: 16, paddingTop: 40 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700' }, sub: { color: '#CCFBF1', marginTop: 2 },
  tabs: { flexDirection: 'row', margin: 12, borderRadius: 10, borderWidth: 1, borderColor: C.primary, overflow: 'hidden' },
  tab: { flex: 1, minHeight: 48, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }, tabOn: { backgroundColor: C.primary },
  tabText: { color: C.primary, fontWeight: '700', fontSize: 16 }, label: { color: C.text, fontWeight: '600', marginTop: 8 },
  input: { borderWidth: 1, borderColor: '#94A3B8', borderRadius: 8, paddingHorizontal: 12, minHeight: 48, backgroundColor: '#fff', marginTop: 4, fontSize: 16, color: C.text },
  banner: { borderWidth: 1, borderRadius: 8, padding: 12, marginTop: 12, backgroundColor: '#fff' },
  info: { color: C.muted, marginTop: 16, lineHeight: 20 }, center: { alignItems: 'center', marginTop: 32, gap: 8 },
  retry: { marginTop: 10, minHeight: 44, borderRadius: 8, backgroundColor: C.primary, justifyContent: 'center', alignItems: 'center' },
  retryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  card: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0', padding: 16, marginTop: 12, minHeight: 64 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, name: { fontSize: 18, fontWeight: '700', color: C.text },
  badge: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, fontWeight: '700' },
  big: { fontSize: 34, fontWeight: '700', color: C.text, marginTop: 8 }, muted: { color: C.muted, marginTop: 4 },
});
