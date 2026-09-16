// ---------------------------------------------------------------------------
// Client for the Epic on FHIR sandbox's FHIR R4 API. The sandbox doesn't
// support an open-ended "list all patients" search, so this fetches the
// documented sandbox test patients (see "Sandbox Test Data") directly by
// their known FHIR IDs, then converts each FHIR Patient resource into the
// same shape used by CSV-loaded patients so the existing patient list/
// selection UI works unchanged regardless of the source.
// ---------------------------------------------------------------------------
import { EpicAuth } from './epicAuth';

const SANDBOX_BASE_URL = (
  process.env.EXPO_PUBLIC_EPIC_SANDBOX_URL || 'https://fhir.epic.com/interconnect-fhir-oauth'
).replace(/\/$/, '');
const FHIR_BASE_URL = `${SANDBOX_BASE_URL}/api/FHIR/R4`;

// The Epic on FHIR sandbox's documented test patients.
const SANDBOX_PATIENT_IDS = [
  'erXuFYUfucBZaryVksYEcMg3', // Camila Lopez
  'eq081-VQEgP8drUUqCWzHfw3', // Derrick Lin
  'eAB3mDIBBcyUKviyzrxsnAw3', // Desiree Powell
  'egqBHVfQlt4Bw3XGXoxVxHg3', // Elijah Davis
  'eIXesllypH3M9tAA5WdJftQ3', // Linda Ross
  'eh2xYHuzl9nkSFVvV3osUHg3', // Olivia Roberts
  'e0w0LEDCYtfckT6N.CkJKCw3', // Warren McGinnis
];

function nameFromFhir(resource) {
  const name = resource.name?.[0];
  if (!name) return 'Unknown';
  if (name.text) return name.text;
  return [...(name.given ?? []), name.family].filter(Boolean).join(' ') || 'Unknown';
}

function mrnFromFhir(resource) {
  const identifiers = resource.identifier ?? [];
  const mrn = identifiers.find((id) => id.type?.coding?.some((c) => c.code === 'MR'));
  return mrn?.value ?? identifiers[0]?.value ?? '';
}

// Converts a FHIR Patient resource into the same field names used by
// CSV-loaded patients ('Patient Name', 'MRN', 'DOB', ...).
function toAppPatient(resource) {
  return {
    'Patient Name': nameFromFhir(resource),
    MRN: mrnFromFhir(resource),
    DOB: resource.birthDate ?? '',
    'Visit Date': '',
    'Visit Time': '',
    'Chief Complaint': '',
  };
}

async function fetchPatient(id, accessToken) {
  const response = await fetch(`${FHIR_BASE_URL}/Patient/${id}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/fhir+json' },
  });
  if (!response.ok) {
    throw new Error(`Epic Patient fetch failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

// Signs in if needed, then fetches the sandbox's documented test patients.
async function fetchSandboxPatients() {
  const accessToken = await EpicAuth.getAccessToken();
  const resources = await Promise.all(SANDBOX_PATIENT_IDS.map((id) => fetchPatient(id, accessToken)));
  return resources.map(toAppPatient);
}

export const EpicClient = { fetchSandboxPatients, missingConfigKeys: EpicAuth.missingConfigKeys };
