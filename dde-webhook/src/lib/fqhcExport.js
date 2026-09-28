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

  // Section 2's Household Size Tracking table (2026-09-28, per live
  // testing) -- Line 1 is always Self, so it always counts; Line 2 is
  // always Spouse/Partner, which only counts when the applicant reports
  // being married. Everything else in that table (dependents, their
  // names/DOBs) is left alone for now -- the form doesn't currently report
  // per-dependent detail, just a household size total.
  sheet.getCell('C11').value = fields['Full Legal Name'] || '';
  sheet.getCell('F11').value = 1;
  const maritalStatus = String(fields['Marital Status'] || '').trim().toUpperCase();
  if (maritalStatus === 'M') {
    sheet.getCell('F12').value = 1;
  }

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildFqhcExport, CELL_MAP };
