import { useState, useEffect, useRef } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity, Animated,
  Alert, Modal, FlatList, SafeAreaView, ScrollView,
  TextInput, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Audio } from 'expo-av';
import * as DocumentPicker from 'expo-document-picker';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { DragonCopilotBackend } from './dragonCopilotBackend';
import { DdeClient } from './ddeClient';

const OPENAI_API_KEY = process.env.EXPO_PUBLIC_OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY;

// ---------------------------------------------------------------------------
// AI pipeline selection — which service labels speakers and writes the
// clinical summary. Transcription always uses Whisper either way.
// ---------------------------------------------------------------------------
const PIPELINES = { CLAUDE: 'claude', DRAGON: 'dragon' };
const PIPELINE_LABELS = { [PIPELINES.CLAUDE]: 'Claude', [PIPELINES.DRAGON]: 'Dragon Copilot' };
// Shorter labels for the small header badge, which has limited width.
const PIPELINE_BADGE_LABELS = { [PIPELINES.CLAUDE]: 'Claude', [PIPELINES.DRAGON]: 'Dragon' };

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
  white:       '#FFFFFF',
  bg:          '#F4F7FF',
  textDark:    '#0B1F3A',
  textMid:     '#4A6080',
  textLight:   '#94A3B8',
  danger:      '#DC2626',
  border:      '#DDE6F0',
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

// ---------------------------------------------------------------------------
// Whisper transcription
// ---------------------------------------------------------------------------
async function transcribeWithWhisper(uri, filename) {
  const ext = (filename ?? 'audio.m4a').split('.').pop().toLowerCase();
  const mimeMap = { m4a: 'audio/m4a', mp3: 'audio/mpeg', mp4: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm' };
  const mimeType = mimeMap[ext] ?? 'audio/m4a';

  const formData = new FormData();

  if (Platform.OS === 'web') {
    // On web, fetch the file as a Blob — the { uri, name, type } shorthand only works on native
    const fileRes = await fetch(uri);
    const blob = await fileRes.blob();
    formData.append('file', blob, filename ?? 'audio.m4a');
  } else {
    formData.append('file', { uri, name: filename ?? 'audio.m4a', type: mimeType });
  }

  formData.append('model', 'whisper-1');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: formData,
  });

  const rawText = await response.text();
  console.log('Whisper raw response:', rawText);

  if (!response.ok) {
    throw new Error(`Whisper API error ${response.status}: ${rawText}`);
  }

  // Response may be plain text or JSON depending on response_format
  try {
    const json = JSON.parse(rawText);
    return json.text ?? rawText;
  } catch {
    return rawText;
  }
}

// ---------------------------------------------------------------------------
// Claude — speaker identification
// ---------------------------------------------------------------------------
async function identifySpeakersClaude(transcript) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `You are a medical transcription assistant. The following is a raw transcript of a medical appointment. Identify the different speakers and reformat the transcript with clear speaker labels on each line.

Rules:
- Use "Doctor:" and "Patient:" as labels when identifiable
- If other speakers are present (nurse, family member), label them accordingly
- If a speaker is unclear, use "Speaker:"
- Preserve the original wording exactly — do not paraphrase or summarize
- Output only the labeled transcript, nothing else

TRANSCRIPT:
${transcript}`,
      }],
    }),
  });

  const rawText = await response.text();
  if (!response.ok) throw new Error(`Speaker ID error ${response.status}: ${rawText}`);
  const json = JSON.parse(rawText);
  return json.content?.[0]?.text ?? transcript;
}

// ---------------------------------------------------------------------------
// Claude clinical summary
// ---------------------------------------------------------------------------
async function generateClinicalSummaryClaude(transcript, patient) {
  const patientContext = patient
    ? `Patient: ${patient['Patient Name'] ?? 'Unknown'}
MRN: ${patient['MRN'] ?? 'N/A'}
DOB: ${patient['DOB'] ?? 'N/A'}
Visit Date: ${patient['Visit Date'] ?? 'N/A'}  ${patient['Visit Time'] ?? ''}
Chief Complaint: ${patient['Chief Complaint'] ?? 'N/A'}`
    : 'No patient selected.';

  const prompt = `You are a clinical documentation assistant. Below is a patient encounter transcript and patient details. Generate a structured clinical note in SOAP format.

${patientContext}

TRANSCRIPT:
${transcript}

Generate a SOAP note using markdown formatting:
- Use ## for each section heading (## Subjective, ## Objective, ## Assessment, ## Plan)
- Use **bold** for key clinical terms, medications, and diagnoses
- Be concise and use standard clinical language
- Only include information present in the transcript`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const rawText = await response.text();
  console.log('Claude raw response:', rawText);

  if (!response.ok) {
    throw new Error(`Claude API error ${response.status}: ${rawText}`);
  }

  const json = JSON.parse(rawText);
  return json.content?.[0]?.text ?? '';
}

// ---------------------------------------------------------------------------
// MarkdownText — renders **bold** and ## Section Headers
// ---------------------------------------------------------------------------
function MarkdownText({ text, baseStyle }) {
  if (!text) return null;
  const lines = text.split('\n');
  return (
    <View>
      {lines.map((line, i) => {
        const isHeader = line.startsWith('## ');
        const content = isHeader ? line.slice(3) : line;
        const parts = content.split(/\*\*(.*?)\*\*/g);
        return (
          <Text
            key={i}
            style={[baseStyle, isHeader ? mdStyles.header : mdStyles.body, i > 0 && mdStyles.lineSpacing]}
            selectable
          >
            {parts.map((part, j) =>
              j % 2 === 1
                ? <Text key={j} style={mdStyles.bold}>{part}</Text>
                : part
            )}
          </Text>
        );
      })}
    </View>
  );
}

const mdStyles = StyleSheet.create({
  header: { fontSize: 16, fontWeight: '700', color: C.blue, marginTop: 16, marginBottom: 4 },
  body:   { fontSize: 15, color: C.textDark, lineHeight: 24 },
  bold:   { fontWeight: '700', color: C.textDark },
  lineSpacing: { marginTop: 2 },
});

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  // Screen: 'record' | 'transcript' | 'summary'
  const [screen, setScreen] = useState('record');

  // AI pipeline: 'claude' | 'dragon'
  const [pipeline, setPipeline] = useState(PIPELINES.CLAUDE);

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

  // Transcription
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeStep, setTranscribeStep] = useState('');
  const [transcript, setTranscript] = useState('');

  // Summary
  const [summarizing, setSummarizing] = useState(false);
  const [summary, setSummary] = useState('');

  // Audio playback
  const [sound, setSound] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackPos, setPlaybackPos] = useState(0);
  const [playbackDur, setPlaybackDur] = useState(0);

  // Debug log
  const logData = useDebugLog();
  const [logModalVisible, setLogModalVisible] = useState(false);

  // Dragon Copilot — backend submission state (no sign-in, no SDK: the
  // recording is uploaded straight to Doctor Robbie's own server)
  const [dragonError, setDragonError] = useState('');
  const [dragonCorrelationId, setDragonCorrelationId] = useState(null);
  const [dragonDdeChecking, setDragonDdeChecking] = useState(false);
  const [dragonDdeResult, setDragonDdeResult] = useState(null);

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const timerRef = useRef(null);

  useEffect(() => {
    (async () => {
      const { granted } = await Audio.requestPermissionsAsync();
      setPermissionGranted(granted);
    })();
  }, []);

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

  function selectPatient(patient) {
    setSelectedPatient(patient);
    setPatientModalVisible(false);
  }

  function handleDiscard() {
    setAudioUri(null);
    setAudioName(null);
    setDuration(0);
  }

  // ---- Audio playback ----

  async function togglePlayback() {
    try {
      if (sound) {
        if (isPlaying) {
          await sound.pauseAsync();
        } else {
          await sound.playAsync();
        }
        return;
      }

      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const { sound: newSound } = await Audio.Sound.createAsync(
        { uri: audioUri },
        { shouldPlay: true },
        (status) => {
          if (status.isLoaded) {
            setIsPlaying(status.isPlaying);
            setPlaybackPos(status.positionMillis ?? 0);
            setPlaybackDur(status.durationMillis ?? 0);
            if (status.didJustFinish) {
              setIsPlaying(false);
              setPlaybackPos(0);
            }
          }
        }
      );
      setSound(newSound);
      setIsPlaying(true);
    } catch (err) {
      Alert.alert('Playback error', String(err));
    }
  }

  async function stopPlayback() {
    if (sound) {
      await sound.unloadAsync();
      setSound(null);
      setIsPlaying(false);
      setPlaybackPos(0);
      setPlaybackDur(0);
    }
  }

  function formatMs(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const s = (totalSec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  // ---- Transcription ----

  async function handleTranscribe() {
    if (!OPENAI_API_KEY) {
      Alert.alert('Missing API key', 'Add EXPO_PUBLIC_OPENAI_API_KEY to your .env file.');
      return;
    }
    setTranscribing(true);
    try {
      setTranscribeStep('Transcribing audio…');
      const rawText = await transcribeWithWhisper(audioUri, audioName);
      console.log('Whisper result length:', rawText?.length);

      setTranscribeStep('Identifying speakers…');
      const labeled = await identifySpeakersClaude(rawText);

      setTranscript(labeled);
      setScreen('transcript');
    } catch (err) {
      Alert.alert('Transcription failed', String(err));
    } finally {
      setTranscribing(false);
      setTranscribeStep('');
    }
  }

  // ---- Summary ----

  async function handleGenerateSummary() {
    if (!ANTHROPIC_API_KEY) {
      Alert.alert('Missing API key', 'Add EXPO_PUBLIC_ANTHROPIC_API_KEY to your .env file.');
      return;
    }
    setSummarizing(true);
    try {
      const text = await generateClinicalSummaryClaude(transcript, selectedPatient);
      setSummary(text);
      setScreen('summary');
    } catch (err) {
      Alert.alert('Summary failed', String(err));
    } finally {
      setSummarizing(false);
    }
  }

  // ---- Dragon Copilot — plain backend upload, no sign-in, no popup ----

  async function handleDragonSubmitRecording() {
    setDragonError('');
    setTranscribing(true);
    setTranscribeStep('Sending to Dragon Copilot…');
    try {
      const correlationId = await DragonCopilotBackend.submitRecording(audioUri, audioName, selectedPatient);
      setDragonCorrelationId(correlationId);
      setDragonDdeResult(null);
      setScreen('dragonNote');
    } catch (err) {
      Alert.alert('Dragon Copilot submission failed', String(err?.message ?? err));
    } finally {
      setTranscribing(false);
      setTranscribeStep('');
    }
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
  // Transcript screen
  // =========================================================================
  if (screen === 'transcript') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="auto" />
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          {/* Header */}
          <View style={styles.tsHeader}>
            <TouchableOpacity onPress={() => { stopPlayback(); setScreen('record'); }} style={styles.backButton}>
              <Text style={styles.backButtonText}>‹ Back</Text>
            </TouchableOpacity>
            <Text style={styles.tsTitle}>Transcript</Text>
            <Text style={styles.tsPipelineBadge} numberOfLines={1}>{PIPELINE_BADGE_LABELS[pipeline]}</Text>
          </View>

          {/* Patient strip */}
          {selectedPatient && (
            <View style={styles.tsPatientStrip}>
              <Text style={styles.tsPatientName}>{patientDisplayName(selectedPatient)}</Text>
              {patientSubtitle(selectedPatient) ? (
                <Text style={styles.tsPatientSub}>{patientSubtitle(selectedPatient)}</Text>
              ) : null}
            </View>
          )}

          <ScrollView contentContainerStyle={styles.tsBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.tsLabel}>Review and edit the transcript before generating the clinical summary.</Text>
            <TextInput
              style={styles.tsInput}
              value={transcript}
              onChangeText={setTranscript}
              multiline
              textAlignVertical="top"
              placeholder="Transcript will appear here…"
              placeholderTextColor="#94A3B8"
            />
          </ScrollView>

          <View style={styles.tsFooter}>
            {/* Audio playback bar */}
            {audioUri && (
              <View style={styles.playbackBar}>
                <TouchableOpacity onPress={togglePlayback} style={styles.playbackBtn}>
                  <Ionicons name={isPlaying ? 'pause-circle' : 'play-circle'} size={36} color={C.blue} />
                </TouchableOpacity>
                <View style={styles.playbackInfo}>
                  <Text style={styles.playbackLabel}>Listen to Encounter</Text>
                  <View style={styles.progressTrack}>
                    <View style={[
                      styles.progressFill,
                      { width: playbackDur > 0 ? `${(playbackPos / playbackDur) * 100}%` : '0%' }
                    ]} />
                  </View>
                  <Text style={styles.playbackTime}>
                    {formatMs(playbackPos)}{playbackDur > 0 ? ` / ${formatMs(playbackDur)}` : ''}
                  </Text>
                </View>
              </View>
            )}

            <TouchableOpacity
              style={[styles.primaryButton, (!transcript.trim() || summarizing) && styles.buttonDisabled]}
              disabled={!transcript.trim() || summarizing}
              onPress={handleGenerateSummary}
            >
              {summarizing ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator color="#fff" size="small" />
                  <Text style={[styles.primaryButtonText, { marginLeft: 10 }]}>Generating…</Text>
                </View>
              ) : (
                <Text style={styles.primaryButtonText}>Generate Clinical Summary</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // =========================================================================
  // Dragon Copilot screen — shown right after a recording is sent. Shows a
  // "processing" state with a manual check, then the note once Dragon Data
  // Exchange (our own webhook server) delivers it. The exact shape of that
  // data ("Dragon standard payload") is still being confirmed, so this
  // renders common field names if present and falls back to raw JSON.
  // =========================================================================
  if (screen === 'dragonNote') {
    const missingKeys = DragonCopilotBackend.missingConfigKeys();
    const noteBody = dragonDdeResult?.data ?? null;
    const displayText = noteBody
      ? (noteBody.transcript ?? noteBody.note ?? noteBody.text ?? JSON.stringify(noteBody, null, 2))
      : null;

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

        {displayText ? (
          <>
            <ScrollView contentContainerStyle={styles.summaryBody}>
              <Text style={styles.summaryText} selectable>{displayText}</Text>
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
                  setDuration(0);
                }}
              >
                <Text style={styles.primaryButtonText}>New Encounter</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <ScrollView contentContainerStyle={styles.dragonBody}>
            {missingKeys.length > 0 ? (
              <View style={styles.dragonWarningBox}>
                <Text style={styles.dragonWarningTitle}>Missing configuration</Text>
                <Text style={styles.dragonWarningText}>Add these to your .env file:</Text>
                {missingKeys.map((key) => (
                  <Text key={key} style={styles.dragonWarningItem}>• {key}</Text>
                ))}
              </View>
            ) : (
              <View style={styles.dragonCenterBlock}>
                <Text style={styles.dragonBodyText}>
                  Dragon Copilot is processing this recording in the background. This can take
                  a minute or two — check back to see if it's ready.
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
                    <Text style={styles.primaryButtonText}>Check for Note</Text>
                  )}
                </TouchableOpacity>
                {!!dragonError && <Text style={styles.dragonErrorText}>{dragonError}</Text>}
              </View>
            )}
          </ScrollView>
        )}
      </SafeAreaView>
    );
  }

  // =========================================================================
  // Summary screen
  // =========================================================================
  if (screen === 'summary') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="auto" />
        <View style={styles.tsHeader}>
          <TouchableOpacity onPress={() => setScreen('transcript')} style={styles.backButton}>
            <Text style={styles.backButtonText}>‹ Transcript</Text>
          </TouchableOpacity>
          <Text style={styles.tsTitle}>Clinical Summary</Text>
          <Text style={styles.tsPipelineBadge}>{PIPELINE_LABELS[pipeline]}</Text>
        </View>

        {selectedPatient && (
          <View style={styles.tsPatientStrip}>
            <Text style={styles.tsPatientName}>{patientDisplayName(selectedPatient)}</Text>
            {patientSubtitle(selectedPatient) ? (
              <Text style={styles.tsPatientSub}>{patientSubtitle(selectedPatient)}</Text>
            ) : null}
          </View>
        )}

        <ScrollView contentContainerStyle={styles.summaryBody}>
          <MarkdownText text={summary} baseStyle={styles.summaryText} />
        </ScrollView>

        <View style={styles.tsFooter}>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => {
              setScreen('record');
              setAudioUri(null);
              setAudioName(null);
              setTranscript('');
              setSummary('');
              setDuration(0);
            }}
          >
            <Text style={styles.primaryButtonText}>New Encounter</Text>
          </TouchableOpacity>
        </View>
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
        <Text style={styles.title}>Doctor Robbie</Text>
        <Text style={styles.subtitle}>Patient Encounter Recording</Text>
        <TouchableOpacity style={styles.debugLink} onPress={() => setLogModalVisible(true)}>
          <Text style={styles.debugLinkText}>View Log</Text>
        </TouchableOpacity>

        {/* AI pipeline toggle */}
        <View style={styles.pipelineBlock}>
          <Text style={styles.pipelineLabel}>AI Pipeline</Text>
          <View style={styles.pipelineToggle}>
            <TouchableOpacity
              style={[styles.pipelineOption, pipeline === PIPELINES.CLAUDE && styles.pipelineOptionActive]}
              onPress={() => setPipeline(PIPELINES.CLAUDE)}
            >
              <Text style={[styles.pipelineOptionText, pipeline === PIPELINES.CLAUDE && styles.pipelineOptionTextActive]}>
                Claude
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.pipelineOption, pipeline === PIPELINES.DRAGON && styles.pipelineOptionActive]}
              onPress={() => setPipeline(PIPELINES.DRAGON)}
            >
              <Text style={[styles.pipelineOptionText, pipeline === PIPELINES.DRAGON && styles.pipelineOptionTextActive]}>
                Dragon Copilot
              </Text>
            </TouchableOpacity>
          </View>
          {pipeline === PIPELINES.DRAGON && (
            <Text style={styles.pipelineWarning}>
              Recordings are sent to Dragon Copilot for processing — no transcript review step.
            </Text>
          )}
        </View>

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
        ) : (
          <TouchableOpacity style={styles.loadPatientButton} onPress={loadPatientList}>
            <Text style={styles.loadPatientButtonText}>Load Patient List</Text>
          </TouchableOpacity>
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
                  style={[styles.primaryButton, transcribing && styles.buttonDisabled]}
                  onPress={pipeline === PIPELINES.DRAGON ? handleDragonSubmitRecording : handleTranscribe}
                  disabled={transcribing}
                >
                  {transcribing ? (
                    <View style={styles.loadingRow}>
                      <ActivityIndicator color="#fff" size="small" />
                      <Text style={[styles.primaryButtonText, { marginLeft: 10 }]}>
                        {transcribeStep || 'Working…'}
                      </Text>
                    </View>
                  ) : (
                    <Text style={styles.primaryButtonText}>
                      {pipeline === PIPELINES.DRAGON ? 'Send to Dragon Copilot' : 'Transcribe & Summarize'}
                    </Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity style={styles.secondaryButton} onPress={handleDiscard} disabled={transcribing}>
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

  pipelineBlock: { alignItems: 'center', marginBottom: 20, width: '100%' },
  pipelineLabel: {
    fontSize: 10, color: C.textLight, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6,
  },
  pipelineToggle: {
    flexDirection: 'row', backgroundColor: C.blueLight, borderRadius: 10,
    padding: 3, borderWidth: 1, borderColor: C.blueBorder,
  },
  pipelineOption: { paddingVertical: 8, paddingHorizontal: 18, borderRadius: 8 },
  pipelineOptionActive: {
    backgroundColor: C.blue,
    shadowColor: C.blue, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 2,
  },
  pipelineOptionText: { fontSize: 13, fontWeight: '600', color: C.blueMid },
  pipelineOptionTextActive: { color: C.white },
  pipelineWarning: { fontSize: 11, color: C.gold, marginTop: 8, textAlign: 'center' },

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

  loadPatientButton: {
    borderWidth: 1.5, borderColor: C.gold, borderStyle: 'dashed',
    paddingVertical: 10, paddingHorizontal: 24, borderRadius: 10, marginBottom: 32,
    backgroundColor: C.goldLight,
  },
  loadPatientButtonText: { color: C.blue, fontSize: 14, fontWeight: '700' },

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

  debugLink: { marginBottom: 24, marginTop: -8 },
  debugLinkText: { fontSize: 12, color: C.textLight, textDecorationLine: 'underline' },

  logScroll: { flex: 1 },
  logContent: { padding: 12 },
  logEmpty: { color: C.textLight, textAlign: 'center', marginTop: 24 },
  logEntry: { marginBottom: 10, borderBottomWidth: 1, borderBottomColor: C.border, paddingBottom: 8 },
  logMeta: { fontSize: 11, color: C.textLight, marginBottom: 2 },
  logMessage: { fontSize: 12, color: C.textDark, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  logLevelLog: { color: C.textMid },
  logLevelWarn: { color: C.gold },
  logLevelError: { color: C.danger },

  // Transcript & Summary screens
  tsHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.bg,
  },
  backButton: { width: 80 },
  backButtonText: { color: C.gold, fontSize: 16, fontWeight: '600' },
  tsTitle: { fontSize: 17, fontWeight: '700', color: C.blue },
  tsPipelineBadge: {
    fontSize: 10, fontWeight: '700', color: C.blueMid, textTransform: 'uppercase',
    letterSpacing: 0.5, backgroundColor: C.blueLight, borderWidth: 1, borderColor: C.blueBorder,
    borderRadius: 6, paddingVertical: 4, paddingHorizontal: 8, width: 80, textAlign: 'center',
  },
  tsPatientStrip: {
    backgroundColor: C.blueLight, paddingHorizontal: 20, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: C.blueBorder,
  },
  tsPatientName: { fontSize: 14, fontWeight: '700', color: C.blue },
  tsPatientSub: { fontSize: 12, color: C.textMid, marginTop: 1 },
  tsBody: { padding: 20, paddingBottom: 8 },
  tsLabel: { fontSize: 13, color: C.textMid, marginBottom: 12, lineHeight: 18 },
  tsInput: {
    backgroundColor: C.white, borderWidth: 1, borderColor: C.border,
    borderRadius: 12, padding: 16, fontSize: 15, color: C.textDark,
    minHeight: 320, lineHeight: 22,
  },
  tsFooter: {
    padding: 20, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg, gap: 12,
  },
  playbackBar: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.white, borderRadius: 12, padding: 10,
    borderWidth: 1, borderColor: C.border,
  },
  playbackBtn: { padding: 2 },
  playbackInfo: { flex: 1, gap: 4 },
  playbackLabel: { fontSize: 12, fontWeight: '600', color: C.blue },
  progressTrack: { height: 4, backgroundColor: C.border, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: C.gold, borderRadius: 2 },
  playbackTime: { fontSize: 11, color: C.textMid },
  summaryBody: { padding: 20, paddingBottom: 8 },
  summaryText: { fontSize: 15, color: C.textDark, lineHeight: 26 },
});
