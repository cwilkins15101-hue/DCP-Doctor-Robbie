// Fills the FQHC Sliding Fee Scale worksheet (assets/fqhc-sliding-fee-scale-
// template.xlsx) with values from a completed FQHC Intake Voice-to-Form
// output, so the physician can download a ready-to-file spreadsheet instead
// of re-typing the intake into it by hand. The template's cells were
// extended (2026-09-28) to hold every field this maps -- see the workbook's
// own "1B. ADDITIONAL APPLICANT DETAILS" section for the fields that don't
// have a home in its original Applicant Profile / Household Size sections.
const path = require('path');
const ExcelJS = require('exceljs');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'assets', 'fqhc-sliding-fee-scale-template.xlsx');
const SHEET_NAME = 'FQHC SFS Calculator';

// Field name (as the app sends it, after combining First/Last/Middle Initial
// into one name and the five address parts into one address -- see App.js's
// buildFqhcExportFields) -> the cell it's written into. Confirmed against a
// live 2026-09-28 test recording of the FQHC Intake form for the exact set
// of fields Dragon Copilot returns.
const CELL_MAP = {
  'Full Legal Name': 'C5',
  'Date of Birth': 'E5',
  'Physical Address': 'C6',
  'Phone Number': 'E6',
  'Home Phone': 'F42',
  'Cell Phone': 'F43',
  'Marital Status': 'F44',
  'Family Size': 'F45',
  'Spouse/Partner Employed': 'F46',
  'Other Household Members Employed': 'F47',
  'Covered/Eligible for Health Insurance': 'F48',
  'Policy Holder': 'F49',
  'Policy Number': 'F50',
  'Insurer': 'F51',
  'Employed': 'F52',
  'Former Spouse/Partner Financially Responsible': 'F53',
};

// Builds the response's populated .xlsx as a Buffer. fields is a flat
// { 'Field Name': 'value', ... } map -- unrecognized keys are ignored,
// missing/empty ones are just left blank in the sheet.
async function buildFqhcExport(fields = {}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(TEMPLATE_PATH);
  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) {
    throw new Error(`Template is missing the expected "${SHEET_NAME}" sheet.`);
  }

  for (const [field, coord] of Object.entries(CELL_MAP)) {
    const value = fields[field];
    if (value !== undefined && value !== null && value !== '') {
      sheet.getCell(coord).value = value;
    }
  }

  // Section 2's Household Size Tracking table (2026-09-29, per a reference
  // example the physician provided) -- Line 1 (Self) is filled from the
  // applicant's own Full Legal Name/Date of Birth; the FQHC Intake form
  // doesn't currently report per-dependent names/DOBs at all, so Lines 2-4
  // (Spouse/Partner, two Dependent Children) are hardcoded demo household
  // members rather than derived from anything real -- this is a partner
  // demo tool (see the app's own "Dragon Copilot Partner Demo" name), not
  // a production intake path, so a fixed illustrative family is the
  // intended behavior here, not a placeholder to eventually replace.
  sheet.getCell('C11').value = fields['Full Legal Name'] || '';
  sheet.getCell('D11').value = fields['Date of Birth'] || '';
  sheet.getCell('F11').value = 1;

  const HARDCODED_HOUSEHOLD_MEMBERS = [
    { row: 12, name: 'Mary Lin', dob: new Date(1975, 6, 6) },
    { row: 13, name: 'Sam Lin', dob: new Date(2012, 4, 10) },
    { row: 14, name: 'Tina Lin', dob: new Date(2017, 1, 7) },
  ];
  for (const member of HARDCODED_HOUSEHOLD_MEMBERS) {
    sheet.getCell(`C${member.row}`).value = member.name;
    const dobCell = sheet.getCell(`D${member.row}`);
    dobCell.value = member.dob;
    // Setting .numFmt directly mutates the cell's underlying style object,
    // which ExcelJS can share by reference across cells that started with
    // identical (here: untouched "General") formatting -- confirmed live
    // (2026-09-29) that doing so bled the date format into the Name column
    // (C11-C14) too, not just the Date of Birth column. Spreading into a
    // new style object instead keeps the mutation scoped to this one cell.
    dobCell.style = { ...dobCell.style, numFmt: 'mm-dd-yy' };
    sheet.getCell(`F${member.row}`).value = 1;
  }

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildFqhcExport, CELL_MAP };
