const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const { buildFqhcExport } = require('../src/lib/fqhcExport');

async function loadSheet(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook.getWorksheet('FQHC SFS Calculator');
}

test('writes each mapped field into its cell', async () => {
  const buffer = await buildFqhcExport({
    'Full Legal Name': 'Jane A Doe',
    'Date of Birth': '1990-01-01',
    'Physical Address': '123 Main St, Apt 4, Springfield, IL 62701',
    'Phone Number': '555-0100',
    'Home Phone': '555-0101',
    'Cell Phone': '555-0102',
    'Marital Status': 'S',
    'Family Size': '1',
    'Policy Holder': 'Jane A Doe',
    Insurer: 'Acme Health',
  });
  const sheet = await loadSheet(buffer);

  assert.equal(sheet.getCell('C5').value, 'Jane A Doe');
  assert.equal(sheet.getCell('E5').value, '1990-01-01');
  assert.equal(sheet.getCell('C6').value, '123 Main St, Apt 4, Springfield, IL 62701');
  assert.equal(sheet.getCell('E6').value, '555-0100');
  assert.equal(sheet.getCell('F42').value, '555-0101');
  assert.equal(sheet.getCell('F43').value, '555-0102');
  assert.equal(sheet.getCell('F44').value, 'S');
  assert.equal(sheet.getCell('F45').value, '1');
  assert.equal(sheet.getCell('F49').value, 'Jane A Doe');
  assert.equal(sheet.getCell('F51').value, 'Acme Health');
});

test('leaves unset fields blank rather than writing empty strings', async () => {
  const buffer = await buildFqhcExport({ 'Full Legal Name': 'Jane Doe' });
  const sheet = await loadSheet(buffer);

  assert.equal(sheet.getCell('E5').value, null);
  assert.equal(sheet.getCell('F49').value, null);
});

test('fills Self (Line 1) from the applicant\'s own name/DOB and marks them as counting', async () => {
  const buffer = await buildFqhcExport({ 'Full Legal Name': 'Jane Doe', 'Date of Birth': '1990-01-01' });
  const sheet = await loadSheet(buffer);

  assert.equal(sheet.getCell('C11').value, 'Jane Doe');
  assert.equal(sheet.getCell('D11').value, '1990-01-01');
  assert.equal(sheet.getCell('F11').value, 1);
});

// The FQHC Intake form doesn't report per-dependent names/DOBs at all, so
// Lines 2-4 are a fixed illustrative household (this is a partner demo
// tool, not a production intake path -- see fqhcExport.js) rather than
// something derived from the actual encounter, regardless of what Marital
// Status or Family Size came back.
test('hardcodes Spouse/Partner and two Dependent Children as counting toward household size', async () => {
  const buffer = await buildFqhcExport({ 'Full Legal Name': 'Jane Doe' });
  const sheet = await loadSheet(buffer);

  assert.equal(sheet.getCell('C12').value, 'Mary Lin');
  assert.equal(sheet.getCell('D12').value.getTime(), new Date(1975, 6, 6).getTime());
  assert.equal(sheet.getCell('F12').value, 1);

  assert.equal(sheet.getCell('C13').value, 'Sam Lin');
  assert.equal(sheet.getCell('D13').value.getTime(), new Date(2012, 4, 10).getTime());
  assert.equal(sheet.getCell('F13').value, 1);

  assert.equal(sheet.getCell('C14').value, 'Tina Lin');
  assert.equal(sheet.getCell('D14').value.getTime(), new Date(2017, 1, 7).getTime());
  assert.equal(sheet.getCell('F14').value, 1);
});

test('Total Household Size formula sums to 4 for the hardcoded household', async () => {
  const buffer = await buildFqhcExport({ 'Full Legal Name': 'Jane Doe' });
  const sheet = await loadSheet(buffer);

  const f11 = sheet.getCell('F11').value;
  const f12 = sheet.getCell('F12').value;
  const f13 = sheet.getCell('F13').value;
  const f14 = sheet.getCell('F14').value;
  const f15 = sheet.getCell('F15').value || 0;
  assert.equal(f11 + f12 + f13 + f14 + f15, 4);
});

test('an unrecognized field name is ignored rather than throwing', async () => {
  await assert.doesNotReject(buildFqhcExport({ 'Not A Real Field': 'x' }));
});
