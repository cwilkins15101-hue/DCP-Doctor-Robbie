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
// CSV-loaded patients ('Patient Name', 'MRN', 'DOB', ...). Keeps the FHIR
// id (CSV-loaded patients don't have one) — the chart screen needs it to
// look up this specific patient's Conditions and CCD afterward.
function toAppPatient(resource) {
  return {
    id: resource.id,
    'Patient Name': nameFromFhir(resource),
    MRN: mrnFromFhir(resource),
    DOB: resource.birthDate ?? '',
    'Visit Date': '',
    'Visit Time': '',
    'Chief Complaint': '',
  };
}

// Converts a FHIR Condition resource into a flat shape for display.
function toAppCondition(resource) {
  return {
    id: resource.id,
    text: resource.code?.text ?? resource.code?.coding?.[0]?.display ?? 'Unknown condition',
    category: resource.category?.[0]?.coding?.[0]?.display ?? resource.category?.[0]?.text ?? '',
    status: resource.clinicalStatus?.coding?.[0]?.code ?? '',
    onset: resource.onsetDateTime ?? resource.recordedDate ?? '',
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

// Fetches this patient's Conditions — Epic surfaces both problem-list items
// and reason-for-visit-derived conditions under the same Condition.Search
// API, so no category filter is needed.
async function fetchConditions(patientId) {
  const accessToken = await EpicAuth.getAccessToken();
  const response = await fetch(`${FHIR_BASE_URL}/Condition?patient=${encodeURIComponent(patientId)}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/fhir+json' },
  });
  if (!response.ok) {
    throw new Error(`Epic Condition fetch failed (${response.status}): ${await response.text()}`);
  }
  const bundle = await response.json();
  return (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .filter((resource) => resource?.resourceType === 'Condition')
    .map(toAppCondition);
}

// Resolves a DocumentReference attachment into its actual text content —
// either it's inline as base64 (attachment.data) or it points at a
// separate Binary to fetch (attachment.url). Shared by CCD and Clinical
// Notes retrieval, which both hand back attachments in this same shape.
async function fetchAttachmentText(attachment, accessToken) {
  if (attachment.data) {
    return globalThis.atob(attachment.data);
  }
  if (attachment.url) {
    // Epic sometimes returns this as a relative reference (e.g.
    // "Binary/abc123") rather than a full URL. Resolved against the app's
    // own address (the default for a relative fetch() in a browser), that
    // silently "succeeds" against the app's own page instead of Epic's
    // server — resolving it against the FHIR base URL instead fixes that.
    const binaryUrl = new URL(attachment.url, `${FHIR_BASE_URL}/`).toString();
    const binaryResponse = await fetch(binaryUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: attachment.contentType || 'application/xml' },
    });
    if (!binaryResponse.ok) {
      throw new Error(`Epic document fetch failed (${binaryResponse.status}): ${await binaryResponse.text()}`);
    }
    return binaryResponse.text();
  }
  throw new Error('The document had neither inline data nor a retrievable URL.');
}

// Retrieves this patient's current CCD (Continuity of Care Document) via
// the DocumentReference $docref operation. Epic generates it on demand and
// returns a DocumentReference pointing at the document. The `patient`
// parameter here is a Reference (Parameters-style operation input), not a
// plain search filter — Epic expects the full "Patient/<id>" form, not the
// bare id (unlike an ordinary ?patient= search filter, which accepts both).
async function fetchCCD(patientId) {
  const accessToken = await EpicAuth.getAccessToken();
  const docRefResponse = await fetch(
    `${FHIR_BASE_URL}/DocumentReference/$docref?patient=${encodeURIComponent(`Patient/${patientId}`)}`,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/fhir+json' } }
  );
  if (!docRefResponse.ok) {
    throw new Error(`Epic CCD lookup failed (${docRefResponse.status}): ${await docRefResponse.text()}`);
  }
  const bundle = await docRefResponse.json();
  const docRef = (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .find((resource) => resource?.resourceType === 'DocumentReference');
  const attachment = docRef?.content?.[0]?.attachment;
  if (!attachment) {
    throw new Error('Epic did not return a CCD document for this patient.');
  }

  const meta = {
    type: docRef.type?.text ?? docRef.type?.coding?.[0]?.display ?? 'Continuity of Care Document',
    date: docRef.date ?? '',
  };
  const xml = await fetchAttachmentText(attachment, accessToken);
  return { xml, meta };
}

// Converts a FHIR DocumentReference (Clinical Notes category) into a flat
// shape for display. Keeps the raw attachment so its text can be fetched
// later, on demand, only if the physician taps into that specific note.
function toAppClinicalNote(resource) {
  return {
    id: resource.id,
    title: resource.type?.text ?? resource.type?.coding?.[0]?.display ?? 'Clinical Note',
    date: resource.date ?? '',
    author: resource.author?.[0]?.display ?? '',
    attachment: resource.content?.[0]?.attachment ?? null,
  };
}

// Lists this patient's clinical notes (progress notes, H&P, discharge
// summaries, etc.) — the actual free-text documents clinicians wrote, as
// opposed to the system-generated CCD summary.
async function fetchClinicalNotes(patientId) {
  const accessToken = await EpicAuth.getAccessToken();
  const response = await fetch(
    `${FHIR_BASE_URL}/DocumentReference?patient=${encodeURIComponent(patientId)}&category=clinical-note`,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/fhir+json' } }
  );
  if (!response.ok) {
    throw new Error(`Epic Clinical Notes fetch failed (${response.status}): ${await response.text()}`);
  }
  const bundle = await response.json();
  return (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .filter((resource) => resource?.resourceType === 'DocumentReference')
    .map(toAppClinicalNote);
}

// Fetches the actual text of one clinical note (as returned by
// fetchClinicalNotes) — done lazily, per note, since a patient can have
// many and most won't be opened.
async function fetchClinicalNoteText(note) {
  if (!note.attachment) {
    throw new Error('This note has no retrievable content.');
  }
  const accessToken = await EpicAuth.getAccessToken();
  return fetchAttachmentText(note.attachment, accessToken);
}

export const EpicClient = {
  fetchSandboxPatients,
  fetchConditions,
  fetchCCD,
  fetchClinicalNotes,
  fetchClinicalNoteText,
  missingConfigKeys: EpicAuth.missingConfigKeys,
};
