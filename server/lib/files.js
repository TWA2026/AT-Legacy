// Pictures and files a customer adds to a request.
//
// The browser turns every picture into a JPEG before it is sent (site/uploads.js), so the server
// takes two kinds of file only: JPEG pictures and PDF documents. They are kept in the database,
// which has a small disk, so every limit here is deliberate. See "Pictures and files" in README.md.

const { esc } = require("./html");

// What each group of files is. A document waits for the owner before any company sees it,
// because surveys and plans often carry a name or an address.
// `title` is what the customer reads. `theirs` is the same heading for the owner and for companies.
const KINDS = {
  site: { title: "The area today", theirs: "The area today", sharing: "shared" },
  idea: { title: "Ideas you like", theirs: "Ideas the customer likes", sharing: "shared" },
  document: { title: "Plans or documents", theirs: "Plans or documents", sharing: "review" }
};
const KIND_ORDER = ["site", "idea", "document"];
const SHARING = ["shared", "review", "private"];

const MB = 1024 * 1024;
const LIMITS = {
  filesPerRequest: 10,
  // Room for ten pictures at their largest.
  bytesPerRequest: 15 * MB,
  jpegBytes: Math.round(1.5 * MB),
  pdfBytes: 3 * MB,
  // Across every request. The database's disk is 1 GB and its own log takes about half of that.
  totalBytes: 200 * MB,
  dayBytes: 60 * MB
};
// The largest body the upload address reads at all. A little over the largest file it keeps.
const BODY_LIMIT = LIMITS.pdfBytes + 64 * 1024;

class FileError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function megabytes(bytes) {
  const size = bytes / MB;
  return (size >= 10 ? Math.round(size) : Math.round(size * 10) / 10) + " MB";
}

function fileSize(bytes) {
  return bytes < 0.1 * MB ? Math.max(1, Math.round(bytes / 1024)) + " KB" : megabytes(bytes);
}

// What a file really is, read from its first bytes. The name and the type the browser claims are not trusted.
function sniff(data) {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length > 4 && data.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return "";
}

// Returns a JPEG without the parts that describe where and how it was taken: EXIF and XMP (APP1),
// Photoshop and IPTC notes (APP13), and comments. A phone's EXIF block holds the GPS position.
// Returns null when the bytes are not a well-formed JPEG.
function stripJpegMetadata(data) {
  if (sniff(data) !== "image/jpeg") return null;
  const kept = [data.subarray(0, 2)];
  let at = 2;
  let sawFrame = false;
  while (at < data.length) {
    if (data[at] !== 0xff) return null;
    // Any number of 0xFF fill bytes may come before a marker.
    while (at < data.length && data[at] === 0xff) at += 1;
    if (at >= data.length) return null;
    const marker = data[at];
    at += 1;
    // The start of the picture data. Everything from here on is kept as it is.
    if (marker === 0xda) {
      if (!sawFrame) return null;
      kept.push(Buffer.from([0xff, 0xda]), data.subarray(at));
      return Buffer.concat(kept);
    }
    if (marker === 0xd9 || marker === 0xd8 || marker === 0x00) return null;
    // Markers that stand alone, with no length after them.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(Buffer.from([0xff, marker]));
      continue;
    }
    if (at + 2 > data.length) return null;
    const length = data.readUInt16BE(at);
    if (length < 2 || at + length > data.length) return null;
    // SOF0 to SOF15 describe the picture itself, except the three that mean something else.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) sawFrame = true;
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!drop) kept.push(Buffer.from([0xff, marker]), data.subarray(at, at + length));
    at += length;
  }
  return null;
}

// A name that is safe to show and to send in a download header. The ending always matches the file.
function cleanName(raw, mime) {
  const ending = mime === "application/pdf" ? ".pdf" : ".jpg";
  let name = String(raw || "").replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop().trim().replace(/\s+/g, " ");
  name = name.replace(/\.[A-Za-z0-9]{1,5}$/, "").slice(0, 70).trim();
  return (name || (mime === "application/pdf" ? "document" : "picture")) + ending;
}

function headerName(name) {
  return name.replace(/[^A-Za-z0-9 ._-]/g, "_");
}

const COLUMNS = "id, request_id, kind, name, mime, size, sharing, created_at";

async function listFiles(pool, requestId) {
  return (await pool.query(`select ${COLUMNS} from request_files where request_id = $1 order by id`, [requestId])).rows;
}

async function loadFile(pool, requestId, fileId) {
  const id = Number(fileId);
  if (!Number.isInteger(id) || id < 1) return null;
  return (await pool.query("select * from request_files where id = $1 and request_id = $2", [id, requestId])).rows[0] || null;
}

async function storageUsed(pool) {
  return Number((await pool.query("select coalesce(sum(size), 0) as bytes from request_files")).rows[0].bytes);
}

// Bytes taken in over the last day, counted here as well as in the database so that
// adding and removing the same file over and over still runs into the daily limit.
const taken = [];
function takenToday(now = Date.now()) {
  while (taken.length && now - taken[0].at > 24 * 3600 * 1000) taken.shift();
  return taken.reduce((sum, entry) => sum + entry.bytes, 0);
}

// Checks one upload against every limit and stores it. Throws a FileError that says what to do instead.
async function saveFile(pool, request, { kind, name, data }) {
  if (!KINDS[kind]) throw new FileError(400, "Choose where this file belongs.");
  if (request.status === "closed") throw new FileError(409, "This request is closed, so files can’t be added to it.");
  if (!Buffer.isBuffer(data) || !data.length) throw new FileError(400, "That file was empty.");

  const mime = sniff(data);
  if (!mime) throw new FileError(415, "We can take pictures and PDF files. This file is neither.");
  if (mime === "application/pdf" && kind !== "document") throw new FileError(415, "Add PDF files under Plans or documents.");
  if (data.length > (mime === "application/pdf" ? LIMITS.pdfBytes : LIMITS.jpegBytes)) {
    throw new FileError(413, mime === "application/pdf"
      ? "That PDF is over " + megabytes(LIMITS.pdfBytes) + ". Take pictures of its pages instead."
      : "That picture is too large to send.");
  }
  let bytes = data;
  if (mime === "image/jpeg") {
    bytes = stripJpegMetadata(data);
    if (!bytes) throw new FileError(415, "We couldn’t read that picture. Try another one, or a screenshot of it.");
  }

  // One upload is checked and stored at a time, so two that arrive together can't both slip under a limit.
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(7100129)");
    const existing = await listFiles(client, request.id);
    if (existing.length >= LIMITS.filesPerRequest) {
      throw new FileError(409, "A request can hold " + LIMITS.filesPerRequest + " files. Remove one to add another.");
    }
    if (existing.reduce((sum, file) => sum + file.size, 0) + bytes.length > LIMITS.bytesPerRequest) {
      throw new FileError(409, "These files add up to more than " + megabytes(LIMITS.bytesPerRequest) + ". Remove one to add another.");
    }
    const day = Number((await client.query("select coalesce(sum(size), 0) as bytes from request_files where created_at > now() - interval '1 day'")).rows[0].bytes);
    if (Math.max(day, takenToday()) + bytes.length > LIMITS.dayBytes || (await storageUsed(client)) + bytes.length > LIMITS.totalBytes) {
      throw new FileError(507, "We can’t take more files right now. Send your request without them and we’ll ask for them another way.");
    }
    const saved = await client.query(
      `insert into request_files (request_id, kind, name, mime, size, sharing, data)
       values ($1, $2, $3, $4, $5, $6, $7) returning ${COLUMNS}`,
      [request.id, kind, cleanName(name, mime), mime, bytes.length, KINDS[kind].sharing, bytes]
    );
    await client.query("commit");
    taken.push({ at: Date.now(), bytes: bytes.length });
    return saved.rows[0];
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Sends one stored file. A picture opens in the browser. A PDF downloads. Neither can run anything.
function sendFile(res, file, name = file.name) {
  const pdf = file.mime === "application/pdf";
  res.set({
    "Content-Type": file.mime,
    "Content-Length": String(file.data.length),
    "Content-Disposition": (pdf ? "attachment" : "inline") + '; filename="' + headerName(name) + '"',
    "Cache-Control": "private, max-age=3600",
    "Content-Security-Policy": pdf ? "default-src 'none'" : "default-src 'none'; sandbox",
    "X-Robots-Tag": "noindex, nofollow"
  });
  res.end(file.data);
}

// Names for a company to see. A file's own name can give away who the customer is, so companies
// get "Picture 2" instead. The numbers run in the order the page shows the files, and they count
// every file, shared or not, so a picture keeps its number when the owner holds another one back.
function plainNames(files) {
  const counts = {};
  const names = new Map();
  for (const kind of KIND_ORDER) {
    for (const file of files.filter((one) => one.kind === kind)) {
      const word = file.mime === "application/pdf" ? "Document" : (kind === "document" ? "Document picture" : "Picture");
      counts[word] = (counts[word] || 0) + 1;
      names.set(file.id, word + " " + counts[word]);
    }
  }
  return names;
}

// The files of one request as a page section's contents, grouped by kind.
//   base     where each file is served from, such as /r/<token>/files
//   label    (file) => the name to show
//   extra    (file) => more markup under the file, such as a Remove button
//   theirs   true on the owner's and a company's page, where "you" is not the customer
function galleryHtml(files, { base, label = (file) => file.name, extra = () => "", theirs = false }) {
  return KIND_ORDER.map((kind) => {
    const group = files.filter((file) => file.kind === kind);
    if (!group.length) return "";
    const items = group.map((file) => {
      const href = base + "/" + file.id;
      const name = label(file);
      const tile = file.mime === "application/pdf"
        ? `<a class="file-doc" href="${esc(href)}"><span class="file-doc-kind" aria-hidden="true">PDF</span><span>${esc(name)}</span></a>`
        : `<a class="file-shot" href="${esc(href)}"><img src="${esc(href)}" alt="${esc(name)}" loading="lazy" width="320" height="320"></a>`;
      return `<li class="file-card">
          ${tile}
          <p class="file-facts">${file.mime === "application/pdf" ? "PDF, " + esc(fileSize(file.size)) : esc(name)}</p>
          ${extra(file)}
        </li>`;
    }).join("\n        ");
    return `<div class="file-kind">
        <h3>${esc(theirs ? KINDS[kind].theirs : KINDS[kind].title)}</h3>
        <ul class="file-cards">
        ${items}
        </ul>
      </div>`;
  }).filter(Boolean).join("\n      ");
}

// The three "add" buttons, for a page where a customer can add files. site/uploads.js runs them.
// site/quote.html carries the same markup; the tests keep the two in step.
function pickerHtml() {
  const group = (kind, help, button, accept) => `<div class="file-group" data-kind="${kind}">
        <h3>${esc(KINDS[kind].title)}</h3>
        <p class="help">${help}</p>
        <ul class="file-list" hidden></ul>
        <input class="file-input" id="files-${kind}" type="file" accept="${accept}" multiple>
        <label class="secondary" for="files-${kind}">${button}</label>
      </div>`;
  return `<div class="file-groups" data-uploads>
      ${group("site", "Where the work will go, and anything in the way.", "Add photos", "image/*")}
      ${group("idea", "Pictures or screenshots of a look you want.", "Add pictures", "image/*")}
      ${group("document", "A survey, a drawing, or HOA rules, as a PDF or a picture. We check these before any company sees them, because they often show a name or an address.", "Add files", "application/pdf,image/*")}
      <p class="form-note" data-upload-status role="status" hidden></p>
      <p class="form-error" data-upload-error role="alert" hidden></p>
    </div>`;
}

module.exports = {
  KINDS, KIND_ORDER, SHARING, LIMITS, BODY_LIMIT, FileError,
  megabytes, fileSize, sniff, stripJpegMetadata, cleanName, listFiles, loadFile, storageUsed, saveFile, sendFile,
  plainNames, galleryHtml, pickerHtml
};
