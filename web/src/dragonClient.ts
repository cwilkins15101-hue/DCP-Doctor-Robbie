import type * as Dragon from '@microsoft/dragon-copilot-sdk-types';
import { env } from './environment';
import { acquireAccessToken } from './auth';
import type { PatientRecord } from './parseCSV';

function sdk(): typeof Dragon {
  const ns = window.DragonCopilotSDK?.dragon;
  if (!ns) {
    throw new Error(
      'window.DragonCopilotSDK is not available — check that the CDN <script> tag in index.html loaded successfully.'
    );
  }
  return ns;
}

let initialized = false;

export async function initializeDragon(): Promise<void> {
  if (initialized) return;
  const dragon = sdk();

  await dragon.initialize({
    applicationName: env.applicationName,
    partnerGuid: env.partnerGuid,
    environmentId: env.environmentId,
    services: {
      dragonMedicalServer: {
        url: env.dragonMedicalServer.url,
        scope: env.dragonMedicalServer.scope,
      },
    },
    authentication: {
      acquireAccessToken,
      scopeBehavior: 'serviceScoped',
    },
    isAmbientEnabled: true,
    isDictationEnabled: false,
    useConsoleLogger: true,
  });

  initialized = true;
}

function splitName(fullName: string | undefined): { firstName: string; lastName: string } {
  const parts = (fullName ?? '').trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return { firstName: '', lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Builds AmbientSessionData from a patient row parsed out of the roster CSV and hands it to the
 * SDK. Must be called before startRecording({ recordingMode: 'ambient' }).
 */
export async function setAmbientSessionForPatient(patient: PatientRecord | null): Promise<void> {
  const dragon = sdk();
  const { firstName, lastName } = splitName(patient?.['Patient Name']);

  const sessionData: Dragon.recording.ambient.AmbientSessionData = {
    correlationId: crypto.randomUUID(),
    clientApplicationVersion: '0.1.0',
    clientApplicationStableId: 'doctor-robbie-web',
    recordingList: [],
    localeInfo: {
      recordingLocales: ['en-us'],
      encounterReportLocale: 'en-us',
      encounterUxLocale: 'en-us',
    },
    draftAutoCreated: true,
    ehrData: patient
      ? {
          patientId: patient['MRN'] ?? '',
          appointmentId: '',
          mrn: patient['MRN'] ?? '',
          siteId: '',
          reasonForVisit: patient['Chief Complaint'] ?? '',
          physicianName: '',
          physicianId: '',
          version: 1,
          dataOrigin: dragon.recording.ambient.DataOrigins.ManualEntryPhysician,
          patient: {
            id: patient['MRN'] ?? '',
            firstName,
            middleName: '',
            lastName,
            gender: dragon.recording.ambient.Genders.Unspecified,
            pronounPreference: { system: '', identifier: '', description: '' },
            dateOfBirth: patient['DOB'] ?? '',
            dataOrigin: dragon.recording.ambient.DataOrigins.ManualEntryPhysician,
          },
        }
      : undefined,
  };

  await dragon.recording.ambient.setSessionData(sessionData);
}

export async function startAmbientRecording(): Promise<void> {
  await sdk().recording.startRecording({ recordingMode: 'ambient' });
}

export async function stopAmbientRecording(): Promise<void> {
  await sdk().recording.stopRecording({ recordingMode: 'ambient' });
}

export function onUploadStatusChanged(
  handler: (detail: Dragon.recording.ambient.AmbientRecordingUploadStatusChangedDetail) => void
): () => void {
  const dragon = sdk();
  const listener = (e: CustomEvent<Dragon.recording.ambient.AmbientRecordingUploadStatusChangedDetail>) =>
    handler(e.detail);
  dragon.recording.ambient.events.addEventListener('ambientRecordingUploadStatusChanged', listener as EventListener);
  return () =>
    dragon.recording.ambient.events.removeEventListener('ambientRecordingUploadStatusChanged', listener as EventListener);
}

export function onRecordingVolumeChanged(handler: (volume: number) => void): () => void {
  const dragon = sdk();
  const listener = (e: CustomEvent<Dragon.recording.RecordingVolumeChangedDetail>) => handler(e.detail.volume);
  dragon.recording.events.addEventListener('recordingVolumeChanged', listener as EventListener);
  return () => dragon.recording.events.removeEventListener('recordingVolumeChanged', listener as EventListener);
}

export function onErrorOccurred(handler: (detail: Dragon.error.ErrorOccurredDetail) => void): () => void {
  const dragon = sdk();
  const listener = (e: CustomEvent<Dragon.error.ErrorOccurredDetail>) => handler(e.detail);
  dragon.error.events.addEventListener('errorOccurred', listener as EventListener);
  return () => dragon.error.events.removeEventListener('errorOccurred', listener as EventListener);
}
