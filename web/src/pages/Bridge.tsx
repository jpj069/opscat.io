// OpsCat Bridge — the incident war room (docs/BRIDGE.md).
// ONE LiveKit room per bridge; a breakout is a server-side subscription group.
// This page: mission-control wall (all groups, all shared screens), breakout
// focus view, live feed rail (SSE), mic/screenshare controls. Media flows
// client <-> LiveKit only. Loaded as a lazy chunk (livekit-client is heavy).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ConnectionState, LocalParticipant, LocalTrackPublication, Participant,
  RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room, RoomEvent, Track,
} from 'livekit-client';
import { api, ApiError, openStream } from '../api';
import { useApp } from '../state';
import { SEV, alpha, fmtTime, initials, sevColor } from '../format';
import { Card, Button, Busy, GlowDot, Modal, SevBadge, Skeleton, StatusPill, ListSkeleton, Input, Field } from '../ui';
import {
  ArrowLeftIcon, BellIcon, ChevronLeftIcon, ChevronRightIcon, LogOutIcon,
  MaximizeIcon, MicIcon, MicOffIcon, MonitorIcon, MonitorUpIcon, PlusIcon,
  RadioIcon, XIcon, ZapIcon,
} from 'lucide-react';
import type { BridgeFeedItem, BridgeGroup, BridgeParticipant, BridgeRoom, BridgeState, Incident } from '../types';

const LOBBY_COLOR = '#8b949e';
type Share = { sid: string; identity: string; track: Track };
type View = 'wall' | { g: number | null }; // g:null = lobby focus

const STATUS_COLOR: Record<Incident['status'], string> = {
  investigating: '#f85149', identified: '#f0883e', monitoring: '#e3b341', resolved: '#3fb950',
};

// ---------------------------------------------------------------- media atoms

function ShareVideo({ track }: { track: Track }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track]);
  return <video ref={ref} muted playsInline />;
}

function AudioOut({ track, muted }: { track: Track; muted: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track]);
  useEffect(() => { if (ref.current) ref.current.muted = muted; }, [muted]);
  return <audio ref={ref} style={{ display: 'none' }} />;
}

// --------------------------------------------------- transcription (phase 2)

// `chunked` mode from docs/BRIDGE.md: energy VAD on the OWN mic (the pristine
// local signal — no server-side decode), one MediaRecorder segment per speech
// burst, POSTed for server-side STT. The server attributes the text to the
// speaker's current group and broadcasts it as a bridge.feed transcript item.
function useTranscriber(active: boolean, roomRef: React.MutableRefObject<Room | null>, roomId: number | null) {
  useEffect(() => {
    if (!active || !roomId) return;
    const msTrack = roomRef.current?.localParticipant
      .getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
    if (!msTrack || typeof MediaRecorder === 'undefined') return;
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) return;

    let gone = false;
    const stream = new MediaStream([msTrack]);
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);

    let rec: MediaRecorder | null = null;
    let parts: BlobPart[] = [];
    let speaking = false;
    let loud = 0;
    let quiet = 0;
    let startedAt = 0;
    const THRESH = 0.02; // RMS 0..1 — above ≈ speech, tuned for headset mics

    const startSegment = () => {
      parts = [];
      rec = new MediaRecorder(stream, { mimeType: mime });
      rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(parts, { type: mime });
        const dur = Date.now() - startedAt;
        // skip blips: sub-400ms or tiny blobs are coughs and key clicks
        if (!gone && blob.size > 2000 && dur > 400) {
          api.postBlob(`/api/room/${roomId}/transcribe?dur=${dur}`, blob).catch(() => {});
        }
      };
      startedAt = Date.now();
      rec.start();
    };
    const stopSegment = () => {
      if (rec && rec.state !== 'inactive') rec.stop();
      rec = null;
    };

    // 60ms ticks: ~120ms attack, ~720ms release, 15s hard cap per segment
    const tick = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      if (!speaking) {
        loud = rms > THRESH ? loud + 1 : 0;
        if (loud >= 2) { speaking = true; quiet = 0; startSegment(); }
      } else {
        quiet = rms > THRESH ? 0 : quiet + 1;
        if (quiet >= 12 || Date.now() - startedAt > 15000) { speaking = false; loud = 0; stopSegment(); }
      }
    }, 60);

    return () => {
      gone = true;
      clearInterval(tick);
      stopSegment();
      ctx.close().catch(() => {});
    };
  }, [active, roomId]);
}

// ---------------------------------------------------------------- page

export default function Bridge() {
  const app = useApp();
  const me = app.user?.id ?? 0;
  const canLead = ['lead', 'cto', 'admin'].includes(app.user?.role || '');
  const incidentId = app.bridgeIncident;

  const [status, setStatus] = useState<'boot' | 'ready' | 'unconfigured' | 'noplan' | 'noroom' | 'noincident' | 'error'>(
    incidentId == null ? 'noincident' : 'boot');
  const [errMsg, setErrMsg] = useState('');
  const [room, setRoom] = useState<BridgeRoom | null>(null);
  const [groups, setGroups] = useState<BridgeGroup[]>([]);
  const [participants, setParticipants] = useState<BridgeParticipant[]>([]);
  const [feed, setFeed] = useState<BridgeFeedItem[] | null>(null);
  const [incident, setIncident] = useState<Incident | null>(null);
  const [stt, setStt] = useState(false); // voice provider configured?
  const [view, setView] = useState<View>('wall');
  const [focusSid, setFocusSid] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [unread, setUnread] = useState(0);
  const [feedFilter, setFeedFilter] = useState<'all' | 'insight'>('all');
  const [toast, setToast] = useState<BridgeFeedItem | null>(null);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [closeArmed, setCloseArmed] = useState(false);

  // livekit state
  const lkRoom = useRef<Room | null>(null);
  const [connState, setConnState] = useState<ConnectionState | 'off'>('off');
  const [lkNote, setLkNote] = useState('');
  const [micOn, setMicOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shares, setShares] = useState<Share[]>([]);
  const [audios, setAudios] = useState<Share[]>([]);
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());

  const myRow = participants.find((p) => p.user_id === me);
  const myGroupId = myRow ? myRow.group_id : null;
  const openGroups = useMemo(() => groups.filter((g) => !g.closed_at), [groups]);
  const groupOf = (identity: string): number | null => {
    const p = participants.find((x) => String(x.user_id) === identity);
    return p ? p.group_id : null;
  };
  const nameOf = (userId: number | null): string => {
    if (userId == null) return 'AI analysis';
    const p = participants.find((x) => x.user_id === userId);
    if (p) return p.name || p.email;
    const u = app.users.find((x) => x.id === userId);
    return u ? u.name : `user ${userId}`;
  };

  // ---------------------------------------------------------- room bootstrap
  useEffect(() => {
    if (incidentId == null) { setStatus('noincident'); return; }
    let gone = false;
    setStatus('boot');
    (async () => {
      try {
        let st = await api.get<BridgeState>(`/api/incidents/${incidentId}/room`);
        if (!st.room) {
          if (!canLead) { if (!gone) setStatus('noroom'); return; }
          st = await api.post<BridgeState>(`/api/incidents/${incidentId}/room`);
        }
        if (gone || !st.room) return;
        setRoom(st.room);
        setGroups(st.groups || []);
        setParticipants(st.participants || []);
        setStt(!!st.stt);
        setStatus('ready');
        const f = await api.get<{ items: BridgeFeedItem[] }>(`/api/room/${st.room.id}/feed?limit=150`);
        if (!gone) setFeed(f.items);
      } catch (e) {
        if (gone) return;
        const err = e as ApiError;
        if (err.status === 503) setStatus('unconfigured');
        else if (err.status === 403) setStatus(err.message.includes('plan') ? 'noplan' : 'noroom');
        else { setErrMsg(err.message || 'bridge unavailable'); setStatus('error'); }
      }
    })();
    api.get<Incident[]>('/api/incidents')
      .then((list) => { if (!gone) setIncident(list.find((i) => i.id === incidentId) || null); })
      .catch(() => {});
    return () => { gone = true; };
  }, [incidentId]);

  // ---------------------------------------------------------- SSE (feed/presence/groups)
  useEffect(() => {
    if (!room) return;
    const stop = openStream({
      onBridge: (type, data) => {
        if (!data || data.roomId !== room.id) return;
        if (type === 'bridge.feed' && data.item) {
          const item = data.item as BridgeFeedItem;
          setFeed((prev) => {
            const cur = prev || [];
            if (cur.some((x) => x.id === item.id)) return cur;
            return [...cur.slice(-499), item];
          });
          if (item.kind === 'insight' && item.severity === 'critical') setToast(item);
          if (!railOpenRef.current) setUnread((n) => n + 1);
        } else if (type === 'bridge.presence' && Array.isArray(data.participants)) {
          setParticipants(data.participants);
        } else if (type === 'bridge.groups' && Array.isArray(data.groups)) {
          setGroups(data.groups);
        }
      },
    });
    return stop;
  }, [room?.id]);
  const railOpenRef = useRef(railOpen);
  useEffect(() => { railOpenRef.current = railOpen; if (railOpen) setUnread(0); }, [railOpen]);

  // ---------------------------------------------------------- LiveKit connect
  useEffect(() => {
    if (!room || room.status !== 'open') return;
    let gone = false;
    const r = new Room({ adaptiveStream: true, dynacast: true });
    lkRoom.current = r;
    setConnState(ConnectionState.Connecting);

    const addShare = (track: Track | undefined, sid: string, identity: string) => {
      if (!track) return;
      setShares((prev) => (prev.some((s) => s.sid === sid) ? prev : [...prev, { sid, identity, track }]));
    };
    const dropShare = (sid: string) => setShares((prev) => prev.filter((s) => s.sid !== sid));

    r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (pub.source === Track.Source.ScreenShare && track.kind === Track.Kind.Video) {
        addShare(track, pub.trackSid, p.identity);
      } else if (track.kind === Track.Kind.Audio) {
        setAudios((prev) => (prev.some((a) => a.sid === pub.trackSid) ? prev
          : [...prev, { sid: pub.trackSid, identity: p.identity, track }]));
      }
    });
    r.on(RoomEvent.TrackUnsubscribed, (_t: RemoteTrack, pub: RemoteTrackPublication) => {
      dropShare(pub.trackSid);
      setAudios((prev) => prev.filter((a) => a.sid !== pub.trackSid));
    });
    r.on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication, p: LocalParticipant) => {
      if (pub.source === Track.Source.ScreenShare && pub.track && pub.track.kind === Track.Kind.Video) {
        addShare(pub.track, pub.trackSid, p.identity);
        setSharing(true);
      }
    });
    r.on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
      if (pub.source === Track.Source.ScreenShare) { dropShare(pub.trackSid); setSharing(false); }
    });
    r.on(RoomEvent.ActiveSpeakersChanged, (spk: Participant[]) => {
      setSpeaking(new Set(spk.map((s) => s.identity)));
    });
    r.on(RoomEvent.ConnectionStateChanged, (s: ConnectionState) => setConnState(s));

    (async () => {
      try {
        const t = await api.post<{ url: string; room: string; token: string }>(`/api/room/${room.id}/token`);
        if (gone) return;
        await r.connect(t.url, t.token);
        if (gone) return;
        try {
          await r.localParticipant.setMicrophoneEnabled(true);
          if (!gone) setMicOn(true);
        } catch {
          if (!gone) setLkNote('Microphone unavailable — check browser permissions.');
        }
        // ensure a participant row exists (idempotent; group stays as-is)
        api.post(`/api/room/${room.id}/join`, { groupId: myGroupIdRef.current }).catch(() => {});
      } catch (e) {
        if (!gone) setLkNote(`Media connection failed: ${(e as Error).message}`);
      }
    })();

    return () => {
      gone = true;
      setShares([]); setAudios([]); setSpeaking(new Set());
      setMicOn(false); setSharing(false); setConnState('off');
      r.disconnect();
      lkRoom.current = null;
    };
  }, [room?.id, room?.status]);
  const myGroupIdRef = useRef<number | null>(null);
  useEffect(() => { myGroupIdRef.current = myGroupId; }, [myGroupId]);

  // audible = my group only (instant UX mute; the SFU enforcement below is
  // authoritative and this just avoids a blip while permissions propagate)
  const audible = useMemo(() => {
    const set = new Set<string>();
    for (const p of participants) {
      if ((p.group_id ?? null) === (myGroupId ?? null)) set.add(String(p.user_id));
    }
    return set;
  }, [participants, myGroupId]);

  // SFU-enforced isolation: my microphone may only be subscribed by my own
  // group; my screen shares stay open to everyone (that IS the wall). The
  // permission list is driven by the server-authoritative group map, and the
  // SFU enforces it against subscribers — a tampered client could only
  // over-share its own mic, it can never overhear another group.
  useEffect(() => {
    const r = lkRoom.current;
    if (!r || connState !== ConnectionState.Connected) return;
    const screens = Array.from(r.localParticipant.trackPublications.values())
      .filter((p) => p.source === Track.Source.ScreenShare)
      .map((p) => p.trackSid);
    r.localParticipant.setTrackSubscriptionPermissions(false, participants
      .filter((p) => p.user_id !== me)
      .map((p) => ((p.group_id ?? null) === (myGroupId ?? null)
        ? { participantIdentity: String(p.user_id), allowAll: true }
        : { participantIdentity: String(p.user_id), allowedTrackSids: screens })));
  }, [participants, myGroupId, connState, shares, me]);

  // live transcript: my own speech, chunked locally, transcribed server-side
  useTranscriber(
    !!room && room.status === 'open' && room.transcription && stt
      && micOn && connState === ConnectionState.Connected,
    lkRoom, room ? room.id : null);

  const lastTranscripts = (gid: number | null, n: number) =>
    (feed || []).filter((i) => i.kind === 'transcript' && (i.group_id ?? null) === gid).slice(-n);

  // ---------------------------------------------------------- actions
  const joinGroup = async (gid: number | null) => {
    if (!room) return;
    try { await api.post(`/api/room/${room.id}/join`, { groupId: gid }); } catch { return; }
    setParticipants((prev) => {
      const mine = prev.find((p) => p.user_id === me);
      if (!mine) {
        return [...prev, { user_id: me, group_id: gid, connected: 1, joined_at: Date.now(),
          last_seen: Date.now(), name: app.user?.name || '', email: '', color: null }];
      }
      return prev.map((p) => (p.user_id === me ? { ...p, group_id: gid } : p));
    });
    setView({ g: gid });
    setFocusSid(null);
  };

  const toggleMic = async () => {
    const r = lkRoom.current;
    if (!r) return;
    try { await r.localParticipant.setMicrophoneEnabled(!micOn); setMicOn(!micOn); } catch { /* denied */ }
  };
  const toggleShare = async () => {
    const r = lkRoom.current;
    if (!r) return;
    try { await r.localParticipant.setScreenShareEnabled(!sharing); } catch { /* user cancelled */ }
  };
  const leave = () => { app.setNav('incidents'); };
  const closeRoom = async () => {
    if (!room) return;
    if (!closeArmed) { setCloseArmed(true); setTimeout(() => setCloseArmed(false), 4000); return; }
    try { await api.post(`/api/room/${room.id}/close`); setRoom({ ...room, status: 'closed' }); } catch { /* role */ }
    setCloseArmed(false);
  };
  const createGroup = async (name: string) => {
    if (!room || !name.trim()) return;
    try {
      const r = await api.post<{ group: BridgeGroup }>(`/api/room/${room.id}/groups`, { name: name.trim() });
      setGroups((prev) => (prev.some((g) => g.id === r.group.id) ? prev : [...prev, r.group]));
      setShowNewGroup(false);
      await joinGroup(r.group.id);
    } catch { /* validation */ }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.fullscreenElement) return;
      setView('wall');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // elapsed ticker
  const [, tick] = useState(0);
  useEffect(() => {
    if (!room || room.status !== 'open') return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [room?.id, room?.status]);

  // ---------------------------------------------------------- empty states
  if (status === 'noincident') {
    return (
      <div className="page">
        <Card style={{ maxWidth: 560 }}>
          <div className="card-title"><RadioIcon size={14} /> Bridge</div>
          <p className="text-sm" style={{ margin: 0 }}>
            The Bridge is an incident's war room. Open one from
            <b> Incidents</b> → select an incident → <b>Open the Bridge</b>.
          </p>
          <Button variant="primary" style={{ marginTop: 12 }}
 onClick={() => app.setNav('incidents')}>Go to Incidents</Button>
        </Card>
      </div>
    );
  }
  if (status === 'unconfigured') {
    return (
      <div className="page">
        <Card style={{ maxWidth: 640 }}>
          <div className="card-title"><RadioIcon size={14} /> Bridge is not configured</div>
          <p className="text-sm" style={{ marginTop: 0 }}>
            The LiveKit sidecar is not set up on this server yet. An admin needs to:
          </p>
          <ol className="text-sm" style={{ margin: '0 0 4px', paddingLeft: 18, lineHeight: 1.9 }}>
            <li>set <span className="mono">OPSCAT_LIVEKIT_URL</span>, <span className="mono">OPSCAT_LIVEKIT_API_KEY</span>, <span className="mono">OPSCAT_LIVEKIT_API_SECRET</span> in <span className="mono">.env</span></li>
            <li>start the sidecar: <span className="mono">docker compose --profile bridge up -d</span></li>
            <li>add a DNS record for <span className="mono">bridge.&lt;your-domain&gt;</span> and open UDP 50100-50200 + TCP 7881</li>
          </ol>
          <p className="text-sm text-text2" style={{ margin: 0 }}>Full walkthrough: docs/BRIDGE.md</p>
        </Card>
      </div>
    );
  }
  if (status === 'noplan') {
    return (
      <div className="page">
        <Card style={{ maxWidth: 560 }}>
          <div className="card-title"><RadioIcon size={14} /> Bridge</div>
          <p className="text-sm" style={{ margin: 0 }}>
            The Bridge is available on the Business and Enterprise plans.
          </p>
        </Card>
      </div>
    );
  }
  if (status === 'noroom') {
    return (
      <div className="page">
        <Card style={{ maxWidth: 560 }}>
          <div className="card-title"><RadioIcon size={14} /> No bridge yet</div>
          <p className="text-sm" style={{ margin: 0 }}>
            This incident has no bridge open. A user with the <b>lead</b> role (or above)
            opens it from the incident.
          </p>
          <Button style={{ marginTop: 12 }} onClick={() => app.setNav('incidents')}>
            <ArrowLeftIcon size={13} /> Back to Incidents
          </Button>
        </Card>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="page">
        <Card style={{ maxWidth: 560 }}>
          <div className="card-title"><RadioIcon size={14} /> Bridge unavailable</div>
          <p className="text-sm" style={{ margin: 0 }}>{errMsg}</p>
        </Card>
      </div>
    );
  }
  if (status === 'boot' || !room) {
    return (
      <div className="page-console br-shell">
        <div className="br-main">
          <div className="row" style={{ padding: '12px 18px', gap: 10 }}>
            <Skeleton w={120} h={18} /><Skeleton w={70} h={16} /><Skeleton w={90} h={16} />
          </div>
          <div className="br-stage"><Busy>
            <div className="br-grid">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={200} />)}</div>
          </Busy></div>
        </div>
        <aside className="br-rail"><ListSkeleton rows={6} lines={2} /></aside>
      </div>
    );
  }

  // ---------------------------------------------------------- ready render
  const elapsed = Math.max(0, Date.now() - room.createdAt);
  const eh = Math.floor(elapsed / 3600000);
  const em = Math.floor(elapsed / 60000) % 60;
  const es = Math.floor(elapsed / 1000) % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const connLabel = connState === 'off' ? null
    : connState === ConnectionState.Connected ? { text: 'live', color: SEV.green }
    : connState === ConnectionState.Reconnecting ? { text: 'reconnecting', color: SEV.medium }
    : connState === ConnectionState.Connecting ? { text: 'connecting', color: SEV.info }
    : { text: 'offline', color: SEV.info };

  const sharesFor = (gid: number | null) => shares.filter((s) => groupOf(s.identity) === gid);
  const membersFor = (gid: number | null) => participants.filter((p) => (p.group_id ?? null) === gid);
  const focusedGroup: BridgeGroup | { id: null; name: string; color: string } | null =
    view === 'wall' ? null
      : view.g === null ? { id: null, name: 'Lobby', color: LOBBY_COLOR }
        : openGroups.find((g) => g.id === view.g) || null;

  const visibleFeed = (feed || []).filter((i) => feedFilter === 'all' || i.kind === 'insight');

  return (
    <div className="page-console br-shell">
      <div className="br-main">
        {/* ---------------------------------------------------------- header */}
        <div className="row row-wrap" style={{ padding: '12px 18px', gap: 10 }}>
          <span className="text-lg font-bold text-text0" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <RadioIcon size={15} /> Bridge
          </span>
          <span className="mono text-base" style={{ color: SEV.low }}>{incident?.label || `INC-${2000 + room.incidentId}`}</span>
          {incident && <SevBadge score={incident.severity} />}
          {incident && <StatusPill text={incident.status} color={STATUS_COLOR[incident.status]} />}
          <span className="mono text-md text-text0" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {pad(eh)}:{pad(em)}:{pad(es)}
          </span>
          <span className="row text-xs"
            title={room.transcription && !stt
              ? 'Transcription is enabled, but no voice provider is configured — an admin sets one under Settings → Voice / Transcription.'
              : undefined}
            style={{ gap: 5, color: room.transcription ? (stt ? SEV.green : SEV.medium) : 'var(--text3)' }}>
            <GlowDot color={room.transcription ? (stt ? SEV.green : SEV.medium) : 'var(--text3)'} size={7} />
            {room.transcription ? (stt ? 'Transcript on' : 'Transcript: no provider') : 'Transcript off'}
          </span>
          {room.status === 'closed' && <StatusPill text="closed" color="var(--text3)" />}
          <div style={{ flex: 1 }} />
          {connLabel && <span className="pill" style={{ color: connLabel.color, background: alpha(connLabel.color, 0.1),
            border: `1px solid ${alpha(connLabel.color, 0.3)}` }}>{connLabel.text}</span>}
          <Button size="sm" onClick={toggleMic} title={micOn ? 'Mute' : 'Unmute'}
 style={micOn ? {} : { color: SEV.critical, borderColor: alpha(SEV.critical, 0.4) }}>
            {micOn ? <MicIcon size={13} /> : <MicOffIcon size={13} />}
          </Button>
          <Button size="sm" onClick={toggleShare} title={sharing ? 'Stop sharing' : 'Share your screen'}
 style={sharing ? { color: SEV.green, borderColor: alpha(SEV.green, 0.45) } : {}}>
            {sharing ? <MonitorIcon size={13} /> : <MonitorUpIcon size={13} />}
          </Button>
          {canLead && room.status === 'open' && (
            <Button size="sm" onClick={closeRoom}
 style={closeArmed ? { color: '#fff', background: SEV.critical, borderColor: SEV.critical } : {}}>
              {closeArmed ? 'Confirm close' : 'Close bridge'}
            </Button>
          )}
          <Button size="sm" onClick={leave} title="Leave the bridge">
            <LogOutIcon size={13} /> Leave
          </Button>
        </div>
        {lkNote && <div className="text-xs" style={{ padding: '0 18px 8px', color: SEV.medium }}>{lkNote}</div>}

        {/* ---------------------------------------------------------- stage */}
        <div className="br-stage">
          {view === 'wall' && (
            <div className="br-grid">
              {[...openGroups.map((g) => ({ id: g.id as number | null, name: g.name, color: g.color || LOBBY_COLOR })),
                { id: null as number | null, name: 'Lobby', color: LOBBY_COLOR }].map((g) => {
                const members = membersFor(g.id);
                const gShares = sharesFor(g.id);
                const mine = (myGroupId ?? null) === g.id;
                return (
                  <Card key={g.id ?? 'lobby'} role="button" tabIndex={0}
                    onClick={() => joinGroup(g.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); joinGroup(g.id); } }}
                    style={{ padding: '10px 12px', cursor: 'pointer', display: 'flex',
                      flexDirection: 'column', gap: 8, borderColor: mine ? 'var(--low)' : undefined }}>
                    <div className="row" style={{ gap: 7, minWidth: 0 }}>
                      <GlowDot color={g.color} size={8} />
                      <span className="text-base font-semibold text-text0"
                        style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.name}</span>
                      {mine && <span className="pill" style={{ color: 'var(--low)', border: '1px solid var(--border)' }}>you</span>}
                      <div style={{ flex: 1 }} />
                      <span className="row text-xs text-text3" style={{ gap: 4 }}>
                        <MonitorIcon size={11} />{gShares.length}
                      </span>
                    </div>
                    <div className="row" style={{ gap: 0, minWidth: 0 }}>
                      {members.length === 0 && <span className="text-sm text-text3">Empty</span>}
                      {members.map((m) => {
                        const spk = speaking.has(String(m.user_id));
                        return (
                          <span key={m.user_id} title={m.name || m.email}
                            style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--bg3)',
                              border: `1px solid ${spk ? SEV.green : m.connected ? 'var(--border)' : 'var(--bg3)'}`,
                              boxShadow: spk ? `0 0 0 2px ${alpha(SEV.green, 0.35)}` : undefined,
                              color: m.connected ? 'var(--text1)' : 'var(--text3)', marginRight: -4,
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <span className="text-2xs font-semibold">{initials(m.name || m.email)}</span>
                          </span>
                        );
                      })}
                      <span className="text-xs text-text2" style={{ marginLeft: 10, whiteSpace: 'nowrap',
                        overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {members.map((m) => m.name || m.email).join(', ')}
                      </span>
                    </div>
                    {(() => {
                      const t = lastTranscripts(g.id, 1)[0];
                      return t ? (
                        <div className="text-xs text-text2" style={{ fontStyle: 'italic', whiteSpace: 'nowrap',
                          overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          “{t.body}” — {nameOf(t.user_id)}
                        </div>
                      ) : null;
                    })()}
                    {gShares.length > 0 ? (
                      <div style={{ display: 'grid', gap: 6,
                        gridTemplateColumns: gShares.length === 1 ? '1fr' : '1fr 1fr' }}>
                        {gShares.map((s) => (
                          <div key={s.sid} className="br-scr">
                            <ShareVideo track={s.track} />
                            <span className="mono text-2xs" style={{ position: 'absolute', left: 5, bottom: 5,
                              padding: '1px 5px', borderRadius: 3, background: 'rgba(4,6,9,.72)', color: 'var(--text2)' }}>
                              {nameOf(Number(s.identity))}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-sm text-text3" style={{ border: '1px dashed var(--bg3)', borderRadius: 4,
                        padding: '14px 10px', textAlign: 'center' }}>No screens shared — audio only</div>
                    )}
                  </Card>
                );
              })}
              <button onClick={() => setShowNewGroup(true)}
                className="text-base" style={{ border: '1px dashed var(--bg3)', borderRadius: 8, minHeight: 96,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text2)' }}>
                <PlusIcon size={15} /> New breakout
              </button>
            </div>
          )}

          {view !== 'wall' && focusedGroup && (() => {
            const gShares = sharesFor(focusedGroup.id);
            const members = membersFor(focusedGroup.id);
            const focus = gShares.find((s) => s.sid === focusSid) || gShares[0] || null;
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
                <div className="row row-wrap" style={{ gap: 10 }}>
                  <Button size="sm" onClick={() => setView('wall')}>
                    <ArrowLeftIcon size={12} /> Mission Control
                  </Button>
                  <span className="row text-lg font-semibold text-text0" style={{ gap: 8 }}>
                    <GlowDot color={focusedGroup.color} size={8} />{focusedGroup.name}
                  </span>
                  <span className="text-xs text-text2">
                    {members.map((m) => m.name || m.email).join(', ') || 'Empty'}
                  </span>
                  <div style={{ flex: 1 }} />
                  <span className="text-xs text-text2">Audio: this group only · {gShares.length} screens</span>
                </div>
                {focus ? (
                  <div className="br-focus" id="br-focuswrap">
                    <ShareVideo track={focus.track} />
                    <span className="mono text-xs" style={{ position: 'absolute', left: 8, top: 8, padding: '2px 7px',
                      borderRadius: 3, background: 'rgba(4,6,9,.72)', color: 'var(--text1)' }}>
                      {nameOf(Number(focus.identity))} — sharing
                    </span>
                    <button aria-label="Toggle fullscreen" title="Fullscreen"
                      onClick={() => {
                        const el = document.getElementById('br-focuswrap');
                        if (document.fullscreenElement) void document.exitFullscreen();
                        else el?.requestFullscreen();
                      }}
                      style={{ position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 5,
                        background: 'rgba(4,6,9,.65)', border: '1px solid rgba(255,255,255,.12)', color: 'var(--text1)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {document.fullscreenElement ? <XIcon size={13} /> : <MaximizeIcon size={13} />}
                    </button>
                  </div>
                ) : (
                  <div className="br-focus" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span className="text-sm text-text3">No screens shared in this group yet — your share appears here</span>
                  </div>
                )}
                {gShares.length > 1 && (
                  <div className="row" style={{ gap: 8, overflowX: 'auto', flexShrink: 0 }}>
                    {gShares.map((s) => (
                      <button key={s.sid} onClick={() => setFocusSid(s.sid)}
                        className="br-scr" style={{ width: 150, flexShrink: 0, padding: 0,
                          borderColor: (focus && s.sid === focus.sid) ? 'var(--low)' : undefined }}>
                        <ShareVideo track={s.track} />
                      </button>
                    ))}
                  </div>
                )}
                {room.transcription && stt && (() => {
                  const lines = lastTranscripts(focusedGroup.id, 2);
                  return lines.length ? (
                    <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {lines.map((l) => (
                        <div key={l.id} className="text-sm" style={{ padding: '5px 9px', borderRadius: 5,
                          background: 'var(--bg2)', border: '1px solid var(--bg3)' }}>
                          <span className="text-text1" style={{ fontStyle: 'italic' }}>“{l.body}”</span>
                          <span className="text-xs text-text3"> — {nameOf(l.user_id)} · {fmtTime(l.created_at)}</span>
                        </div>
                      ))}
                    </div>
                  ) : null;
                })()}
              </div>
            );
          })()}
        </div>
      </div>

      {/* ---------------------------------------------------------- feed rail */}
      <aside className={`br-rail${railOpen ? '' : ' closed'}`} aria-label="Bridge feed">
        {railOpen ? (
          <>
            <div className="row" style={{ padding: '8px 10px', borderBottom: '1px solid var(--bg3)', gap: 6 }}>
              <span className="micro">Bridge feed</span>
              <div style={{ flex: 1 }} />
              <button className="pill" onClick={() => setFeedFilter('all')}
                style={{ color: feedFilter === 'all' ? 'var(--text0)' : 'var(--text2)',
                  background: feedFilter === 'all' ? 'var(--bg3)' : 'transparent', border: '1px solid var(--bg3)' }}>All</button>
              <button className="pill" onClick={() => setFeedFilter('insight')}
                style={{ color: feedFilter === 'insight' ? 'var(--text0)' : 'var(--text2)',
                  background: feedFilter === 'insight' ? 'var(--bg3)' : 'transparent', border: '1px solid var(--bg3)' }}>Insights</button>
              <button onClick={() => setRailOpen(false)} aria-label="Collapse feed"
                style={{ color: 'var(--text3)', padding: 3 }}><ChevronRightIcon size={14} /></button>
            </div>
            <div className="br-feed" style={{ flex: 1, overflowY: 'auto', padding: '8px 10px',
              display: 'flex', flexDirection: 'column', gap: 6 }}>
              {feed === null && <Busy><ListSkeleton rows={6} lines={2} /></Busy>}
              {feed !== null && visibleFeed.length === 0 && (
                <span className="text-sm text-text3" style={{ padding: 8 }}>Nothing here yet.</span>
              )}
              {visibleFeed.map((i) => {
                const g = i.group_id ? openGroups.find((x) => x.id === i.group_id) : null;
                const critical = i.kind === 'insight' && i.severity === 'critical';
                return (
                  <div key={i.id} className="text-sm" style={{ display: 'flex', gap: 8, padding: '6px 8px',
                    borderRadius: 6,
                    background: i.kind === 'system' ? 'transparent' : critical ? alpha(SEV.critical, 0.06) : 'var(--bg2)',
                    border: `1px solid ${critical ? alpha(SEV.critical, 0.35) : i.kind === 'system' ? 'transparent' : 'var(--bg3)'}`,
                    borderLeft: i.kind === 'insight' ? `2px solid ${critical ? SEV.critical : 'var(--low)'}` : undefined }}>
                    <span style={{ color: critical ? SEV.critical : i.kind === 'insight' ? 'var(--low)' : 'var(--text3)',
                      paddingTop: 2, flexShrink: 0 }}>
                      {i.kind === 'insight' ? (critical ? <BellIcon size={12} /> : <ZapIcon size={12} />)
                        : i.kind === 'transcript' ? <MicIcon size={12} /> : <RadioIcon size={12} />}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ color: i.kind === 'system' ? 'var(--text3)'
                        : i.kind === 'insight' ? 'var(--text0)' : 'var(--text1)' }}>
                        {i.kind === 'transcript' ? `“${i.body}”` : i.body}
                      </span>
                      <div className="row text-2xs text-text3" style={{ gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
                        {i.kind !== 'system' && <span className="font-semibold text-text2">{nameOf(i.user_id)}</span>}
                        {g && <span className="row" style={{ gap: 4, color: 'var(--text2)' }}>
                          <GlowDot color={g.color} size={5} />{g.name}</span>}
                        <time className="mono">{fmtTime(i.created_at)}</time>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, paddingTop: 8 }}>
            <button onClick={() => setRailOpen(true)} aria-label="Expand feed"
              style={{ color: 'var(--text3)', padding: 3 }}><ChevronLeftIcon size={14} /></button>
            {unread > 0 && <span className="mono text-2xs font-bold" style={{ minWidth: 17, height: 17,
              borderRadius: 9, background: toast ? SEV.critical : 'var(--bg3)',
              color: toast ? '#fff' : 'var(--text1)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', padding: '0 4px' }}>{unread}</span>}
            <ZapIcon size={13} style={{ color: 'var(--text3)' }} />
          </div>
        )}
      </aside>

      {/* audio sinks: every subscribed mic, muted unless in my group */}
      <div aria-hidden="true">
        {audios.map((a) => <AudioOut key={a.sid} track={a.track} muted={!audible.has(a.identity)} />)}
      </div>

      {/* critical-insight toast */}
      {toast && (
        <div role="status" style={{ position: 'fixed', right: railOpen ? 316 : 52, bottom: 20,
          width: 'min(380px, calc(100vw - 32px))', background: 'var(--bg2)', zIndex: 50,
          border: `1px solid ${alpha(SEV.critical, 0.5)}`, borderLeft: `3px solid ${SEV.critical}`,
          borderRadius: 8, padding: '11px 12px', boxShadow: '0 12px 32px rgba(0,0,0,.55)' }}>
          <div className="row text-xs font-bold" style={{ gap: 7, color: SEV.critical,
            letterSpacing: '.08em', textTransform: 'uppercase' }}>
            <ZapIcon size={12} /> Critical insight
            <div style={{ flex: 1 }} />
            <button onClick={() => setToast(null)} aria-label="Dismiss" style={{ color: 'var(--text3)' }}>
              <XIcon size={13} /></button>
          </div>
          <div className="text-base text-text0" style={{ marginTop: 6 }}>{toast.body}</div>
          <div className="row text-2xs text-text2" style={{ gap: 5, marginTop: 6 }}>
            <BellIcon size={11} /> Pushed to all responders on their alert channels
          </div>
          {toast.group_id && (
            <div className="row" style={{ gap: 8, marginTop: 9 }}>
              <Button variant="primary" size="sm"
 onClick={() => { const gid = toast.group_id; setToast(null); void joinGroup(gid); }}>
                Open {openGroups.find((g) => g.id === toast.group_id)?.name || 'group'}
              </Button>
              <Button size="sm" onClick={() => setToast(null)}>Dismiss</Button>
            </div>
          )}
        </div>
      )}

      {showNewGroup && <NewGroupModal onClose={() => setShowNewGroup(false)} onCreate={createGroup} />}
    </div>
  );
}

function NewGroupModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <Modal title="New breakout" onClose={onClose} width={380}>
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="DB / Replication"
          autoFocus onKeyDown={(e) => { if (e.key === 'Enter') onCreate(name); }} />
      </Field>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => onCreate(name)} disabled={!name.trim()}>Create</Button>
      </div>
    </Modal>
  );
}
