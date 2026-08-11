import { useEffect, useRef, useState } from 'react';
import type * as Dragon from '@microsoft/dragon-copilot-sdk-types';
import { initMsal, signIn, getActiveAccount, type AccountInfo } from './auth';
import {
  initializeDragon,
  setAmbientSessionForPatient,
  startAmbientRecording,
  stopAmbientRecording,
  onUploadStatusChanged,
  onRecordingVolumeChanged,
  onErrorOccurred,
} from './dragonClient';
import { parseCSV, type PatientRecord } from './parseCSV';
import { MarkdownNote } from './components/MarkdownNote';

type Screen = 'signin' | 'patient' | 'record' | 'note';
type UploadStatus = Dragon.recording.ambient.AmbientRecordingUploadStatus | 'idle';

export default function App() {
  const [screen, setScreen] = useState<Screen>('signin');
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [patients, setPatients] = useState<PatientRecord[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<PatientRecord | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [volume, setVolume] = useState(0);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
  const [noteText, setNoteText] = useState('');

  const cleanupFns = useRef<Array<() => void>>([]);

  useEffect(() => {
    initMsal()
      .then(() => {
        const existing = getActiveAccount();
        if (existing) setAccount(existing);
      })
      .catch(err => setErrorMsg(String(err)));
  }, []);

  useEffect(() => {
    if (screen !== 'record') return;
    const offVolume = onRecordingVolumeChanged(setVolume);
    const offUpload = onUploadStatusChanged(detail => {
      setUploadStatus(detail.status);
      if (detail.status === 'uploadCompleted') setScreen('note');
    });
    const offError = onErrorOccurred(detail => setErrorMsg(`${detail.title}: ${detail.message}`));
    cleanupFns.current = [offVolume, offUpload, offError];
    return () => cleanupFns.current.forEach(fn => fn());
  }, [screen]);

  async function handleSignIn() {
    setBusy(true);
    setErrorMsg(null);
    try {
      const acc = await signIn();
      setAccount(acc);
      await initializeDragon();
      setScreen('patient');
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setPatients(parseCSV(text));
  }

  async function handleSelectPatientAndContinue() {
    setBusy(true);
    setErrorMsg(null);
    try {
      await setAmbientSessionForPatient(selectedPatient);
      setScreen('record');
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleStartRecording() {
    setErrorMsg(null);
    setUploadStatus('idle');
    try {
      await startAmbientRecording();
      setIsRecording(true);
    } catch (err) {
      setErrorMsg(String(err));
    }
  }

  async function handleStopRecording() {
    try {
      await stopAmbientRecording();
      setIsRecording(false);
    } catch (err) {
      setErrorMsg(String(err));
    }
  }

  function handleNewRecording() {
    setNoteText('');
    setUploadStatus('idle');
    setScreen('record');
  }

  return (
    <div>
      <h1>🩺 Doctor Robbie — Dragon Copilot</h1>
      {errorMsg && <div className="card status-pill error">{errorMsg}</div>}

      {screen === 'signin' && (
        <div className="card">
          <h2>Sign in</h2>
          <p className="hint">Sign in with your Microsoft Entra account to connect to Dragon Copilot.</p>
          <button className="btn btn-primary" onClick={handleSignIn} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in with Microsoft'}
          </button>
        </div>
      )}

      {screen === 'patient' && (
        <div className="card">
          <h2>Select patient</h2>
          <p className="hint">Signed in as {account?.username}. Upload the patient roster CSV, or continue without one.</p>
          <input type="file" accept=".csv,.tsv,text/csv" onChange={handleCsvUpload} />
          {patients.length > 0 && (
            <select
              value={selectedPatient?.['MRN'] ?? ''}
              onChange={e => setSelectedPatient(patients.find(p => p['MRN'] === e.target.value) ?? null)}
              style={{ marginTop: 12 }}
            >
              <option value="">— Select a patient —</option>
              {patients.map(p => (
                <option key={p['MRN']} value={p['MRN']}>
                  {p['Patient Name']} ({p['MRN']})
                </option>
              ))}
            </select>
          )}
          <div style={{ marginTop: 16 }}>
            <button className="btn btn-primary" onClick={handleSelectPatientAndContinue} disabled={busy}>
              Continue
            </button>
          </div>
        </div>
      )}

      {screen === 'record' && (
        <div className="card">
          <h2>Ambient recording</h2>
          {selectedPatient && <p className="hint">Patient: {selectedPatient['Patient Name']}</p>}
          <div className="volume-meter">
            <div className="volume-meter-fill" style={{ width: `${volume}%` }} />
          </div>
          <span className={`status-pill ${uploadStatus === 'uploadFailed' ? 'error' : uploadStatus === 'uploadCompleted' ? 'ok' : ''}`}>
            {uploadStatus === 'idle' ? (isRecording ? 'Recording…' : 'Not recording') : uploadStatus}
          </span>
          <div style={{ marginTop: 16 }}>
            {!isRecording ? (
              <button className="btn btn-primary" onClick={handleStartRecording}>Start ambient recording</button>
            ) : (
              <button className="btn btn-danger" onClick={handleStopRecording}>Stop recording</button>
            )}
          </div>
        </div>
      )}

      {screen === 'note' && (
        <div className="card">
          <h2>Clinical note</h2>
          <p className="hint">
            Dragon Copilot generates the draft note server-side and delivers it to your EHR through the
            EHR Integration Service — that hand-off is a backend/FHIR integration, not part of the browser
            SDK, so it isn't wired up in this prototype. Paste the generated note below (e.g. from Dragon
            Admin Center or your backend's webhook payload) to preview it here.
          </p>
          <textarea rows={10} value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="## Subjective&#10;..." />
          {noteText && (
            <div style={{ marginTop: 16 }}>
              <MarkdownNote text={noteText} />
            </div>
          )}
          <div style={{ marginTop: 16 }}>
            <button className="btn btn-secondary" onClick={handleNewRecording}>New recording</button>
          </div>
        </div>
      )}
    </div>
  );
}
