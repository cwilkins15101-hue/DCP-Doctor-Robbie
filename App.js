import { useState, useEffect, useRef } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity, Animated,
  Alert, Modal, FlatList, SafeAreaView, ScrollView,
  ActivityIndicator, Platform, useWindowDimensions, Image, TextInput,
} from 'react-native';
import { Audio } from 'expo-av';
import * as DocumentPicker from 'expo-document-picker';
import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import RenderHtml from 'react-native-render-html';
import { DragonCopilotBackend } from './dragonCopilotBackend';
import { DdeClient } from './ddeClient';
import { EpicClient } from './epicClient';
import { MsftAuth } from './msftAuth';

// ---------------------------------------------------------------------------
// Color tokens — Blue & Gold
// ---------------------------------------------------------------------------
const C = {
  blue:        '#0B3D91',
  blueMid:     '#1A56DB',
  blueLight:   '#E8F0FE',
  blueBorder:  '#BFDBFE',
  gold:        '#F5A623',
  goldLight:   '#FEF3C7',
  amberDark:   '#92400E',
  success:     '#15803D',
  successLight: '#DCFCE7',
  white:       '#FFFFFF',
  bg:          '#F4F7FF',
  textDark:    '#0B1F3A',
  textMid:     '#4A6080',
  textLight:   '#94A3B8',
  danger:      '#DC2626',
  border:      '#DDE6F0',
  epicRed:     '#ED1C24',
  epicRedDark: '#C4151B',
};

// ---------------------------------------------------------------------------
// In-app debug logger — intercepts console.log / console.error
// ---------------------------------------------------------------------------
const logEntries = [];
const logListeners = new Set();

function addLog(level, args) {
  const entry = {
    id: Date.now() + Math.random(),
    level,
    time: new Date().toLocaleTimeString(),
    message: args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '),
  };
  logEntries.push(entry);
  if (logEntries.length > 200) logEntries.shift();
  logListeners.forEach(fn => fn([...logEntries]));
}

const _origLog = console.log;
const _origError = console.error;
const _origWarn = console.warn;
console.log = (...args) => { _origLog(...args); addLog('log', args); };
console.error = (...args) => { _origError(...args); addLog('error', args); };
console.warn = (...args) => { _origWarn(...args); addLog('warn', args); };

function useDebugLog() {
  const [entries, setEntries] = useState([...logEntries]);
  useEffect(() => {
    logListeners.add(setEntries);
    return () => logListeners.delete(setEntries);
  }, []);
  return entries;
}

// ---------------------------------------------------------------------------
// CSV / TSV parser
// ---------------------------------------------------------------------------
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const splitLine = line => line.split(delimiter).map(v => v.trim().replace(/^"|"$/g, ''));
  const headers = splitLine(lines[0]);
  return lines.slice(1)
    .filter(line => line.trim().length > 0)
    .map(line => {
      const values = splitLine(line);
      return headers.reduce((obj, h, i) => ({ ...obj, [h]: values[i] ?? '' }), {});
    });
}

function formatClockTime(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// Dragon standard payload — noteBody here is one entry from getResult's
// artifacts map: { data: <webhook payload>, storedAt }, and the webhook
// payload's own `data` field is the Dragon Data Exchange retrieval
// response { notificationId, data: "<JSON string>" } — so the actual note
// JSON is three levels down at data.data.data (confirmed from a real
// webhook delivery). resources[] holds the note's sections, each with a
// display name and text — legitimately empty ("") for sections the
// encounter didn't cover, which is common for short recordings and NOT a
// sign the payload shape is wrong. Returns every section, blank or not —
// callers decide whether to show the blank ones (see the "Display
// additional note sections" toggle) rather than this function silently
// dropping them. Returns null only when the shape itself doesn't match
// (so callers can fall back to raw JSON as a last resort).
// ---------------------------------------------------------------------------
function parseDragonNote(noteBody) {
  try {
    const raw = noteBody?.data?.data?.data;
    if (typeof raw !== 'string') return null;
    const payload = JSON.parse(raw);
    if (!Array.isArray(payload.resources)) return null;
    const sections = payload.resources.map((r) => ({
      id: r.legacy_id,
      title: r.context?.display_description || r.legacy_id,
      content: (r.content || '').replace(/\r\n/g, '\n').trim(),
    }));
    return { title: payload.document?.title || 'Clinical Note', sections };
  } catch {
    return null;
  }
}

// Dragon Copilot delivers the transcript as a separate notification from
// the note (event type transcript_ready_complete vs
// encounter_data_ready_complete — see Notification events docs). Its
// retrieval payload's confirmed shape (see Recordings, sessions, and
// transcript docs) is transcript.turns[], each with an index, a speaker
// ("clinician" or "other"), and text — no artifact_type field at all. As
// with parseDragonNote, zero turns (a short/silent recording) is a valid
// result, not a sign the shape doesn't match.
function parseDragonTranscript(transcriptBody) {
  try {
    const raw = transcriptBody?.data?.data?.data;
    if (typeof raw !== 'string') return null;
    const payload = JSON.parse(raw);
    const rawTurns = payload.transcript?.turns;
    if (!Array.isArray(rawTurns)) return null;
    const turns = rawTurns
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((t) => ({
        id: String(t.index),
        speaker: t.speaker === 'clinician' ? 'Clinician' : t.speaker === 'other' ? 'Patient' : (t.speaker || 'Speaker'),
        text: (t.text || '').replace(/\r\n/g, '\n').trim(),
      }))
      .filter((t) => t.text.length > 0);
    return { turns };
  } catch {
    return null;
  }
}

// Finds the delivered result whose CloudEvent type contains the given
// keyword — results are now keyed by Dragon's own event types (e.g.
// "encounter_data_ready_complete", "transcript_ready_complete").
// When an encounter has multiple recordings, a note update might arrive
// under a different event type (e.g. encounter_data_updated) than the
// original (encounter_data_ready_complete) rather than replacing the same
// stored entry — so among all matches, take the most recently stored one.
function findArtifact(artifacts, keyword) {
  if (!artifacts) return null;
  const matches = Object.entries(artifacts)
    .filter(([type]) => type.toLowerCase().includes(keyword))
    .map(([, value]) => value);
  if (matches.length === 0) return null;
  return matches.reduce((latest, current) =>
    new Date(current.storedAt) > new Date(latest.storedAt) ? current : latest
  );
}

// React Native's Alert.alert doesn't reliably show anything on the web
// build (Alert has no real web implementation) — every plain title+message
// confirmation/error in this app goes through here instead, falling back
// to a real Alert on native platforms where it does work.
function notify(title, message) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.alert) {
      window.alert(message ? `${title}\n\n${message}` : title);
    }
    return;
  }
  Alert.alert(title, message);
}

// Converts Epic's narrative HTML (IPS sections, clinical notes) into plain,
// readable text — good enough for pasting into a chat tool like Dragon
// Copilot Chat, which doesn't render HTML.
function htmlToPlainText(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<(td|th)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const { width: windowWidth } = useWindowDimensions();
  const panelWidth = Math.min(440, windowWidth * 0.92);

  // Screen: 'record' | 'dragonNote'
  const [screen, setScreen] = useState('record');

  // Doctor Robbie's own login — Microsoft sign-in (see msftAuth.js). In
  // memory only, so every fresh load starts signed out; msftUser gates the
  // whole app below, before any screen-specific rendering.
  const [msftUser, setMsftUser] = useState(null);
  const [msftSigningIn, setMsftSigningIn] = useState(false);
  const [msftSignInError, setMsftSignInError] = useState('');

  // Permissions
  const [permissionGranted, setPermissionGranted] = useState(false);

  // Recording
  const [recording, setRecording] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [audioUri, setAudioUri] = useState(null);
  const [audioName, setAudioName] = useState(null);
  // The real recorded/picked format, shown in the UI instead of trusting
  // the "Recording.m4a" label — on web, expo-av's HIGH_QUALITY preset
  // actually records audio/webm regardless of that label (confirmed
  // 2026-09-23, see audioStreamUpload.js), so the label alone is
  // misleading for exactly the recordings physicians look at most.
  const [audioFormat, setAudioFormat] = useState(null);
  const [audioSource, setAudioSource] = useState(null); // 'mic' | 'upload' — mic audio auto-submits on stop
  // Voice-to-Form — null means the standard clinical note (the existing
  // default); otherwise one of Dragon Copilot's outputFormIds. Test values
  // only for now; the real form Microsoft is provisioning isn't ready yet.
  const [selectedFormId, setSelectedFormId] = useState(null);
  const VOICE_TO_FORM_OPTIONS = [
    { id: null, label: 'Standard Clinical Note' },
    { id: 'encounter_note_pi_mdm', label: 'Encounter Note (PI/MDM)' },
    { id: 'letter_to_patient', label: 'Letter to Patient' },
    { id: 'letter_to_pcp_gp', label: 'Letter to PCP/GP' },
    { id: 'referral_letter_to_clinician', label: 'Referral Letter' },
  ];

  // Patient list
  const [patients, setPatients] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [patientModalVisible, setPatientModalVisible] = useState(false);
  const [patientListSource, setPatientListSource] = useState('local'); // 'local' | 'epic' — drives the panel header
  const [loadingEpicPatients, setLoadingEpicPatients] = useState(false);

  // Epic patient chart (Conditions + IPS) — only available for patients
  // loaded from Epic (they carry a FHIR id; CSV-loaded patients don't).
  const [chartModalVisible, setChartModalVisible] = useState(false);
  const [loadingConditions, setLoadingConditions] = useState(false);
  const [conditions, setConditions] = useState([]);
  const [chartError, setChartError] = useState('');
  const [loadingIps, setLoadingIps] = useState(false);
  const [ips, setIps] = useState(null); // { generatedAt, sections }
  const [ipsError, setIpsError] = useState('');
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [clinicalNotes, setClinicalNotes] = useState([]);
  const [notesError, setNotesError] = useState('');
  const [expandedNoteId, setExpandedNoteId] = useState(null);
  const [noteTexts, setNoteTexts] = useState({}); // { [noteId]: { loading, text, error } }
  const [compilingForDragon, setCompilingForDragon] = useState(false);
  const [launchingDragonCopilot, setLaunchingDragonCopilot] = useState(false);

  // Dragon Copilot Summary — a left-side slide-in panel showing the
  // compiled IPS + Clinical Notes text (mirrors the Epic Chart Summary
  // panel's pattern, sliding in from the opposite edge).
  const [dragonSummaryVisible, setDragonSummaryVisible] = useState(false);
  const [dragonSummaryText, setDragonSummaryText] = useState('');
  const [dragonSummaryError, setDragonSummaryError] = useState('');
  const [dragonSummaryCopied, setDragonSummaryCopied] = useState(false);

  // Dragon Copilot submission
  const [submitting, setSubmitting] = useState(false);
  const [submitStep, setSubmitStep] = useState('');

  // Debug log
  const logData = useDebugLog();
  const [logModalVisible, setLogModalVisible] = useState(false);

  // Dragon Copilot — backend submission state (the recording is uploaded
  // straight to Doctor Robbie's own server, which calls Dragon Copilot on
  // the physician's behalf)
  const [dragonError, setDragonError] = useState('');
  const [dragonCorrelationId, setDragonCorrelationId] = useState(null);
  const [dragonDdeChecking, setDragonDdeChecking] = useState(false);
  const [dragonDdeResult, setDragonDdeResult] = useState(null);
  const [noteTab, setNoteTab] = useState('note');
  // Physician edits to the note's sections, keyed by section id — seeded
  // from the parsed note whenever the server actually delivers new content
  // (see the effect below keyed on noteResult?.storedAt), left alone
  // otherwise so in-progress edits survive re-renders and repeat polls of
  // the same underlying data.
  const [editedNoteSections, setEditedNoteSections] = useState({});
  // Off by default — Dragon Copilot's note template includes sections the
  // encounter didn't cover (blank content); most of the time those are
  // just noise, but a physician may want to see and fill them in directly
  // (e.g. after adding more detail via Dragon Copilot's own web app).
  const [showAllNoteSections, setShowAllNoteSections] = useState(false);

  // One encounter (correlationId) can have multiple recordings added to it
  // — each entry here is just a local log of what's been submitted so far,
  // for the recordings panel; Dragon Copilot re-processes the note/
  // transcript across all of them under the same correlationId.
  const [recordings, setRecordings] = useState([]);
  // Bumped on every submission (first or additional) to restart background
  // polling even if the previous recording's results were already ready.
  const [pollGeneration, setPollGeneration] = useState(0);
  // Captured right when a recording is submitted — anything already stored
  // from before this timestamp is a stale result from an earlier recording,
  // not the update this submission is waiting on.
  const [lastSubmittedAt, setLastSubmittedAt] = useState(null);

  // The note and transcript are delivered as separate, independent
  // notifications (see webhookReceiver.js) — track their readiness
  // separately rather than as one combined status.
  const artifacts = dragonDdeResult?.artifacts ?? null;
  const noteResult = findArtifact(artifacts, 'encounter_data');
  const transcriptResult = findArtifact(artifacts, 'transcript');
  const noteReady = !!noteResult;
  const transcriptReady = !!transcriptResult;
  // "Current" (drives the status badges/polling) is stricter than "ready"
  // (drives whether there's anything to show at all) — after an additional
  // recording, the tabs keep showing the previous note/transcript rather
  // than blanking, but the badge should go back to "Submitted" until the
  // actually-updated version lands.
  const noteIsCurrent = noteReady && (!lastSubmittedAt || new Date(noteResult.storedAt) >= lastSubmittedAt);
  const transcriptIsCurrent =
    transcriptReady && (!lastSubmittedAt || new Date(transcriptResult.storedAt) >= lastSubmittedAt);

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const timerRef = useRef(null);
  // Holds the Web Audio API nodes + live upload session for the web-only
  // true-streaming recording path (see startLiveCaptureWeb/stopLiveCaptureWeb
  // below) — null whenever not actively live-streaming.
  const liveCaptureRef = useRef(null);

  // Chart panel — slides in from the right rather than taking over the
  // whole screen, so the recording/patient context stays visible behind it.
  const chartPanelAnim = useRef(new Animated.Value(0)).current; // 0 = off-screen right, 1 = in view
  const [chartPanelRendered, setChartPanelRendered] = useState(false);

  useEffect(() => {
    if (chartModalVisible) {
      setChartPanelRendered(true);
      Animated.timing(chartPanelAnim, { toValue: 1, duration: 260, useNativeDriver: true }).start();
    } else if (chartPanelRendered) {
      Animated.timing(chartPanelAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
        setChartPanelRendered(false);
      });
    }
  }, [chartModalVisible]);

  // Patient list panel — same right-side slide-in treatment as the chart panel.
  const patientPanelAnim = useRef(new Animated.Value(0)).current;
  const [patientPanelRendered, setPatientPanelRendered] = useState(false);

  useEffect(() => {
    if (patientModalVisible) {
      setPatientPanelRendered(true);
      Animated.timing(patientPanelAnim, { toValue: 1, duration: 260, useNativeDriver: true }).start();
    } else if (patientPanelRendered) {
      Animated.timing(patientPanelAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
        setPatientPanelRendered(false);
      });
    }
  }, [patientModalVisible]);

  // Dragon Copilot Summary panel — slides in from the left (the opposite
  // edge from the Epic panels), so toValue 1 maps to translateX 0 the same
  // way, but the JSX below interpolates outputRange from the negative side.
  const dragonSummaryPanelAnim = useRef(new Animated.Value(0)).current;
  const [dragonSummaryPanelRendered, setDragonSummaryPanelRendered] = useState(false);

  useEffect(() => {
    if (dragonSummaryVisible) {
      setDragonSummaryPanelRendered(true);
      Animated.timing(dragonSummaryPanelAnim, { toValue: 1, duration: 260, useNativeDriver: true }).start();
    } else if (dragonSummaryPanelRendered) {
      Animated.timing(dragonSummaryPanelAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
        setDragonSummaryPanelRendered(false);
      });
    }
  }, [dragonSummaryVisible]);

  useEffect(() => {
    (async () => {
      const { granted } = await Audio.requestPermissionsAsync();
      setPermissionGranted(granted);
    })();
  }, []);

  // Watches for Dragon Copilot's results in the background, updating
  // dragonDdeResult as soon as either the note or the transcript lands —
  // whichever arrives first is shown right away, independent of the other.
  // Stops once both have arrived for this round, or after about 15 minutes
  // (observed average delivery time is ~6 minutes, so this leaves margin
  // rather than cutting off right around when results typically land).
  // pollGeneration restarts this on every submission (including additional
  // recordings added to an already-ready encounter), since Dragon
  // Copilot re-processes the note/transcript each time.
  useEffect(() => {
    if (screen !== 'dragonNote' || !dragonCorrelationId) return;
    let stopped = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 180; // ~15 minutes at 5s intervals
    const intervalId = setInterval(async () => {
      if (stopped) return;
      attempts += 1;
      try {
        const result = await DdeClient.fetchResult(dragonCorrelationId);
        if (!stopped && result) {
          setDragonDdeResult(result);
          const note = findArtifact(result.artifacts, 'encounter_data');
          const transcript = findArtifact(result.artifacts, 'transcript');
          const noteCurrent = note && (!lastSubmittedAt || new Date(note.storedAt) >= lastSubmittedAt);
          const transcriptCurrent =
            transcript && (!lastSubmittedAt || new Date(transcript.storedAt) >= lastSubmittedAt);
          if (noteCurrent && transcriptCurrent) {
            stopped = true;
            clearInterval(intervalId);
          }
        }
      } catch {
        // Transient errors are fine to ignore on a background poll.
      }
      if (attempts >= MAX_ATTEMPTS) {
        stopped = true;
        clearInterval(intervalId);
      }
    }, 5000);
    return () => {
      stopped = true;
      clearInterval(intervalId);
    };
  }, [screen, dragonCorrelationId, pollGeneration, lastSubmittedAt]);

  // If the transcript shows up before the note, switch to it automatically
  // so the physician sees it right away instead of a "still processing"
  // placeholder on the default Note tab. Only fires on that transition —
  // it won't fight a physician who's deliberately switched tabs since.
  useEffect(() => {
    if (transcriptReady && !noteReady && noteTab === 'note') {
      setNoteTab('transcript');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcriptReady, noteReady]);

  // Re-seeds edited section text only when the server actually delivers
  // new note content (storedAt only changes on a real webhook delivery,
  // not on every poll tick that finds nothing new) — so typing in a
  // section survives repeat polls without being clobbered.
  useEffect(() => {
    const parsed = noteResult ? parseDragonNote(noteResult) : null;
    if (!parsed) return;
    const seeded = {};
    parsed.sections.forEach((section) => { seeded[section.id] = section.content; });
    setEditedNoteSections(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteResult?.storedAt]);

  useEffect(() => {
    if (isRecording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.15, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
        ])
      ).start();
      timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
    } else {
      pulseAnim.setValue(1);
      pulseAnim.stopAnimation();
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [isRecording]);

  // ---- Recording ----

  // True live streaming (web only, 2026-09-24) — captures raw microphone
  // audio via the Web Audio API and pushes it to dde-webhook as it's
  // spoken, instead of recording a complete file and uploading it
  // afterward. See dragonCopilotBackend.js's startLiveRecordingStream for
  // why: a real-time streaming protocol fed an entire recording in one
  // instantaneous burst (what the old expo-av + submitRecording path does,
  // even though it goes out over that same real-time transport) is the
  // leading theory for why Dragon Copilot never responds. ScriptProcessorNode
  // is deprecated in favor of AudioWorkletNode, but needs no separate module
  // file to load and works fine in Chrome, which is all this needs today.
  //
  // The processor must be connected to a destination to keep firing
  // onaudioprocess in some browsers — routed through a silent (gain 0) node
  // so the physician's own voice doesn't play back out loud while recording.
  async function startLiveCaptureWeb() {
    // Started BEFORE requesting the microphone, deliberately -- this may
    // need to open a Microsoft sign-in popup internally (MsftAuth.
    // getAccessToken(), if the cached token has expired), and that only
    // reliably works while still inside the original click's user-gesture
    // window. Awaiting getUserMedia() first (a separate, real async gap)
    // can cause browsers to silently block a popup opened afterward, which
    // hung indefinitely (2026-09-24 live test: no request ever reached the
    // Network tab, meaning fetch() itself never got called -- getAccessToken
    // never resolved). startLiveRecordingStream() is async now (2026-09-24
    // Option B rewrite: it makes a real streamStart network call before
    // it's safe to send audio, rather than just opening a stream
    // controller), so it's awaited here before wiring up the microphone.
    const liveSession = await DragonCopilotBackend.startLiveRecordingStream(
      selectedPatient,
      recordings.length + 1,
      selectedFormId ? [selectedFormId] : undefined
    );

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextClass({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0); // Float32, -1..1
      const pcmBytes = new DataView(new ArrayBuffer(input.length * 2));
      for (let i = 0; i < input.length; i++) {
        const sample = Math.max(-1, Math.min(1, input[i]));
        // Signed 16-bit little-endian, per Microsoft's documented format.
        pcmBytes.setInt16(i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
      }
      liveSession.pushChunk(new Uint8Array(pcmBytes.buffer));
    };

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    liveCaptureRef.current = { stream, audioContext, source, processor, silentGain, liveSession };
    return liveSession;
  }

  function stopLiveCaptureWeb() {
    const capture = liveCaptureRef.current;
    if (!capture) return null;
    capture.processor.disconnect();
    capture.source.disconnect();
    capture.silentGain.disconnect();
    capture.stream.getTracks().forEach((track) => track.stop());
    capture.audioContext.close();
    liveCaptureRef.current = null;
    return capture.liveSession;
  }

  async function startRecording() {
    try {
      if (Platform.OS === 'web') {
        await startLiveCaptureWeb();
        setIsRecording(true);
        setDuration(0);
        setAudioUri(null);
        setAudioFormat('audio/L16;rate=16000;channels=1');
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording: rec } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      setRecording(rec);
      setIsRecording(true);
      setDuration(0);
      setAudioUri(null);
      setAudioFormat(null);
    } catch (err) {
      console.error('Failed to start recording:', err);
    }
  }

  // Web's HIGH_QUALITY preset actually records audio/webm, not the m4a its
  // label suggests — iOS/Android genuinely do record m4a (AAC) with this
  // same preset, so that assumption is safe to keep for native.
  async function detectRecordedAudioFormat(uri) {
    if (Platform.OS !== 'web') return 'audio/m4a';
    try {
      const blob = await (await fetch(uri)).blob();
      return blob.type || 'audio/m4a';
    } catch {
      return 'audio/m4a';
    }
  }

  async function stopRecording() {
    try {
      if (Platform.OS === 'web' && liveCaptureRef.current) {
        const liveSession = stopLiveCaptureWeb();
        setAudioUri('live-stream'); // non-null sentinel — there's no file/URI to hold, audio already sent
        setAudioName('Live stream');
        setAudioSource('mic');
        setIsRecording(false);
        await finishLiveRecordingStream(liveSession);
        return;
      }
      await recording.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      const uri = recording.getURI();
      const name = 'Recording.m4a';
      setAudioUri(uri);
      setAudioName(name);
      setAudioFormat(await detectRecordedAudioFormat(uri));
      setAudioSource('mic');
      setRecording(null);
      setIsRecording(false);
      // Mic recordings send themselves the moment you stop — no separate
      // submit tap. Passing uri/name directly (rather than relying on the
      // audioUri/audioName state just set above) avoids using stale values
      // from before this render commits.
      await submitAudioToDragon(uri, name);
    } catch (err) {
      console.error('Failed to stop recording:', err);
    }
  }

  function formatDuration(seconds) {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  // ---- File upload ----

  async function pickAudioFile() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        copyToCacheDirectory: true,
      });
      if (!result.canceled && result.assets?.length > 0) {
        const file = result.assets[0];
        if (isRecording) await stopRecording();
        setAudioUri(file.uri);
        setAudioName(file.name);
        setAudioFormat(file.mimeType || null);
        setAudioSource('upload');
        setDuration(0);
      }
    } catch (err) {
      notify('Error', 'Could not pick file: ' + err.message);
    }
  }

  // ---- Patient list ----

  async function loadPatientList() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/plain', 'text/comma-separated-values'],
        copyToCacheDirectory: true,
      });
      if (!result.canceled && result.assets?.length > 0) {
        const file = result.assets[0];
        const response = await fetch(file.uri);
        const text = await response.text();
        const parsed = parseCSV(text);
        if (parsed.length === 0) {
          notify('Empty file', 'No patient records found in the CSV.');
          return;
        }
        setPatients(parsed);
        setPatientListSource('local');
        setPatientModalVisible(true);
      }
    } catch (err) {
      notify('Error', 'Could not load patient list: ' + err.message);
    }
  }

  // Signs into the Epic on FHIR sandbox (if not already signed in this
  // session) and loads its documented test patients.
  async function handleLoadEpicPatients() {
    const missing = EpicClient.missingConfigKeys();
    if (missing.length > 0) {
      notify('Epic isn’t configured', `Add these to your .env file: ${missing.join(', ')}`);
      return;
    }
    setLoadingEpicPatients(true);
    try {
      const epicPatients = await EpicClient.fetchSandboxPatients();
      setPatients(epicPatients);
      setPatientListSource('epic');
      setPatientModalVisible(true);
    } catch (err) {
      notify('Epic sign-in failed', String(err?.message ?? err));
    } finally {
      setLoadingEpicPatients(false);
    }
  }

  function selectPatient(patient) {
    setSelectedPatient(patient);
    setPatientModalVisible(false);
  }

  // Opens the chart modal and loads this Epic patient's Conditions
  // (Problems & Reason for Visit) and the list of their Clinical Notes.
  // The International Patient Summary, and each note's actual text, are
  // fetched separately, on demand — both are heavier than a plain list read.
  async function handleViewChart() {
    if (!selectedPatient?.id) return;
    setChartModalVisible(true);
    setLoadingConditions(true);
    setChartError('');
    setConditions([]);
    setIps(null);
    setIpsError('');
    setClinicalNotes([]);
    setNotesError('');
    setExpandedNoteId(null);
    setNoteTexts({});
    try {
      const result = await EpicClient.fetchConditions(selectedPatient.id);
      setConditions(result);
    } catch (err) {
      setChartError(String(err?.message ?? err));
    } finally {
      setLoadingConditions(false);
    }
    setLoadingNotes(true);
    try {
      const notes = await EpicClient.fetchClinicalNotes(selectedPatient.id);
      setClinicalNotes(notes);
    } catch (err) {
      setNotesError(String(err?.message ?? err));
    } finally {
      setLoadingNotes(false);
    }
  }

  async function handleFetchIPS() {
    if (!selectedPatient?.id) return;
    setLoadingIps(true);
    setIpsError('');
    try {
      const result = await EpicClient.fetchIPS(selectedPatient.id);
      setIps(result);
    } catch (err) {
      setIpsError(String(err?.message ?? err));
    } finally {
      setLoadingIps(false);
    }
  }

  // Expands/collapses a clinical note, fetching its text the first time
  // it's opened (and reusing it after that).
  async function handleToggleNote(note) {
    if (expandedNoteId === note.id) {
      setExpandedNoteId(null);
      return;
    }
    setExpandedNoteId(note.id);
    if (noteTexts[note.id]) return;
    setNoteTexts((prev) => ({ ...prev, [note.id]: { loading: true, text: null, error: '' } }));
    try {
      const text = await EpicClient.fetchClinicalNoteText(note);
      setNoteTexts((prev) => ({ ...prev, [note.id]: { loading: false, text, error: '' } }));
    } catch (err) {
      setNoteTexts((prev) => ({
        ...prev,
        [note.id]: { loading: false, text: null, error: String(err?.message ?? err) },
      }));
    }
  }

  async function handleCopyNoteText(note) {
    const entry = noteTexts[note.id];
    if (!entry?.text) return;
    await Clipboard.setStringAsync(htmlToPlainText(entry.text));
    notify('Copied', 'The note text was copied to your clipboard.');
  }

  // Pulls the International Patient Summary and every clinical note's text
  // into one clean, readable document and shows it in the Dragon Copilot
  // Summary panel — meant to be copied from there into Dragon Copilot Chat
  // (a separate app with no API for this, so a plain-text hand-off is the
  // only option). Fetches whatever hasn't been loaded yet (IPS, and any
  // note bodies the physician hasn't tapped into) rather than requiring
  // every section to already be open.
  async function handleCompileForDragon() {
    if (!selectedPatient?.id) return;
    setCompilingForDragon(true);
    setDragonSummaryError('');
    setDragonSummaryText('');
    setDragonSummaryCopied(false);
    setDragonSummaryVisible(true);
    try {
      let ipsData = ips;
      if (!ipsData) {
        try {
          ipsData = await EpicClient.fetchIPS(selectedPatient.id);
          setIps(ipsData);
        } catch (err) {
          ipsData = null;
        }
      }

      const updatedNoteTexts = { ...noteTexts };
      for (const note of clinicalNotes) {
        if (!updatedNoteTexts[note.id]?.text) {
          try {
            const text = await EpicClient.fetchClinicalNoteText(note);
            updatedNoteTexts[note.id] = { loading: false, text, error: '' };
          } catch (err) {
            updatedNoteTexts[note.id] = { loading: false, text: null, error: String(err?.message ?? err) };
          }
        }
      }
      setNoteTexts(updatedNoteTexts);

      const HEAVY_RULE = '='.repeat(44);
      const LIGHT_RULE = '-'.repeat(30);
      const patientLine = [patientDisplayName(selectedPatient), patientSubtitle(selectedPatient)]
        .filter(Boolean)
        .join('  ·  ');
      const parts = ['DRAGON COPILOT SUMMARY', '', patientLine, `Compiled ${new Date().toLocaleString()}`, ''];

      if (ipsData?.sections?.length) {
        parts.push(HEAVY_RULE, 'INTERNATIONAL PATIENT SUMMARY', HEAVY_RULE, '');
        for (const section of ipsData.sections) {
          parts.push(section.title.toUpperCase(), LIGHT_RULE, htmlToPlainText(section.html), '');
        }
      }

      if (clinicalNotes.length) {
        parts.push(HEAVY_RULE, 'CLINICAL NOTES', HEAVY_RULE, '');
        for (const note of clinicalNotes) {
          const entry = updatedNoteTexts[note.id];
          const heading = [note.title, note.author, note.date].filter(Boolean).join('  ·  ');
          parts.push(heading, LIGHT_RULE, entry?.text ? htmlToPlainText(entry.text) : '[content unavailable]', '');
        }
      }

      setDragonSummaryText(parts.join('\n').trim());
    } catch (err) {
      setDragonSummaryError(String(err?.message ?? err));
    } finally {
      setCompilingForDragon(false);
    }
  }

  async function handleCopyDragonSummary() {
    if (!dragonSummaryText) return;
    await Clipboard.setStringAsync(dragonSummaryText);
    setDragonSummaryCopied(true);
    setTimeout(() => setDragonSummaryCopied(false), 2000);
  }

  async function handleMsftSignIn() {
    setMsftSigningIn(true);
    setMsftSignInError('');
    try {
      await MsftAuth.getAccessToken();
      setMsftUser(MsftAuth.getSignedInUser());
    } catch (err) {
      setMsftSignInError(String(err?.message ?? err));
    } finally {
      setMsftSigningIn(false);
    }
  }

  // Opens Dragon Copilot's own web app in a new tab, seeded with this
  // encounter's correlationId and (if the patient came from Epic) their
  // FHIR patient context — Microsoft's Token Launch API. Requires a
  // correlationId (i.e. at least one recording already submitted), since
  // that's how Dragon Copilot ties the new tab back to this encounter.
  // An embedded-iframe version was tried and worked for basic display, but
  // Dragon Copilot's own app redirects to a full separate window anyway
  // once it detects no "native mic access" (a local desktop app + browser
  // extension Dragon Copilot itself requires for in-browser dictation, per
  // Microsoft's docs — unrelated to anything configurable from here), so a
  // real new-tab launch gives the same result with less complexity.
  async function handleLaunchDragonCopilot() {
    if (!dragonCorrelationId) return;
    setLaunchingDragonCopilot(true);
    try {
      await DragonCopilotBackend.launchDragonCopilot({
        correlationId: dragonCorrelationId,
        patient: selectedPatient,
        launchType: 'copilot',
      });
    } catch (err) {
      notify('Could not launch Dragon Copilot', String(err?.message ?? err));
    } finally {
      setLaunchingDragonCopilot(false);
    }
  }

  function handleDiscard() {
    setAudioUri(null);
    setAudioName(null);
    setAudioFormat(null);
    setAudioSource(null);
    setDuration(0);
  }

  // ---- Dragon Copilot submission ----

  // Shared by both the mic-recording flow (auto-submits the instant you
  // stop, via stopRecording) and the upload-file flow (manual submit
  // button below) — takes the audio uri/name explicitly rather than
  // reading them from state, since stopRecording calls this right after
  // setting that state, before the state update has actually committed.
  async function submitAudioToDragon(uri, name) {
    setDragonError('');
    setSubmitting(true);
    setSubmitStep('Sending to Dragon Copilot…');
    try {
      // Reuses dragonCorrelationId when adding another recording to the
      // current encounter (it's null for a brand-new one). Doesn't touch
      // dragonDdeResult/noteTab here — an additional recording should keep
      // showing the existing note/transcript while Dragon Copilot
      // re-processes them, not blank the screen back to "processing".
      const correlationId = await DragonCopilotBackend.submitRecording(
        uri,
        name,
        selectedPatient,
        dragonCorrelationId,
        recordings.length + 1,
        selectedFormId ? [selectedFormId] : undefined,
        duration
      );
      setDragonCorrelationId(correlationId);
      setRecordings((prev) => [
        { id: `${correlationId}-${prev.length + 1}`, number: prev.length + 1, submittedAt: new Date(), durationSeconds: duration },
        ...prev,
      ]);
      setLastSubmittedAt(new Date());
      setPollGeneration((g) => g + 1);
    } catch (err) {
      notify('Dragon Copilot submission failed', String(err?.message ?? err));
    } finally {
      setSubmitting(false);
      setSubmitStep('');
    }
  }

  // Completes a live-streamed recording (see startLiveCaptureWeb) — the
  // audio itself has already been sent as it was captured; this waits for
  // any still-in-flight chunk uploads, sends RecordingClose (via
  // liveSession.finish), and waits for dde-webhook to confirm Dragon
  // Copilot accepted the whole thing. Mirrors submitAudioToDragon's
  // completion handling above. `duration` (seconds) is the actual recorded
  // length, tracked by the recording timer -- the new streamFinish
  // endpoint needs this explicitly since there's no server-side wall-clock
  // timing across the three separate calls the way there was in a single
  // continuous stream.
  async function finishLiveRecordingStream(liveSession) {
    setDragonError('');
    setSubmitting(true);
    setSubmitStep('Sending to Dragon Copilot…');
    try {
      const correlationId = await liveSession.finish(duration);
      setDragonCorrelationId(correlationId);
      setRecordings((prev) => [
        { id: `${correlationId}-${prev.length + 1}`, number: prev.length + 1, submittedAt: new Date(), durationSeconds: duration },
        ...prev,
      ]);
      setLastSubmittedAt(new Date());
      setPollGeneration((g) => g + 1);
    } catch (err) {
      notify('Dragon Copilot submission failed', String(err?.message ?? err));
    } finally {
      setSubmitting(false);
      setSubmitStep('');
    }
  }

  // Upload-file flow only (the manual submit button below) — a separate,
  // older REST transport from submitAudioToDragon (which mic recordings use,
  // over the AAS WebSocket), kept as its own function so mic recordings are
  // untouched. Restored 2026-09-24 after live testing showed the WebSocket
  // path stalling for manually-uploaded files specifically, while this REST
  // path has a track record of working reliably end to end. Doesn't support
  // Voice-to-Form (outputFormIds) — that's WebSocket-only — so an uploaded
  // file always gets the standard clinical note regardless of the "Output"
  // picker's selection.
  async function submitUploadedFileToDragon(uri, name) {
    setDragonError('');
    setSubmitting(true);
    setSubmitStep('Sending to Dragon Copilot…');
    try {
      const correlationId = await DragonCopilotBackend.uploadRecordingFile(
        uri,
        name,
        selectedPatient,
        dragonCorrelationId,
        recordings.length + 1
      );
      setDragonCorrelationId(correlationId);
      setRecordings((prev) => [
        { id: `${correlationId}-${prev.length + 1}`, number: prev.length + 1, submittedAt: new Date(), durationSeconds: duration },
        ...prev,
      ]);
      setLastSubmittedAt(new Date());
      setPollGeneration((g) => g + 1);
    } catch (err) {
      notify('Dragon Copilot submission failed', String(err?.message ?? err));
    } finally {
      setSubmitting(false);
      setSubmitStep('');
    }
  }

  // Upload-file flow's manual submit button — mic recordings auto-submit
  // instead (see stopRecording) and go straight to a "View Note" button.
  async function handleDragonSubmitRecording() {
    await submitUploadedFileToDragon(audioUri, audioName);
    setScreen('dragonNote');
  }

  // Returns to the recording screen without losing the current encounter —
  // the correlation ID, and whatever note/transcript has already arrived,
  // stay intact so the physician can keep reviewing them afterward.
  function handleRecordAnother() {
    setAudioUri(null);
    setAudioName(null);
    setAudioFormat(null);
    setAudioSource(null);
    setDuration(0);
    setScreen('record');
  }

  // Checks Doctor Robbie's own Dragon Data Exchange server for the result
  // of this recording, once processing has finished on Microsoft's side.
  async function handleCheckDdeResult() {
    if (!dragonCorrelationId) {
      setDragonError('Nothing to check yet — send a recording first.');
      return;
    }
    setDragonError('');
    setDragonDdeChecking(true);
    try {
      const result = await DdeClient.fetchResult(dragonCorrelationId);
      if (!result) {
        setDragonError('Still processing — check again in a minute.');
        return;
      }
      setDragonDdeResult(result);
    } catch (err) {
      setDragonError(String(err?.message ?? err));
    } finally {
      setDragonDdeChecking(false);
    }
  }

  // ---- Patient display helpers ----

  function patientDisplayName(patient) {
    return patient['Patient Name'] ?? 'Unknown';
  }

  function patientSubtitle(patient) {
    const parts = [];
    if (patient['MRN']) parts.push(`MRN: ${patient['MRN']}`);
    if (patient['DOB']) parts.push(`DOB: ${patient['DOB']}`);
    return parts.join('  ·  ');
  }

  function patientVisitInfo(patient) {
    const parts = [];
    if (patient['Visit Date']) parts.push(patient['Visit Date']);
    if (patient['Visit Time']) parts.push(patient['Visit Time']);
    if (patient['Chief Complaint']) parts.push(patient['Chief Complaint']);
    return parts.join('  ·  ');
  }

  // =========================================================================
  // Debug Log modal — extracted so both the sign-in gate below and the
  // main app can show it. Signing in logs the exact redirect URI Microsoft
  // rejected (see msftAuth.js) here, so this needs to be reachable before
  // sign-in succeeds, not just after.
  function renderDebugLogModal() {
    return (
      <Modal
        visible={logModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setLogModalVisible(false)}
      >
        <SafeAreaView style={styles.modalSafeArea}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Debug Log</Text>
            <TouchableOpacity onPress={() => setLogModalVisible(false)}>
              <Text style={styles.modalClose}>Close</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.logScroll} contentContainerStyle={styles.logContent}>
            {logData.length === 0 && (
              <Text style={styles.logEmpty}>No log entries yet.</Text>
            )}
            {[...logData].reverse().map(entry => (
              <View key={entry.id} style={styles.logEntry}>
                <Text style={styles.logMeta}>
                  {entry.time}  <Text style={entry.level === 'error' ? styles.logLevelError : entry.level === 'warn' ? styles.logLevelWarn : styles.logLevelLog}>{entry.level}</Text>
                </Text>
                <Text style={styles.logMessage} selectable>{entry.message}</Text>
              </View>
            ))}
          </ScrollView>
          <View style={styles.modalFooter}>
            <TouchableOpacity style={styles.reloadButton} onPress={() => { logEntries.length = 0; logListeners.forEach(fn => fn([])); }}>
              <Text style={styles.reloadButtonText}>Clear Log</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>
    );
  }

  // Sign-in gate — Doctor Robbie's own login. Checked before any
  // screen-specific rendering below, so nothing else in the app is
  // reachable until a physician signs in with Microsoft. The resulting
  // token is reused later for the "Launch Dragon Copilot" button — see
  // msftAuth.js for why an interactive, delegated sign-in is required
  // there instead of an app-only server-minted token.
  // =========================================================================
  if (!msftUser) {
    const missingMsftKeys = MsftAuth.missingConfigKeys();
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="auto" />
        <View style={styles.signInContainer}>
          <Text style={styles.title}>Doctor Robbie</Text>
          <Text style={styles.subtitle}>Sign in to continue</Text>
          {missingMsftKeys.length > 0 ? (
            <View style={styles.dragonWarningBox}>
              <Text style={styles.dragonWarningTitle}>Missing configuration</Text>
              <Text style={styles.dragonWarningText}>Add these to your .env file:</Text>
              {missingMsftKeys.map((key) => (
                <Text key={key} style={styles.dragonWarningItem}>• {key}</Text>
              ))}
            </View>
          ) : (
            <>
              <TouchableOpacity
                style={[styles.primaryButton, styles.signInButton, msftSigningIn && styles.buttonDisabled]}
                onPress={handleMsftSignIn}
                disabled={msftSigningIn}
              >
                {msftSigningIn ? (
                  <View style={styles.loadingRow}>
                    <ActivityIndicator color="#fff" size="small" />
                    <Text style={[styles.primaryButtonText, { marginLeft: 10 }]}>Signing in…</Text>
                  </View>
                ) : (
                  <Text style={styles.primaryButtonText}>Sign in with Microsoft</Text>
                )}
              </TouchableOpacity>
              {!!msftSignInError && <Text style={styles.dragonErrorText}>{msftSignInError}</Text>}
            </>
          )}
          <TouchableOpacity style={styles.debugLink} onPress={() => setLogModalVisible(true)}>
            <Text style={styles.debugLinkText}>View Log</Text>
          </TouchableOpacity>
        </View>
        {renderDebugLogModal()}
      </SafeAreaView>
    );
  }

  // =========================================================================
  // Dragon Copilot screen — shown right after a recording is sent. Shows a
  // "processing" state with a manual check, then the note once Dragon Data
  // Exchange (our own webhook server) delivers it.
  // =========================================================================
  if (screen === 'dragonNote') {
    const missingKeys = DragonCopilotBackend.missingConfigKeys();
    const parsedNote = noteResult ? parseDragonNote(noteResult) : null;
    const parsedTranscript = transcriptResult ? parseDragonTranscript(transcriptResult) : null;

    function renderNoteTab() {
      if (parsedNote) {
        // Dragon Copilot's note template includes sections the encounter
        // didn't cover at all (blank content) — hidden by default since
        // most of the time they're just noise, but a physician can reveal
        // them to fill in manually or after adding detail via Dragon
        // Copilot's own web app.
        const visibleSections = showAllNoteSections
          ? parsedNote.sections
          : parsedNote.sections.filter((s) => s.content.length > 0);
        return (
          <>
            <Text style={styles.noteTitle}>{parsedNote.title}</Text>
            {parsedNote.sections.length > 0 && (
              <TouchableOpacity
                style={styles.noteSectionsToggleRow}
                onPress={() => setShowAllNoteSections((v) => !v)}
                activeOpacity={0.7}
              >
                <View style={[styles.checkbox, showAllNoteSections && styles.checkboxChecked]}>
                  {showAllNoteSections && <Ionicons name="checkmark" size={12} color={C.white} />}
                </View>
                <Text style={styles.noteSectionsToggleText}>Display additional note sections</Text>
              </TouchableOpacity>
            )}
            {visibleSections.length === 0 ? (
              <Text style={styles.dragonBodyText}>
                Dragon Copilot didn't find anything to include in this note — this is expected for very short or silent recordings.
              </Text>
            ) : (
              visibleSections.map((section) => (
                <View key={section.id} style={styles.noteSection}>
                  <Text style={styles.noteSectionTitle}>{section.title}</Text>
                  <TextInput
                    multiline
                    scrollEnabled={false}
                    textAlignVertical="top"
                    value={editedNoteSections[section.id] ?? section.content}
                    onChangeText={(text) =>
                      setEditedNoteSections((prev) => ({ ...prev, [section.id]: text }))
                    }
                    style={styles.noteSectionInput}
                  />
                </View>
              ))
            )}
          </>
        );
      }
      if (noteResult) {
        return <Text style={styles.summaryText} selectable>{JSON.stringify(noteResult, null, 2)}</Text>;
      }
      return <Text style={styles.dragonBodyText}>The note hasn't been delivered yet.</Text>;
    }

    function renderTranscriptTab() {
      if (parsedTranscript) {
        if (parsedTranscript.turns.length === 0) {
          return (
            <Text style={styles.dragonBodyText}>
              Dragon Copilot didn't capture any speech in this recording — this is expected for very short or silent recordings.
            </Text>
          );
        }
        return parsedTranscript.turns.map((turn) => (
          <View key={turn.id} style={styles.noteSection}>
            <Text style={styles.noteSectionTitle}>{turn.speaker}</Text>
            <Text style={styles.noteSectionContent} selectable>{turn.text}</Text>
          </View>
        ));
      }
      if (transcriptResult) {
        return <Text style={styles.summaryText} selectable>{JSON.stringify(transcriptResult, null, 2)}</Text>;
      }
      return <Text style={styles.dragonBodyText}>The transcript hasn't been delivered yet.</Text>;
    }

    function renderStatusBadge(label, ready) {
      return (
        <View key={label} style={styles.statusItem}>
          <Text style={styles.statusLabel}>{label}</Text>
          <View style={[styles.noteStatusBadge, ready ? styles.noteStatusBadgeReady : styles.noteStatusBadgeSubmitted]}>
            <Text style={[styles.noteStatusBadgeText, ready ? styles.noteStatusBadgeTextReady : styles.noteStatusBadgeTextSubmitted]}>
              {ready ? 'Ready' : 'Submitted'}
            </Text>
          </View>
        </View>
      );
    }

    function renderRecordingsPanel() {
      return (
        <View style={styles.recordingsPanel}>
          <Text style={styles.recordingsPanelTitle}>Recordings</Text>
          <ScrollView style={styles.recordingsList}>
            {recordings.map((r) => (
              <View key={r.id} style={styles.recordingItem}>
                <Text style={styles.recordingItemTitle}>Recording {r.number}</Text>
                <Text style={styles.recordingItemMeta}>
                  {formatClockTime(r.submittedAt)}
                  {r.durationSeconds > 0 ? ` · ${formatDuration(r.durationSeconds)}` : ''}
                </Text>
              </View>
            ))}
          </ScrollView>
          <TouchableOpacity style={styles.recordAnotherButton} onPress={handleRecordAnother}>
            <Ionicons name="mic" size={14} color={C.white} />
            <Text style={styles.recordAnotherButtonText}>Record Another</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="auto" />
        <View style={styles.tsHeader}>
          <TouchableOpacity onPress={() => setScreen('record')} style={styles.backButton}>
            <Text style={styles.backButtonText}>‹ Recording</Text>
          </TouchableOpacity>
          <Text style={styles.tsTitle}>Dragon Copilot</Text>
          <View style={{ width: 80 }} />
        </View>

        {/* Opens Dragon Copilot's own web app in a new tab via Token
            Launch, seeded with this encounter's correlationId and Epic
            patient context. Only meaningful in the web build — there's no
            new-tab/form-submission concept on native. */}
        {Platform.OS === 'web' && dragonCorrelationId && (
          <View style={styles.dragonLaunchRow}>
            <TouchableOpacity
              style={[styles.launchDragonButton, launchingDragonCopilot && styles.buttonDisabled]}
              onPress={handleLaunchDragonCopilot}
              disabled={launchingDragonCopilot}
            >
              {launchingDragonCopilot ? (
                <ActivityIndicator color={C.blue} size="small" />
              ) : (
                <Ionicons name="open-outline" size={16} color={C.blue} />
              )}
              <Text style={styles.launchDragonButtonText}>
                {launchingDragonCopilot ? 'Launching…' : 'Launch Dragon Copilot'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {missingKeys.length > 0 ? (
          <ScrollView contentContainerStyle={styles.dragonBody}>
            <View style={styles.dragonWarningBox}>
              <Text style={styles.dragonWarningTitle}>Missing configuration</Text>
              <Text style={styles.dragonWarningText}>Add these to your .env file:</Text>
              {missingKeys.map((key) => (
                <Text key={key} style={styles.dragonWarningItem}>• {key}</Text>
              ))}
            </View>
          </ScrollView>
        ) : (
          <View style={styles.dragonNoteBody}>
            {renderRecordingsPanel()}

            <View style={styles.dragonMainPane}>
              <View style={styles.statusRow}>
                {renderStatusBadge('Note', noteIsCurrent)}
                {renderStatusBadge('Transcript', transcriptIsCurrent)}
              </View>
              {/* Always available, even once both are "current" — lets a
                  physician pull in edits made directly in Dragon Copilot's
                  own web app (see "Launch Dragon Copilot") without needing
                  to add another recording just to re-trigger polling. */}
              {artifacts && (
                <View style={styles.checkNowRow}>
                  <TouchableOpacity onPress={handleCheckDdeResult} disabled={dragonDdeChecking}>
                    <Text style={styles.debugLinkText}>
                      {dragonDdeChecking ? 'Checking…' : 'Check for updates from Dragon Copilot'}
                    </Text>
                  </TouchableOpacity>
                  {!!dragonError && <Text style={styles.dragonErrorText}>{dragonError}</Text>}
                </View>
              )}

              {artifacts ? (
                <>
                  <View style={styles.noteTabRow}>
                    <TouchableOpacity
                      style={[styles.noteTabButton, noteTab === 'note' && styles.noteTabButtonActive]}
                      onPress={() => setNoteTab('note')}
                    >
                      <Text style={[styles.noteTabButtonText, noteTab === 'note' && styles.noteTabButtonTextActive]}>
                        Note
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.noteTabButton, noteTab === 'transcript' && styles.noteTabButtonActive]}
                      onPress={() => setNoteTab('transcript')}
                    >
                      <Text style={[styles.noteTabButtonText, noteTab === 'transcript' && styles.noteTabButtonTextActive]}>
                        Transcript
                      </Text>
                    </TouchableOpacity>
                  </View>
                  <ScrollView contentContainerStyle={styles.summaryBody}>
                    {noteTab === 'note' ? renderNoteTab() : renderTranscriptTab()}
                  </ScrollView>
                  <View style={styles.tsFooter}>
                    <TouchableOpacity
                      style={styles.primaryButton}
                      onPress={() => {
                        setScreen('record');
                        setAudioUri(null);
                        setAudioName(null);
                        setAudioFormat(null);
                        setDragonCorrelationId(null);
                        setDragonDdeResult(null);
                        setRecordings([]);
                        setPollGeneration(0);
                        setNoteTab('note');
                        setEditedNoteSections({});
                        setShowAllNoteSections(false);
                        setSelectedFormId(null);
                        setDuration(0);
                      }}
                    >
                      <Text style={styles.primaryButtonText}>New Encounter</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <ScrollView contentContainerStyle={styles.dragonBody}>
                  <View style={styles.dragonCenterBlock}>
                    <Text style={styles.dragonBodyText}>
                      Dragon Copilot is processing this recording in the background. This typically
                      takes approximately 5 minutes — the status above updates automatically, or check manually below.
                    </Text>
                    <TouchableOpacity
                      style={[styles.primaryButton, dragonDdeChecking && styles.buttonDisabled]}
                      onPress={handleCheckDdeResult}
                      disabled={dragonDdeChecking}
                    >
                      {dragonDdeChecking ? (
                        <View style={styles.loadingRow}>
                          <ActivityIndicator color="#fff" size="small" />
                          <Text style={[styles.primaryButtonText, { marginLeft: 10 }]}>Checking…</Text>
                        </View>
                      ) : (
                        <Text style={styles.primaryButtonText}>Check for Results</Text>
                      )}
                    </TouchableOpacity>
                    {!!dragonError && <Text style={styles.dragonErrorText}>{dragonError}</Text>}
                  </View>
                </ScrollView>
              )}
            </View>
          </View>
        )}
        {renderDebugLogModal()}
      </SafeAreaView>
    );
  }

  // =========================================================================
  // Record screen (default)
  // =========================================================================
  if (!permissionGranted) {
    return (
      <View style={styles.container}>
        <Text style={styles.permissionText}>
          Microphone permission is required to record patient conversations.
        </Text>
        <StatusBar style="auto" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="auto" />

      <View style={styles.container}>
        {/* Header */}
        {dragonCorrelationId && (
          <TouchableOpacity
            style={styles.viewResultsButton}
            onPress={() => setScreen('dragonNote')}
            activeOpacity={0.85}
          >
            <Text style={styles.viewResultsButtonText}>‹ View Dragon Copilot Results</Text>
          </TouchableOpacity>
        )}
        <Text style={styles.title}>Doctor Robbie</Text>
        <Text style={styles.subtitle}>
          {dragonCorrelationId ? 'Recording #' + (recordings.length + 1) + ' for this encounter' : 'Patient Encounter Recording'}
        </Text>
        <TouchableOpacity style={styles.debugLink} onPress={() => setLogModalVisible(true)}>
          <Text style={styles.debugLinkText}>View Log</Text>
        </TouchableOpacity>

        {/* Patient banner */}
        {selectedPatient ? (
          <TouchableOpacity style={styles.patientBanner} onPress={() => setPatientModalVisible(true)}>
            <View style={styles.patientBannerInner}>
              <Text style={styles.patientBannerLabel}>Patient</Text>
              <Text style={styles.patientBannerName}>{patientDisplayName(selectedPatient)}</Text>
              {patientSubtitle(selectedPatient) ? (
                <Text style={styles.patientBannerSub}>{patientSubtitle(selectedPatient)}</Text>
              ) : null}
            </View>
            <Text style={styles.patientBannerChange}>Change</Text>
          </TouchableOpacity>
        ) : null}

        {selectedPatient?.id ? (
          <TouchableOpacity style={styles.epicChartButton} onPress={handleViewChart} activeOpacity={0.85}>
            <Text style={styles.epicChartButtonText}>Epic Chart Summary</Text>
          </TouchableOpacity>
        ) : null}

        {!selectedPatient && (
          <View style={styles.patientSourceRow}>
            <TouchableOpacity style={styles.localPatientListButton} onPress={loadPatientList}>
              <Text style={styles.localPatientListButtonText}>Local Patient List</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.epicPatientListButton, loadingEpicPatients && styles.buttonDisabled]}
              onPress={handleLoadEpicPatients}
              disabled={loadingEpicPatients}
              activeOpacity={0.85}
            >
              {loadingEpicPatients ? (
                <ActivityIndicator color={C.white} size="small" />
              ) : (
                <Text style={styles.epicPatientListButtonText}>Epic Patient List</Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        <>
            {/* Voice-to-Form — pick what Dragon Copilot should produce from
                this recording, before starting it. Test outputFormIds only,
                until Microsoft finishes provisioning the real custom form. */}
            {!isRecording && !audioUri && (
              <View style={styles.formPickerBlock}>
                <Text style={styles.formPickerLabel}>Output</Text>
                <View style={styles.formPickerRow}>
                  {VOICE_TO_FORM_OPTIONS.map((opt) => (
                    <TouchableOpacity
                      key={opt.label}
                      style={[styles.formChip, selectedFormId === opt.id && styles.formChipActive]}
                      onPress={() => setSelectedFormId(opt.id)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.formChipText, selectedFormId === opt.id && styles.formChipTextActive]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {/* Recording area */}
            <View style={styles.recordingArea}>
              {isRecording && (
                <View style={styles.recordingIndicator}>
                  <View style={styles.recordingDot} />
                  <Text style={styles.recordingLabel}>Recording</Text>
                </View>
              )}

              <Text style={styles.timer}>{formatDuration(duration)}</Text>

              <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                <TouchableOpacity
                  style={[styles.recordButton, isRecording && styles.recordButtonActive]}
                  onPress={isRecording ? stopRecording : startRecording}
                  activeOpacity={0.8}
                >
                  <Ionicons
                    name={isRecording ? 'stop' : 'mic'}
                    size={40}
                    color="#FFFFFF"
                  />
                </TouchableOpacity>
              </Animated.View>

              <Text style={styles.recordHint}>
                {isRecording ? 'Tap to stop' : audioUri ? 'Tap to re-record' : 'Tap to begin recording'}
              </Text>
            </View>

            {/* Upload divider */}
            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.dividerLine} />
            </View>

            <TouchableOpacity style={styles.uploadButton} onPress={pickAudioFile}>
              <Text style={styles.uploadButtonText}>Upload Audio File</Text>
            </TouchableOpacity>

            {/* Actions after audio is ready. Mic recordings auto-submit the
                instant recording stops, so there's nothing left to send —
                just a progress indicator, then a way to view the note.
                Uploaded files still need an explicit Send/Discard, since
                they aren't submitted automatically. */}
            {audioUri && !isRecording && audioSource === 'mic' && (
              <View style={styles.actions}>
                <Text style={styles.readyText}>
                  {audioName ?? 'Recording'}{duration > 0 ? ` (${formatDuration(duration)})` : ''}
                </Text>
                {audioFormat && <Text style={styles.formatText}>Format: {audioFormat}</Text>}
                {submitting ? (
                  <View style={[styles.primaryButton, styles.buttonDisabled]}>
                    <View style={styles.loadingRow}>
                      <ActivityIndicator color="#fff" size="small" />
                      <Text style={[styles.primaryButtonText, { marginLeft: 10 }]}>
                        {submitStep || 'Working…'}
                      </Text>
                    </View>
                  </View>
                ) : (
                  <TouchableOpacity style={styles.primaryButton} onPress={() => setScreen('dragonNote')}>
                    <Text style={styles.primaryButtonText}>View Note</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
            {audioUri && !isRecording && audioSource === 'upload' && (
              <View style={styles.actions}>
                <Text style={styles.readyText}>
                  {audioName ?? 'Recording'}{duration > 0 ? ` (${formatDuration(duration)})` : ''}
                </Text>
                {audioFormat && <Text style={styles.formatText}>Format: {audioFormat}</Text>}
                <TouchableOpacity
                  style={[styles.primaryButton, submitting && styles.buttonDisabled]}
                  onPress={handleDragonSubmitRecording}
                  disabled={submitting}
                >
                  {submitting ? (
                    <View style={styles.loadingRow}>
                      <ActivityIndicator color="#fff" size="small" />
                      <Text style={[styles.primaryButtonText, { marginLeft: 10 }]}>
                        {submitStep || 'Working…'}
                      </Text>
                    </View>
                  ) : (
                    <Text style={styles.primaryButtonText}>
                      {dragonCorrelationId ? 'Add to Encounter' : 'Send to Dragon Copilot'}
                    </Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity style={styles.secondaryButton} onPress={handleDiscard} disabled={submitting}>
                  <Text style={styles.secondaryButtonText}>Discard</Text>
                </TouchableOpacity>
              </View>
            )}
          </>
      </View>

      {renderDebugLogModal()}

      {/* Patient list panel — same right-side slide-in treatment as the
          Epic Chart Summary panel, with a header that reflects whichever
          source (Epic or a local CSV) the list came from. */}
      <Modal
        visible={patientPanelRendered}
        transparent
        animationType="none"
        onRequestClose={() => setPatientModalVisible(false)}
      >
        <View style={styles.chartOverlay}>
          <TouchableOpacity
            style={styles.chartBackdrop}
            activeOpacity={1}
            onPress={() => setPatientModalVisible(false)}
          />
          <Animated.View
            style={[
              styles.chartPanel,
              {
                width: panelWidth,
                transform: [
                  {
                    translateX: patientPanelAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [panelWidth, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <SafeAreaView style={styles.chartPanelSafeArea}>
              <View style={styles.chartPanelHeader}>
                <View style={styles.chartPanelHeaderLeft}>
                  {patientListSource === 'epic' ? (
                    <View style={styles.chartPanelHeaderBadge}>
                      <Text style={styles.chartPanelHeaderBadgeText}>Epic</Text>
                    </View>
                  ) : (
                    <View style={styles.localPanelHeaderBadge}>
                      <Text style={styles.localPanelHeaderBadgeText}>Local</Text>
                    </View>
                  )}
                  <Text style={styles.chartPanelTitle}>Patient List</Text>
                </View>
                <TouchableOpacity onPress={() => setPatientModalVisible(false)}>
                  <Text style={styles.modalClose}>Done</Text>
                </TouchableOpacity>
              </View>

              <FlatList
                data={patients}
                keyExtractor={(_, i) => String(i)}
                contentContainerStyle={styles.patientList}
                ItemSeparatorComponent={() => <View style={styles.listSeparator} />}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={[styles.patientRow, selectedPatient === item && styles.patientRowSelected]}
                    onPress={() => selectPatient(item)}
                  >
                    <Text style={styles.patientRowName}>{patientDisplayName(item)}</Text>
                    {patientSubtitle(item) ? (
                      <Text style={styles.patientRowDetail}>{patientSubtitle(item)}</Text>
                    ) : null}
                    {patientVisitInfo(item) ? (
                      <Text style={styles.patientRowVisit}>{patientVisitInfo(item)}</Text>
                    ) : null}
                  </TouchableOpacity>
                )}
              />

              {patientListSource === 'local' ? (
                <View style={styles.modalFooter}>
                  <TouchableOpacity style={styles.reloadButton} onPress={loadPatientList}>
                    <Text style={styles.reloadButtonText}>Load Different File</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </SafeAreaView>
          </Animated.View>
        </View>
      </Modal>

      {/* Epic Chart Summary — a right-side panel (like an EHR chart review
          pane) rather than a full-screen takeover, so the recording screen
          stays visible behind it. */}
      <Modal
        visible={chartPanelRendered}
        transparent
        animationType="none"
        onRequestClose={() => setChartModalVisible(false)}
      >
        <View style={styles.chartOverlay}>
          <TouchableOpacity
            style={styles.chartBackdrop}
            activeOpacity={1}
            onPress={() => setChartModalVisible(false)}
          />
          <Animated.View
            style={[
              styles.chartPanel,
              {
                width: panelWidth,
                transform: [
                  {
                    translateX: chartPanelAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [panelWidth, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <SafeAreaView style={styles.chartPanelSafeArea}>
              <View style={styles.chartPanelHeader}>
                <View style={styles.chartPanelHeaderLeft}>
                  <View style={styles.chartPanelHeaderBadge}>
                    <Text style={styles.chartPanelHeaderBadgeText}>Epic</Text>
                  </View>
                  <Text style={styles.chartPanelTitle}>Chart Summary</Text>
                </View>
                <TouchableOpacity onPress={() => setChartModalVisible(false)}>
                  <Text style={styles.modalClose}>Done</Text>
                </TouchableOpacity>
              </View>

              <ScrollView contentContainerStyle={styles.chartScrollContent}>
            <TouchableOpacity
              style={[styles.primaryButton, styles.compileButton, compilingForDragon && styles.buttonDisabled]}
              onPress={handleCompileForDragon}
              disabled={compilingForDragon}
            >
              {compilingForDragon ? (
                <ActivityIndicator color={C.white} size="small" />
              ) : (
                <Text style={styles.primaryButtonText}>Compile for Dragon Copilot</Text>
              )}
            </TouchableOpacity>

            <Text style={styles.chartSectionTitle}>Problems & Reason for Visit</Text>
            {loadingConditions ? (
              <ActivityIndicator color={C.blue} style={styles.chartSpinner} />
            ) : chartError ? (
              <Text style={styles.chartErrorText}>{chartError}</Text>
            ) : conditions.length === 0 ? (
              <Text style={styles.chartEmptyText}>No conditions found for this patient.</Text>
            ) : (
              conditions.map((c) => (
                <View key={c.id} style={styles.conditionRow}>
                  <Text style={styles.conditionText}>{c.text}</Text>
                  {(c.category || c.status) ? (
                    <Text style={styles.conditionMeta}>
                      {[c.category, c.status].filter(Boolean).join('  ·  ')}
                    </Text>
                  ) : null}
                </View>
              ))
            )}

            <View style={styles.chartDivider} />

            <Text style={styles.chartSectionTitle}>International Patient Summary</Text>
            {!ips && !loadingIps ? (
              <TouchableOpacity style={styles.loadPatientButton} onPress={handleFetchIPS}>
                <Text style={styles.loadPatientButtonText}>Get International Patient Summary</Text>
              </TouchableOpacity>
            ) : null}
            {loadingIps ? <ActivityIndicator color={C.blue} style={styles.chartSpinner} /> : null}
            {ipsError ? <Text style={styles.chartErrorText}>{ipsError}</Text> : null}
            {ips ? (
              <>
                {ips.generatedAt ? (
                  <Text style={styles.chartEmptyText}>Generated {ips.generatedAt}</Text>
                ) : null}
                {ips.sections.map((section) => (
                  <View key={section.id} style={styles.ipsSection}>
                    <Text style={styles.ipsSectionTitle}>{section.title}</Text>
                    <View style={styles.noteHtmlBox}>
                      <RenderHtml
                        contentWidth={panelWidth - 64}
                        source={{ html: section.html }}
                        baseStyle={styles.noteHtmlBase}
                      />
                    </View>
                  </View>
                ))}
              </>
            ) : null}

            <View style={styles.chartDivider} />

            <Text style={styles.chartSectionTitle}>Clinical Notes</Text>
            {loadingNotes ? (
              <ActivityIndicator color={C.blue} style={styles.chartSpinner} />
            ) : notesError ? (
              <Text style={styles.chartErrorText}>{notesError}</Text>
            ) : clinicalNotes.length === 0 ? (
              <Text style={styles.chartEmptyText}>No clinical notes found for this patient.</Text>
            ) : (
              clinicalNotes.map((note) => {
                const expanded = expandedNoteId === note.id;
                const entry = noteTexts[note.id];
                return (
                  <View key={note.id} style={styles.conditionRow}>
                    <TouchableOpacity onPress={() => handleToggleNote(note)}>
                      <Text style={styles.conditionText}>{note.title}</Text>
                      {(note.author || note.date) ? (
                        <Text style={styles.conditionMeta}>
                          {[note.author, note.date].filter(Boolean).join('  ·  ')}
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                    {expanded ? (
                      entry?.loading ? (
                        <ActivityIndicator color={C.blue} style={styles.chartSpinner} />
                      ) : entry?.error ? (
                        <Text style={styles.chartErrorText}>{entry.error}</Text>
                      ) : entry?.text ? (
                        <>
                          <TouchableOpacity
                            style={[styles.loadPatientButton, styles.copyButtonSpacing]}
                            onPress={() => handleCopyNoteText(note)}
                          >
                            <Text style={styles.loadPatientButtonText}>Copy Note to Clipboard</Text>
                          </TouchableOpacity>
                          <View style={styles.noteHtmlBox}>
                            <RenderHtml
                              contentWidth={panelWidth - 64}
                              source={{ html: entry.text }}
                              baseStyle={styles.noteHtmlBase}
                            />
                          </View>
                        </>
                      ) : null
                    ) : null}
                  </View>
                );
              })
            )}
              </ScrollView>
            </SafeAreaView>
          </Animated.View>
        </View>
      </Modal>

      {/* Dragon Copilot Summary — a left-side slide-in panel (opposite edge
          from the Epic panels) showing the compiled IPS + Clinical Notes
          text, ready to copy into Dragon Copilot Chat. */}
      <Modal
        visible={dragonSummaryPanelRendered}
        transparent
        animationType="none"
        onRequestClose={() => setDragonSummaryVisible(false)}
      >
        <View style={styles.chartOverlay}>
          <Animated.View
            style={[
              styles.chartPanel,
              {
                width: panelWidth,
                transform: [
                  {
                    translateX: dragonSummaryPanelAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-panelWidth, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <SafeAreaView style={styles.chartPanelSafeArea}>
              <View style={styles.chartPanelHeader}>
                <View style={styles.chartPanelHeaderLeft}>
                  <Image source={require('./assets/DCP_Flame.png')} style={styles.dragonBadgeIcon} />
                  <Text style={styles.chartPanelTitle}>Dragon Copilot Summary</Text>
                </View>
                <TouchableOpacity onPress={() => setDragonSummaryVisible(false)}>
                  <Text style={styles.modalClose}>Done</Text>
                </TouchableOpacity>
              </View>

              <ScrollView contentContainerStyle={styles.chartScrollContent}>
                {compilingForDragon ? (
                  <ActivityIndicator color={C.blue} style={styles.chartSpinner} />
                ) : null}
                {dragonSummaryError ? (
                  <Text style={styles.chartErrorText}>{dragonSummaryError}</Text>
                ) : null}
                {dragonSummaryText ? (
                  <>
                    <TouchableOpacity
                      style={[styles.loadPatientButton, styles.copyButtonSpacing]}
                      onPress={handleCopyDragonSummary}
                    >
                      <Text style={styles.loadPatientButtonText}>
                        {dragonSummaryCopied ? 'Copied ✓' : 'Copy to Clipboard'}
                      </Text>
                    </TouchableOpacity>
                    <TextInput
                      style={[styles.noteHtmlBox, styles.dragonSummaryInput]}
                      value={dragonSummaryText}
                      onChangeText={setDragonSummaryText}
                      multiline
                      scrollEnabled={false}
                      textAlignVertical="top"
                    />
                  </>
                ) : null}
              </ScrollView>
            </SafeAreaView>
          </Animated.View>
          <TouchableOpacity
            style={styles.chartBackdrop}
            activeOpacity={1}
            onPress={() => setDragonSummaryVisible(false)}
          />
        </View>
      </Modal>
    </SafeAreaView>
  );
}


// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: C.bg },
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  signInContainer: {
    flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 12, width: '100%',
  },
  signInButton: { width: '100%', maxWidth: 320, marginTop: 8 },

  title: { fontSize: 30, fontWeight: '800', color: C.blue, letterSpacing: 0.5, marginBottom: 2 },
  subtitle: { fontSize: 13, color: C.textMid, marginBottom: 20, letterSpacing: 0.3 },

  dragonBody: { padding: 20, flexGrow: 1 },
  dragonCenterBlock: { alignItems: 'center', gap: 16, marginTop: 24 },
  dragonBodyText: { fontSize: 14, color: C.textMid, textAlign: 'center', lineHeight: 20 },
  dragonErrorText: { fontSize: 13, color: C.danger, textAlign: 'center', marginTop: 20, lineHeight: 18 },
  dragonWarningBox: {
    backgroundColor: C.goldLight, borderWidth: 1, borderColor: C.gold,
    borderRadius: 12, padding: 16, gap: 6,
  },
  dragonWarningTitle: { fontSize: 14, fontWeight: '700', color: C.textDark },
  dragonWarningText: { fontSize: 13, color: C.textMid, marginBottom: 4 },
  dragonWarningItem: { fontSize: 12, color: C.textDark, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },

  patientSourceRow: { flexDirection: 'row', gap: 10, marginBottom: 32 },
  loadPatientButton: {
    borderWidth: 1.5, borderColor: C.gold, borderStyle: 'dashed',
    paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10,
    backgroundColor: C.goldLight, alignItems: 'center',
  },
  loadPatientButtonText: { color: C.blue, fontSize: 13, fontWeight: '700', textAlign: 'center' },

  localPatientListButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.white, borderRadius: 20, borderWidth: 1.5, borderColor: C.gold,
    paddingVertical: 9, paddingHorizontal: 18,
  },
  localPatientListButtonText: { color: C.blue, fontSize: 13, fontWeight: '700', letterSpacing: 0.2 },
  epicPatientListButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.epicRed, borderRadius: 20,
    paddingVertical: 9, paddingHorizontal: 18,
    shadowColor: C.epicRedDark, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 3,
  },
  epicPatientListButtonText: { color: C.white, fontSize: 13, fontWeight: '700', letterSpacing: 0.2 },

  patientBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: C.blueLight, borderRadius: 12, borderWidth: 1, borderColor: C.blueBorder,
    paddingVertical: 10, paddingHorizontal: 16, marginBottom: 32, width: '100%',
  },
  patientBannerInner: { gap: 2 },
  patientBannerLabel: { fontSize: 10, color: C.blueMid, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  patientBannerName: { fontSize: 15, fontWeight: '700', color: C.blue },
  patientBannerSub: { fontSize: 12, color: C.textMid, marginTop: 1 },
  patientBannerChange: { fontSize: 13, color: C.gold, fontWeight: '600' },

  epicChartButton: {
    flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.epicRed, borderRadius: 20,
    paddingVertical: 9, paddingHorizontal: 18, marginBottom: 24,
    shadowColor: C.epicRedDark, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 3,
  },
  epicChartButtonText: { color: C.white, fontSize: 13, fontWeight: '700', letterSpacing: 0.2 },

  formPickerBlock: { width: '100%', marginBottom: 20 },
  formPickerLabel: {
    fontSize: 11, fontWeight: '700', color: C.textLight, textTransform: 'uppercase',
    letterSpacing: 0.5, marginBottom: 8,
  },
  formPickerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  formChip: {
    borderWidth: 1, borderColor: C.blueBorder, backgroundColor: C.white,
    borderRadius: 16, paddingVertical: 7, paddingHorizontal: 14,
  },
  formChipActive: { backgroundColor: C.blue, borderColor: C.blue },
  formChipText: { fontSize: 12, fontWeight: '600', color: C.blueMid },
  formChipTextActive: { color: C.white },

  recordingArea: { alignItems: 'center', gap: 20 },
  recordingIndicator: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  recordingDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.danger },
  recordingLabel: { fontSize: 13, fontWeight: '700', color: C.danger, letterSpacing: 1, textTransform: 'uppercase' },
  timer: { fontSize: 52, fontWeight: '200', color: C.blue, fontVariant: ['tabular-nums'], letterSpacing: 3 },
  recordButton: {
    width: 100, height: 100, borderRadius: 50, backgroundColor: C.blue,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: C.blue, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 12, elevation: 8,
    borderWidth: 3, borderColor: C.gold,
  },
  recordButtonActive: { backgroundColor: C.danger, borderColor: C.danger, shadowColor: C.danger },
  recordHint: { fontSize: 13, color: C.textLight, marginTop: 4 },

  dividerRow: { flexDirection: 'row', alignItems: 'center', marginTop: 32, marginBottom: 16, width: '100%' },
  dividerLine: { flex: 1, height: 1, backgroundColor: C.border },
  dividerText: { marginHorizontal: 12, fontSize: 13, color: C.textLight },

  uploadButton: {
    borderWidth: 1.5, borderColor: C.border,
    paddingVertical: 13, paddingHorizontal: 32, borderRadius: 12, width: '100%', alignItems: 'center',
    backgroundColor: C.white,
  },
  uploadButtonText: { color: C.textMid, fontSize: 15, fontWeight: '500' },

  actions: { marginTop: 48, alignItems: 'center', gap: 12, width: '100%' },
  readyText: { fontSize: 14, color: C.textMid, marginBottom: 4 },
  formatText: { fontSize: 12, color: C.textLight, marginBottom: 4 },
  primaryButton: {
    backgroundColor: C.blue, paddingVertical: 15, paddingHorizontal: 32,
    borderRadius: 14, width: '100%', alignItems: 'center',
    shadowColor: C.blue, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4,
  },
  primaryButtonText: { color: C.white, fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },
  buttonDisabled: { opacity: 0.45 },
  loadingRow: { flexDirection: 'row', alignItems: 'center' },
  secondaryButton: { paddingVertical: 12 },
  secondaryButtonText: { color: C.textLight, fontSize: 14 },

  permissionText: { fontSize: 16, color: C.textMid, textAlign: 'center', lineHeight: 24 },

  // Patient modal
  modalSafeArea: { flex: 1, backgroundColor: C.white },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 16,
    borderBottomWidth: 1, borderBottomColor: C.border,
    backgroundColor: C.bg,
  },
  modalTitle: { fontSize: 17, fontWeight: '700', color: C.blue },
  modalClose: { fontSize: 16, color: C.gold, fontWeight: '600' },
  patientList: { paddingVertical: 8 },
  listSeparator: { height: 1, backgroundColor: C.border, marginLeft: 16 },
  patientRow: { paddingHorizontal: 20, paddingVertical: 14 },
  patientRowSelected: { backgroundColor: C.blueLight },
  patientRowName: { fontSize: 15, fontWeight: '600', color: C.textDark },
  patientRowDetail: { fontSize: 12, color: C.textLight, marginTop: 2 },
  patientRowVisit: { fontSize: 12, color: C.textMid, marginTop: 2, fontStyle: 'italic' },
  modalFooter: { padding: 20, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg },
  reloadButton: { alignItems: 'center', paddingVertical: 12 },
  reloadButtonText: { color: C.gold, fontSize: 15, fontWeight: '600' },

  // Epic Chart Summary — right-side slide-in panel (Conditions + IPS + Notes)
  chartOverlay: { flex: 1, flexDirection: 'row', backgroundColor: 'rgba(11, 31, 58, 0.4)' },
  chartBackdrop: { flex: 1 },
  chartPanel: {
    height: '100%', backgroundColor: C.white,
    shadowColor: '#000', shadowOffset: { width: -4, height: 0 }, shadowOpacity: 0.2, shadowRadius: 20, elevation: 20,
  },
  chartPanelSafeArea: { flex: 1, backgroundColor: C.white },
  chartPanelHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 16,
    borderBottomWidth: 1, borderBottomColor: C.border,
    backgroundColor: C.bg,
  },
  chartPanelHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  chartPanelHeaderBadge: { backgroundColor: C.epicRed, borderRadius: 5, paddingVertical: 3, paddingHorizontal: 7 },
  chartPanelHeaderBadgeText: { color: C.white, fontSize: 12, fontWeight: '800', letterSpacing: 0.3 },
  chartPanelTitle: { fontSize: 16, fontWeight: '700', color: C.blue },
  localPanelHeaderBadge: { borderWidth: 1.5, borderColor: C.gold, borderRadius: 5, paddingVertical: 2, paddingHorizontal: 6 },
  localPanelHeaderBadgeText: { color: C.blue, fontSize: 12, fontWeight: '800', letterSpacing: 0.3 },
  dragonBadgeIcon: { width: 22, height: 22 },
  dragonSummaryInput: { fontSize: 12, color: C.textDark, lineHeight: 18, minHeight: 400 },
  chartScrollContent: { padding: 20 },
  compileButton: { marginBottom: 24 },
  chartSectionTitle: { fontSize: 15, fontWeight: '700', color: C.blue, marginBottom: 10 },
  chartSpinner: { marginVertical: 12 },
  chartErrorText: { fontSize: 13, color: C.danger, marginBottom: 8 },
  chartEmptyText: { fontSize: 13, color: C.textLight, marginBottom: 8 },
  chartDivider: { height: 1, backgroundColor: C.border, marginVertical: 24 },
  conditionRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  conditionText: { fontSize: 14, fontWeight: '600', color: C.textDark },
  conditionMeta: { fontSize: 12, color: C.textLight, marginTop: 2 },
  copyButtonSpacing: { marginTop: 8, marginBottom: 16 },
  noteHtmlBox: { backgroundColor: C.bg, borderRadius: 8, padding: 12 },
  noteHtmlBase: { fontSize: 13, color: C.textDark, lineHeight: 19 },
  ipsSection: { marginBottom: 20 },
  ipsSectionTitle: { fontSize: 14, fontWeight: '700', color: C.textDark, marginBottom: 8 },

  debugLink: { marginBottom: 24, marginTop: -8 },
  debugLinkText: { fontSize: 12, color: C.textLight, textDecorationLine: 'underline' },

  viewResultsButton: {
    flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.blue, borderRadius: 20,
    paddingVertical: 9, paddingHorizontal: 18, marginBottom: 16,
    shadowColor: C.blue, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 3,
  },
  viewResultsButtonText: { color: C.white, fontSize: 13, fontWeight: '700', letterSpacing: 0.2 },

  logScroll: { flex: 1 },
  logContent: { padding: 12 },
  logEmpty: { color: C.textLight, textAlign: 'center', marginTop: 24 },
  logEntry: { marginBottom: 10, borderBottomWidth: 1, borderBottomColor: C.border, paddingBottom: 8 },
  logMeta: { fontSize: 11, color: C.textLight, marginBottom: 2 },
  logMessage: { fontSize: 12, color: C.textDark, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  logLevelLog: { color: C.textMid },
  logLevelWarn: { color: C.gold },
  logLevelError: { color: C.danger },

  // Dragon Copilot note screen
  tsHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.bg,
  },
  backButton: { width: 80 },
  backButtonText: { color: C.gold, fontSize: 16, fontWeight: '600' },
  tsTitle: { fontSize: 17, fontWeight: '700', color: C.blue },
  dragonLaunchRow: {
    paddingHorizontal: 16, paddingTop: 12,
    borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.bg,
  },
  launchDragonButton: {
    flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.blueLight, borderWidth: 1, borderColor: C.blueBorder, borderRadius: 20,
    paddingVertical: 8, paddingHorizontal: 16, marginBottom: 12, gap: 8,
  },
  launchDragonButtonText: { color: C.blue, fontSize: 13, fontWeight: '700' },
  dragonNoteBody: { flex: 1, flexDirection: 'row' },
  dragonMainPane: { flex: 1 },
  recordingsPanel: {
    width: 116, borderRightWidth: 1, borderRightColor: C.border,
    backgroundColor: C.bg, paddingTop: 12, paddingHorizontal: 8,
  },
  recordingsPanelTitle: {
    fontSize: 10, fontWeight: '700', color: C.textLight, textTransform: 'uppercase',
    letterSpacing: 0.5, marginBottom: 8, paddingHorizontal: 4,
  },
  recordingsList: { flex: 1 },
  recordingItem: {
    backgroundColor: C.white, borderWidth: 1, borderColor: C.border,
    borderRadius: 8, padding: 8, marginBottom: 8,
  },
  recordingItemTitle: { fontSize: 12, fontWeight: '700', color: C.blue },
  recordingItemMeta: { fontSize: 10, color: C.textMid, marginTop: 2 },
  recordAnotherButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    backgroundColor: C.blue, borderRadius: 8, paddingVertical: 8, marginBottom: 12,
  },
  recordAnotherButtonText: { color: C.white, fontSize: 11, fontWeight: '700' },
  statusRow: {
    flexDirection: 'row', justifyContent: 'center', gap: 24,
    paddingVertical: 12, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.bg,
  },
  checkNowRow: {
    alignItems: 'center', gap: 4, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.bg,
  },
  statusItem: { alignItems: 'center', gap: 4 },
  statusLabel: {
    fontSize: 10, fontWeight: '700', color: C.textLight,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  noteStatusBadge: {
    minWidth: 80, alignItems: 'center', paddingVertical: 4, paddingHorizontal: 10,
    borderRadius: 6, borderWidth: 1,
  },
  noteStatusBadgeSubmitted: { backgroundColor: C.goldLight, borderColor: C.gold },
  noteStatusBadgeReady: { backgroundColor: C.successLight, borderColor: C.success },
  noteStatusBadgeText: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  noteStatusBadgeTextSubmitted: { color: C.amberDark },
  noteStatusBadgeTextReady: { color: C.success },
  noteTabRow: {
    flexDirection: 'row', backgroundColor: C.blueLight, borderRadius: 10,
    padding: 3, borderWidth: 1, borderColor: C.blueBorder,
    marginHorizontal: 16, marginTop: 12,
  },
  noteTabButton: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  noteTabButtonActive: {
    backgroundColor: C.blue,
    shadowColor: C.blue, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 2,
  },
  noteTabButtonText: { fontSize: 13, fontWeight: '600', color: C.blueMid },
  noteTabButtonTextActive: { color: C.white },
  tsFooter: {
    padding: 20, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg, gap: 12,
  },
  summaryBody: { padding: 20, paddingBottom: 8 },
  summaryText: { fontSize: 15, color: C.textDark, lineHeight: 26 },

  noteTitle: { fontSize: 20, fontWeight: '800', color: C.blue, marginBottom: 16 },
  noteSection: {
    backgroundColor: C.white, borderWidth: 1, borderColor: C.border,
    borderRadius: 12, padding: 16, marginBottom: 12,
  },
  noteSectionTitle: {
    fontSize: 11, fontWeight: '700', color: C.blueMid, textTransform: 'uppercase',
    letterSpacing: 0.5, marginBottom: 6,
  },
  noteSectionContent: { fontSize: 15, color: C.textDark, lineHeight: 22 },
  noteSectionInput: {
    fontSize: 15, color: C.textDark, lineHeight: 22,
    padding: 0, borderWidth: 0,
  },
  noteSectionsToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 },
  checkbox: {
    width: 18, height: 18, borderRadius: 4, borderWidth: 1.5, borderColor: C.blueBorder,
    alignItems: 'center', justifyContent: 'center', backgroundColor: C.white,
  },
  checkboxChecked: { backgroundColor: C.blue, borderColor: C.blue },
  noteSectionsToggleText: { fontSize: 13, color: C.textMid, fontWeight: '600' },
});
