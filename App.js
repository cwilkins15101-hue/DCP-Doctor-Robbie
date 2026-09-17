import { useState, useEffect, useRef } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity, Animated,
  Alert, Modal, FlatList, SafeAreaView, ScrollView,
  ActivityIndicator, Platform, useWindowDimensions,
} from 'react-native';
import { Audio } from 'expo-av';
import * as DocumentPicker from 'expo-document-picker';
import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { DragonCopilotBackend } from './dragonCopilotBackend';
import { DdeClient } from './ddeClient';
import { EpicClient } from './epicClient';

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
// display name and text (often empty for sections the encounter didn't
// cover). Returns null if the shape doesn't match, so callers can fall
// back to showing the raw JSON.
// ---------------------------------------------------------------------------
function parseDragonNote(noteBody) {
  try {
    const raw = noteBody?.data?.data?.data;
    if (typeof raw !== 'string') return null;
    const payload = JSON.parse(raw);
    const sections = (payload.resources || [])
      .map((r) => ({
        id: r.legacy_id,
        title: r.context?.display_description || r.legacy_id,
        content: (r.content || '').replace(/\r\n/g, '\n').trim(),
      }))
      .filter((s) => s.content.length > 0);
    if (sections.length === 0) return null;
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
// ("clinician" or "other"), and text — no artifact_type field at all.
function parseDragonTranscript(transcriptBody) {
  try {
    const raw = transcriptBody?.data?.data?.data;
    if (typeof raw !== 'string') return null;
    const payload = JSON.parse(raw);
    const rawTurns = payload.transcript?.turns;
    if (!Array.isArray(rawTurns) || rawTurns.length === 0) return null;
    const turns = rawTurns
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((t) => ({
        id: String(t.index),
        speaker: t.speaker === 'clinician' ? 'Clinician' : t.speaker === 'other' ? 'Patient' : (t.speaker || 'Speaker'),
        text: (t.text || '').replace(/\r\n/g, '\n').trim(),
      }))
      .filter((t) => t.text.length > 0);
    return turns.length > 0 ? { turns } : null;
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

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const { width: windowWidth } = useWindowDimensions();

  // Screen: 'record' | 'dragonNote'
  const [screen, setScreen] = useState('record');

  // Permissions
  const [permissionGranted, setPermissionGranted] = useState(false);

  // Recording
  const [recording, setRecording] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [audioUri, setAudioUri] = useState(null);
  const [audioName, setAudioName] = useState(null);

  // Patient list
  const [patients, setPatients] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [patientModalVisible, setPatientModalVisible] = useState(false);
  const [loadingEpicPatients, setLoadingEpicPatients] = useState(false);

  // Epic patient chart (Conditions + CCD) — only available for patients
  // loaded from Epic (they carry a FHIR id; CSV-loaded patients don't).
  const [chartModalVisible, setChartModalVisible] = useState(false);
  const [loadingConditions, setLoadingConditions] = useState(false);
  const [conditions, setConditions] = useState([]);
  const [chartError, setChartError] = useState('');
  const [loadingCcd, setLoadingCcd] = useState(false);
  const [ccd, setCcd] = useState(null); // { xml, meta }
  const [ccdError, setCcdError] = useState('');
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [clinicalNotes, setClinicalNotes] = useState([]);
  const [notesError, setNotesError] = useState('');
  const [expandedNoteId, setExpandedNoteId] = useState(null);
  const [noteTexts, setNoteTexts] = useState({}); // { [noteId]: { loading, text, error } }

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

  async function startRecording() {
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording: rec } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      setRecording(rec);
      setIsRecording(true);
      setDuration(0);
      setAudioUri(null);
    } catch (err) {
      console.error('Failed to start recording:', err);
    }
  }

  async function stopRecording() {
    try {
      await recording.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      const uri = recording.getURI();
      setAudioUri(uri);
      setAudioName('Recording.m4a');
      setRecording(null);
      setIsRecording(false);
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
        setDuration(0);
      }
    } catch (err) {
      Alert.alert('Error', 'Could not pick file: ' + err.message);
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
          Alert.alert('Empty file', 'No patient records found in the CSV.');
          return;
        }
        setPatients(parsed);
        setPatientModalVisible(true);
      }
    } catch (err) {
      Alert.alert('Error', 'Could not load patient list: ' + err.message);
    }
  }

  // Signs into the Epic on FHIR sandbox (if not already signed in this
  // session) and loads its documented test patients.
  async function handleLoadEpicPatients() {
    const missing = EpicClient.missingConfigKeys();
    if (missing.length > 0) {
      Alert.alert('Epic isn’t configured', `Add these to your .env file: ${missing.join(', ')}`);
      return;
    }
    setLoadingEpicPatients(true);
    try {
      const epicPatients = await EpicClient.fetchSandboxPatients();
      setPatients(epicPatients);
      setPatientModalVisible(true);
    } catch (err) {
      Alert.alert('Epic sign-in failed', String(err?.message ?? err));
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
  // The CCD, and each note's actual text, are fetched separately, on
  // demand — $docref generation and note bodies are both slower/heavier
  // than a plain list read.
  async function handleViewChart() {
    if (!selectedPatient?.id) return;
    setChartModalVisible(true);
    setLoadingConditions(true);
    setChartError('');
    setConditions([]);
    setCcd(null);
    setCcdError('');
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

  async function handleFetchCCD() {
    if (!selectedPatient?.id) return;
    setLoadingCcd(true);
    setCcdError('');
    try {
      const result = await EpicClient.fetchCCD(selectedPatient.id);
      setCcd(result);
    } catch (err) {
      setCcdError(String(err?.message ?? err));
    } finally {
      setLoadingCcd(false);
    }
  }

  async function handleCopyCCD() {
    if (!ccd?.xml) return;
    await Clipboard.setStringAsync(ccd.xml);
    Alert.alert('Copied', 'The full CCD document was copied to your clipboard.');
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
    await Clipboard.setStringAsync(entry.text);
    Alert.alert('Copied', 'The note text was copied to your clipboard.');
  }

  function handleDiscard() {
    setAudioUri(null);
    setAudioName(null);
    setDuration(0);
  }

  // ---- Dragon Copilot submission ----

  async function handleDragonSubmitRecording() {
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
        audioUri,
        audioName,
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
      setScreen('dragonNote');
    } catch (err) {
      Alert.alert('Dragon Copilot submission failed', String(err?.message ?? err));
    } finally {
      setSubmitting(false);
      setSubmitStep('');
    }
  }

  // Returns to the recording screen without losing the current encounter —
  // the correlation ID, and whatever note/transcript has already arrived,
  // stay intact so the physician can keep reviewing them afterward.
  function handleRecordAnother() {
    setAudioUri(null);
    setAudioName(null);
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
        return (
          <>
            <Text style={styles.noteTitle}>{parsedNote.title}</Text>
            {parsedNote.sections.map((section) => (
              <View key={section.id} style={styles.noteSection}>
                <Text style={styles.noteSectionTitle}>{section.title}</Text>
                <Text style={styles.noteSectionContent} selectable>{section.content}</Text>
              </View>
            ))}
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
            <Text style={styles.backButtonText}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={styles.tsTitle}>Dragon Copilot</Text>
          <View style={{ width: 80 }} />
        </View>

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
              {artifacts && (!noteIsCurrent || !transcriptIsCurrent) && (
                <View style={styles.checkNowRow}>
                  <TouchableOpacity onPress={handleCheckDdeResult} disabled={dragonDdeChecking}>
                    <Text style={styles.debugLinkText}>
                      {dragonDdeChecking ? 'Checking…' : 'Check now for updated results'}
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
                        setDragonCorrelationId(null);
                        setDragonDdeResult(null);
                        setRecordings([]);
                        setPollGeneration(0);
                        setNoteTab('note');
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
          <TouchableOpacity style={styles.backToResultsLink} onPress={() => setScreen('dragonNote')}>
            <Text style={styles.backToResultsLinkText}>‹ Back to Results</Text>
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
            <TouchableOpacity style={[styles.loadPatientButton, styles.patientSourceButton]} onPress={loadPatientList}>
              <Text style={styles.loadPatientButtonText}>Load Patient List</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.loadPatientButton, styles.patientSourceButton, loadingEpicPatients && styles.buttonDisabled]}
              onPress={handleLoadEpicPatients}
              disabled={loadingEpicPatients}
            >
              {loadingEpicPatients ? (
                <ActivityIndicator color={C.blue} size="small" />
              ) : (
                <Text style={styles.loadPatientButtonText}>Get Patients from Epic</Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        <>
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

            {/* Actions after audio is ready */}
            {audioUri && !isRecording && (
              <View style={styles.actions}>
                <Text style={styles.readyText}>
                  {audioName ?? 'Recording'}{duration > 0 ? ` (${formatDuration(duration)})` : ''}
                </Text>
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

      {/* Debug log modal */}
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

      {/* Patient list modal */}
      <Modal
        visible={patientModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setPatientModalVisible(false)}
      >
        <SafeAreaView style={styles.modalSafeArea}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Select Patient</Text>
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

          <View style={styles.modalFooter}>
            <TouchableOpacity style={styles.reloadButton} onPress={loadPatientList}>
              <Text style={styles.reloadButtonText}>Load Different File</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
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
                width: Math.min(440, windowWidth * 0.92),
                transform: [
                  {
                    translateX: chartPanelAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [Math.min(440, windowWidth * 0.92), 0],
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

            <Text style={styles.chartSectionTitle}>Continuity of Care Document (CCD)</Text>
            {!ccd && !loadingCcd ? (
              <TouchableOpacity style={styles.loadPatientButton} onPress={handleFetchCCD}>
                <Text style={styles.loadPatientButtonText}>Get CCD</Text>
              </TouchableOpacity>
            ) : null}
            {loadingCcd ? <ActivityIndicator color={C.blue} style={styles.chartSpinner} /> : null}
            {ccdError ? <Text style={styles.chartErrorText}>{ccdError}</Text> : null}
            {ccd ? (
              <>
                <Text style={styles.chartEmptyText}>
                  {ccd.meta.type}{ccd.meta.date ? `  ·  ${ccd.meta.date}` : ''}
                  {'  ·  '}{Math.round(ccd.xml.length / 1024)} KB
                </Text>
                <TouchableOpacity style={[styles.loadPatientButton, styles.ccdCopyButton]} onPress={handleCopyCCD}>
                  <Text style={styles.loadPatientButtonText}>Copy Full CCD to Clipboard</Text>
                </TouchableOpacity>
                <Text style={styles.ccdPreviewLabel}>Preview (first 2,000 characters):</Text>
                <Text style={styles.ccdText} selectable>
                  {ccd.xml.slice(0, 2000)}
                  {ccd.xml.length > 2000 ? '…' : ''}
                </Text>
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
                            style={[styles.loadPatientButton, styles.ccdCopyButton]}
                            onPress={() => handleCopyNoteText(note)}
                          >
                            <Text style={styles.loadPatientButtonText}>Copy Note to Clipboard</Text>
                          </TouchableOpacity>
                          <Text style={styles.ccdText} selectable>
                            {entry.text.slice(0, 2000)}
                            {entry.text.length > 2000 ? '…' : ''}
                          </Text>
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
    </SafeAreaView>
  );
}


// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: C.bg },
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },

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

  patientSourceRow: { flexDirection: 'row', gap: 10, marginBottom: 32, width: '100%' },
  patientSourceButton: { flex: 1 },
  loadPatientButton: {
    borderWidth: 1.5, borderColor: C.gold, borderStyle: 'dashed',
    paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10,
    backgroundColor: C.goldLight, alignItems: 'center',
  },
  loadPatientButtonText: { color: C.blue, fontSize: 13, fontWeight: '700', textAlign: 'center' },

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

  // Epic Chart Summary — right-side slide-in panel (Conditions + CCD + Notes)
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
  chartScrollContent: { padding: 20 },
  chartSectionTitle: { fontSize: 15, fontWeight: '700', color: C.blue, marginBottom: 10 },
  chartSpinner: { marginVertical: 12 },
  chartErrorText: { fontSize: 13, color: C.danger, marginBottom: 8 },
  chartEmptyText: { fontSize: 13, color: C.textLight, marginBottom: 8 },
  chartDivider: { height: 1, backgroundColor: C.border, marginVertical: 24 },
  conditionRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  conditionText: { fontSize: 14, fontWeight: '600', color: C.textDark },
  conditionMeta: { fontSize: 12, color: C.textLight, marginTop: 2 },
  ccdCopyButton: { marginTop: 8, marginBottom: 16 },
  ccdPreviewLabel: { fontSize: 12, color: C.textLight, marginBottom: 6 },
  ccdText: {
    fontSize: 11, color: C.textMid, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    backgroundColor: C.bg, borderRadius: 8, padding: 12, lineHeight: 16,
  },

  debugLink: { marginBottom: 24, marginTop: -8 },
  debugLinkText: { fontSize: 12, color: C.textLight, textDecorationLine: 'underline' },

  backToResultsLink: { alignSelf: 'flex-start', marginBottom: 12 },
  backToResultsLinkText: { color: C.gold, fontSize: 15, fontWeight: '600' },

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
});
