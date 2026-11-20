// Writes a real Excel workbook (.xlsx) with no outside packages.
//
// An .xlsx file is a zip of small XML files. This writes just enough of them for a
// workbook Excel, Numbers, and Google Sheets open cleanly: typed cells (text, numbers,
// dates, money), a frozen header row with filters, column widths, and clickable links.
// Text is always written as text, never as a formula, so a customer can't plant one.
//
//   workbook([{ name, columns: [{ header, type, width }], rows: [[...]] }], { timeZone })
//   types: text | int | number | money (given in cents) | date | datetime | link ({ text, url })

const zlib = require("node:zlib");

const STYLE = { text: 0, header: 1, date: 2, datetime: 3, money: 4, int: 5, link: 6, number: 0 };
const EXCEL_DAY_ZERO = Date.UTC(1899, 11, 30);

function escapeXml(value) {
  return String(value)
    .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function columnLetters(index) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

// Excel stores a date as days since the end of 1899, in local wall-clock time.
function excelDate(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric"
  }).formatToParts(date)) parts[part.type] = Number(part.value);
  const wallClock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (wallClock - EXCEL_DAY_ZERO) / 86400000;
}

function cell(ref, type, value, timeZone, links) {
  if (value === null || value === undefined || value === "") return "";
  if (type === "link") {
    if (!value.url || !value.text) return "";
    links.push({ ref, url: value.url });
    return `<c r="${ref}" t="inlineStr" s="${STYLE.link}"><is><t xml:space="preserve">${escapeXml(value.text)}</t></is></c>`;
  }
  if (type === "date" || type === "datetime") {
    const serial = excelDate(value, timeZone);
    return serial === null ? "" : `<c r="${ref}" s="${STYLE[type]}"><v>${type === "date" ? Math.floor(serial) : serial}</v></c>`;
  }
  if (type === "int" || type === "number" || type === "money") {
    const number = type === "money" ? Number(value) / 100 : Number(value);
    return Number.isFinite(number) ? `<c r="${ref}" s="${STYLE[type]}"><v>${number}</v></c>` : "";
  }
  return `<c r="${ref}" t="inlineStr" s="${STYLE.text}"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function sheetXml(sheet, first, timeZone) {
  const links = [];
  const lastColumn = columnLetters(sheet.columns.length - 1);
  const lastRow = sheet.rows.length + 1;
  const header = sheet.columns.map((column, c) =>
    `<c r="${columnLetters(c)}1" t="inlineStr" s="${STYLE.header}"><is><t xml:space="preserve">${escapeXml(column.header)}</t></is></c>`).join("");
  const rows = sheet.rows.map((row, r) =>
    `<row r="${r + 2}">${sheet.columns.map((column, c) => cell(columnLetters(c) + (r + 2), column.type || "text", row[c], timeZone, links)).join("")}</row>`).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<dimension ref="A1:${lastColumn}${lastRow}"/>` +
    `<sheetViews><sheetView workbookViewId="0"${first ? ' tabSelected="1"' : ""}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<cols>${sheet.columns.map((column, c) => `<col min="${c + 1}" max="${c + 1}" width="${column.width || 14}" customWidth="1"/>`).join("")}</cols>` +
    `<sheetData><row r="1">${header}</row>${rows}</sheetData>` +
    `<autoFilter ref="A1:${lastColumn}${lastRow}"/>` +
    (links.length ? `<hyperlinks>${links.map((link, i) => `<hyperlink ref="${link.ref}" r:id="rId${i + 1}"/>`).join("")}</hyperlinks>` : "") +
    `</worksheet>`;
  const rels = links.length ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    links.map((link, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(link.url)}" TargetMode="External"/>`).join("") +
    `</Relationships>` : "";
  return { xml, rels };
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="3"><numFmt numFmtId="164" formatCode="mmm d, yyyy"/><numFmt numFmtId="165" formatCode="mmm d, yyyy h:mm AM/PM"/><numFmt numFmtId="166" formatCode="&quot;$&quot;#,##0.00"/></numFmts>` +
  `<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF2F5D7C"/><name val="Calibri"/></font></fonts>` +
  `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF13283A"/><bgColor indexed="64"/></patternFill></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="7">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

// A sheet's tab name: at most 31 characters, and none of the ones Excel refuses.
function tabName(name, used) {
  let clean = String(name).replace(/[\[\]:*?\/\\]/g, " ").trim().slice(0, 31) || "Sheet";
  while (used.has(clean.toLowerCase())) clean = clean.slice(0, 28) + " " + (used.size + 1);
  used.add(clean.toLowerCase());
  return clean;
}

function zip(files) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const body = [];
  const directory = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const raw = Buffer.from(file.data, "utf8");
    const packed = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    body.push(local, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const index = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, index, end]);
}

function workbook(sheets, { timeZone = "America/New_York" } = {}) {
  const used = new Set();
  const names = sheets.map((sheet) => tabName(sheet.name, used));
  const built = sheets.map((sheet, i) => sheetXml(sheet, i === 0, timeZone));
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const files = [
    { name: "[Content_Types].xml", data: head + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      sheets.map((sheet, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", data: head + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: head + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
      names.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") + `</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: head + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets.map((sheet, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: STYLES_XML }
  ];
  built.forEach((sheet, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheet.xml });
    if (sheet.rels) files.push({ name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, data: sheet.rels });
  });
  return zip(files);
}

module.exports = { workbook };
