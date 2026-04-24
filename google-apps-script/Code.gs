/**
 * Inventory reader for the LP2P dashboard.
 *
 * Returns each row of the inventory sheet with:
 *   - values: [nom, achat, revente, benef]
 *   - color:  '#rrggbb' — background color of the "nom" cell (used to infer sold/in-stock)
 *
 * Deploy as a Web App (Deploy > New deployment > Web app):
 *   Execute as: Me
 *   Who has access: Anyone
 * Then copy the /exec URL into the dashboard via the "Apps Script (couleurs)" button.
 */

const INVENTORY_SHEET_ID = '1jSQNoni7qW6ShnRw3hi_g_fF90qn5YZ3koRaL1gYTLE';
// If your tab has a different name, change this. Empty = first sheet.
const SHEET_TAB_NAME = '';

function doGet(e) {
  const ss = SpreadsheetApp.openById(INVENTORY_SHEET_ID);
  const sheet = SHEET_TAB_NAME ? ss.getSheetByName(SHEET_TAB_NAME) : ss.getSheets()[0];
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Sheet not found' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) {
    return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }
  // We only need the first 4 columns (Nom, Achat, Revente, Benef).
  const range = sheet.getRange(1, 1, lastRow, 4);
  const values = range.getValues();
  const bgs = range.getBackgrounds(); // 2D array of hex strings, one per cell
  const out = values.map((row, i) => ({
    values: row.map(function (v) { return v === null || v === undefined ? '' : String(v); }),
    // Color of the "Nom" cell (col A) drives the stock status
    color: bgs[i][0] || '',
  }));
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}
