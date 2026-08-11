export type PatientRecord = Record<string, string>;

// Ported from the mobile app's parseCSV — same roster CSV/TSV format, framework-agnostic.
export function parseCSV(text: string): PatientRecord[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const splitLine = (line: string) => line.split(delimiter).map(v => v.trim().replace(/^"|"$/g, ''));
  const headers = splitLine(lines[0]);
  return lines
    .slice(1)
    .filter(line => line.trim().length > 0)
    .map(line => {
      const values = splitLine(line);
      return headers.reduce<PatientRecord>((obj, h, i) => ({ ...obj, [h]: values[i] ?? '' }), {});
    });
}
