// Mini Envoy companion app (Expo Go). Two screens: Health and Traffic.
// Start the sidecar with --admin-host 0.0.0.0 --admin-token secret, then enter http://<laptop-ip>:8001 in the app.
// Phone and laptop must be on the same Wi-Fi (or the phone's hotspot).
//
// Design: "Quiet Console". Only the PRD palette (section 13) and neutrals mixed from it. Status is always an icon
// shape plus a word, never colour alone. Teal means "you can act here", never status.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, RefreshControl, ScrollView, StatusBar, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

const C = {
  bg: '#F8FAFC', surface: '#FFFFFF', sunken: '#EFF2F4',
  text: '#1F2937', text2: '#4A535E',               // 14.0:1 and 7.5:1 on bg
  border: '#DADDE0', borderStrong: '#8B9097',      // decorative / control outline (3.1:1)
  primary: '#0F766E', primaryStrong: '#136360', primaryTint: '#ECF4F3',
  ok: '#166534', warn: '#B54708', err: '#B42318',  // 6.8 / 5.2 / 6.3:1 on bg
  okTint: '#ECF3EF', warnTint: '#F9F0EB', errTint: '#F9EDED',
};
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
const POLL_OK_MS = 3000;      // refresh every 3 s while connected
const POLL_ERROR_MS = 10000;  // slow down after a failure so we don't spam a dead address
const STALE_S = 10;           // after this the "Updated" line turns into a warning
const fmtMs = v => (v == null ? '—' : Math.abs(v) >= 100 ? String(Math.round(v)) : Number(v).toFixed(1));

/* ---------- icons, drawn with Views so no icon package is needed. Each status has its own shape. ---------- */
function Icon({ kind, size = 20 }) {
  const s = size, half = s / 2;
  if (kind === 'ok') return (   // filled circle with a tick
    <View style={{ width: s, height: s, borderRadius: half, backgroundColor: C.ok, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontSize: s * 0.62, fontWeight: '800', lineHeight: s * 0.75 }}>✓</Text></View>);
  if (kind === 'down') return ( // diamond (a different shape from every other status) with a cross
    <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: s * 0.74, height: s * 0.74, borderRadius: s * 0.12, backgroundColor: C.err, transform: [{ rotate: '45deg' }] }} />
      <Text style={{ color: '#fff', fontSize: s * 0.5, fontWeight: '800', lineHeight: s * 0.62 }}>✕</Text></View>);
  if (kind === 'drained') return ( // filled circle with a pause mark
    <View style={{ width: s, height: s, borderRadius: half, backgroundColor: C.warn, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: s * 0.14 }}>
      <View style={{ width: s * 0.12, height: s * 0.42, backgroundColor: '#fff', borderRadius: 1 }} />
      <View style={{ width: s * 0.12, height: s * 0.42, backgroundColor: '#fff', borderRadius: 1 }} /></View>);
  if (kind === 'clock') return (   // outlined clock: stale data
    <View style={{ width: s, height: s, borderRadius: half, borderWidth: 2, borderColor: C.warn }}>
      <View style={{ position: 'absolute', left: half - 2, top: s * 0.2, width: 2, height: half - s * 0.2 - 1, backgroundColor: C.warn }} />
      <View style={{ position: 'absolute', left: half - 2, top: half - 2, width: s * 0.28, height: 2, backgroundColor: C.warn }} /></View>);
  if (kind === 'flow') return (    // outlined circle with a play mark: traffic is flowing
    <View style={{ width: s, height: s, borderRadius: half, borderWidth: 2, borderColor: C.ok, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ marginLeft: s * 0.08, width: 0, height: 0, borderTopWidth: s * 0.2, borderBottomWidth: s * 0.2, borderLeftWidth: s * 0.3,
        borderTopColor: 'transparent', borderBottomColor: 'transparent', borderLeftColor: C.ok }} /></View>);
  return <View style={{ width: s, height: s, borderRadius: half, borderWidth: 2, borderStyle: 'dashed', borderColor: C.text2 }} />; // unknown
}
const upState = u => (u.drained ? { kind: 'drained', word: 'Drained', color: C.warn }
  : u.health === 'Down' ? { kind: 'down', word: 'Down', color: C.err } : { kind: 'ok', word: 'Healthy', color: C.ok });

function Logo() {
  return (<View style={st.logo}><View style={st.logoLine} /><View style={[st.logoDot, { left: 5 }]} />
    <View style={[st.logoDot, st.logoMid]} /><View style={[st.logoDot, { right: 5 }]} /></View>);
}

/* ---------- Path Strip: client -> sidecar -> upstream, and where traffic stops ---------- */
function PathStrip({ u }) {
  const s = upState(u), reach = !u.drained && u.health !== 'Down';
  const caption = u.drained ? `Stopped at the sidecar: ${u.name} is drained, so nothing is forwarded.`
    : u.health === 'Down' ? `${u.name} is Down. The sidecar is still sending it requests.`
    : `Forwarding to ${u.name}. Requests reach it and come back.`;
  const Node = ({ on, label }) => (<View style={st.pnode}><View style={[st.pdot, on && st.pdotOn]} /><Text style={st.pl} numberOfLines={1}>{label}</Text></View>);
  return (
    <View accessible accessibilityLabel={`Request path: client, sidecar, ${u.name}. ${caption}`}>
      <View style={st.path}>
        <Node on label="Client" /><View style={[st.plink, st.plinkOn]} />
        <Node on label="Sidecar" />
        <View style={[st.plink, !reach && st.plinkOff]}>{!reach && <View style={st.pmark}><Icon kind={s.kind} size={20} /></View>}</View>
        <Node on={reach} label={u.name} />
      </View>
      <Text style={st.pcap}>{caption}</Text>
    </View>);
}

/* ---------- small building blocks ---------- */
const Btn = ({ label, onPress, kind = 'primary', style }) => (
  <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [st.btn, st[`btn_${kind}`], pressed && st[`btn_${kind}_p`], style]}>
    <Text style={[st.btnText, kind === 'quiet' && { color: C.text }]}>{label}</Text></Pressable>);

function Banner({ tone, kind, title, body, children }) {
  const map = { err: [C.errTint, C.err], warn: [C.warnTint, C.warn], ok: [C.okTint, C.ok] }[tone];
  return (
    <View style={[st.banner, { backgroundColor: map[0], borderColor: map[1] }]} accessibilityLiveRegion="polite">
      <Icon kind={kind} size={22} />
      <View style={{ flex: 1 }}>
        {title ? <Text style={[st.bTitle, { color: tone === 'warn' ? C.text : map[1] }]}>{title}</Text> : null}
        {body ? <Text style={st.bBody}>{body}</Text> : null}
        {children}
      </View>
    </View>);
}

function Segments({ ups, sel, onSel }) {
  if (ups.length < 2) return null;
  return (
    <View style={st.seg} accessibilityRole="tablist">
      {ups.map(u => { const on = u.id === sel, s = upState(u);
        return (<Pressable key={u.id} onPress={() => onSel(u.id)} accessibilityRole="tab" accessibilityState={{ selected: on }}
          accessibilityLabel={`${u.name}, ${s.word}`} style={[st.segItem, on && st.segOn]}>
          <Icon kind={s.kind} size={16} /><Text style={[st.segText, on && { color: C.text }]}>{u.name}</Text></Pressable>); })}
    </View>);
}

/* ---------- the app ---------- */
function Main() {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState('');
  const [base, setBase] = useState('');
  const [editing, setEditing] = useState(true);
  const [token, setToken] = useState('secret');
  const [tab, setTab] = useState('health');
  const [status, setStatus] = useState('idle');     // idle | loading | ok | error
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);     // { tone, text } after drain / resume
  const [updatedAt, setUpdatedAt] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [sel, setSel] = useState(null);
  const [sheet, setSheet] = useState(null);         // upstream waiting for drain confirmation
  const [busy, setBusy] = useState(false);
  const hist = useRef({});                          // upstream id -> last 20 "last request" latencies
  const [, bump] = useState(0);

  const url = base.trim().replace(/\/+$/, '');

  const load = useCallback(async () => {
    if (!url) { setStatus('idle'); return; }
    setStatus(s => (s === 'ok' ? 'ok' : 'loading'));   // keep showing data while re-polling
    try {
      const r = await fetch(`${url}/__sidecar/health`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      d.upstreams.forEach(u => { if (u.lastLatencyMs != null) hist.current[u.id] = [...(hist.current[u.id] || []), u.lastLatencyMs].slice(-20); });
      setData(d); setError(null); setStatus('ok'); setUpdatedAt(Date.now()); setEditing(false); bump(n => n + 1);
    } catch (e) {
      setStatus('error');
      setError(e.message);
    }
  }, [url]);

  useEffect(() => {    // poll: fast while connected, slower after an error, not at all without an address
    if (!url) { setStatus('idle'); return; }
    load();
    const t = setInterval(load, status === 'error' ? POLL_ERROR_MS : POLL_OK_MS);
    return () => clearInterval(t);
  }, [load, url, status === 'error']);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const ups = data?.upstreams ?? [];
  const u = ups.find(x => x.id === sel) || ups.find(x => x.health === 'Down' && !x.drained) || ups[0];
  const age = updatedAt ? Math.max(0, Math.round((now - updatedAt) / 1000)) : null;

  const onPull = async () => { setRefreshing(true); await load(); setRefreshing(false); };
  const connect = () => { const v = draft.trim(); if (!v) return; setData(null); hist.current = {}; setBase(/^https?:\/\//.test(v) ? v : `http://${v}`); };

  async function setDrain(up, want) {
    setBusy(true);
    try {
      const r = await fetch(`${url}/__sidecar/drain`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ upstream: up.id, drained: want }) });
      if (!r.ok) throw new Error(r.status === 401 ? 'the admin token is wrong' : `HTTP ${r.status}`);
      setMessage({ tone: 'ok', text: want ? `Traffic drained. New requests to ${up.name} aren't forwarded.` : `Traffic resumed. ${up.name} is receiving requests again.` });
      await load();
    } catch (e) {
      setMessage({ tone: 'err', text: `Couldn't ${want ? 'drain' : 'resume'} traffic. Nothing changed. (${e.message})` });
    } finally { setBusy(false); setSheet(null); }
  }

  /* ----- connection card ----- */
  const connection = (status === 'idle' || editing) ? (
    <View style={st.card}>
      <Text style={st.h3}>Connect to your sidecar</Text>
      <Text style={st.help}>Start it with --admin-host 0.0.0.0, then enter the laptop's address. Run ipconfig on the laptop to find its IP.</Text>
      <Text style={st.label} nativeID="addrLabel">Sidecar address</Text>
      <TextInput style={st.input} value={draft} onChangeText={setDraft} placeholder="http://192.168.x.x:8001" placeholderTextColor="#69707A"
        autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go" onSubmitEditing={connect} accessibilityLabelledBy="addrLabel" accessibilityLabel="Sidecar address" />
      <Btn label="Connect" onPress={connect} style={{ marginTop: 12 }} />
    </View>
  ) : (
    <View style={st.connRow}>
      <Text style={st.connAddr} numberOfLines={1}>{url}</Text>
      <Pressable onPress={() => { setDraft(url); setEditing(true); }} accessibilityRole="button" style={st.linkBtn}><Text style={st.link}>Change</Text></Pressable>
    </View>);

  /* ----- states shared by both tabs ----- */
  const stateView = () => {
    if (status === 'loading' && !data) return (<View style={st.center}><ActivityIndicator size="large" color={C.primary} /><Text style={st.help}>Connecting to {url}…</Text></View>);
    if (status === 'error') return (
      <Banner tone="err" kind="down" title={`Can't reach ${url}`}
        body={`Check that the phone and laptop share Wi-Fi and the sidecar runs with --admin-host 0.0.0.0.${data ? ' Showing the last data received.' : ''} (${error})`}>
        <Btn label="Try again" kind="quiet" onPress={load} style={{ marginTop: 12, alignSelf: 'flex-start', paddingHorizontal: 20 }} />
      </Banner>);
    if (status === 'ok' && ups.length === 0) return <Banner tone="warn" kind="clock" title="No upstreams" body="Connected, but config.json has no upstreams. Add one and restart the sidecar." />;
    return null;
  };

  /* ----- Health ----- */
  const health = u && (() => {
    const s = upState(u), h = hist.current[u.id] || [], max = Math.max(1, ...h);
    return (<>
      {u.health === 'Down' && !u.drained && (
        <Banner tone="err" kind="down" title={`${u.name} is Down: 3 requests failed in a row.`} body="Drain traffic to stop sending requests to it.">
          <Btn label="Go to Traffic" kind="quiet" onPress={() => { setSel(u.id); setTab('traffic'); }} style={{ marginTop: 12, alignSelf: 'flex-start', paddingHorizontal: 20 }} />
        </Banner>)}
      {u.drained && <Banner tone="warn" kind="drained" title={`Traffic to ${u.name} is drained.`} body="New requests get 503 “drained” and aren't forwarded." />}
      <View style={st.card} accessible accessibilityLabel={`${u.name} is ${s.word}. Average latency ${fmtMs(u.avgLatencyMs)} milliseconds.`}>
        <View style={st.row}><Icon kind={s.kind} size={30} /><Text style={[st.status, { color: s.color }]}>{s.word}</Text></View>
        <Text style={st.target} numberOfLines={1}>{u.name} · {u.target}</Text>
        <View style={st.bigRow}><Text style={st.big}>{fmtMs(u.avgLatencyMs)}</Text><Text style={st.bigUnit}>ms</Text></View>
        <Text style={st.help}>Average latency, last 20 requests</Text>
        <View style={st.metrics}>
          <View><Text style={st.mVal}>{fmtMs(u.lastLatencyMs)} ms</Text><Text style={st.mKey}>Last request</Text></View>
          <View><Text style={st.mVal}>{u.requests}</Text><Text style={st.mKey}>Requests</Text></View>
        </View>
        {h.length >= 5 && (<View style={{ marginTop: 20 }}>
          <View style={st.spark}>{h.map((v, i) => <View key={i} style={[st.bar, { height: 4 + 40 * (v / max) }, i === h.length - 1 && { backgroundColor: C.text }]} />)}</View>
          <Text style={st.help}>Last-request latency per refresh, newest on the right</Text>
        </View>)}
      </View>
    </>);
  })();

  /* ----- Traffic ----- */
  const traffic = u && (
    <>
      <View style={st.card}>
        {(() => {   // three states, never "flowing" in green while the upstream is Down
          const t = u.drained ? { kind: 'drained', color: C.warn, title: 'Traffic is drained', body: `New requests to ${u.name} get 503 “drained”. Each one is still logged.` }
            : u.health === 'Down' ? { kind: 'down', color: C.err, title: 'Still sending to a Down upstream', body: `Requests keep going to ${u.name} and failing. Drain traffic to stop them.` }
            : { kind: 'flow', color: C.ok, title: 'Traffic is flowing', body: `Requests to ${u.name} are forwarded with a ${data?.timeoutMs ?? 2000} ms timeout.` };
          return (<>
            <View style={st.row}><Icon kind={t.kind} size={30} /><Text style={[st.h2, { color: t.color }]}>{t.title}</Text></View>
            <Text style={[st.help, { marginBottom: 20 }]}>{t.body}</Text>
          </>);
        })()}
        <PathStrip u={u} />
      </View>
      <Pressable style={st.switchRow} onPress={() => (u.drained ? setDrain(u, false) : setSheet(u))} disabled={busy}
        accessibilityRole="switch" accessibilityState={{ checked: u.drained, busy }} accessibilityLabel={`Drain traffic for ${u.name}`}
        accessibilityHint={u.drained ? 'Resumes traffic' : 'Asks you to confirm first'}>
        <View style={{ flex: 1 }}>
          <Text style={st.h3}>Drain traffic</Text>
          <Text style={st.help}>{u.drained ? 'On. Requests are drained.' : 'Off. Requests are forwarded.'}</Text>
        </View>
        {busy ? <ActivityIndicator color={C.primary} /> : (
          <Switch value={u.drained} onValueChange={v => (v ? setSheet(u) : setDrain(u, false))} importantForAccessibility="no-hide-descendants"
            trackColor={{ false: C.borderStrong, true: C.warn }} thumbColor="#FFFFFF" ios_backgroundColor={C.borderStrong}
            {...(Platform.OS === 'web' ? { activeThumbColor: '#FFFFFF' } : {})} />)}
      </Pressable>
      {u.drained && <Btn label="Resume traffic" onPress={() => setDrain(u, false)} style={{ marginTop: 12 }} />}
      <View style={[st.card, { marginTop: 24 }]}>
        <Text style={[st.label, { marginTop: 0 }]} nativeID="tokLabel">Admin token</Text>
        <TextInput style={st.input} value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} secureTextEntry
          accessibilityLabel="Admin token" accessibilityLabelledBy="tokLabel" />
        <Text style={st.help}>Needed to drain or resume. It's the value passed to --admin-token.</Text>
      </View>
    </>);

  const conn = status === 'ok' ? { kind: 'ok', text: `Connected to ${data?.sidecar}`, color: C.ok }
    : status === 'error' ? { kind: 'down', text: "Can't reach the sidecar", color: C.err }
    : { kind: 'none', text: status === 'loading' ? 'Connecting…' : 'Not connected', color: C.text2 };
  const stale = age != null && age > STALE_S;

  return (
    <View style={[st.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="dark-content" backgroundColor={C.bg} />
      <View style={st.top}>
        <View style={st.brand}><Logo /><Text style={st.brandText}>Mini Envoy</Text></View>
        <View style={st.conn} accessibilityLiveRegion="polite"><Icon kind={conn.kind} size={14} /><Text style={[st.connText, { color: conn.color }]} numberOfLines={1}>{conn.text}</Text></View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPull} colors={[C.primary]} tintColor={C.primary} />}>
        <Text style={st.h1} accessibilityRole="header">{tab === 'health' ? 'Health' : 'Traffic'}</Text>
        <Text style={[st.help, { marginBottom: 16 }]}>{tab === 'health' ? 'Latency and Healthy or Down for each upstream.' : 'Drain an upstream to stop forwarding to it. Resume any time.'}</Text>

        {connection}
        {message && (<Banner tone={message.tone} kind={message.tone === 'ok' ? 'ok' : 'down'} body={message.text}>
          <Pressable onPress={() => setMessage(null)} accessibilityRole="button" style={[st.linkBtn, { marginLeft: -14, marginBottom: -10 }]}><Text style={st.link}>Dismiss</Text></Pressable></Banner>)}
        {stateView()}
        <Segments ups={ups} sel={u?.id} onSel={setSel} />
        {tab === 'health' ? health : traffic}

        {updatedAt && (<View style={[st.row, { marginTop: 20, gap: 8 }]} accessible accessibilityLabel={stale ? `Data is ${age} seconds old. Pull down to refresh.` : `Updated ${age} seconds ago`}>
          {stale ? <Icon kind="clock" size={16} /> : null}
          <Text style={[st.help, { marginTop: 0 }, stale && { color: C.warn, fontWeight: '600' }]}>
            {stale ? `Data is ${age} s old. Pull down to refresh.` : `Updated ${age} s ago · pull down to refresh`}</Text>
        </View>)}
        <Text style={st.disclaimer}>Educational prototype — not Envoy, no mTLS on this path. Health is derived from recent requests, not a real probe.</Text>
      </ScrollView>

      <View style={[st.tabbar, { paddingBottom: Math.max(insets.bottom, 8) }]} accessibilityRole="tablist">
        {[['health', 'Health'], ['traffic', 'Traffic']].map(([k, label]) => { const on = tab === k; return (
          <Pressable key={k} onPress={() => setTab(k)} accessibilityRole="tab" accessibilityState={{ selected: on }} style={st.tabItem}>
            <View style={[st.tabMark, on && { backgroundColor: C.primary }]} />
            {k === 'health'
              ? <View style={st.tabIcon}>{[10, 18, 7, 14].map((h, i) => <View key={i} style={{ width: 3, height: h, borderRadius: 1, backgroundColor: on ? C.primary : C.text2 }} />)}</View>
              : <View style={[st.tabIcon, { width: 26, height: 14, borderRadius: 7, borderWidth: 2, borderColor: on ? C.primary : C.text2, justifyContent: 'center', paddingHorizontal: 2 }]}>
                  <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: on ? C.primary : C.text2, alignSelf: 'flex-end' }} /></View>}
            <Text style={[st.tabText, on && { color: C.primary }]}>{label}</Text>
          </Pressable>); })}
      </View>

      {/* drain confirmation: a bottom sheet with plain buttons, no gesture required */}
      <Modal visible={!!sheet} transparent animationType="slide" onRequestClose={() => setSheet(null)} statusBarTranslucent>
        <Pressable style={st.scrim} onPress={() => setSheet(null)} accessibilityLabel="Close" accessibilityRole="button" />
        <View style={[st.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]} accessibilityViewIsModal>
          <View style={st.grabber} />
          <Text style={st.h2} accessibilityRole="header">Drain traffic from {sheet?.name}?</Text>
          <Text style={[st.bBody, { marginTop: 8 }]}>New requests to {sheet?.name} get 503 “drained” and aren't forwarded until you resume. Every drained request still shows in the access log.</Text>
          <Btn label={busy ? 'Draining…' : 'Drain traffic'} kind="drain" onPress={() => !busy && setDrain(sheet, true)} style={{ marginTop: 24 }} />
          <Btn label="Keep forwarding" kind="quiet" onPress={() => setSheet(null)} style={{ marginTop: 12 }} />
        </View>
      </Modal>
    </View>);
}

export default function App() {
  return <SafeAreaProvider><Main /></SafeAreaProvider>;
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10, gap: 12 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandText: { fontSize: 15, fontWeight: '600', color: C.text },
  logo: { width: 28, height: 28, borderRadius: 7, backgroundColor: C.primary, justifyContent: 'center' },
  logoLine: { position: 'absolute', left: 6, right: 6, height: 2, backgroundColor: '#fff' },
  logoDot: { position: 'absolute', width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  logoMid: { left: 10, width: 8, height: 8, borderRadius: 4, borderWidth: 2, borderColor: '#fff', backgroundColor: C.primary },
  conn: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  connText: { fontSize: 13, fontWeight: '600' },

  h1: { fontSize: 34, fontWeight: '700', color: C.text, letterSpacing: -0.5 },
  h2: { fontSize: 22, fontWeight: '700', color: C.text, flexShrink: 1 },
  h3: { fontSize: 17, fontWeight: '600', color: C.text },
  help: { fontSize: 15, color: C.text2, marginTop: 4, lineHeight: 21 },
  label: { fontSize: 15, fontWeight: '600', color: C.text, marginTop: 16 },
  input: { borderWidth: 1, borderColor: C.borderStrong, borderRadius: 8, paddingHorizontal: 12, minHeight: 48, backgroundColor: C.surface, marginTop: 6, fontSize: 17, color: C.text, fontFamily: MONO },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  center: { alignItems: 'center', marginTop: 32, gap: 12 },

  card: { backgroundColor: C.surface, borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 20, marginTop: 12 },
  connRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.sunken, borderRadius: 10, paddingLeft: 14, marginTop: 4, minHeight: 48 },
  connAddr: { flex: 1, fontFamily: MONO, fontSize: 13, color: C.text },
  linkBtn: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 14, alignSelf: 'flex-start' },
  link: { color: C.primary, fontSize: 15, fontWeight: '600' },

  banner: { flexDirection: 'row', gap: 12, borderWidth: 1, borderRadius: 12, padding: 16, marginTop: 12 },
  bTitle: { fontSize: 17, fontWeight: '600', lineHeight: 22 },
  bBody: { fontSize: 15, color: C.text, marginTop: 2, lineHeight: 21 },

  seg: { flexDirection: 'row', backgroundColor: C.sunken, borderRadius: 10, padding: 4, marginTop: 16, gap: 4 },
  segItem: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 8 },
  segOn: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  segText: { fontSize: 15, fontWeight: '600', color: C.text2 },

  status: { fontSize: 34, fontWeight: '700', letterSpacing: -0.5 },
  target: { fontFamily: MONO, fontSize: 13, color: C.text2, marginTop: 8 },
  bigRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 24, gap: 6 },
  big: { fontSize: 56, fontWeight: '600', color: C.text, letterSpacing: -1.5, fontVariant: ['tabular-nums'] },
  bigUnit: { fontSize: 22, color: C.text2 },
  metrics: { flexDirection: 'row', gap: 40, marginTop: 20, paddingTop: 16, borderTopWidth: 1, borderTopColor: C.border },
  mVal: { fontSize: 17, fontWeight: '600', color: C.text, fontVariant: ['tabular-nums'] },
  mKey: { fontSize: 13, color: C.text2, marginTop: 2 },
  spark: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 44 },
  bar: { flex: 1, maxWidth: 12, borderRadius: 2, backgroundColor: C.borderStrong },

  path: { flexDirection: 'row', alignItems: 'flex-start' },
  pnode: { width: 72, alignItems: 'center', gap: 6 },
  pdot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: C.borderStrong, backgroundColor: C.surface, marginTop: 5 },
  pdotOn: { borderColor: C.text, backgroundColor: C.text },
  pl: { fontSize: 13, fontWeight: '600', color: C.text },
  plink: { flex: 1, height: 2, backgroundColor: C.text2, marginTop: 11, marginHorizontal: -22, alignItems: 'center', justifyContent: 'center' },
  plinkOn: {},
  plinkOff: { backgroundColor: C.border },
  pmark: { backgroundColor: C.surface, padding: 3, borderRadius: 14 },
  pcap: { fontSize: 15, color: C.text, marginTop: 14, lineHeight: 21 },

  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 16, backgroundColor: C.surface, borderRadius: 12, borderWidth: 1, borderColor: C.border, paddingHorizontal: 20, minHeight: 72, marginTop: 12 },

  btn: { minHeight: 52, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, borderWidth: 1 },
  btn_primary: { backgroundColor: C.primary, borderColor: C.primary }, btn_primary_p: { backgroundColor: C.primaryStrong },
  btn_drain: { backgroundColor: C.warn, borderColor: C.warn }, btn_drain_p: { opacity: 0.85 },
  btn_quiet: { backgroundColor: C.surface, borderColor: C.borderStrong }, btn_quiet_p: { backgroundColor: C.sunken },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '600' },

  disclaimer: { fontSize: 13, color: C.text2, marginTop: 24, lineHeight: 18 },

  tabbar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.surface },
  tabItem: { flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 4, paddingTop: 6 },
  tabMark: { position: 'absolute', top: 0, height: 3, width: 48, borderRadius: 2, backgroundColor: 'transparent' },
  tabIcon: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 18 },
  tabText: { fontSize: 13, fontWeight: '600', color: C.text2 },

  scrim: { flex: 1, backgroundColor: 'rgba(31,41,55,0.45)' },
  sheet: { backgroundColor: C.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingHorizontal: 20, paddingTop: 10 },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: C.border, marginBottom: 16 },
});
