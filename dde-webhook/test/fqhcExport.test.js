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

test('always marks Self as counting toward household size, with their name', async () => {
  const buffer = await buildFqhcExport({ 'Full Legal Name': 'Jane Doe', 'Marital Status': 'S' });
  const sheet = await loadSheet(buffer);

  assert.equal(sheet.getCell('C11').value, 'Jane Doe');
  assert.equal(sheet.getCell('F11').value, 1);
  assert.equal(sheet.getCell('F12').value, null);
});

test('marks Spouse/Partner as counting toward household size when Marital Status is M', async () => {
  const buffer = await buildFqhcExport({ 'Full Legal Name': 'Jane Doe', 'Marital Status': 'M' });
  const sheet = await loadSheet(buffer);

  assert.equal(sheet.getCell('F11').value, 1);
  assert.equal(sheet.getCell('F12').value, 1);
});

test('Marital Status match is case-insensitive and trims whitespace', async () => {
  const buffer = await buildFqhcExport({ 'Marital Status': ' m ' });
  const sheet = await loadSheet(buffer);

  assert.equal(sheet.getCell('F12').value, 1);
});

test('an unrecognized field name is ignored rather than throwing', async () => {
  await assert.doesNotReject(buildFqhcExport({ 'Not A Real Field': 'x' }));
});
