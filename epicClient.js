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
// look up this specific patient's Conditions, IPS, and notes afterward.
function toAppPatient(resource) {
  return {
    id: resource.id,
    'Patient Name': nameFromFhir(resource),
    MRN: mrnFromFhir(resource),
    DOB: resource.birthDate ?? '',
    // FHIR's gender values (male/female/other/unknown) match Dragon
    // Copilot's Token Launch API's patientGender values exactly, so this
    // is passed straight through with no translation.
    Gender: resource.gender ?? '',
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

// Base64 of a UTF-8 string without relying on Buffer/btoa being present on
// every platform this app runs on (web, iOS, Android).
function utf8ToBase64(text) {
  const bytes = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += chars[a >> 2] + chars[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : chars[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : chars[c & 63];
  }
  return out;
}

// Epic won't file a note without a valid Encounter ("Valid encounter
// required"), so find one for this patient. Prefers the patient's most
// recent Encounter (needs "Encounter.Search" on the Epic app); if that isn't
// available, falls back to the encounter an existing note of theirs
// already belongs to (works with the Clinical Notes entries the app has).
function encounterIdFromReference(reference) {
  return typeof reference === 'string' ? reference.split('Encounter/')[1]?.split(/[/?#]/)[0] || null : null;
}

async function findEncounterId(patientId, accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/fhir+json' };

  try {
    const response = await fetch(`${FHIR_BASE_URL}/Encounter?patient=${encodeURIComponent(patientId)}`, { headers });
    if (response.ok) {
      const encounters = ((await response.json()).entry ?? [])
        .map((entry) => entry.resource)
        .filter((resource) => resource?.resourceType === 'Encounter' && resource.id);
      encounters.sort((a, b) => String(b.period?.start ?? '').localeCompare(String(a.period?.start ?? '')));
      if (encounters[0]) return encounters[0].id;
    }
  } catch {
    // Fall through to the notes-based lookup.
  }

  const response = await fetch(
    `${FHIR_BASE_URL}/DocumentReference?patient=${encodeURIComponent(patientId)}&category=clinical-note`,
    { headers }
  );
  if (response.ok) {
    const notes = ((await response.json()).entry ?? [])
      .map((entry) => entry.resource)
      .filter((resource) => resource?.resourceType === 'DocumentReference');
    notes.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
    for (const note of notes) {
      const id = encounterIdFromReference(note.context?.encounter?.[0]?.reference);
      if (id) return id;
    }
  }
  return null;
}

// LOINC code Epic files the note under. 11506-3 ("Subsequent evaluation
// note") is one of the two note classes Epic's Clinical Notes API names;
// override if your Epic app is set up for a different note type.
const NOTE_LOINC_CODE = process.env.EXPO_PUBLIC_EPIC_NOTE_LOINC || '11506-3';
const NOTE_LOINC_DISPLAY = process.env.EXPO_PUBLIC_EPIC_NOTE_LOINC_DISPLAY || 'Subsequent evaluation note';

// Files plain text as a clinical note on this patient's chart
// (DocumentReference.Create). Epic's error body is passed through as-is so
// a rejection says exactly what Epic wants changed (missing encounter,
// unsupported note type, missing API permission, ...).
async function createClinicalNote(patientId, { title, text, encounterId: givenEncounterId }) {
  const accessToken = await EpicAuth.getAccessToken();
  const encounterId = givenEncounterId ?? (await findEncounterId(patientId, accessToken));
  if (!encounterId) {
    throw new Error(
      "Epic requires a visit (encounter) on every note, and none could be found for this patient. " +
        'Add "Encounter.Search" (R4) to your Epic app\'s Incoming APIs, or open a visit for this patient in Epic.'
    );
  }
  const resource = {
    resourceType: 'DocumentReference',
    status: 'current',
    type: {
      coding: [{ system: 'http://loinc.org', code: NOTE_LOINC_CODE, display: NOTE_LOINC_DISPLAY }],
      text: title,
    },
    subject: { reference: `Patient/${patientId}` },
    date: new Date().toISOString(),
    description: title,
    content: [{ attachment: { contentType: 'text/plain', data: utf8ToBase64(text) } }],
  };
  if (encounterId) resource.context = { encounter: [{ reference: `Encounter/${encounterId}` }] };

  const response = await fetch(`${FHIR_BASE_URL}/DocumentReference`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/fhir+json',
      'Content-Type': 'application/fhir+json',
    },
    body: JSON.stringify(resource),
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    const wwwAuth = response.headers.get('WWW-Authenticate');
    throw new Error(
      `Epic note creation failed (${response.status}): ${detail || '(Epic gave no explanation)'}` +
        (wwwAuth ? `\nWWW-Authenticate: ${wwwAuth}` : '') +
        `\nTo diagnose, open View Log and look for "Epic sign-in granted scopes".`
    );
  }
  const location = response.headers.get('Location') ?? '';
  return { id: location.split('/DocumentReference/')[1]?.split('/')[0] ?? null };
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
// separate Binary to fetch (attachment.url).
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

// Retrieves the International Patient Summary (IPS) — Epic's newer
// alternative to a plain CCD. A single Patient $summary call generates a
// Bundle with a Composition (summarizing what's inside) plus discrete FHIR
// resources for Problems, Allergies, Medications, and Immunizations. Each
// Composition section also carries ready-to-render narrative HTML, so no
// separate document-then-binary fetch (and no C-CDA XML parsing) is needed.
async function fetchIPS(patientId) {
  const accessToken = await EpicAuth.getAccessToken();
  const params = new URLSearchParams({
    profile: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Composition-uv-ips',
  });
  const response = await fetch(
    `${FHIR_BASE_URL}/Patient/${encodeURIComponent(patientId)}/$summary?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/fhir+json' } }
  );
  if (!response.ok) {
    throw new Error(`Epic IPS lookup failed (${response.status}): ${await response.text()}`);
  }
  const bundle = await response.json();
  const resources = (bundle.entry ?? []).map((entry) => entry.resource);
  const composition = resources.find((resource) => resource?.resourceType === 'Composition');
  if (!composition) {
    throw new Error('Epic did not return an International Patient Summary for this patient.');
  }
  const patientResource = resources.find((resource) => resource?.resourceType === 'Patient');

  const sections = [];
  if (composition.text?.div) {
    sections.push({ id: 'document-overview', title: 'Document Overview', html: composition.text.div });
  }
  if (patientResource?.text?.div) {
    sections.push({ id: 'patient-summary', title: 'Patient Summary', html: patientResource.text.div });
  }
  sections.push(
    ...(composition.section ?? [])
      .filter((section) => section.text?.div)
      .map((section, index) => ({
        id: `${index}-${section.title ?? 'section'}`,
        title: section.title ?? 'Section',
        html: section.text.div,
      }))
  );

  return { generatedAt: bundle.timestamp ?? composition.date ?? '', sections };
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
// opposed to the system-generated IPS summary.
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
  fetchIPS,
  fetchClinicalNotes,
  fetchClinicalNoteText,
  createClinicalNote,
  missingConfigKeys: EpicAuth.missingConfigKeys,
};
