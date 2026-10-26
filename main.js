/*
 * Verso — Your reading life, scheduled.
 * v1.4.2 — Next reading: once today's reading is done, the dashboard
 * card, the book view and the "Pages read" message say what the next
 * reading is and how many pages it has.
 */

const { Plugin, PluginSettingTab, Setting, Notice, Modal, ItemView, FuzzySuggestModal, Platform } = require('obsidian');

// ─── Date Helpers ─────────────────────────────────────────────────────────────
//
// All "today" / date-string logic must use LOCAL time, not UTC. Using
// Date.toISOString() (UTC) caused "today" to roll over before local midnight
// for users behind UTC — producing wrong default start dates, premature
// missed-chunk detection, and off-by-one streaks/stats. These helpers format
// dates from local components so the calendar day always matches the user's.

// Format a Date object as 'YYYY-MM-DD' using local time components.
function versoLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Today's date as a local 'YYYY-MM-DD' string.
function versoToday() {
  return versoLocalDateString(new Date());
}

// Parse a 'YYYY-MM-DD' string into a Date at LOCAL midnight (not UTC midnight).
// Using new Date('2026-06-13') parses as UTC, which can shift the weekday for
// users far from UTC — this keeps the calendar day stable.
function versoParseLocalDate(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(year, month - 1, day);
}

// Build Sunday-start week columns spanning [rangeStart, rangeEnd], inclusive.
// Each column: { index, start, end, label, monthLabel, isMonthStart }.
// - start/end are 'YYYY-MM-DD' strings (the Sunday and Saturday of that week)
// - label is "W1", "W2", ... (1-indexed, for display)
// - monthLabel is the month name if this column starts a new month in the
//   header (used to build the two-tier month/week header), else null
function buildWeekColumns(rangeStart, rangeEnd) {
  const weeks = [];

  // Snap the first column's start back to the most recent Sunday on/before
  // rangeStart, so weeks align to real calendar weeks.
  const firstSunday = versoParseLocalDate(rangeStart);
  firstSunday.setDate(firstSunday.getDate() - firstSunday.getDay());

  const end = versoParseLocalDate(rangeEnd);

  let cursor = new Date(firstSunday);
  let index = 0;
  let lastMonth = null;

  while (cursor <= end) {
    const weekStart = new Date(cursor);
    const weekEnd = new Date(cursor);
    weekEnd.setDate(weekEnd.getDate() + 6);

    const month = weekStart.getMonth();
    const monthLabel = month !== lastMonth
      ? weekStart.toLocaleDateString(undefined, { month: 'long' })
      : null;
    lastMonth = month;

    weeks.push({
      index,
      start: versoLocalDateString(weekStart),
      end: versoLocalDateString(weekEnd),
      label: `W${index + 1}`,
      monthLabel,
      isMonthStart: monthLabel !== null
    });

    cursor.setDate(cursor.getDate() + 7);
    index++;
  }

  return weeks;
}

// ─── Default Settings ────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {

  // ── Onboarding ──────────────────────────────────────────────
  onboardingComplete: false,

  // ── Vocabulary ──────────────────────────────────────────────
  // Options: 'projects', 'lists', 'shelves', 'custom'
  // For 'custom', collectionTermCustom holds the SINGULAR form and
  // collectionTermCustomPlural the plural. The singular keeps its original
  // key so existing vaults upgrade without a migration step.
  collectionTerm: 'lists',
  collectionTermCustom: '',
  collectionTermCustomPlural: '',

  // ── Reading days ────────────────────────────────────────────
  // Options: 'everyday', 'weekdays', 'custom'
  readingDays: 'everyday',
  customReadingDays: {
    sun: false,
    mon: true,
    tue: true,
    wed: true,
    thu: true,
    fri: true,
    sat: false
  },

  // ── Data ────────────────────────────────────────────────────
  collections: [],
  books: [],
  chunks: [],
  sessions: [],

  // Texts of completion quotes already shown in the current cycle, so a
  // quote doesn't repeat until its pool has been used up. (v1.3.2)
  quotesShown: [],

  // ── Import from a note (v1.4.0) ─────────────────────────────
  // Frontmatter property names read by "Fill in from a note" in Add book.
  // Matched without regard to case, so "Author" finds "author".
  importTitleProperty: 'title',
  importAuthorProperty: 'author',
  importPagesProperty: 'pages',

  // ── Days off (v1.4.0) ───────────────────────────────────────
  // Date ranges with no reading, for every book: [{ id, start, end, label }].
  // One book's own days off live on the book as book.daysOff.
  daysOff: []
};

// ─── Data Helpers ────────────────────────────────────────────────────────────

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function createCollection(data = {}) {
  return {
    id: generateId(),
    name: data.name || 'New collection',
    notes: data.notes || '',
    books: [],
    dateCreated: new Date().toISOString(),
    targetDate: data.targetDate || null
  };
}

// Preset book-cover colors. Drawn from the app's existing color-ramp system
// (the same "200" stops already used elsewhere in the UI), so every color a
// reader can pick already looks intentional against the theme and reads
// clearly against every other swatch on a shelf. The first entry matches the
// long-standing default coverColor, so existing books that predate this
// picker still land on a familiar color rather than an arbitrary new one.
const COVER_COLORS = [
  '#B5D4F4', // blue (existing default)
  '#9FE1CB', // teal
  '#AFA9EC', // purple
  '#F0997B', // coral
  '#ED93B1', // pink
  '#FAC775', // amber
  '#97C459', // green
  '#D3D1C7'  // gray
];

function createBook(data = {}) {
  return {
    id: generateId(),
    collectionId: data.collectionId || null,
    title: data.title || 'Untitled book',
    author: data.author || '',
    totalPages: data.totalPages || 0,
    totalChapters: data.totalChapters || 0,
    coverColor: data.coverColor || '#B5D4F4',
    isbn: data.isbn || '',
    publisher: data.publisher || '',
    year: data.year || '',
    notes: data.notes || '',
    startDate: data.startDate || null,
    targetFinishDate: data.targetFinishDate || null,
    // Snapshot of targetFinishDate at creation time — never touched again after
    // this point. Lets us tell, at completion, whether the finish date was ever
    // moved (and which direction), without keeping a full edit history. See
    // updateBookDates() and checkBookCompletion().
    originalTargetFinishDate: data.targetFinishDate || null,
    chunkType: data.chunkType || 'chapter',
    readingDaysOverride: data.readingDaysOverride || null,
    status: data.status || 'planned',
    dateCompleted: data.dateCompleted || null,
    archivedDate: data.archivedDate || null,
    statusBeforeArchive: data.statusBeforeArchive || null,
    archiveReason: data.archiveReason || '',
    archiveReasonCategory: data.archiveReasonCategory || null,
    // 'page' (default) or 'percent' — 'percent' is for e-readers (Kindle,
    // Kobo, etc.) that only expose a percent-complete figure, not a page
    // number. Internally everything still stores/computes in pages; this
    // only changes what the reader types in and what the daily target
    // label shows. (LiveAQuietLife, 2026-09-04)
    progressInputMode: data.progressInputMode || 'page',
    dateAdded: new Date().toISOString()
  };
}

function createChunk(data = {}) {
  return {
    id: generateId(),
    bookId: data.bookId || null,
    label: data.label || '',
    chapterTitle: data.chapterTitle || '',
    pagesStart: data.pagesStart || 0,
    pagesEnd: data.pagesEnd || 0,

    scheduledDate: data.scheduledDate || null,
    status: data.status || 'upcoming',
    dateCompleted: data.dateCompleted || null,
    scheduledPagesEnd: data.scheduledPagesEnd || null
  };
}

 
function createSession(data = {}) {
  return {
    id: generateId(),
    chunkId: data.chunkId || null,
    bookId: data.bookId || null,
    pagesRead: data.pagesRead || 0,
    startTime: data.startTime || null,
    endTime: data.endTime || null,
    minutesTaken: data.minutesTaken || null,
    dateCompleted: data.dateCompleted || new Date().toISOString()
  };
}

// ─── Verso Toast ─────────────────────────────────────────────────────────────
//
// A center-screen alternative to Obsidian's top-right Notice, for Verso's own
// messages. Auto-fades and removes itself; not meant for stacking (one at a
// time is the expected use).
// Appearance lives in styles.css under .verso-toast so themes and snippets
// can override it; only the fade-out, which is behaviour, stays here.
function versoToast(message, timeout = 4000) {
  const el = document.body.createDiv({ cls: 'verso-toast', text: message });
  window.setTimeout(() => {
    el.style.opacity = '0';
    window.setTimeout(() => el.remove(), 300);
  }, timeout);
  return el;
}

// ─── Scheduling Helpers ──────────────────────────────────────────────────────

// ─── Days off (v1.4.0) ──────────────────────────────────────────────────────
//
// A days-off range is { id, start, end, label } with YYYY-MM-DD dates,
// inclusive. getReadingDaysFor() wraps a book's weekly pattern as
// { weekly, off } only when a range applies, so a book with no days off
// takes exactly the same code paths as before.

function versoWeeklyDays(readingDays) {
  return readingDays && readingDays.weekly !== undefined ? readingDays.weekly : readingDays;
}

function versoIsDayOff(dateString, readingDays) {
  const off = readingDays && readingDays.off;
  return Array.isArray(off) && off.some(r => r.start <= dateString && dateString <= r.end);
}

function versoWithDaysOff(readingDays, ranges) {
  const off = (ranges || []).filter(r => r && r.start && r.end);
  return off.length ? { weekly: readingDays, off } : readingDays;
}

// dateString is optional; without it days off aren't checked.
function isDayEnabled(dayNumber, readingDays, dateString) {
  if (readingDays && readingDays.weekly !== undefined) {
    if (dateString && versoIsDayOff(dateString, readingDays)) return false;
    return isDayEnabled(dayNumber, readingDays.weekly);
  }
  if (readingDays === 'everyday') return true;
  if (readingDays === 'weekdays') return dayNumber >= 1 && dayNumber <= 5;
  if (typeof readingDays === 'object') {
    const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    return readingDays[dayKeys[dayNumber]] === true;
  }
  return true;
}

// Convert the global readingDays setting ('everyday' | 'weekdays' | 'custom')
// into the { sun, mon, tue, wed, thu, fri, sat } object shape used by
// per-book overrides. Shared by AddBookModal (initial default) and
// VersoEditBookModal (fallback when a book has no override yet).
function globalReadingDaysAsObject(settings) {
  const setting = settings.readingDays;

  if (setting === 'everyday') {
    return { sun: true, mon: true, tue: true, wed: true, thu: true, fri: true, sat: true };
  }
  if (setting === 'weekdays') {
    return { sun: false, mon: true, tue: true, wed: true, thu: true, fri: true, sat: false };
  }
  // 'custom' — use the stored custom days
  return { ...settings.customReadingDays };
}

function countReadingDays(startDate, endDate, readingDays) {
  const start = versoParseLocalDate(startDate);
  const end = versoParseLocalDate(endDate);
  let count = 0;
  const current = new Date(start);
  while (current <= end) {
    if (isDayEnabled(current.getDay(), readingDays, versoLocalDateString(current))) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

function calculatePaceNeeded(totalPages, pagesRead, finishDate, readingDays) {
  const remainingPages = totalPages - pagesRead;
  const today = versoToday();
  const readingDaysLeft = countReadingDays(today, finishDate, readingDays);
  if (readingDaysLeft <= 0) return remainingPages;
  return Math.ceil(remainingPages / readingDaysLeft);
}

// A book is "off pace" once its target finish date no longer has any reading
// day left before it — there is no sane way left to distribute the remaining
// pages across a schedule. Rather than collapsing everything onto today
// (the old behavior — see recalculateSchedule's freeze branch and Verso
// future-works §1.1–§1.4), the book's schedule simply stops generating new
// chunks until the reader sets a new target date. Single source of truth for
// this condition — getBookStatus, recalculateSchedule, and getBookProgress
// all defer to it so the three can never drift out of sync with each other.
function isOffPace(book, readingDays) {
  if (!book.targetFinishDate) return false;
  const today = versoToday();
  return countReadingDays(today, book.targetFinishDate, readingDays) <= 0;
}

// Reading days a book loses between now and its finish date when its
// reading days change from `before` to `after` (e.g. days off are added).
function versoReadingDaysLost(book, before, after) {
  return versoReadingDaysLeft(book, before) - versoReadingDaysLeft(book, after);
}

// Reading days left in a book's schedule, from today (or its start date,
// if later) through its finish date.
function versoReadingDaysLeft(book, readingDays) {
  const today = versoToday();
  const from = book.startDate && book.startDate > today ? book.startDate : today;
  if (!book.targetFinishDate || book.targetFinishDate < from) return 0;
  return countReadingDays(from, book.targetFinishDate, readingDays);
}

// The finish date that gives a book back the reading days it lost, so the
// daily pages stay about the same. Unchanged if nothing was lost.
function versoFinishDateAfterDaysOff(book, before, after) {
  let lost = versoReadingDaysLost(book, before, after);
  if (lost <= 0) return book.targetFinishDate;
  const d = versoParseLocalDate(book.targetFinishDate);
  for (let i = 0; i < 3660 && lost > 0; i++) {
    d.setDate(d.getDate() + 1);
    if (isDayEnabled(d.getDay(), after, versoLocalDateString(d))) lost--;
  }
  return lost > 0 ? book.targetFinishDate : versoLocalDateString(d);
}

// Single source of truth for "is this chunk missed?" — a chunk already marked
// 'missed' by recalculation, OR an 'upcoming' chunk whose scheduled date has
// passed but hasn't been recalculated yet. Used by status, progress, and the
// book view so they can never drift apart.
function isChunkMissed(chunk, today) {
  return chunk.status === 'missed' ||
    (chunk.status === 'upcoming' && chunk.scheduledDate < today);
}

// A missed chunk only counts toward current status/progress math if it
// belongs to the book's CURRENT reading attempt — i.e., it's dated on or
// after the most recent reactivation, if the book has ever gone off-pace
// and come back. Chunks from a lapsed attempt before the reader set a new
// target date remain in the data permanently (untouched, for a possible
// future insights feature — see Verso future-works) but stop being
// load-bearing for any LIVE number the moment a fresh attempt begins.
// Books that have never gone off-pace have no reactivatedDate, so this is a
// no-op for them — every missed chunk they have already belongs to their
// one and only attempt.
function isChunkFromCurrentAttempt(chunk, book) {
  return !book.reactivatedDate || chunk.scheduledDate >= book.reactivatedDate;
}

// A book's status badge reflects whether the reader is CURRENTLY caught up,
// not whether they ever fell behind. Missed chunks are a permanent historical
// record (for the insights feature) — but if pagesRead has since caught up to
// everything that was due by today (complete + missed chunk pages combined),
// the badge clears to 'on-track' even though the missed chunks themselves
// remain in the data.
//
// 'not-started' covers active books whose startDate hasn't arrived yet —
// distinct from 'planned' (no schedule at all). With no chunks due, the old
// logic fell through to 'on-track' by default, which read as a hollow,
// dishonest badge on a book that hasn't begun. Checked before the missed-
// chunk logic since a future-start book by definition has nothing missed.
function getBookStatus(book, chunks, readingDays) {
  if (book.status === 'planned') return 'planned';
  if (book.status === 'complete') return 'complete';
  // Archived books have no live pace. Their old schedule keeps its dates
  // while archived, so running the math below would report days missed
  // while the book was set aside. (v1.3.2)
  if (book.status === 'archived') return 'archived';

  const today = versoToday();
  if (book.startDate && book.startDate > today) return 'not-started';

  if (isOffPace(book, readingDays)) return 'off-pace';

  const bookChunks = chunks.filter(c => c.bookId === book.id);

  const missedChunks = bookChunks.filter(c => isChunkMissed(c, today) && isChunkFromCurrentAttempt(c, book));

  if (missedChunks.length === 0) return 'on-track';

  // Pages scheduled to have been read by today (complete + missed chunks —
  // i.e. every chunk whose scheduledDate is today or earlier). Complete
  // chunks always count regardless of attempt — real reading is real
  // reading — but missed chunks are restricted to the current attempt the
  // same way as above, for the same reason.
  const dueByToday = bookChunks
    .filter(c => c.status === 'complete' || (isChunkMissed(c, today) && isChunkFromCurrentAttempt(c, book)))
    .reduce((sum, c) => sum + (c.pagesEnd - c.pagesStart + 1), 0);

  const pagesRead = bookChunks
    .filter(c => c.status === 'complete')
    .reduce((sum, c) => sum + (c.pagesEnd - c.pagesStart + 1), 0);

  if (pagesRead >= dueByToday) return 'on-track';

  return missedChunks.length <= 2 ? 'behind' : 'at-risk';
}

// A finished book stays finished after it's archived. Counts such as
// "Books finished this year" and the completion shelf use this so
// archiving a completed book doesn't remove it from them. (v1.3.2)
function versoIsFinishedBook(book) {
  if (book.status === 'complete') return true;
  return book.status === 'archived' && book.statusBeforeArchive === 'complete';
}

// ── Shared status/date display helpers (used by both dashboard and book view) ──

function versoFormatDate(dateString) {
  if (!dateString) return '—';
  const date = new Date(dateString + 'T00:00:00');
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Like versoFormatDate, but includes the year — used for date ranges where
// the year isn't otherwise implied (e.g. the Add book confirm step).
function versoFormatDateLong(dateString) {
  if (!dateString) return '—';
  const date = new Date(dateString + 'T00:00:00');
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function versoBadgeLabelForStatus(status) {
  if (status === 'on-track') return 'On track';
  if (status === 'behind') return 'Behind';
  if (status === 'at-risk') return 'At risk';
  if (status === 'off-pace') return 'Off pace';
  if (status === 'planned') return 'Planned';
  if (status === 'complete') return 'Completed';
  if (status === 'not-started') return 'Not started';
  if (status === 'archived') return 'Archived';
  return status;
}

function versoBadgeClassForStatus(status) {
  if (status === 'on-track') return 'verso-badge-on-track';
  if (status === 'behind') return 'verso-badge-behind-soft';
  if (status === 'at-risk') return 'verso-badge-behind';
  if (status === 'off-pace') return 'verso-badge-off-pace';
  if (status === 'planned') return 'verso-badge-planned';
  if (status === 'complete') return 'verso-badge-complete';
  if (status === 'not-started') return 'verso-badge-not-started';
  if (status === 'archived') return 'verso-badge-planned';
  return '';
}

function versoBarClassForStatus(status) {
  if (status === 'on-track') return 'verso-bar-on-track';
  if (status === 'behind') return 'verso-bar-behind';
  if (status === 'at-risk') return 'verso-bar-at-risk';
  if (status === 'off-pace') return 'verso-bar-off-pace';
  if (status === 'planned') return 'verso-bar-planned';
  if (status === 'complete') return 'verso-bar-complete';
  // 'not-started' intentionally omitted: the progress bar row this class
  // would apply to is gated by `if (progress)` at its only call site, and
  // progress is null precisely when a book is not-started — this branch
  // was confirmed unreachable and had no matching CSS rule either.
  // Removed per issue #5 (LiveAQuietLife, 2026-09-05).
  return '';
}

// ── Shared vocabulary helpers ───────────────────────────────────────────────
//
// The collection term is reader-configurable, so its plural, singular,
// capitalized and example-name forms are needed across several views and
// modals. They live at module scope so there is exactly one definition of
// each; earlier versions carried per-class copies that had already drifted.

// Plural form — 'lists', 'shelves', or the reader's own word.
function versoCollectionTerm(settings) {
  if (settings.collectionTerm === 'custom') {
    return settings.collectionTermCustomPlural || settings.collectionTermCustom || 'collections';
  }
  return settings.collectionTerm;
}

// Singular form. Built-in terms come from the map below. A custom term uses
// the singular the reader supplied rather than guessing at English
// morphology, falling back to the plural unchanged if they left it blank.
function versoCollectionTermSingular(settings) {
  if (settings.collectionTerm === 'custom') {
    return settings.collectionTermCustom
      || settings.collectionTermCustomPlural
      || 'collection';
  }
  return versoSingularize(settings.collectionTerm);
}

// Only ever handles the built-in terms — see versoCollectionTermSingular.
function versoSingularize(term) {
  const map = {
    projects: 'project',
    lists: 'list',
    shelves: 'shelf'
  };
  return map[term] || term;
}

function versoCapitalize(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function versoExampleCollectionName(term) {
  const examples = {
    projects: 'Summer reading',
    lists: 'To read',
    shelves: 'Currently reading'
  };
  return examples[term] || 'New collection';
}

function versoAddSummaryRow(table, label, value) {
  const row = table.createDiv({ cls: 'verso-summary-row' });
  row.createEl('span', { text: label, cls: 'verso-summary-label' });
  row.createEl('span', { text: value, cls: 'verso-summary-value' });
}


// ─── Scheduling Engine ────────────────────────────────────────────────────────
//
// Pages-only chunking for v1. Each reading day gets an even share of the
// remaining pages, with the final chunk absorbing any remainder.
//
// generateSchedule()    — builds the full initial schedule for a new book
// recalculateSchedule() — redistributes pages across remaining "upcoming"
//                         chunks, run on load and after marking a chunk done

// Get an array of every reading-day date (YYYY-MM-DD) between start and end, inclusive
function getReadingDateRange(startDate, endDate, readingDays) {
  const dates = [];
  const start = versoParseLocalDate(startDate);
  const end = versoParseLocalDate(endDate);
  const current = new Date(start);

  while (current <= end) {
    const dateString = versoLocalDateString(current);
    if (isDayEnabled(current.getDay(), readingDays, dateString)) {
      dates.push(dateString);
    }
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

// Build a default label for a chunk based on its page range.
//
// `book` is optional so every existing call site keeps working unchanged;
// pass it to get the percent-mode label. For a percent-mode book, the
// label is a single flat target percent (e.g. "42%"), not a start-end
// range — a range degenerates to something like "30%-30%" whenever the
// daily pace rounds to the same whole percent, which reads as sloppy
// rather than informative. See verso-workflow-notes issue on percent-based
// progress tracking. (LiveAQuietLife, 2026-09-04)
function buildChunkLabel(pagesStart, pagesEnd, book) {
  if (book && book.progressInputMode === 'percent' && book.totalPages > 0) {
    const targetPercent = Math.round((pagesEnd / book.totalPages) * 100);
    return `${targetPercent}%`;
  }
  if (pagesStart === pagesEnd) return `p. ${pagesStart}`;
  return `pp. ${pagesStart}-${pagesEnd}`;
}

// Title-case for book titles: capitalizes every word except a fixed list
// of minor words (articles, short conjunctions/prepositions) — unless
// that minor word is the first or last word of the title, which is always
// capitalized regardless. Standard title-case convention.
//
// A word the reader typed with capitals inside it is left as typed: all
// caps ("YHWH", "NT") or mixed case ("McDonald", "iPhone"). Typed in
// lowercase, "mcdonald" still comes out "Mcdonald". (v1.3.3)
const VERSO_TITLE_MINOR_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet',
  'as', 'at', 'by', 'in', 'of', 'on', 'per', 'to', 'up', 'via', 'vs'
]);

function versoCapitalizeWord(word) {
  // Capitals the reader typed inside the word are kept (v1.3.3).
  const letters = word.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 2 && letters === letters.toUpperCase()) return word;
  if (/[a-z][A-Z]/.test(word)) return word;

  // Capitalize each segment around hyphens/apostrophes so "o'brien" ->
  // "O'Brien" and "jean-claude" -> "Jean-Claude" come out right. A short
  // ending after an apostrophe stays lowercase: "Israel's", "don't",
  // "we'll". It used to come out "Israel'S". (v1.3.3)
  const parts = word.split(/([-'’])/);
  return parts.map((seg, i) => {
    if (seg === '-' || seg === "'" || seg === '’') return seg;
    if (seg.length === 0) return seg;
    const afterApostrophe = i > 0 && (parts[i - 1] === "'" || parts[i - 1] === '’');
    if (afterApostrophe && seg.length <= 2) return seg.toLowerCase();
    return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
  }).join('');
}

function versoTitleCase(str) {
  if (!str) return str;
  const words = str.trim().split(/\s+/);
  return words.map((word, i) => {
    const isEdge = i === 0 || i === words.length - 1;
    if (!isEdge && VERSO_TITLE_MINOR_WORDS.has(word.toLowerCase())) {
      return word.toLowerCase();
    }
    return versoCapitalizeWord(word);
  }).join(' ');
}

function versoNameCase(str) {
  if (!str) return str;
  return str.trim().split(/\s+/).map(versoCapitalizeWord).join(' ');
}

// Distribute a page range evenly across a list of dates.
// Returns an array of { scheduledDate, pagesStart, pagesEnd } objects.
// The last entry absorbs any remainder so every page is accounted for.
// ─── Import from a note (v1.4.0, logic-notes #8) ────────────────────────────

// Frontmatter value for a property name, ignoring case. An exact match wins.
function versoFrontmatterValue(frontmatter, name) {
  if (!frontmatter || !name) return undefined;
  const wanted = String(name).trim();
  if (Object.prototype.hasOwnProperty.call(frontmatter, wanted)) return frontmatter[wanted];
  const lower = wanted.toLowerCase();
  const key = Object.keys(frontmatter).find(k => k.trim().toLowerCase() === lower);
  return key === undefined ? undefined : frontmatter[key];
}

// "[[Adela Yarbro Collins]]" or "[[People/Collins|Collins]]" -> plain text.
function versoStripWikilink(text) {
  return String(text).replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g,
    (_, target, alias) => (alias || target.split('/').pop())).trim();
}

// Reads title, author and total pages from a note's frontmatter, using the
// property names in settings. A one-time copy: nothing links back to the note.
// Page counts may arrive as numbers or as text ("256"); 0 or anything
// non-numeric counts as missing.
function versoBookFromFrontmatter(frontmatter, settings) {
  const titleRaw = versoFrontmatterValue(frontmatter, settings.importTitleProperty || 'title');
  const authorRaw = versoFrontmatterValue(frontmatter, settings.importAuthorProperty || 'author');
  const pagesRaw = versoFrontmatterValue(frontmatter, settings.importPagesProperty || 'pages');

  const text = v => (v === null || v === undefined) ? '' : versoStripWikilink(v);

  const title = Array.isArray(titleRaw) ? text(titleRaw[0]) : text(titleRaw);

  const author = Array.isArray(authorRaw)
    ? authorRaw.map(text).filter(Boolean).join(', ')
    : text(authorRaw);

  let totalPages = null;
  if (typeof pagesRaw === 'number') {
    totalPages = Math.floor(pagesRaw);
  } else if (typeof pagesRaw === 'string' && /^\s*\d[\d,]*\s*$/.test(pagesRaw)) {
    totalPages = parseInt(pagesRaw.replace(/,/g, ''), 10);
  }
  if (!(totalPages > 0)) totalPages = null;

  return { title, author, totalPages };
}

class VersoNotePickerModal extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder('Choose a note to fill in the book details');
  }

  getItems() {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(file) {
    return file.path.replace(/\.md$/, '');
  }

  onChooseItem(file) {
    this.onChoose(file);
  }
}

function distributePages(firstPage, totalPages, dates) {
  if (dates.length === 0) return [];

  const pagesPerDay = Math.floor(totalPages / dates.length);
  const remainder = totalPages - (pagesPerDay * dates.length);

  const result = [];
  let pageCursor = firstPage;

  dates.forEach((date, index) => {
    // Give the remainder to the final day so earlier days are predictable
    const isLastDay = index === dates.length - 1;
    let daysPages = pagesPerDay;
    if (isLastDay) daysPages += remainder;

    // Don't generate empty chunks (can happen if totalPages < dates.length)
    if (daysPages <= 0) return;

    const pagesStart = pageCursor;
    const pagesEnd = pageCursor + daysPages - 1;

    result.push({
      scheduledDate: date,
      pagesStart,
      pagesEnd
    });

    pageCursor = pagesEnd + 1;
  });

  return result;
}

// The first date a new schedule can use: the start date, or today if the
// start date is in the past. Days before today can't be read any more, so
// scheduling pages on them only produced instant "missed" days and an
// at-risk badge on a book that was just added. (v1.3.2) The book keeps its
// real startDate; only the schedule begins today.
function versoScheduleFrom(startDate) {
  const today = versoToday();
  return startDate < today ? today : startDate;
}

// Generate the full initial schedule for a newly added book.
// Returns an array of chunk data objects ready to pass to createChunk().
function generateSchedule(book, readingDays) {
  const from = versoScheduleFrom(book.startDate);
  const dates = getReadingDateRange(from, book.targetFinishDate, readingDays);

  if (dates.length === 0) {
    // No valid reading days in range — single chunk on the first schedulable date
    return [{
      bookId: book.id,
      label: buildChunkLabel(1, book.totalPages, book),
      pagesStart: 1,
      pagesEnd: book.totalPages,
      scheduledDate: from,
      status: 'upcoming'
    }];
  }

  const distributed = distributePages(1, book.totalPages, dates);

  return distributed.map(d => ({
    bookId: book.id,
    label: buildChunkLabel(d.pagesStart, d.pagesEnd, book),
    pagesStart: d.pagesStart,
    pagesEnd: d.pagesEnd,
    scheduledDate: d.scheduledDate,
    status: 'upcoming'
  }));
}

// Recalculate the schedule for a book:
//  - Any "upcoming" chunk with a scheduledDate in the past becomes "missed"
//  - All remaining "upcoming" chunks (including today's, if not yet done)
//    get their page ranges redistributed across the remaining reading days
//    up to the book's target finish date
//  - "Complete" chunks are never touched
//
// IMPORTANT: "missed" chunks are kept purely as a HISTORICAL RECORD (for the
// monthly patterns/insights feature) — their page ranges are NOT subtracted
// from the pool and WILL overlap with the newly-generated "upcoming" chunks,
// since those unread pages get redistributed forward. Any code that sums
// pages across chunks (progress, totals, etc.) must only ever sum
// "complete" + "upcoming" chunks, never "missed" — otherwise pages get
// double-counted.
//
// Deterministic id for a chunk generated by recalculateSchedule. Random ids
// meant every recalculation produced "new" data even when the schedule was
// identical, so data.json was rewritten on every startup — on every device —
// which is what produced the stream of data.sync-conflict files. With a
// stable id, the same schedule always serializes the same way, so
// recalculateBook() can detect "nothing changed" and skip the write, and two
// devices that do recalculate on the same day write byte-identical data.
// Unique by construction: a book never has two upcoming chunks on one date.
function versoScheduledChunkId(bookId, scheduledDate, pagesStart, pagesEnd) {
  return `${bookId}-${scheduledDate}-${pagesStart}-${pagesEnd}`;
}

// True if two chunk lists contain the same chunks with the same field
// values, regardless of order. Used to skip saving when a recalculation
// changed nothing.
function versoChunkSetsEqual(a, b) {
  if (a.length !== b.length) return false;
  const byId = new Map(a.map(c => [c.id, c]));
  return b.every(c => {
    const other = byId.get(c.id);
    if (!other) return false;
    const keys = new Set([...Object.keys(c), ...Object.keys(other)]);
    for (const key of keys) {
      // Treat a missing field and a null one as the same thing — chunks
      // built by createChunk carry e.g. scheduledPagesEnd: null, while
      // recalculated ones omit it.
      const x = c[key] === undefined ? null : c[key];
      const y = other[key] === undefined ? null : other[key];
      if (x !== y) return false;
    }
    return true;
  });
}

// ─── Sync merge (v1.3.3) ─────────────────────────────────────────────────────
//
// Everything Verso knows lives in one data.json. A sync tool can't merge two
// versions of one file: when two devices both saved, one copy won whole and
// the other's changes were lost. A device that hadn't received the other's
// latest file yet could also bring deleted books back. (Syncthing keeps the
// losing copy as data.sync-conflict-*.json.)
//
// Verso now merges two copies record by record:
//  - Books and collections: the copy changed most recently wins. Each record
//    carries a `modified` stamp, set by saveSettings when its contents change.
//  - Deleting a book or collection leaves a tombstone in `deletedIds`, so an
//    older copy can't bring it back. Unmarking a reading leaves one too.
//  - Completed readings from both copies are kept. Two that overlap in pages
//    (each device logged the same pages without knowing about the other)
//    become one reading covering both ranges. Upcoming and missed readings
//    are rebuilt afterwards by recalculateSchedule.
//  - Each completed reading keeps exactly one session.
//  - Other settings come from whichever copy changed them last.

// Top-level keys that aren't plain settings: merged by their own rules, and
// left out of the settings comparison.
const VERSO_MERGED_KEYS = new Set([
  'collections', 'books', 'chunks', 'sessions', 'quotesShown', 'deletedIds', 'settingsModified'
]);

// How long a tombstone is kept. A device that has been away longer than
// this could bring a deleted book back.
const VERSO_TOMBSTONE_DAYS = 180;

function versoRecordKey(rec) {
  const { modified, ...rest } = rec;
  return JSON.stringify(rest);
}

function versoSettingsKey(settings) {
  const out = {};
  Object.keys(settings).sort().forEach(k => {
    if (!VERSO_MERGED_KEYS.has(k)) out[k] = settings[k];
  });
  return JSON.stringify(out);
}

// What data.json held at the last load or save, used to tell which records
// this device has changed since.
function versoSnapshot(settings) {
  return {
    books: new Map((settings.books || []).map(b => [b.id, versoRecordKey(b)])),
    collections: new Map((settings.collections || []).map(c => [c.id, versoRecordKey(c)])),
    settingsKey: versoSettingsKey(settings)
  };
}

// Stamp books and collections changed since the snapshot, tombstone the
// ones removed, and stamp settings if any changed. Drops expired tombstones.
function versoStampChanges(settings, snapshot, nowIso) {
  if (!settings.deletedIds || typeof settings.deletedIds !== 'object') settings.deletedIds = {};
  if (!snapshot) return;
  ['books', 'collections'].forEach(kind => {
    const before = snapshot[kind];
    const present = new Set();
    (settings[kind] || []).forEach(rec => {
      present.add(rec.id);
      if (before.get(rec.id) !== versoRecordKey(rec)) rec.modified = nowIso;
    });
    before.forEach((_, id) => {
      if (!present.has(id)) settings.deletedIds[id] = nowIso;
    });
  });
  if (snapshot.settingsKey !== versoSettingsKey(settings)) settings.settingsModified = nowIso;

  const cutoff = new Date(Date.now() - VERSO_TOMBSTONE_DAYS * 86400000).toISOString();
  Object.keys(settings.deletedIds).forEach(id => {
    if (settings.deletedIds[id] < cutoff) delete settings.deletedIds[id];
  });
}

// The latest moment anything in this copy changed. Breaks ties between
// records that carry no stamps (data saved before v1.3.3).
function versoFreshness(data) {
  let latest = data.settingsModified || '';
  const bump = v => { if (v && v > latest) latest = v; };
  (data.books || []).forEach(b => bump(b.modified));
  (data.collections || []).forEach(c => bump(c.modified));
  (data.chunks || []).forEach(c => bump(c.dateCompleted));
  (data.sessions || []).forEach(s => bump(s.dateCompleted));
  Object.values(data.deletedIds || {}).forEach(bump);
  return latest;
}

function versoRangesOverlap(a, b) {
  return a.pagesStart <= b.pagesEnd && b.pagesStart <= a.pagesEnd;
}

// Merge two copies of Verso's data. `local` is what this device has;
// `other` is the copy from disk or a conflict file. Returns a new data
// object; records taken unchanged keep their identity.
function versoMergeData(local, other) {
  const preferLocal = versoFreshness(local) >= versoFreshness(other);
  const tie = (a, b) => (preferLocal ? a : b);

  // Tombstones: union, keeping the later time.
  const deletedIds = { ...(other.deletedIds || {}) };
  Object.entries(local.deletedIds || {}).forEach(([id, t]) => {
    if (!deletedIds[id] || t > deletedIds[id]) deletedIds[id] = t;
  });
  const isDeleted = rec => !!deletedIds[rec.id] && deletedIds[rec.id] >= (rec.modified || '');

  // Books and collections: newer stamp wins; unstamped ties go to the
  // fresher copy. Records removed by a tombstone are dropped. `winner`
  // records which copy each book came from.
  const winner = new Map();
  const mergeRecords = (localList, otherList, track) => {
    const L = new Map((localList || []).map(r => [r.id, r]));
    const O = new Map((otherList || []).map(r => [r.id, r]));
    const ids = [...L.keys(), ...[...O.keys()].filter(id => !L.has(id))];
    const result = [];
    ids.forEach(id => {
      const l = L.get(id);
      const o = O.get(id);
      let pick;
      let side;
      if (l && o) {
        const lm = l.modified || '';
        const om = o.modified || '';
        if (lm !== om) side = lm > om ? 'local' : 'other';
        else if (versoRecordKey(l) === versoRecordKey(o)) side = 'local';
        else side = preferLocal ? 'local' : 'other';
        pick = side === 'local' ? l : o;
      } else {
        pick = l || o;
        side = l ? 'local' : 'other';
      }
      if (isDeleted(pick)) return;
      if (track) winner.set(id, side);
      result.push(pick);
    });
    return result;
  };

  const books = mergeRecords(local.books, other.books, true);
  const bookById = new Map(books.map(b => [b.id, b]));
  const bookGone = bookId => !bookById.has(bookId) && !!deletedIds[bookId];

  // ── Chunks ──
  const Lc = new Map((local.chunks || []).map(c => [c.id, c]));
  const Oc = new Map((other.chunks || []).map(c => [c.id, c]));
  const allChunkIds = [...Lc.keys(), ...[...Oc.keys()].filter(id => !Lc.has(id))];
  // A completion counts unless a later unmark tombstoned it.
  const counts = c => !!c && c.status === 'complete' &&
    !(deletedIds[c.id] && deletedIds[c.id] > (c.dateCompleted || ''));

  const complete = [];     // { chunk, side: 'local' | 'other' | 'both' }
  const completeIds = new Set();
  allChunkIds.forEach(id => {
    const l = Lc.get(id);
    const o = Oc.get(id);
    const lOk = counts(l);
    const oOk = counts(o);
    if (!lOk && !oOk) return;
    let chunk;
    let side;
    if (lOk && oOk) {
      const same = JSON.stringify(l) === JSON.stringify(o);
      if (same) { chunk = l; side = 'both'; }
      else if ((l.dateCompleted || '') >= (o.dateCompleted || '')) { chunk = l; side = 'local'; }
      else { chunk = o; side = 'other'; }
    } else {
      chunk = lOk ? l : o;
      side = lOk ? 'local' : 'other';
    }
    if (bookGone(chunk.bookId)) return;
    complete.push({ chunk, side });
    completeIds.add(id);
  });

  // Overlapping completed readings that came from different copies become
  // one: the later one, widened to cover both ranges.
  const droppedChunkIds = new Set();
  const widened = new Map();   // chunkId -> widened copy
  const byBook = new Map();
  complete.forEach(entry => {
    if (!byBook.has(entry.chunk.bookId)) byBook.set(entry.chunk.bookId, []);
    byBook.get(entry.chunk.bookId).push(entry);
  });
  byBook.forEach(entries => {
    entries.sort((a, b) => (b.chunk.dateCompleted || '').localeCompare(a.chunk.dateCompleted || ''));
    const kept = [];
    entries.forEach(entry => {
      const target = entry.side === 'both' ? null : kept.find(k =>
        k.side !== 'both' && k.side !== entry.side && versoRangesOverlap(k.chunk, entry.chunk)
      );
      if (!target) { kept.push(entry); return; }
      if (!widened.has(target.chunk.id)) {
        target.chunk = { ...target.chunk };
        widened.set(target.chunk.id, target.chunk);
      }
      target.chunk.pagesStart = Math.min(target.chunk.pagesStart, entry.chunk.pagesStart);
      target.chunk.pagesEnd = Math.max(target.chunk.pagesEnd, entry.chunk.pagesEnd);
      droppedChunkIds.add(entry.chunk.id);
    });
  });
  widened.forEach(c => {
    c.label = buildChunkLabel(c.pagesStart, c.pagesEnd, bookById.get(c.bookId));
  });

  const chunks = [];
  const finalComplete = new Map();
  complete.forEach(({ chunk }) => {
    if (droppedChunkIds.has(chunk.id)) return;
    const c = widened.get(chunk.id) || chunk;
    finalComplete.set(c.id, c);
    chunks.push(c);
  });

  // Upcoming and missed readings come from whichever copy's book record won
  // (they're rebuilt by recalculation anyway). Chunks of a book neither copy
  // knows about are kept from either side.
  allChunkIds.forEach(id => {
    if (completeIds.has(id)) return;
    const l = Lc.get(id);
    const o = Oc.get(id);
    const bookId = (l || o).bookId;
    if (bookGone(bookId)) return;
    let source;
    if (bookById.has(bookId)) source = winner.get(bookId) === 'local' ? l : o;
    else source = l || o;
    if (!source || source.status === 'complete') return;
    chunks.push(source);
  });

  // ── Sessions ──
  const Ls = new Map((local.sessions || []).map(s => [s.id, s]));
  const Os = new Map((other.sessions || []).map(s => [s.id, s]));
  const allSessions = [...Ls.values(), ...[...Os.values()].filter(s => !Ls.has(s.id))];
  const chunkIdsKnown = new Set(allChunkIds);
  const byChunk = new Map();
  const sessions = [];
  allSessions.forEach(s => {
    if (bookGone(s.bookId)) return;
    if (droppedChunkIds.has(s.chunkId)) return;
    if (!chunkIdsKnown.has(s.chunkId)) { sessions.push(s); return; }  // older data
    if (!finalComplete.has(s.chunkId)) return;                         // unmarked
    if (!byChunk.has(s.chunkId)) byChunk.set(s.chunkId, []);
    byChunk.get(s.chunkId).push(s);
  });
  byChunk.forEach((group, chunkId) => {
    const chunk = finalComplete.get(chunkId);
    let keep = group;
    const allShared = group.every(s => Ls.has(s.id) && Os.has(s.id));
    if (group.length > 1 && !allShared) {
      const match = group.find(s => s.dateCompleted === chunk.dateCompleted);
      const latest = group.reduce((a, b) => ((b.dateCompleted || '') > (a.dateCompleted || '') ? b : a));
      keep = [match || latest];
    }
    keep.forEach(s => {
      if (widened.has(chunkId)) {
        sessions.push({ ...s, pagesRead: chunk.pagesEnd - chunk.pagesStart + 1 });
      } else {
        sessions.push(s);
      }
    });
  });

  // ── Collections ──
  // Book lists follow each book's own collectionId, so moving a book on one
  // device isn't undone by the other copy's list.
  const collections = mergeRecords(local.collections, other.collections, false).map(coll => {
    const list = (coll.books || []).filter(id => {
      if (deletedIds[id] && !bookById.has(id)) return false;
      const b = bookById.get(id);
      return !b || b.collectionId === coll.id;
    });
    books.forEach(b => {
      if (b.collectionId === coll.id && !list.includes(b.id)) list.push(b.id);
    });
    const same = list.length === (coll.books || []).length &&
      list.every((id, i) => id === coll.books[i]);
    return same ? coll : { ...coll, books: list };
  });

  // ── Settings and quotes ──
  const lsm = local.settingsModified || '';
  const osm = other.settingsModified || '';
  const settingsFrom = lsm !== osm ? (lsm > osm ? local : other) : tie(local, other);
  const merged = {};
  Object.keys(settingsFrom).forEach(k => {
    if (!VERSO_MERGED_KEYS.has(k)) merged[k] = settingsFrom[k];
  });
  if (settingsFrom.settingsModified) merged.settingsModified = settingsFrom.settingsModified;

  const quotes = [...(local.quotesShown || [])];
  (other.quotesShown || []).forEach(q => { if (!quotes.includes(q)) quotes.push(q); });

  return {
    ...merged,
    collections,
    books,
    chunks,
    sessions,
    quotesShown: quotes,
    deletedIds
  };
}

// Returns the updated full list of chunks for this book (complete + missed + upcoming).
function recalculateSchedule(book, existingChunks, readingDays) {
  const today = versoToday();

  // A book whose timeline hasn't begun yet can't have any genuine missed-
  // reading history — "missed" describes a reading day that came and went
  // unread, which requires the book to have started. If startDate is still
  // in the future, treat ALL existing chunks as if nothing has happened yet:
  // drop any (corrupted) missed/upcoming chunks and rebuild the schedule
  // fresh from startDate. This also self-heals books affected by the
  // phantom-chunk bug below (chunks dated before startDate that had been
  // incorrectly marked missed).
  if (book.startDate > today && !existingChunks.some(c => c.status === 'complete')) {
    const dates = getReadingDateRange(book.startDate, book.targetFinishDate, readingDays);
    const distributed = distributePages(1, book.totalPages, dates);
    return distributed.map(d => ({
      id: versoScheduledChunkId(book.id, d.scheduledDate, d.pagesStart, d.pagesEnd),
      bookId: book.id,
      label: buildChunkLabel(d.pagesStart, d.pagesEnd, book),
      chapterTitle: '',
      pagesStart: d.pagesStart,
      pagesEnd: d.pagesEnd,
      scheduledDate: d.scheduledDate,
      status: 'upcoming',
      dateCompleted: null
    }));
  }

  const completeChunks = existingChunks.filter(c => c.status === 'complete');
  const upcomingChunks = existingChunks.filter(c => c.status === 'upcoming');
  const alreadyMissedChunks = existingChunks.filter(c => c.status === 'missed');

  // OFF-PACE FREEZE (see Verso future-works §1.1–§1.4): once the target finish
  // date has no reading day left before it, there is no sane way to
  // distribute the remaining pages. The old behavior collapsed everything
  // onto today, which produced a chunk sized to the whole remaining book —
  // and regenerated an equally-sized "new" one every subsequent session,
  // since nothing about the collapse depends on time actually passing. That
  // was the direct cause of the missed-day/page inflation in §1.2/§1.3 and
  // the destructive same-click completion in §1.4.
  //
  // Instead: mark anything still overdue as missed ONE FINAL TIME, and
  // generate nothing new. The book stays exactly as it is — pagesRead
  // untouched, existing history untouched — until the reader sets a new
  // target date. At that point updateBookDates() calls this function again
  // with a real target date ahead of today, isOffPace() is no longer true,
  // and the normal distribution below picks up from pagesRead + 1 across the
  // new window — a fresh schedule for what's actually left, not a redo of
  // the whole book. This freeze is naturally idempotent: once there are no
  // upcoming chunks left to convert, re-running it changes nothing.
  if (isOffPace(book, readingDays)) {
    const lastPageRead = completeChunks.length > 0
      ? Math.max(...completeChunks.map(c => c.pagesEnd))
      : 0;
    const missedChunks = [
      ...alreadyMissedChunks,
      ...upcomingChunks.map(c => ({ ...c, status: 'missed' }))
    ].filter(c => c.pagesEnd > lastPageRead);
    return [...completeChunks, ...missedChunks];
  }

  // Split upcoming into "now overdue" (becomes missed) vs "still upcoming"
  const newlyMissed = upcomingChunks.filter(c => c.scheduledDate < today);

  // The furthest page actually reached — the high-water mark of all complete chunks.
  // Used to resolve missed chunks whose pages have since been read, e.g. a reader who
  // backdated a start date and caught up in one session. Distinct from pagesRead (a count);
  // this is a page number, safe to compare against chunk.pagesEnd regardless of start page.
  const lastPageRead = completeChunks.length > 0
    ? Math.max(...completeChunks.map(c => c.pagesEnd))
    : 0;

  // Mark newly-overdue chunks as missed (preserve their original page ranges for history).
  // Filter out any missed chunks fully covered by the reader's actual progress — so
  // catching up via "actual pages read" correctly clears the Behind badge.
  const missedChunks = [
    ...alreadyMissedChunks,
    ...newlyMissed.map(c => ({ ...c, status: 'missed' }))
  ].filter(c => c.pagesEnd > lastPageRead);

  // How many pages have been read so far (complete chunks only)
  const pagesRead = completeChunks.reduce((sum, c) => sum + (c.pagesEnd - c.pagesStart + 1), 0);

  // Pages still owed — total minus what's been read.
  // Missed chunks' pages are NOT subtracted; they roll back into the pool.
  const remainingPages = book.totalPages - pagesRead;

  // Reading days remaining, from today through the target finish date —
  // EXCLUDING any dates already "used up" by a completed chunk. This keeps
  // recalculation idempotent: if today's chunk is already done, today no
  // longer counts as an available slot for redistribution.
  //
  // (Books that haven't started yet — book.startDate > today — are handled
  // by the early return above, so by this point book.startDate <= today.
  // Books with no reading days left at all are handled by the off-pace
  // freeze above, so remainingDates below is never empty by construction —
  // no [today] collapse fallback needed, and none is provided: an empty
  // range should mean "generate nothing," which distributePages already
  // does on its own for an empty dates array.)
  const usedDates = new Set(completeChunks.map(c => c.scheduledDate));
  const remainingDates = getReadingDateRange(today, book.targetFinishDate, readingDays)
    .filter(date => !usedDates.has(date));

  // Redistribute remaining pages across remaining dates
  const firstPage = pagesRead + 1;
  const distributed = distributePages(firstPage, remainingPages, remainingDates);

  const newUpcoming = distributed.map(d => ({
    id: versoScheduledChunkId(book.id, d.scheduledDate, d.pagesStart, d.pagesEnd),
    bookId: book.id,
    label: buildChunkLabel(d.pagesStart, d.pagesEnd, book),
    chapterTitle: '',
    pagesStart: d.pagesStart,
    pagesEnd: d.pagesEnd,
    scheduledDate: d.scheduledDate,
    status: 'upcoming',
    dateCompleted: null
  }));

  return [...completeChunks, ...missedChunks, ...newUpcoming];
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

// ─── Mobile keyboard ────────────────────────────────────────────────────────
//
// GitHub #2 / logic-notes #7. On mobile the on-screen keyboard is drawn
// over the page instead of shrinking it, so a short, centered modal can
// end up with its field under the keyboard. There's nothing to scroll in
// a short modal, so Verso moves the modal itself up with a transform, by
// exactly how far the keyboard covers the focused field. A transform
// doesn't change layout, so Obsidian's own modal sizing is untouched, and
// a tall modal whose field is already visible computes zero and doesn't
// move. Only Verso's own modals are affected. (v1.3.2)
//
// The keyboard's top edge comes from the keyboard events Obsidian's
// mobile app fires (keyboardHeight), falling back to visualViewport when
// those aren't available.
class VersoKeyboardAvoider {
  constructor(plugin) {
    this.plugin = plugin;
    this.keyboardHeight = 0;
    this.shiftedModal = null;
    this.update = this.update.bind(this);
  }

  start() {
    const plugin = this.plugin;
    const onShow = (e) => {
      const h = e && (e.keyboardHeight || (e.detail && e.detail.keyboardHeight));
      if (h) this.keyboardHeight = h;
      this.scheduleUpdate();
    };
    const onHide = () => {
      this.keyboardHeight = 0;
      this.reset();
    };
    ['keyboardWillShow', 'keyboardDidShow'].forEach(name => plugin.registerDomEvent(window, name, onShow));
    ['keyboardWillHide', 'keyboardDidHide'].forEach(name => plugin.registerDomEvent(window, name, onHide));
    plugin.registerDomEvent(document, 'focusin', () => this.scheduleUpdate());
    plugin.registerDomEvent(document, 'focusout', () => this.scheduleUpdate());
    if (window.visualViewport) {
      plugin.registerDomEvent(window.visualViewport, 'resize', () => this.scheduleUpdate());
    }
    plugin.register(() => this.reset());
  }

  // The keyboard animates in, so measure again shortly after.
  scheduleUpdate() {
    window.requestAnimationFrame(this.update);
    window.setTimeout(this.update, 300);
  }

  // Bottom edge of the area the keyboard leaves visible, in client pixels.
  visibleBottom() {
    const fromEvent = this.keyboardHeight > 0 ? window.innerHeight - this.keyboardHeight : Infinity;
    const vv = window.visualViewport;
    const fromViewport = vv ? vv.offsetTop + vv.height : Infinity;
    return Math.min(fromEvent, fromViewport, window.innerHeight);
  }

  update() {
    const el = document.activeElement;
    const isField = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
    const modal = isField ? el.closest('.modal') : null;
    if (!modal || !modal.querySelector('[class*="verso-"]')) {
      this.reset();
      return;
    }
    if (this.shiftedModal && this.shiftedModal !== modal) this.reset();

    const current = this.shiftedModal === modal ? (modal._versoShift || 0) : 0;
    // Positions as if the modal weren't shifted.
    const fieldBottom = el.getBoundingClientRect().bottom + current;
    const modalTop = modal.getBoundingClientRect().top + current;
    const margin = 16;
    const overlap = fieldBottom + margin - this.visibleBottom();
    // Never push the top of the modal off the screen.
    const topLimit = Math.max(0, modalTop - margin);
    const shift = Math.max(0, Math.min(overlap, topLimit));

    if (shift === current) return;
    if (shift === 0) {
      this.reset();
      return;
    }
    modal.style.transition = 'transform 0.15s ease-out';
    modal.style.transform = `translateY(-${Math.round(shift)}px)`;
    modal._versoShift = Math.round(shift);
    this.shiftedModal = modal;
  }

  reset() {
    const modal = this.shiftedModal;
    if (!modal) return;
    modal.style.transform = '';
    modal._versoShift = 0;
    this.shiftedModal = null;
  }
}

// Backstop interval for noticing data.json changes from a sync tool. The
// focus and visibility checks catch most changes right away. (v1.3.2)
const VERSO_EXTERNAL_CHECK_MS = 5 * 60 * 1000;

class VersoPlugin extends Plugin {

  async onload() {
    console.log(`Verso v${this.manifest.version} loading...`);
    await this.loadSettings();

    // Merge any copy a sync tool set aside while Verso was closed (v1.3.3).
    this.externalCheckInProgress = true;
    try {
      await this.mergeConflictFiles();
    } catch (e) {
      console.error('Verso: could not merge sync conflict files.', e);
    } finally {
      this.externalCheckInProgress = false;
    }

    // Catch up any missed reading days and redistribute schedules
    await this.recalculateAllBooks();

    this.setupStatusBar();

    // ...and do it again whenever the calendar day changes while Obsidian
    // stays open (see checkDayRollover).
    this.lastKnownDay = versoToday();
    this.rolloverInProgress = false;
    this.registerInterval(window.setInterval(() => this.checkDayRollover(), 60 * 1000));

    // Pick up data.json changes written by a sync tool on another device
    // (logic-notes #9). Checked when Obsidian regains focus or becomes
    // visible again, which covers the usual case of picking up the other
    // device, with a slower poll as a backstop. No file watcher: mobile
    // doesn't support one. (v1.3.2)
    this.externalCheckInProgress = false;
    await this.rememberDataMtime();
    this.registerDomEvent(window, 'focus', () => this.checkExternalDataChange());
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') this.checkExternalDataChange();
    });
    this.registerInterval(window.setInterval(() => this.checkExternalDataChange(), VERSO_EXTERNAL_CHECK_MS));

    // Keep Verso's modal fields above the mobile keyboard (GitHub #2).
    if (document.body.classList.contains('is-mobile')) {
      new VersoKeyboardAvoider(this).start();
    }

    this.registerView(
      VIEW_TYPE_VERSO_DASHBOARD,
      (leaf) => new VersoDashboardView(leaf, this)
    );

    this.registerView(
      VIEW_TYPE_VERSO_BOOK,
      (leaf) => new VersoBookView(leaf, this)
    );

    this.registerView(
      VIEW_TYPE_VERSO_LIBRARY,
      (leaf) => new VersoLibraryView(leaf, this)
    );

    this.registerView(
      VIEW_TYPE_VERSO_TODAY,
      (leaf) => new VersoTodaySidebarView(leaf, this)
    );

    this.addRibbonIcon('book-open', 'Verso', (evt) => {
      this.activateDashboardView();
    });

    this.addCommand({
      id: 'verso-open-dashboard',
      name: 'Open dashboard',
      callback: () => {
        this.activateDashboardView();
      }
    });

    this.addCommand({
      id: 'verso-open-library',
      name: 'Open library',
      callback: () => {
        this.activateLibraryView();
      }
    });

    this.addCommand({
      id: 'verso-open-today-sidebar',
      name: 'Open Today sidebar',
      callback: () => {
        this.activateTodaySidebar();
      }
    });

    this.addSettingTab(new VersoSettingTab(this.app, this));

    this.addCommand({
      id: 'verso-add-days-off',
      name: 'Add days off',
      callback: () => {
        new VersoDaysOffModal(this.app, this, null, () => {}).open();
      }
    });

    this.addCommand({
      id: 'verso-add-book',
      name: 'Add a book',
      callback: () => {
        new AddBookModal(this.app, this, () => this.refreshAllViews()).open();
      }
    });

  }

  onunload() {
    console.log('Verso unloaded.');
  }

  // Open the dashboard view in a new tab, or reveal it if already open.
  async activateDashboardView() {
    const { workspace } = this.app;

    // If the active tab is already a Verso view, swap it in place — avoids
    // piling up separate dashboard/book tabs as the user navigates between them.
    const active = this.getActiveLeaf();
    if (active && this.isVersoLeaf(active)) {
      await active.setViewState({ type: VIEW_TYPE_VERSO_DASHBOARD, active: true });
      workspace.revealLeaf(active);
      return;
    }

    const existing = workspace.getLeavesOfType(VIEW_TYPE_VERSO_DASHBOARD);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE_VERSO_DASHBOARD, active: true });
    workspace.revealLeaf(leaf);
  }

  // The leaf of the active view. Replaces workspace.activeLeaf, which
  // Obsidian has deprecated. (v1.3.2)
  getActiveLeaf() {
    const view = this.app.workspace.getActiveViewOfType(ItemView);
    return view ? view.leaf : null;
  }

  // True if the given leaf is currently showing a Verso dashboard, book, or
  // library view.
  isVersoLeaf(leaf) {
    if (!leaf.view) return false;
    const type = leaf.view.getViewType();
    return type === VIEW_TYPE_VERSO_DASHBOARD ||
      type === VIEW_TYPE_VERSO_BOOK ||
      type === VIEW_TYPE_VERSO_LIBRARY;
  }

  // If a dashboard view is currently open, re-render it. Used so actions
  // triggered from outside the dashboard (e.g. the command palette's
  // "Add a book") still update an already-open dashboard tab.
  refreshOpenDashboard() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_VERSO_DASHBOARD);
    leaves.forEach(leaf => {
      if (leaf.view && typeof leaf.view.render === 'function') {
        leaf.view.render();
      }
    });
  }

  // Mirror of refreshOpenDashboard for the Today sidebar — keeps the two
  // checklists in sync regardless of which one a chunk gets checked off in.
  refreshOpenSidebar() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_VERSO_TODAY);
    leaves.forEach(leaf => {
      if (leaf.view && typeof leaf.view.render === 'function') {
        leaf.view.render();
      }
    });
  }

  // Open the Today sidebar in the right-hand dock — distinct from the main
  // tabbed views (Dashboard/Book/Library), which open via getLeaf('tab').
  // A docked pane uses getRightLeaf instead, and is deliberately NOT part of
  // isVersoLeaf's tab-swap logic: it should stay put, never get swapped out
  // when the reader navigates between Dashboard/Book/Library tabs.
  async activateTodaySidebar() {
    const { workspace } = this.app;

    const existing = workspace.getLeavesOfType(VIEW_TYPE_VERSO_TODAY);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_VERSO_TODAY, active: true });
    workspace.revealLeaf(leaf);
  }

  // Open the detail view for a specific book in a new tab (or reuse an
  // existing book-view tab, repointing it at the requested book).
  // fromView/fromTab let the book view's back link return to where the
  // user came from (e.g. 'library' + a specific tab) instead of always
  // defaulting to the dashboard.
  async activateBookView(bookId, fromView, fromTab) {
    const { workspace } = this.app;
    const state = { bookId, fromView: fromView || null, fromTab: fromTab || null };

    const active = this.getActiveLeaf();
    if (active && this.isVersoLeaf(active)) {
      await active.setViewState({
        type: VIEW_TYPE_VERSO_BOOK,
        active: true,
        state
      });
      workspace.revealLeaf(active);
      return;
    }

    const existing = workspace.getLeavesOfType(VIEW_TYPE_VERSO_BOOK);
    const leaf = existing.length > 0 ? existing[0] : workspace.getLeaf('tab');

    await leaf.setViewState({
      type: VIEW_TYPE_VERSO_BOOK,
      active: true,
      state
    });
    workspace.revealLeaf(leaf);
  }

  // Open the Library view in a new tab, or reveal/reuse an existing one.
  // Same-tab swap pattern as activateBookView/activateDashboardView.
  async activateLibraryView(activeTab) {
    const { workspace } = this.app;
    const state = activeTab ? { activeTab } : undefined;

    const active = this.getActiveLeaf();
    if (active && this.isVersoLeaf(active)) {
      await active.setViewState({
        type: VIEW_TYPE_VERSO_LIBRARY,
        active: true,
        state
      });
      workspace.revealLeaf(active);
      return;
    }

    const existing = workspace.getLeavesOfType(VIEW_TYPE_VERSO_LIBRARY);
    const leaf = existing.length > 0 ? existing[0] : workspace.getLeaf('tab');

    await leaf.setViewState({
      type: VIEW_TYPE_VERSO_LIBRARY,
      active: true,
      state
    });
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // Migration: a book can reach 'complete' status while still carrying
    // leftover 'missed' or 'upcoming' chunks (see checkBookCompletion).
    // Going forward, checkBookCompletion prunes these at the moment of
    // completion — but any book that completed before that fix shipped may
    // already have stranded chunks sitting in saved data. Sweep them out on
    // every load so old vaults self-heal the same way the future-start
    // phantom-chunk fix does in recalculateSchedule.
    const completeBookIds = new Set(
      this.settings.books.filter(b => b.status === 'complete').map(b => b.id)
    );
    if (completeBookIds.size > 0) {
      this.settings.chunks = this.settings.chunks.filter(c =>
        !completeBookIds.has(c.bookId) || c.status === 'complete'
      );
    }

    // Migration: 'originalTargetFinishDate' was added after some books were
    // already created, so older saved books won't have it. Backfill with the
    // book's current targetFinishDate — the most honest available guess,
    // since no record of an earlier value exists. This means a book that was
    // actually rescheduled before this fix shipped will look unrescheduled
    // going forward; accepted, since there's no way to recover the true
    // original date for those books.
    // Own copy, so pushing to it never touches DEFAULT_SETTINGS.
    this.settings.quotesShown = Array.isArray(this.settings.quotesShown)
      ? [...this.settings.quotesShown]
      : [];
    this.settings.daysOff = Array.isArray(this.settings.daysOff)
      ? [...this.settings.daysOff]
      : [];

    this.settings.books.forEach(book => {
      if (!book.originalTargetFinishDate) {
        book.originalTargetFinishDate = book.targetFinishDate;
      }
    });

    // Sync merge bookkeeping (v1.3.3): tombstones, and what the file held
    // as loaded, so the next save can tell what this device changed.
    if (!this.settings.deletedIds || typeof this.settings.deletedIds !== 'object') {
      this.settings.deletedIds = {};
    }
    this.syncSnapshot = versoSnapshot(this.settings);
    await this.rememberDataMtime();
  }

  async saveSettings() {
    // While Verso's own write is in flight, the file's time has changed
    // but lastDataMtime hasn't caught up, so the external check would
    // mistake it for a sync write. saveDepth tells it to wait.
    this.saveDepth = (this.saveDepth || 0) + 1;
    try {
      versoStampChanges(this.settings, this.syncSnapshot, new Date().toISOString());
      const merged = await this.mergeDiskBeforeSave();
      await this.saveData(this.settings);
      this.syncSnapshot = versoSnapshot(this.settings);
      await this.rememberDataMtime();
      if (merged) this.refreshAllViews();
      this.updateStatusBar();
    } finally {
      this.saveDepth--;
    }
  }

  // ── Status bar (v1.4.0) ─────────────────────────────────────
  //
  // "12 pages left today". Desktop only: phones have no status bar. Hidden
  // when nothing is left. Same count as the dashboard's "Pages today".
  // Updated after every save and view refresh, which covers checking off a
  // reading and the day rolling over. Click opens the dashboard.
  setupStatusBar() {
    if (Platform && Platform.isMobile) return;
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('verso-status-bar');
    this.statusBarEl.addClass('mod-clickable');
    this.statusBarEl.setAttribute('aria-label', 'Open Verso dashboard');
    this.registerDomEvent(this.statusBarEl, 'click', () => this.activateDashboardView());
    this.updateStatusBar();
  }

  pagesLeftToday() {
    return this.getTodaysChunks().reduce((sum, c) => sum + (c.pagesEnd - c.pagesStart + 1), 0);
  }

  updateStatusBar() {
    if (!this.statusBarEl) return;
    const n = this.pagesLeftToday();
    this.statusBarEl.setText(n > 0 ? `${n} page${n === 1 ? '' : 's'} left today` : '');
    this.statusBarEl.style.display = n > 0 ? '' : 'none';
  }

  // If a sync tool replaced data.json since Verso last read or wrote it,
  // merge that copy in before writing, instead of overwriting it. Returns
  // true if a merge happened. (v1.3.3)
  async mergeDiskBeforeSave() {
    if (this.lastDataMtime == null) return false;
    const adapter = this.app.vault.adapter;
    let disk;
    try {
      const stat = await adapter.stat(this.dataFilePath());
      if (!stat || stat.mtime === this.lastDataMtime) return false;
      disk = JSON.parse(await adapter.read(this.dataFilePath()));
    } catch (e) {
      console.error('Verso: could not read data.json to merge before saving.', e);
      return false;
    }
    this.settings = versoMergeData(this.settings, Object.assign({}, DEFAULT_SETTINGS, disk));
    this.recalculateActiveBooksInMemory();
    return true;
  }

  recalculateActiveBooksInMemory() {
    this.settings.books
      .filter(b => b.status !== 'complete' && b.status !== 'archived' && b.status !== 'planned')
      .forEach(b => this.recalculateBookInMemory(b.id));
  }

  // Sync tools keep the losing copy when two devices both changed
  // data.json, e.g. Syncthing's data.sync-conflict-*.json or Dropbox's
  // "data (conflicted copy).json". Merge each into Verso's data, then move
  // it into merged-conflicts/ so it's handled once. Returns true if any
  // were merged. (v1.3.3)
  async mergeConflictFiles() {
    const adapter = this.app.vault.adapter;
    const dir = this.manifest.dir;
    let files;
    try {
      files = (await adapter.list(dir)).files;
    } catch (e) {
      return false;
    }
    const conflicts = files.filter(f => {
      const name = f.split('/').pop();
      return name !== 'data.json' && /^data\b.*conflict.*\.json$/i.test(name);
    });
    if (conflicts.length === 0) return false;

    const archiveDir = `${dir}/merged-conflicts`;
    let mergedAny = false;
    for (const file of conflicts) {
      let copy;
      try {
        copy = JSON.parse(await adapter.read(file));
      } catch (e) {
        console.error(`Verso: could not read ${file}; leaving it in place.`, e);
        continue;
      }
      this.settings = versoMergeData(this.settings, Object.assign({}, DEFAULT_SETTINGS, copy));
      mergedAny = true;
      try {
        if (!(await adapter.exists(archiveDir))) await adapter.mkdir(archiveDir);
        await adapter.rename(file, `${archiveDir}/${file.split('/').pop()}`);
      } catch (e) {
        // Leaving it in place only means it's merged again next time,
        // which changes nothing.
        console.error(`Verso: merged ${file} but could not move it.`, e);
      }
    }
    if (!mergedAny) return false;

    // Merged records keep the stamps they came with, rather than counting
    // as changed on this device.
    this.syncSnapshot = versoSnapshot(this.settings);
    this.recalculateActiveBooksInMemory();
    for (const book of this.settings.books.filter(b => b.status === 'active')) {
      const finished = this.lastChunkCompletionDate(book.id);
      if (finished) await this.checkBookCompletion(book.id, finished);
    }
    await this.saveSettings();
    this.refreshAllViews();
    new Notice('Verso merged reading changes from another device.');
    return true;
  }

  // ── External changes to data.json (sync) ────────────────────

  dataFilePath() {
    return `${this.manifest.dir}/data.json`;
  }

  // Records data.json's modified time after Verso's own load or save, so
  // only writes from outside Verso count as external changes.
  async rememberDataMtime() {
    try {
      const stat = await this.app.vault.adapter.stat(this.dataFilePath());
      this.lastDataMtime = stat ? stat.mtime : null;
    } catch (e) {
      this.lastDataMtime = null;
    }
  }

  async checkExternalDataChange() {
    if (this.externalCheckInProgress || this.saveDepth > 0 || this.rolloverInProgress) return;
    this.externalCheckInProgress = true;
    try {
      const stat = await this.app.vault.adapter.stat(this.dataFilePath());
      if (stat && stat.mtime !== this.lastDataMtime) await this.reloadFromDisk();
      await this.mergeConflictFiles();
    } catch (e) {
      console.error('Verso: could not check data.json for outside changes.', e);
    } finally {
      this.externalCheckInProgress = false;
    }
  }

  // Obsidian calls this when it notices data.json changed on disk.
  async onExternalSettingsChange() {
    await this.checkExternalDataChange();
  }

  // Replace the in-memory data with what's on disk, bring schedules up to
  // today, and redraw every open view.
  async reloadFromDisk() {
    await this.loadSettings();
    await this.rememberDataMtime();
    await this.recalculateAllBooks();
    this.refreshAllViews();
  }

  // ── Collection helpers ──────────────────────────────────────

  async addCollection(data) {
    const collection = createCollection(data);
    this.settings.collections.push(collection);
    await this.saveSettings();
    return collection;
  }

  getCollection(id) {
    return this.settings.collections.find(c => c.id === id);
  }

  async updateCollection(id, updates) {
    const index = this.settings.collections.findIndex(c => c.id === id);
    if (index === -1) return null;
    this.settings.collections[index] = { ...this.settings.collections[index], ...updates };
    await this.saveSettings();
    return this.settings.collections[index];
  }

  // Deleting a collection removes only the collection. Its books stay,
  // with no collection. (Earlier versions deleted every book in it, along
  // with their schedules. No UI calls this yet.) (v1.3.2)
  async deleteCollection(id) {
    this.settings.collections = this.settings.collections.filter(c => c.id !== id);
    this.settings.books.forEach(b => {
      if (b.collectionId === id) b.collectionId = null;
    });
    await this.saveSettings();
    this.refreshAllViews();
  }

  // ── Book helpers ────────────────────────────────────────────

  async addBook(data) {
    const book = createBook(data);
    this.settings.books.push(book);
    if (data.collectionId) {
      const collection = this.getCollection(data.collectionId);
      if (collection) {
        collection.books.push(book.id);
        await this.updateCollection(data.collectionId, { books: collection.books });
      }
    }
    await this.saveSettings();

    // Build a schedule and go active only if the book has everything a
    // schedule needs AND the caller didn't explicitly request 'planned'.
    // Note: check data.status (what the caller asked for), not book.status —
    // createBook() defaults status to 'planned' when no status is given, so
    // book.status here is always 'planned' unless the caller set it.
    // A planned book may still carry a targetFinishDate (e.g. a syllabus
    // due date) without being ready to schedule yet.
    if (data.status !== 'planned' && book.totalPages > 0 && book.startDate && book.targetFinishDate) {
      await this.buildScheduleForBook(book.id);
      book.status = 'active';
      await this.updateBook(book.id, { status: 'active' });
    }

    return book;
  }

  getBook(id) {
    return this.settings.books.find(b => b.id === id);
  }

  getBooksForCollection(collectionId) {
    return this.settings.books.filter(b => b.collectionId === collectionId);
  }

  async updateBook(id, updates) {
    const index = this.settings.books.findIndex(b => b.id === id);
    if (index === -1) return null;
    this.settings.books[index] = { ...this.settings.books[index], ...updates };
    await this.saveSettings();
    return this.settings.books[index];
  }

  // Removes the book, its chunks, its sessions, and its place in any
  // collection's book list. (Sessions and collection references used to
  // be left behind.) Refreshes every open view. (v1.3.2)
  async deleteBook(id) {
    this.settings.books = this.settings.books.filter(b => b.id !== id);
    this.settings.chunks = this.settings.chunks.filter(c => c.bookId !== id);
    this.settings.sessions = (this.settings.sessions || []).filter(s => s.bookId !== id);
    this.settings.collections.forEach(c => {
      if (Array.isArray(c.books)) c.books = c.books.filter(bookId => bookId !== id);
    });
    await this.saveSettings();
    this.refreshAllViews();
  }

  // Archive: hide from the dashboard but keep all data, recoverable via
  // the Library's Archived tab. The book's chunks are left untouched.
  // Records the book's status at the moment of archiving (statusBeforeArchive)
  // so Restore can return it to the right place — e.g. a book archived from
  // Completed should restore to Completed, not jump back onto the dashboard
  // as Active.
  // reasonData: { archiveReason: string, archiveReasonCategory: string|null }
  async archiveBook(id, reasonData = {}) {
    const book = this.getBook(id);
    const statusBeforeArchive = book && book.status !== 'archived' ? book.status : 'active';
    const archived = await this.updateBook(id, {
      status: 'archived',
      statusBeforeArchive,
      archivedDate: new Date().toISOString(),
      archiveReason: reasonData.archiveReason || '',
      archiveReasonCategory: reasonData.archiveReasonCategory || null
    });
    this.refreshAllViews();
    return archived;
  }

  // Edit the reason on an already-archived book (does not touch archivedDate).
  async updateArchiveReason(id, reasonData = {}) {
    const updated = await this.updateBook(id, {
      archiveReason: reasonData.archiveReason || '',
      archiveReasonCategory: reasonData.archiveReasonCategory || null
    });
    this.refreshAllViews();
    return updated;
  }

  // newTargetFinishDate (optional, v1.3.2): for an active book whose
  // timeline had already begun. Sets the new finish date and stamps today
  // as reactivatedDate, so reading days that passed while the book sat in
  // the archive are kept as history but don't count against its status or
  // pace (see isChunkFromCurrentAttempt). Recalculates before returning.
  async restoreBook(id, newTargetFinishDate) {
    const book = this.getBook(id);
    const restoredStatus = (book && book.statusBeforeArchive) || 'active';
    const updates = {
      status: restoredStatus,
      statusBeforeArchive: null,
      archivedDate: null,
      archiveReason: '',
      archiveReasonCategory: null
    };
    if (newTargetFinishDate && restoredStatus === 'active') {
      updates.targetFinishDate = newTargetFinishDate;
      updates.reactivatedDate = versoToday();
    }
    const restored = await this.updateBook(id, updates);
    await this.recalculateBook(id);
    this.refreshAllViews();
    return restored;
  }

  // Restore needs a new finish date only for an active book whose schedule
  // had already started; its old plan kept running while it was archived.
  restoreNeedsNewFinishDate(book) {
    const restoredStatus = book.statusBeforeArchive || 'active';
    return restoredStatus === 'active' && !!book.startDate && book.startDate < versoToday();
  }

  getArchivedBooks() {
    return this.settings.books.filter(b => b.status === 'archived');
  }

  // Promote a planned (or otherwise schedule-less) book to active: set its
  // start/finish dates, mark it active, and build its initial schedule.
  // Returns the updated book, or null if the book doesn't exist.
  async activateBook(bookId, startDate, targetFinishDate) {
    const book = await this.updateBook(bookId, {
      startDate,
      targetFinishDate,
      status: 'active'
    });
    if (!book) return null;

    await this.buildScheduleForBook(bookId);
    this.refreshAllViews();
    return this.getBook(bookId);
  }

  // Update a book's schedule: dates and/or reading days. Three cases:
  //  - Planned book: no schedule exists yet, and building one here would
  //    silently activate the book behind the reader's back. targetFinishDate
  //    and readingDaysOverride are stored as preferences that activateBook()
  //    consumes later; startDate is ignored entirely, because a planned book
  //    doesn't have one until activation deliberately sets it. (Note that
  //    without this branch a planned book's null startDate would fail the
  //    `< versoToday()` test below and fall into the rebuild path.)
  //  - Active, timeline not begun (startDate is today or in the future):
  //    startDate, targetFinishDate, AND readingDaysOverride can all change —
  //    the schedule is fully rebuilt from scratch, same as initial activation.
  //  - Active, timeline begun (startDate in the past): startDate becomes
  //    immutable (it's a historical fact, and the existing schedule may
  //    carry "missed" chunks recording that history — rebuilding from scratch
  //    would erase them). targetFinishDate and readingDaysOverride can still
  //    change, and recalculateSchedule() redistributes the remaining pages
  //    forward (across the new reading days, if changed) while preserving
  //    complete/missed chunks. If this edit pulls the book OUT of off-pace
  //    (see isOffPace), today is stamped as reactivatedDate — see
  //    isChunkFromCurrentAttempt for what that changes.
  //  - readingDaysOverride is optional (undefined = leave unchanged) so
  //    callers that only touch dates don't need to pass it.
  // Returns the updated book, or null if the book doesn't exist.
  async updateBookDates(bookId, startDate, targetFinishDate, readingDaysOverride) {
    const book = this.getBook(bookId);
    if (!book) return null;

    const dateUpdates = { targetFinishDate };
    if (readingDaysOverride !== undefined) dateUpdates.readingDaysOverride = readingDaysOverride;

    // Planned books never touch the chunk-building machinery from here.
    // Same self-protection recalculateBook() already applies.
    if (book.status === 'planned') {
      await this.updateBook(bookId, dateUpdates);
      return this.getBook(bookId);
    }

    // A scheduled book can't lose its dates — an empty finish (or start)
    // date would wipe every upcoming reading day. The edit form blocks
    // this too; this guards every other caller. (v1.3.2)
    if (!targetFinishDate || (!this.hasBookStarted(book) && !startDate)) {
      return book;
    }

    const timelineStarted = this.hasBookStarted(book);

    if (!timelineStarted) {
      dateUpdates.startDate = startDate;
      await this.updateBook(bookId, dateUpdates);
      await this.buildScheduleForBook(bookId);
    } else {
      // Detect an off-pace → active transition BEFORE applying the update,
      // using the book's actual current state. If the reader is setting a
      // new date that pulls the book out of off-pace, stamp today as the
      // start of a fresh reading attempt — every missed chunk from before
      // this date stops counting toward status/progress math (see
      // isChunkFromCurrentAttempt) without ever being deleted. A book that
      // wasn't off-pace, or one whose new date still leaves it off-pace,
      // gets no stamp at all; this is a no-op for the common case of just
      // nudging a healthy book's date around.
      const oldReadingDays = this.getReadingDaysFor(book);
      const wasOffPace = isOffPace(book, oldReadingDays);

      const previewBook = {
        ...book,
        targetFinishDate,
        readingDaysOverride: readingDaysOverride !== undefined ? readingDaysOverride : book.readingDaysOverride
      };
      const newReadingDays = this.getReadingDaysFor(previewBook);
      const willBeOffPace = isOffPace(previewBook, newReadingDays);

      if (wasOffPace && !willBeOffPace) {
        dateUpdates.reactivatedDate = versoToday();
      }

      await this.updateBook(bookId, dateUpdates);
      await this.recalculateBook(bookId);
    }

    return this.getBook(bookId);
  }

  // ── Scheduling ──────────────────────────────────────────────

  // True once a book's schedule has begun: its start date has passed, or
  // any reading has been logged (a book started today can already have
  // today's reading marked). Deciding by date alone let an edit to a book
  // that started today rebuild its schedule from scratch and erase that
  // day's logged reading. (v1.3.2)
  hasBookStarted(book) {
    if (!book || !book.startDate) return false;
    if (book.startDate < versoToday()) return true;
    return this.settings.chunks.some(c => c.bookId === book.id && c.status === 'complete');
  }

  // Rebuild the stored label on every chunk of a book, e.g. "pp. 41-60"
  // or "23%", from its current mode and page count.
  async relabelChunks(bookId) {
    const book = this.getBook(bookId);
    if (!book) return;
    let changed = false;
    this.settings.chunks.forEach(c => {
      if (c.bookId !== bookId) return;
      const label = buildChunkLabel(c.pagesStart, c.pagesEnd, book);
      if (c.label !== label) {
        c.label = label;
        changed = true;
      }
    });
    if (changed) await this.saveSettings();
  }

  // Get the effective reading-days setting for a book (its override, or the global default)
  // Includes days off (all-book and this book's) when any are set.
  getReadingDaysFor(book) {
    const weekly = book.readingDaysOverride || this.settings.readingDays === 'custom'
      ? (book.readingDaysOverride || this.settings.customReadingDays)
      : this.settings.readingDays;
    return versoWithDaysOff(weekly, [...(this.settings.daysOff || []), ...(book.daysOff || [])]);
  }

  // ── Days off (v1.4.0) ───────────────────────────────────────

  // Active books a days-off range would apply to: one book, or all.
  daysOffBooks(bookId) {
    return this.settings.books.filter(b => b.status === 'active' && (!bookId || b.id === bookId));
  }

  // What adding a range would do to each affected book, without changing
  // anything: [{ book, lost, noneLeft, newFinish, paceBefore, paceAfter }].
  // noneLeft: the range covers every reading day left before the finish
  // date. Keeping that date would leave the book off pace, with all its
  // upcoming readings frozen as missed, so its finish date has to move.
  previewDaysOff(range, bookId) {
    return this.daysOffBooks(bookId).map(book => {
      const before = this.getReadingDaysFor(book);
      const after = versoWithDaysOff(before.weekly !== undefined ? before.weekly : before,
        [...(before.off || []), range]);
      const progress = this.getBookProgress(book.id);
      const pagesRead = progress ? progress.pagesRead : 0;
      const lost = versoReadingDaysLost(book, before, after);
      return {
        book,
        lost,
        noneLeft: lost > 0 && versoReadingDaysLeft(book, after) <= 0,
        newFinish: versoFinishDateAfterDaysOff(book, before, after),
        paceBefore: calculatePaceNeeded(book.totalPages, pagesRead, book.targetFinishDate, before),
        paceAfter: calculatePaceNeeded(book.totalPages, pagesRead, book.targetFinishDate, after)
      };
    });
  }

  // Adds a days-off range for one book (bookId) or all books (null). With
  // moveFinishDates, each book that loses reading days gets a later finish
  // date that gives them back; otherwise the pages are spread over the
  // reading days that remain. A book left with no reading days at all
  // (noneLeft) has its finish date moved either way.
  //
  // The finish date is set directly, not through updateBookDates(). That
  // function checks for off pace against the book's reading days, which by
  // then include the new range: a book the range would leave with no days
  // looked off pace, the new date seemed to rescue it, and it was stamped
  // reactivatedDate, which stops earlier missed readings from counting.
  // Days off never start a new attempt. (v1.4.0)
  async addDaysOff({ start, end, label }, bookId, moveFinishDates) {
    const range = { id: generateId(), start, end, label: (label || '').trim() };
    const plan = this.previewDaysOff(range, bookId)
      .filter(p => moveFinishDates || p.noneLeft);

    if (bookId) {
      const book = this.getBook(bookId);
      if (!book) return;
      const i = this.settings.books.indexOf(book);
      this.settings.books[i] = { ...book, daysOff: [...(book.daysOff || []), range] };
    } else {
      this.settings.daysOff = [...(this.settings.daysOff || []), range];
    }

    for (const p of plan) {
      if (p.newFinish && p.newFinish !== p.book.targetFinishDate) {
        const i = this.settings.books.findIndex(b => b.id === p.book.id);
        if (i !== -1) this.settings.books[i] = { ...this.settings.books[i], targetFinishDate: p.newFinish };
      }
    }
    this.daysOffBooks(bookId).forEach(b => this.recalculateBookInMemory(b.id));
    await this.saveSettings();
    this.refreshAllViews();
  }

  // Removes a range wherever it is. Finish dates aren't moved back.
  async removeDaysOff(id) {
    this.settings.daysOff = (this.settings.daysOff || []).filter(r => r.id !== id);
    this.settings.books = this.settings.books.map(b =>
      (b.daysOff || []).some(r => r.id === id)
        ? { ...b, daysOff: b.daysOff.filter(r => r.id !== id) }
        : b
    );
    await this.recalculateAllBooks();
    await this.saveSettings();
    this.refreshAllViews();
  }

  // Every range that hasn't ended yet, with the book it belongs to (null =
  // all books), soonest first.
  upcomingDaysOff(bookId) {
    const today = versoToday();
    const list = [];
    (this.settings.daysOff || []).forEach(r => list.push({ range: r, book: null }));
    this.settings.books.forEach(b => (b.daysOff || []).forEach(r => list.push({ range: r, book: b })));
    return list
      .filter(x => x.range.end >= today && (!bookId || !x.book || x.book.id === bookId))
      .sort((a, b) => a.range.start.localeCompare(b.range.start));
  }

  // Build and store the initial schedule for a book that has no chunks yet
  async buildScheduleForBook(bookId) {
    const book = this.getBook(bookId);
    if (!book) return [];

    const readingDays = this.getReadingDaysFor(book);
    const scheduleData = generateSchedule(book, readingDays);
    const chunks = scheduleData.map(data => createChunk(data));

    // Remove any existing chunks for this book first (in case of rebuild)
    this.settings.chunks = this.settings.chunks.filter(c => c.bookId !== bookId);
    this.settings.chunks.push(...chunks);

    await this.saveSettings();
    return chunks;
  }

  // Recalculate one book's schedule — marks overdue chunks as missed and
  // redistributes remaining pages across remaining reading days.
  async recalculateBook(bookId) {
    if (this.recalculateBookInMemory(bookId)) {
      await this.saveSettings();
    }
  }

  // Recalculates one book's chunks in memory only. Returns true if the
  // chunk set actually changed, false if the recalculation was a no-op.
  // Callers decide whether (and how often) to save — see recalculateBook
  // and recalculateAllBooks.
  recalculateBookInMemory(bookId) {
    const book = this.getBook(bookId);
    if (!book || book.status === 'complete' || book.status === 'planned') return false;

    const existingChunks = this.getChunksForBook(bookId);
    const readingDays = this.getReadingDaysFor(book);

    // A day selection with no days at all would make the book look
    // off-pace and permanently freeze its upcoming chunks as 'missed'.
    // Leave the schedule alone until a real selection exists.
    const weekly = versoWeeklyDays(readingDays);
    if (typeof weekly === 'object' && !Object.values(weekly).some(v => v === true)) {
      return false;
    }

    const updatedChunks = recalculateSchedule(book, existingChunks, readingDays);

    if (versoChunkSetsEqual(existingChunks, updatedChunks)) return false;

    // Replace this book's chunks with the recalculated set
    this.settings.chunks = this.settings.chunks.filter(c => c.bookId !== bookId);
    this.settings.chunks.push(...updatedChunks);
    return true;
  }

  // Recalculate every active book — run on plugin load, at day rollover, and
  // when the global reading days change. Saves ONCE at the end, and only if
  // at least one book's schedule actually changed: on a normal restart
  // nothing has changed since the last recalculation, so data.json is left
  // untouched (which is what keeps sync tools from producing conflicts).
  async recalculateAllBooks() {
    const activeBooks = this.settings.books.filter(b =>
      b.status !== 'complete' && b.status !== 'archived' && b.status !== 'planned'
    );
    let anyChanged = false;
    for (const book of activeBooks) {
      if (this.recalculateBookInMemory(book.id)) anyChanged = true;
    }
    if (anyChanged) await this.saveSettings();
    return anyChanged;
  }

  // ── Day rollover ────────────────────────────────────────────
  //
  // Recalculation used to run only on plugin load, so with Obsidian left
  // open overnight yesterday's unread pages weren't redistributed (and
  // "today" in every view was stale) until a restart. Checked once a
  // minute; cheap, since it's just a string compare until the date changes.
  async checkDayRollover() {
    const today = versoToday();
    if (today === this.lastKnownDay || this.rolloverInProgress) return;
    this.rolloverInProgress = true;
    try {
      this.lastKnownDay = today;
      await this.recalculateAllBooks();
      this.refreshAllViews();
    } finally {
      this.rolloverInProgress = false;
    }
  }

  refreshBookAndLibraryViews() {
    // Checking off a reading happens in the dashboard or sidebar, which
    // refresh each other. Book and Library views show progress too, so
    // they're refreshed here. (v1.3.2)
    [VIEW_TYPE_VERSO_BOOK, VIEW_TYPE_VERSO_LIBRARY].forEach(type => {
      this.app.workspace.getLeavesOfType(type).forEach(leaf => {
        if (leaf.view && typeof leaf.view.render === 'function') leaf.view.render();
      });
    });
  }

  // Re-render every open Verso view (dashboard, sidebar, book, library).
  // Called after any change that affects more than the view it came from:
  // archive, restore, delete, Start reading, edits, adds. (v1.3.2)
  refreshAllViews() {
    this.updateStatusBar();
    [VIEW_TYPE_VERSO_DASHBOARD, VIEW_TYPE_VERSO_TODAY, VIEW_TYPE_VERSO_BOOK, VIEW_TYPE_VERSO_LIBRARY]
      .forEach(type => {
        this.app.workspace.getLeavesOfType(type).forEach(leaf => {
          if (leaf.view && typeof leaf.view.render === 'function') {
            leaf.view.render();
          }
        });
      });
  }

  // ── Chunk helpers ───────────────────────────────────────────

  async addChunk(data) {
    const chunk = createChunk(data);
    this.settings.chunks.push(chunk);
    await this.saveSettings();
    return chunk;
  }

  getChunksForBook(bookId) {
    return this.settings.chunks
      .filter(c => c.bookId === bookId)
      .sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate));
  }

  // Both getTodaysChunks() and getAllTodaysChunks() filter to ACTIVE books
  // only. Archiving a book deliberately leaves its chunks untouched (see
  // archiveBook) — so without this filter, an archived book's chunks still
  // surface here if their scheduledDate happens to be today. The dashboard
  // never hit this because it filters to active books before ever calling
  // these, but that's a fragile habit to rely on at every call site — the
  // Today sidebar (which calls getAllTodaysChunks() directly, with no filter
  // of its own) surfaced exactly this gap. Fixed at the source so every
  // current and future caller gets correct behavior automatically.
  //
  // Status filter is intentionally the explicit allow-list 'upcoming'
  // (Complete added back in getAllTodaysChunks) rather than the looser
  // "!== 'complete'" this used to be. Before the off-pace freeze existed, a
  // 'missed' chunk was always dated in the past by construction, so it could
  // never collide with a scheduledDate === today query — "not complete" and
  // "upcoming" were equivalent in practice. The freeze branch in
  // recalculateSchedule() broke that: it converts every still-upcoming chunk
  // to 'missed' regardless of its date, including one dated exactly today,
  // so a frozen off-pace book could show a "missed" chunk dated today that
  // the old filter would still treat as actionable. Being explicit here
  // means "actionable today" can never again silently include a status that
  // was never meant to be actionable.
  getTodaysChunks() {
    const today = versoToday();
    const activeBookIds = new Set(
      this.settings.books.filter(b => b.status === 'active').map(b => b.id)
    );
    return this.settings.chunks.filter(c =>
      c.scheduledDate === today && c.status === 'upcoming' && activeBookIds.has(c.bookId)
    );
  }

  // Like getTodaysChunks(), but includes chunks already marked complete today —
  // used by the dashboard so checked-off items stay visible.
  getAllTodaysChunks() {
    const today = versoToday();
    const activeBookIds = new Set(
      this.settings.books.filter(b => b.status === 'active').map(b => b.id)
    );
    return this.settings.chunks.filter(c =>
      c.scheduledDate === today &&
      (c.status === 'upcoming' || c.status === 'complete') &&
      activeBookIds.has(c.bookId)
    );
  }

  // Tomorrow's scheduled chunks, for the sidebar's read-ahead preview.
  // Includes chunks already completed (a reader who read ahead into
  // tomorrow's pages today) — same inclusive shape as getAllTodaysChunks(),
  // including the same explicit 'upcoming'/'complete' allow-list rather than
  // an unfiltered pull by date alone.
  getTomorrowsChunks() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = versoLocalDateString(tomorrow);
    const activeBookIds = new Set(
      this.settings.books.filter(b => b.status === 'active').map(b => b.id)
    );
    return this.settings.chunks.filter(c =>
      c.scheduledDate === tomorrowStr &&
      (c.status === 'upcoming' || c.status === 'complete') &&
      activeBookIds.has(c.bookId)
    );
  }

async markChunkComplete(chunkId, actualEnd = null) {
    const index = this.settings.chunks.findIndex(c => c.id === chunkId);
    if (index === -1) return null;
    const chunk = this.settings.chunks[index];

    // If the reader logged an actual ending page that differs from the plan,
    // the chunk's range becomes the truth of what they read. Preserve the
    // planned end as a breadcrumb (for the future insights feature), then
    // mutate pagesEnd — so every downstream page sum (recalc, completion
    // check, status) works against reality with zero further changes.
    // Clamp into the legal range defensively; the modal already validates,
    // but this method is callable from elsewhere.
    if (actualEnd !== null && actualEnd !== chunk.pagesEnd) {
      const book = this.getBook(chunk.bookId);
      const maxPage = book ? book.totalPages : actualEnd;
      chunk.scheduledPagesEnd = chunk.pagesEnd;
      chunk.pagesEnd = Math.max(chunk.pagesStart, Math.min(actualEnd, maxPage));
      chunk.label = buildChunkLabel(chunk.pagesStart, chunk.pagesEnd, book);
    }

    chunk.status = 'complete';
    chunk.dateCompleted = new Date().toISOString();

    // pagesEnd - pagesStart + 1 because page ranges are inclusive
    // (pagesEnd now reflects the actual ending page, if one was logged)
    const pagesRead = chunk.pagesEnd - chunk.pagesStart + 1;

    const session = createSession({
      chunkId: chunk.id,
      bookId: chunk.bookId,
      pagesRead,
      dateCompleted: chunk.dateCompleted
    });
    this.settings.sessions.push(session);

    await this.saveSettings();

    // Recalculate this book in case completing this chunk changes the picture
    // (e.g. it was the last "missed" pages absorbed into today)
    await this.recalculateBook(chunk.bookId);

    // Check if the book is now fully complete
    const bookJustCompleted = await this.checkBookCompletion(chunk.bookId);

    this.refreshBookAndLibraryViews();
    return { chunk, bookJustCompleted };
  }

  // ── Log reading on a day with nothing scheduled (v1.4.0) ────
  //
  // A day off, or a day outside the book's reading days, has no reading to
  // check off. "Log reading" on the dashboard card records one anyway:
  // a reading dated today that starts at the next unread page, pre-filled
  // to the end of the next scheduled reading. recalculateSchedule keeps
  // completed readings on any date, counts their pages as read and treats
  // today as used, so the remaining pages are simply spread over the
  // remaining reading days. Finish dates and days off don't change.
  //
  // extraReadingFor() only builds the reading; nothing is stored until
  // logExtraReading() is called with the page the reader reached.
  // Returns null when the book has nothing left to read.
  extraReadingFor(bookId) {
    const book = this.getBook(bookId);
    if (!book || book.status !== 'active') return null;
    const chunks = this.getChunksForBook(bookId);
    const pagesRead = chunks
      .filter(c => c.status === 'complete')
      .reduce((sum, c) => sum + (c.pagesEnd - c.pagesStart + 1), 0);
    if (pagesRead >= book.totalPages) return null;
    const pagesStart = pagesRead + 1;
    const next = chunks.find(c => c.status === 'upcoming');
    const pagesEnd = Math.min(book.totalPages,
      Math.max(pagesStart, next ? next.pagesEnd : book.totalPages));
    return {
      bookId,
      label: buildChunkLabel(pagesStart, pagesEnd, book),
      pagesStart,
      pagesEnd,
      scheduledDate: versoToday(),
      status: 'upcoming'
    };
  }

  // Stores a reading from extraReadingFor() and marks it read up to
  // actualEnd. `extra: true` tells it apart from a scheduled reading, for
  // future reading stats. Same result shape as markChunkComplete().
  async logExtraReading(reading, actualEnd) {
    const chunk = { ...createChunk(reading), extra: true };
    this.settings.chunks.push(chunk);
    return this.markChunkComplete(chunk.id, actualEnd);
  }

  // ── Log more pages after today's reading is done (v1.4.1) ───
  //
  // A reader who reads in several sittings checks off today's reading,
  // then reads again later. Before 1.4.1 the only way to add those pages
  // was to uncheck and recheck the reading. "Log more pages" records the
  // extra sitting as its own reading, exactly as "Log reading" does on a
  // day with nothing scheduled. (Evarinyah, Discord, 2026-10-22)
  //
  // Returns the reading to log when the book has something scheduled
  // today and all of it is checked off; otherwise null. Off-pace books
  // are left out, as they are for "Log reading".
  moreReadingFor(bookId) {
    const book = this.getBook(bookId);
    if (!book) return null;
    const todays = this.getAllTodaysChunks().filter(c => c.bookId === bookId);
    if (todays.length === 0 || todays.some(c => c.status !== 'complete')) return null;
    if (getBookStatus(book, this.settings.chunks, this.getReadingDaysFor(book)) === 'off-pace') return null;
    const reading = this.extraReadingFor(bookId);
    if (!reading) return null;

    // Nothing was scheduled today (a day off, or not a reading day): the
    // only readings are sittings logged with "Log reading", so there's no
    // "today's reading" to call done. Say how much was logged instead.
    if (todays.every(c => c.extra)) {
      reading.nothingScheduled = true;
      reading.todayRead = todays.reduce((n, c) => n + (c.pagesEnd - c.pagesStart + 1), 0);
      return reading;
    }

    // Fell short of today's plan (e.g. read 8 of 10 pages): suggest
    // finishing today's pages, not the whole next reading, which by now
    // has absorbed the shortfall. Only scheduled readings count as the
    // plan; an extra sitting's scheduledPagesEnd is just its pre-fill.
    const planned = todays.filter(c => !c.extra).map(c => c.scheduledPagesEnd || c.pagesEnd);
    const plannedEnd = planned.length > 0 ? Math.min(Math.max(...planned), book.totalPages) : 0;
    if (plannedEnd >= reading.pagesStart) {
      reading.pagesEnd = plannedEnd;
      reading.label = buildChunkLabel(reading.pagesStart, plannedEnd, book);
      reading.restOfToday = true;
      // For "8 of 10 pages read today" on the dashboard and sidebar.
      const plannedStart = Math.min(...todays.filter(c => !c.extra).map(c => c.pagesStart));
      reading.todayPlanned = plannedEnd - plannedStart + 1;
      reading.todayRead = todays.reduce((n, c) => n + (c.pagesEnd - c.pagesStart + 1), 0);
    }
    return reading;
  }

  // The book's next reading still to read: the earliest upcoming reading
  // dated today or later. Null for a book that isn't active or has no
  // schedule left (off-pace, or every page read). (v1.4.2)
  nextReadingFor(bookId) {
    const book = this.getBook(bookId);
    if (!book || book.status !== 'active') return null;
    const today = versoToday();
    return this.settings.chunks
      .filter(c => c.bookId === bookId && c.status === 'upcoming' && c.scheduledDate >= today)
      .sort((a, b) => a.scheduledDate < b.scheduledDate ? -1
        : a.scheduledDate > b.scheduledDate ? 1
        : a.pagesStart - b.pagesStart)[0] || null;
  }

  // Opens Pages read for a reading from extraReadingFor() or
  // moreReadingFor() and stores it on confirm. Shared by the dashboard
  // and the Today sidebar. onLogged refreshes the caller's view.
  openLogReading(book, reading, onLogged) {
    new VersoPagesReadModal(this.app, this, reading, book, async (actualEnd) => {
      const { bookJustCompleted } = await this.logExtraReading(reading, actualEnd);
      if (onLogged) onLogged();
      if (bookJustCompleted) {
        new VersoBookCompleteModal(this.app, this, book.id).open();
      }
      return { bookJustCompleted };
    }, { extra: true }).open();
  }

  // A completed reading of the same book that starts after this one ends.
  // Unchecking a reading while a later one is still checked would leave
  // the later reading's pages out of step with what's been read, so
  // versoConfirmUnmark asks for the later one first. (v1.4.1)
  laterCompletedReading(chunk) {
    return this.settings.chunks.find(c =>
      c.bookId === chunk.bookId && c.id !== chunk.id &&
      c.status === 'complete' && c.pagesStart > chunk.pagesEnd
    ) || null;
  }

  // Reverse an accidental completion: restores the chunk to 'upcoming',
  // removes its session, and un-completes the book if this was its final
  // chunk.
  async unmarkChunkComplete(chunkId) {
    const index = this.settings.chunks.findIndex(c => c.id === chunkId);
    if (index === -1) return null;
    const chunk = this.settings.chunks[index];
    if (chunk.status !== 'complete') return chunk;

    chunk.status = 'upcoming';
    chunk.dateCompleted = null;

    // Tombstone the completion so another device's older copy can't bring
    // it back in a sync merge (v1.3.3).
    if (!this.settings.deletedIds) this.settings.deletedIds = {};
    this.settings.deletedIds[chunkId] = new Date().toISOString();

    // Remove the session created when this chunk was completed
    this.settings.sessions = this.settings.sessions.filter(s => s.chunkId !== chunkId);

    // If the book had been marked complete, reopen it
    const book = this.getBook(chunk.bookId);
    if (book && book.status === 'complete') {
      await this.updateBook(chunk.bookId, { status: 'active', dateCompleted: null });
    }

    await this.saveSettings();

    // Recalculate so the schedule reflects this chunk being outstanding again
    await this.recalculateBook(chunk.bookId);

    this.refreshBookAndLibraryViews();
    return chunk;
  }

  // Mark a book complete if all its pages have been read.
  //
  // completionDate is optional. Omitted (the normal path, from
  // markChunkComplete) it's "now" — correct, because the reader just
  // finished the final chunk this moment. The Edit Book path passes an
  // explicit date instead: correcting a 340-page book down to 300 means it
  // was finished whenever the last chunk was actually logged, not the day
  // the typo was noticed. This matters because the celebration shelf and
  // the dashboard's "finished this year" count both filter by the YEAR of
  // dateCompleted — a book finished Dec 28th and corrected Jan 3rd would
  // otherwise jump to the wrong year.
  async checkBookCompletion(bookId, completionDate) {
    const book = this.getBook(bookId);
    if (!book || book.status === 'complete') return false;

    const chunks = this.getChunksForBook(bookId);
    const completeChunks = chunks.filter(c => c.status === 'complete');
    const pagesRead = completeChunks.reduce((sum, c) => sum + (c.pagesEnd - c.pagesStart + 1), 0);

    if (pagesRead >= book.totalPages) {
      await this.updateBook(bookId, {
        status: 'complete',
        dateCompleted: completionDate || new Date().toISOString()
      });
      // A book can complete while still carrying leftover 'missed' or
      // 'upcoming' chunks — e.g. a reader falls behind, then catches up in
      // one big session via Actual Pages Read, finishing the book before
      // recalculateSchedule ever gets a chance to resolve the backlog.
      // Once complete, recalculateAllBooks will never touch this book again
      // (it explicitly skips 'complete' books), so any non-complete chunks
      // left behind are permanently stranded — dead data with no further
      // purpose. Prune them here, at the moment of completion.
      this.settings.chunks = this.settings.chunks.filter(c =>
        c.bookId !== bookId || c.status === 'complete'
      );
      await this.saveSettings();
      return true;
    }
    return false;
  }

  // The date a book's reading actually ended: the latest dateCompleted
  // across its complete chunks. Returns null if nothing has been logged,
  // leaving the caller to fall back to "now".
  lastChunkCompletionDate(bookId) {
    const completed = this.getChunksForBook(bookId)
      .filter(c => c.status === 'complete' && c.dateCompleted);
    if (completed.length === 0) return null;
    return completed.reduce(
      (latest, c) => (c.dateCompleted > latest ? c.dateCompleted : latest),
      completed[0].dateCompleted
    );
  }

  // ── Progress helpers ────────────────────────────────────────

  getBookProgress(bookId) {
    const book = this.getBook(bookId);
    if (!book) return null;

    // Planned books have no schedule yet — return a minimal, honest
    // progress object rather than running pace math against null dates.
    if (book.status === 'planned') {
      return {
        bookId,
        totalPages: book.totalPages,
        pagesRead: 0,
        percentage: 0,
        chunksTotal: 0,
        chunksComplete: 0,
        missedDaysCount: 0,
        missedPages: 0,
        status: 'planned',
        paceNeeded: 0
      };
    }

    const chunks = this.getChunksForBook(bookId);
    const completedChunks = chunks.filter(c => c.status === 'complete');
    const pagesRead = completedChunks.reduce((sum, c) => sum + (c.pagesEnd - c.pagesStart + 1), 0);
    const percentage = book.totalPages > 0 ? Math.round((pagesRead / book.totalPages) * 100) : 0;
    const readingDays = this.getReadingDaysFor(book);

    // Archived books: real progress, but no pace, missed days, or catch-up
    // line (see getBookStatus). Checked before off-pace so an archived book
    // past its old finish date doesn't read "Target was ...". (v1.3.2)
    if (book.status === 'archived') {
      return {
        bookId,
        totalPages: book.totalPages,
        pagesRead,
        percentage,
        chunksTotal: chunks.length,
        chunksComplete: completedChunks.length,
        missedDaysCount: 0,
        missedPages: 0,
        status: 'archived',
        nextDueDate: null,
        paceNeeded: 0
      };
    }

    // Off-pace books (see isOffPace and the freeze branch in
    // recalculateSchedule) have no schedule to report on until a new target
    // date is set — real pagesRead/percentage are still honest and worth
    // showing (the reader's actual progress doesn't stop being true just
    // because the plan lapsed), but missedDaysCount/missedPages/paceNeeded
    // would be summing inert historical chunks left over from before the
    // freeze. Reporting them here would resurrect exactly the fabricated
    // "X missed days" figure this whole fix exists to retire.
    if (isOffPace(book, readingDays)) {
      return {
        bookId,
        totalPages: book.totalPages,
        pagesRead,
        percentage,
        chunksTotal: chunks.length,
        chunksComplete: completedChunks.length,
        missedDaysCount: 0,
        missedPages: 0,
        status: 'off-pace',
        nextDueDate: null,
        paceNeeded: 0
      };
    }

    const today = versoToday();
    const missedChunks = chunks.filter(c => isChunkMissed(c, today) && isChunkFromCurrentAttempt(c, book));
    // Only the pages of a missed reading not yet read count as missed. A
    // missed reading clears once the reader passes its last page (see
    // recalculateSchedule); until then it shrinks as they read into it,
    // rather than counting its whole range. (v1.4.1)
    const lastPageRead = completedChunks.length > 0
      ? Math.max(...completedChunks.map(c => c.pagesEnd))
      : 0;
    const missedPages = missedChunks.reduce((sum, c) =>
      sum + Math.max(0, c.pagesEnd - Math.max(c.pagesStart - 1, lastPageRead)), 0);

    // Earliest still-upcoming chunk's date, if any. Used by the dashboard to
    // distinguish "on track, with a chunk due today" from "on track, but
    // nothing is scheduled today" (e.g. the book started today but today
    // isn't one of its reading days) — both are honestly 'on-track' by
    // getBookStatus's definition, but only the dashboard CARD DISPLAY needs
    // to tell them apart; the underlying status value stays the same.
    const upcomingChunks = chunks.filter(c => c.status === 'upcoming');
    const nextDueDate = upcomingChunks.length > 0
      ? upcomingChunks.reduce((earliest, c) => c.scheduledDate < earliest ? c.scheduledDate : earliest, upcomingChunks[0].scheduledDate)
      : null;

    // Pages a day to catch up, from the schedule itself: the pages left
    // over the readings left. Counting reading days from today instead
    // counted today after today's reading was done, and ignored days off,
    // so it disagreed with "Next reading" (42 vs 44 pages). Rounded down,
    // as distributePages does: each reading gets that many and the last
    // one takes the leftover pages. Falls back to the day count if no
    // readings are left. (v1.4.2)
    const readingsLeft = upcomingChunks.filter(c => c.scheduledDate >= today).length;
    const paceNeeded = readingsLeft > 0
      ? Math.max(1, Math.floor((book.totalPages - pagesRead) / readingsLeft))
      : calculatePaceNeeded(book.totalPages, pagesRead, book.targetFinishDate, readingDays);

    return {
      bookId,
      totalPages: book.totalPages,
      pagesRead,
      percentage,
      chunksTotal: chunks.length,
      chunksComplete: completedChunks.length,
      missedDaysCount: missedChunks.length,
      missedPages,
      status: getBookStatus(book, this.settings.chunks, readingDays),
      nextDueDate,
      paceNeeded
    };
  }

  getCollectionProgress(collectionId) {
    const books = this.getBooksForCollection(collectionId);
    if (books.length === 0) return null;
    const totalPages = books.reduce((sum, b) => sum + b.totalPages, 0);
    const pagesRead = books.reduce((sum, b) => {
      const progress = this.getBookProgress(b.id);
      return sum + (progress ? progress.pagesRead : 0);
    }, 0);
    return {
      collectionId,
      totalBooks: books.length,
      booksComplete: books.filter(b => b.status === 'complete').length,
      totalPages,
      pagesRead,
      percentage: totalPages > 0 ? Math.round((pagesRead / totalPages) * 100) : 0
    };
  }

}

// ─── Dashboard View ──────────────────────────────────────────────────────────
//
// Main dashboard, opened as its own workspace tab via ribbon icon or command.
// Daily view: stat cards, today's reading (with completion checkboxes), and
// book progress (status badges + progress bars). Empty state shown when no
// books exist yet. Weekly and monthly views are future work.

const VIEW_TYPE_VERSO_DASHBOARD = 'verso-dashboard-view';

class VersoDashboardView extends ItemView {

  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_VERSO_DASHBOARD;
  }

  getDisplayText() {
    return 'Verso';
  }

  getIcon() {
    return 'book-open';
  }

  async onOpen() {
    this.render();
  }

  async onClose() {
    this.contentEl.empty();
  }

  render() {
    const container = this.contentEl;
    container.empty();
    container.addClass('verso-dashboard-view');

    const visibleBooks = this.plugin.settings.books.filter(b => b.status !== 'archived');
    if (visibleBooks.length === 0) {
      this.renderEmptyState(container);
    } else {
      this.renderPopulatedState(container);
    }
  }

  renderEmptyState(container) {
    this.renderHeaderRow(container);

    const wrap = container.createDiv({ cls: 'verso-dashboard-empty' });

    const iconCircle = wrap.createDiv({ cls: 'verso-empty-icon-circle' });
    iconCircle.createSpan({ text: '📖' });

    wrap.createEl('h2', {
      text: 'Ready to add your first book?',
      cls: 'verso-empty-title'
    });

    wrap.createEl('p', {
      text: 'Add a book and a finish date. Verso handles the pages-per-day math, and redoes it whenever reality disagrees with the plan.',
      cls: 'verso-empty-description'
    });

    const buttonRow = wrap.createDiv({ cls: 'verso-empty-buttons' });

    const addBookBtn = buttonRow.createEl('button', {
      text: 'Add your first book',
      cls: 'verso-btn verso-btn-primary'
    });
    addBookBtn.addEventListener('click', () => {
      new AddBookModal(this.app, this.plugin, () => this.render()).open();
    });

    const settingsBtn = buttonRow.createEl('button', {
      text: 'Explore settings',
      cls: 'verso-btn verso-btn-secondary'
    });
    settingsBtn.addEventListener('click', () => {
      this.app.setting.open();
      this.app.setting.openTabById(this.plugin.manifest.id);
    });
  }

  renderPopulatedState(container) {
    this.renderHeaderRow(container);

    this.statSection = container.createDiv();
    this.renderStatCards(this.statSection);

    this.bookCardsSection = container.createDiv();
    this.renderDashboardBookCards(this.bookCardsSection);
  }

  // Title + action group (Add book, Library link), shared by populated and
  // empty states. The Add book button is always rendered here — distinct
  // from the empty state's "Add your first book" callout, which is a
  // one-time onboarding moment that stays even after this button exists.
  renderHeaderRow(container) {
    const header = container.createDiv({ cls: 'verso-dashboard-header-row' });
    header.createEl('h2', { text: 'Dashboard', cls: 'verso-dashboard-title' });

    const actions = header.createDiv({ cls: 'verso-dashboard-header-actions' });

    const addBookLink = actions.createEl('a', { text: '+ Add book', cls: 'verso-book-back-link' });
    addBookLink.addEventListener('click', (e) => {
      e.preventDefault();
      new AddBookModal(this.app, this.plugin, () => this.render()).open();
    });

    const daysOffLink = actions.createEl('a', { text: 'Days off', cls: 'verso-book-back-link' });
    daysOffLink.addEventListener('click', (e) => {
      e.preventDefault();
      new VersoDaysOffListModal(this.app, this.plugin, () => this.render()).open();
    });

    const libraryLink = actions.createEl('a', { text: 'Library →', cls: 'verso-book-back-link' });
    libraryLink.addEventListener('click', (e) => {
      e.preventDefault();
      this.plugin.activateLibraryView();
    });

    // Upcoming days off stay in view so they aren't forgotten. (v1.4.0)
    const upcoming = this.plugin.upcomingDaysOff(null);
    if (upcoming.length) {
      const line = container.createDiv({ cls: 'verso-dashboard-days-off' });
      line.setText('Days off: ' + upcoming.map(({ range, book }) =>
        versoDescribeDaysOff(range) + (book ? ` (${book.title})` : '')).join('; '));
      line.addEventListener('click', () =>
        new VersoDaysOffListModal(this.app, this.plugin, () => this.render()).open());
    }
  }

  // Status priority for dashboard ordering: most-needs-attention first.
  // off-pace sits above at-risk/behind — it's the one state that actively
  // blocks reading until the reader sets a new date, so it's not just
  // "more urgent," it's the one thing standing in the way of anything else
  // happening with that book. at-risk/behind float next regardless of due
  // date — a quietly at-risk book is more urgent information than a calmer
  // one due sooner. on-track sits above not-started: real progress
  // outranks "hasn't begun."
  static STATUS_PRIORITY = { 'off-pace': 0, 'at-risk': 1, 'behind': 2, 'on-track': 3, 'not-started': 4 };

  renderDashboardBookCards(container) {
    container.empty();

    const books = this.plugin.settings.books.filter(b => b.status === 'active');

    container.createEl('h3', { text: 'Reading', cls: 'verso-section-heading' });

    if (books.length === 0) {
      container.createEl('p', {
        text: 'No active books yet.',
        cls: 'verso-step-placeholder'
      });
      return;
    }

    const todaysChunks = this.plugin.getAllTodaysChunks();

    const list = container.createDiv({ cls: 'verso-progress-list' });

    // Pair each book with its progress once, sort that combined list, then
    // render in order — avoids computing progress twice per book and keeps
    // the sort comparator simple (status tier, then a date tiebreaker that
    // depends on which tier: due date for on-track, start date for
    // not-started — at-risk/behind have no natural date tiebreaker, so they
    // keep their relative order from the underlying books array).
    const booksWithProgress = books
      .map(book => ({ book, progress: this.plugin.getBookProgress(book.id) }))
      .filter(entry => entry.progress);

    booksWithProgress.sort((a, b) => {
      const priorityDiff =
        VersoDashboardView.STATUS_PRIORITY[a.progress.status] -
        VersoDashboardView.STATUS_PRIORITY[b.progress.status];
      if (priorityDiff !== 0) return priorityDiff;

      if (a.progress.status === 'on-track') {
        const aDue = a.book.targetFinishDate || '9999-12-31';
        const bDue = b.book.targetFinishDate || '9999-12-31';
        if (aDue !== bDue) return aDue < bDue ? -1 : 1;
      } else if (a.progress.status === 'not-started') {
        const aStart = a.book.startDate || '9999-12-31';
        const bStart = b.book.startDate || '9999-12-31';
        if (aStart !== bStart) return aStart < bStart ? -1 : 1;
      }
      return 0;
    });

    booksWithProgress.forEach(({ book, progress }) => {
      const card = list.createDiv({ cls: 'verso-progress-card verso-progress-card-clickable' });
      card.addEventListener('click', () => {
        this.plugin.activateBookView(book.id);
      });

      // Chunks scheduled for today (sorted: incomplete first), each rendered
      // as a checkbox row that doubles as the card's header when present.
      const chunksForBook = todaysChunks
        .filter(c => c.bookId === book.id)
        .sort((a, b) => {
          if (a.status === 'complete' && b.status !== 'complete') return 1;
          if (a.status !== 'complete' && b.status === 'complete') return -1;
          return 0;
        });

      // Today's checked-off sittings share one row (v1.4.1); its checkbox
      // acts on the latest sitting (todayRow.chunk).
      versoTodayRows(chunksForBook, () => book).forEach(todayRow => {
        const chunk = todayRow.chunk;
        const row = card.createDiv({ cls: 'verso-dashboard-card-chunk-row' });
        if (chunk.status === 'complete') row.addClass('verso-today-row-complete');

        const checkbox = row.createDiv({ cls: 'verso-today-checkbox' });
        if (chunk.status === 'complete') {
          checkbox.addClass('verso-today-checkbox-checked');
          checkbox.setText('✓');
        }

        const info = row.createDiv({ cls: 'verso-today-info' });
        info.createSpan({ text: `${book.title} — ${todayRow.label}`, cls: 'verso-today-label' });

        const pages = todayRow.pages;
        const meta = row.createDiv({ cls: 'verso-today-meta' });
        let metaText = `${pages} page${pages === 1 ? '' : 's'}`;
        if (todayRow.sittings > 1) metaText += ` · ${todayRow.sittings} sittings`;
        meta.createSpan({ text: metaText, cls: 'verso-today-pages' });

        versoMakeCheckboxAccessible(checkbox, chunk.status === 'complete', `${book.title}, ${todayRow.label}`);

        // Only the checkbox itself toggles completion — the rest of the row
        // (title, pages) falls through to the card's "open book" click.
        // stopPropagation here keeps the toggle from also opening the book.
        checkbox.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (chunk.status !== 'complete') {
            const book = this.plugin.getBook(chunk.bookId);
            new VersoPagesReadModal(this.app, this.plugin, chunk, book, async (actualEnd) => {
              const { bookJustCompleted } = await this.plugin.markChunkComplete(chunk.id, actualEnd);
              this.refreshAfterChunkUpdate();
              if (bookJustCompleted) {
                new VersoBookCompleteModal(this.app, this.plugin, book.id).open();
              }
              return { bookJustCompleted };
            }).open();
          } else {
            versoConfirmUnmark(this.app, this.plugin, chunk, () => this.refreshAfterChunkUpdate(), todayRow);
          }
        });
      });

      // Progress header: title (only if no chunk row already covered it),
      // author byline, collection/due-date meta, and status badge.
      const header = card.createDiv({ cls: 'verso-progress-header' });

      const info = header.createDiv({ cls: 'verso-progress-info' });
      if (chunksForBook.length === 0) {
        info.createDiv({ text: book.title, cls: 'verso-progress-title' });
      }

      if (book.author) {
        info.createDiv({ text: book.author, cls: 'verso-progress-author' });
      }

      const collection = this.plugin.getCollection(book.collectionId);

      if (collection || book.targetFinishDate) {
        const metaLine = info.createDiv({ cls: 'verso-progress-meta' });

        if (collection) {
          metaLine.createSpan({ text: collection.name });
        }

        if (book.targetFinishDate) {
          if (collection) metaLine.createSpan({ text: ' · ' });
          metaLine.createSpan({ text: `aiming for ${this.formatDate(book.targetFinishDate)}` });
        }
      }

      const today = versoToday();
      const onTrackNothingDueToday =
        progress.status === 'on-track' && progress.nextDueDate && progress.nextDueDate !== today;

      // No reading today: say why, so a missing checkbox isn't a mystery.
      // (v1.4.0)
      if (chunksForBook.length === 0 && progress.status !== 'not-started' && progress.status !== 'off-pace') {
        let note = versoNoReadingTodayReason(this.plugin.getReadingDaysFor(book), new Date());
        if (progress.nextDueDate && !onTrackNothingDueToday) {
          note += ` · next reading ${this.formatDate(progress.nextDueDate)}`;
        }
        const noteEl = info.createDiv({ text: note, cls: 'verso-progress-no-reading' });

        // Read anyway: log pages on a day with nothing scheduled. (v1.4.0)
        const reading = this.plugin.extraReadingFor(book.id);
        if (reading) {
          noteEl.appendText(' · ');
          const logLink = noteEl.createEl('a', { text: 'Log reading', cls: 'verso-log-reading-link' });
          versoMakeLinkAccessible(logLink);
          logLink.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.plugin.openLogReading(book, reading, () => this.refreshAfterChunkUpdate());
          });
        }
      }

      // Read again later: today's reading is checked off, so offer to log
      // another sitting. (v1.4.1)
      const more = this.plugin.moreReadingFor(book.id);
      if (more) {
        const moreEl = info.createDiv({ text: `${versoTodayReadText(more)} · `, cls: 'verso-progress-no-reading' });
        const moreLink = moreEl.createEl('a', { text: 'Log more pages', cls: 'verso-log-reading-link' });
        versoMakeLinkAccessible(moreLink);
        moreLink.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.plugin.openLogReading(book, more, () => this.refreshAfterChunkUpdate());
        });

        // Once today's reading is done, say what's next, so the reader
        // knows how many pages to read. (v1.4.2)
        const next = this.plugin.nextReadingFor(book.id);
        if (next) {
          info.createDiv({ text: versoNextReadingText(next, book), cls: 'verso-progress-no-reading' });
        }
      }

      const badge = header.createDiv({ cls: `verso-badge ${this.badgeClassForStatus(progress.status)}` });
      badge.setText(
        progress.status === 'not-started'
          ? `Starts ${this.formatDate(book.startDate)}`
          : onTrackNothingDueToday
            ? `Next: ${this.formatDate(progress.nextDueDate)}`
            : this.badgeLabelForStatus(progress.status)
      );

      // Not-started books have nothing to show progress on yet — the badge
      // already says "Starts {date}", and a 0%-wide bar would just be noise
      // dressed up as data. Skip the bar row entirely for this status.
      // On-track-with-nothing-due-today is different: real progress may
      // already exist (e.g. a book read on Mon/Wed sitting on a non-reading
      // Friday), so its bar stays — only the badge label changes.
      if (progress.status !== 'not-started') {
        const barRow = card.createDiv({ cls: 'verso-progress-bar-row' });
        const barTrack = barRow.createDiv({ cls: 'verso-progress-bar-track' });
        const barFill = barTrack.createDiv({ cls: `verso-progress-bar-fill ${this.barClassForStatus(progress.status)}` });
        barFill.style.width = `${Math.min(progress.percentage, 100)}%`;

        barRow.createDiv({ text: `${progress.percentage}%`, cls: 'verso-progress-percent' });
      }

      if (progress.status === 'behind' || progress.status === 'at-risk') {
        const catchUp = card.createDiv({ cls: 'verso-progress-catchup' });
        const dayWord = progress.missedDaysCount === 1 ? 'day' : 'days';
        const pageWord = progress.missedPages === 1 ? 'page' : 'pages';
        const pacePageWord = progress.paceNeeded === 1 ? 'page' : 'pages';
        catchUp.setText(
          `${progress.missedDaysCount} missed ${dayWord} (${progress.missedPages} ${pageWord}) · ` +
          `${progress.paceNeeded} ${pacePageWord}/day to catch up`
        );
      } else if (progress.status === 'off-pace') {
        const offPaceLine = card.createDiv({ cls: 'verso-progress-catchup' });
        offPaceLine.setText(
          `Target was ${this.formatDate(book.targetFinishDate)} · no schedule until a new date is set`
        );
      }
    });
  }

  formatDate(dateString) {
    return versoFormatDate(dateString);
  }

  badgeLabelForStatus(status) {
    return versoBadgeLabelForStatus(status);
  }

  badgeClassForStatus(status) {
    return versoBadgeClassForStatus(status);
  }

  barClassForStatus(status) {
    return versoBarClassForStatus(status);
  }

  renderStatCards(container) {
    container.empty();
    const stats = this.computeStats();
    const grid = container.createDiv({ cls: 'verso-stat-grid' });

    this.renderStatCard(grid, 'Books active', String(stats.booksActive));

    this.renderStatCard(
      grid,
      'Pages today',
      String(stats.pagesToday),
      stats.booksToday > 0
        ? `across ${stats.booksToday} book${stats.booksToday === 1 ? '' : 's'}`
        : null
    );

    this.renderStatCard(
      grid,
      'On track',
      stats.booksActive > 0 ? `${stats.onTrackCount} / ${stats.booksActive}` : '—'
    );

    this.renderStatCard(
      grid,
      'Books finished',
      String(stats.booksFinishedThisYear),
      'this year'
    );
  }

  renderStatCard(container, label, value, subtext) {
    const card = container.createDiv({ cls: 'verso-stat-card' });
    card.createDiv({ text: label, cls: 'verso-stat-label' });
    card.createDiv({ text: value, cls: 'verso-stat-value' });
    if (subtext) {
      card.createDiv({ text: subtext, cls: 'verso-stat-subtext' });
    }
  }

  // Re-render the stat cards and book cards after a chunk's completion
  // status changes, without rebuilding the whole view. Also nudges the
  // Today sidebar (if open) so both checklists stay in sync regardless of
  // which one a chunk gets checked off in.
  refreshAfterChunkUpdate() {
    if (this.statSection) this.renderStatCards(this.statSection);
    if (this.bookCardsSection) this.renderDashboardBookCards(this.bookCardsSection);
    this.plugin.refreshOpenSidebar();
  }

  // Compute all values needed for the stat cards in one pass.
  computeStats() {
    const books = this.plugin.settings.books;
    const activeBooks = books.filter(b => b.status === 'active');

    // Pages today — pages still REMAINING to read today: today's actionable
    // (upcoming) chunks belonging to active books only. Completed chunks drop
    // out (so the count ticks down as readings are checked off via
    // refreshAfterChunkUpdate), and non-active books (complete/planned/
    // archived) never contribute — which keeps this in lockstep with the
    // book cards below. Uses getTodaysChunks() rather than re-deriving the
    // same filter inline — this used to duplicate it with a looser
    // "!== 'complete'" check, which silently went stale once off-pace
    // freezing meant a 'missed' chunk could also land on today's date.
    const activeIds = new Set(activeBooks.map(b => b.id));
    const todaysChunks = this.plugin.getTodaysChunks();
    const pagesToday = todaysChunks.reduce((sum, c) => sum + (c.pagesEnd - c.pagesStart + 1), 0);
    const booksToday = new Set(todaysChunks.map(c => c.bookId)).size;

    // On track — active books with zero missed chunks (status === 'on-track').
    // Books with a future startDate return 'not-started' from getBookStatus
    // before this check is even reached, so they're correctly excluded here
    // without any extra filtering.
    const onTrackCount = activeBooks.filter(b => {
      const status = getBookStatus(b, this.plugin.settings.chunks, this.plugin.getReadingDaysFor(b));
      return status === 'on-track';
    }).length;

    // Books finished this year
    const currentYear = new Date().getFullYear();
    const booksFinishedThisYear = books.filter(b => {
      if (!versoIsFinishedBook(b) || !b.dateCompleted) return false;
      return new Date(b.dateCompleted).getFullYear() === currentYear;
    }).length;

    return {
      booksActive: activeBooks.length,
      pagesToday,
      booksToday,
      onTrackCount,
      booksFinishedThisYear
    };
  }
}


// ─── Today Sidebar View ─────────────────────────────────────────────────────
//
// A compact, docked checklist of today's reading — opened manually (command
// palette only, never auto-docked) so it doesn't compete with whatever else
// the reader already has pinned to their sidebar. Flat list, today's chunks
// only (no overdue/missed section — that's the dashboard's job), full
// check/uncheck parity with the dashboard's own checkboxes. Reuses
// markChunkComplete/unmarkChunkComplete/VersoPagesReadModal exactly as the
// dashboard does — no parallel completion logic.

const VIEW_TYPE_VERSO_TODAY = 'verso-today-view';

class VersoTodaySidebarView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_VERSO_TODAY;
  }

  getDisplayText() {
    return 'Today';
  }

  getIcon() {
    return 'check-circle';
  }

  async onOpen() {
    this.render();
  }

  async onClose() {
    this.contentEl.empty();
  }

  render() {
    const container = this.contentEl;
    container.empty();
    container.addClass('verso-today-sidebar-view');

    container.createEl('h3', { text: 'Reading today', cls: 'verso-section-heading' });
    this.renderChunkSection(container, this.plugin.getAllTodaysChunks(), 'Nothing scheduled for today.', true);

    container.createEl('h3', { text: 'Tomorrow', cls: 'verso-section-heading' });
    this.renderChunkSection(container, this.plugin.getTomorrowsChunks(), 'Nothing scheduled for tomorrow.', false);
  }

  // Shared row renderer for both the Today and Tomorrow sections.
  // Today is interactive (checkbox toggles completion via the existing
  // markChunkComplete/VersoPagesReadModal path). Tomorrow is a read-only
  // preview — read-ahead is already fully captured by logging a higher
  // actual-end page on TODAY's chunk, so a second, separate checkbox on
  // tomorrow's row would just be a redundant way to record the same fact,
  // and one that desyncs from the dashboard card's title (which only ever
  // describes today's chunk). A still-complete tomorrow row can appear here
  // as a leftover from before this change; it displays correctly, it's just
  // no longer how new completions happen.
  renderChunkSection(container, chunks, emptyText, interactive) {
    if (chunks.length === 0) {
      const empty = container.createDiv({ cls: 'verso-today-sidebar-empty' });
      empty.createSpan({ text: emptyText });
      return;
    }

    // Incomplete first, completed (dimmed) trailing — same ordering the
    // dashboard card uses for its own today-chunk rows.
    const sorted = [...chunks].sort((a, b) => {
      if (a.status === 'complete' && b.status !== 'complete') return 1;
      if (a.status !== 'complete' && b.status === 'complete') return -1;
      return 0;
    });

    const list = container.createDiv({ cls: 'verso-today-sidebar-list' });

    // Each book's checked-off sittings share one row; its checkbox acts on
    // the latest sitting (todayRow.chunk). (v1.4.1)
    versoTodayRows(sorted, id => this.plugin.getBook(id)).forEach(todayRow => {
      const chunk = todayRow.chunk;
      const book = this.plugin.getBook(chunk.bookId);
      if (!book) return;

      const row = list.createDiv({ cls: 'verso-today-sidebar-row' });
      if (chunk.status === 'complete') row.addClass('verso-today-sidebar-row-complete');
      if (!interactive) row.addClass('verso-today-sidebar-row-preview');

      const checkbox = row.createDiv({ cls: 'verso-today-checkbox' });
      if (chunk.status === 'complete') {
        checkbox.addClass('verso-today-checkbox-checked');
        checkbox.setText('✓');
      }

      const info = row.createDiv({ cls: 'verso-today-sidebar-info' });
      info.createDiv({ text: book.title, cls: 'verso-today-sidebar-title' });
      const labelText = todayRow.sittings > 1 ? `${todayRow.label} · ${todayRow.sittings} sittings` : todayRow.label;
      info.createDiv({ text: labelText, cls: 'verso-today-sidebar-label' });

      if (!interactive) return;

      // "Log more pages" goes under the book's checked-off row once all of
      // its readings today are done. (v1.4.1)
      const more = chunk.status === 'complete' ? this.plugin.moreReadingFor(book.id) : null;
      if (more) {
        const moreEl = info.createDiv({ cls: 'verso-today-sidebar-label' });
        if (more.restOfToday) moreEl.appendText(`${versoTodayReadText(more)} · `);
        const moreLink = moreEl.createEl('a', { text: 'Log more pages', cls: 'verso-log-reading-link' });
        versoMakeLinkAccessible(moreLink);
        moreLink.addEventListener('click', (e) => {
          e.preventDefault();
          this.plugin.openLogReading(book, more, () => {
            this.render();
            this.plugin.refreshOpenDashboard();
          });
        });
      }

      versoMakeCheckboxAccessible(checkbox, chunk.status === 'complete', `${book.title}, ${todayRow.label}`);
      checkbox.addEventListener('click', async () => {
        if (chunk.status !== 'complete') {
          new VersoPagesReadModal(this.app, this.plugin, chunk, book, async (actualEnd) => {
            const { bookJustCompleted } = await this.plugin.markChunkComplete(chunk.id, actualEnd);
            this.render();
            this.plugin.refreshOpenDashboard();
            if (bookJustCompleted) {
              new VersoBookCompleteModal(this.app, this.plugin, book.id).open();
            }
            return { bookJustCompleted };
          }).open();
        } else {
          versoConfirmUnmark(this.app, this.plugin, chunk, () => {
            this.render();
            this.plugin.refreshOpenDashboard();
          }, todayRow);
        }
      });
    });
  }
}


// Rows for a list of today's readings: each book's checked-off readings
// collapse into one row ("pp. 189–218 · 3 sittings"), so a reader who
// reads in many sittings doesn't get a long list. Unread readings keep a
// row each. row.chunk is the reading the checkbox acts on; for a combined
// row it's the latest sitting, so unchecking removes sittings one at a
// time, newest first (see laterCompletedReading). Order is kept. (v1.4.1)
function versoTodayRows(chunks, bookFor) {
  const rows = [];
  const doneByBook = new Map();
  chunks.forEach(c => {
    if (c.status !== 'complete') {
      rows.push({ chunk: c, chunks: [c] });
      return;
    }
    let row = doneByBook.get(c.bookId);
    if (!row) {
      row = { chunk: c, chunks: [] };
      doneByBook.set(c.bookId, row);
      rows.push(row);
    }
    row.chunks.push(c);
    if (c.pagesStart > row.chunk.pagesStart) row.chunk = c;
  });
  rows.forEach(row => {
    row.sittings = row.chunks.length;
    row.pagesStart = Math.min(...row.chunks.map(c => c.pagesStart));
    row.pagesEnd = Math.max(...row.chunks.map(c => c.pagesEnd));
    row.pages = row.chunks.reduce((n, c) => n + (c.pagesEnd - c.pagesStart + 1), 0);
    row.label = row.sittings > 1
      ? buildChunkLabel(row.pagesStart, row.pagesEnd, bookFor(row.chunk.bookId))
      : row.chunk.label;
  });
  return rows;
}

// The note before "Log more pages": "8 of 10 pages read today" when the
// reader fell short of today's reading, "12 pages logged today" on a day
// with nothing scheduled, otherwise "Today's reading done". (v1.4.1)
function versoTodayReadText(reading) {
  if (reading.nothingScheduled) {
    const r = reading.todayRead;
    return `${r} page${r === 1 ? '' : 's'} logged today`;
  }
  if (!reading.restOfToday) return "Today's reading done";
  const n = reading.todayPlanned;
  return `${reading.todayRead} of ${n} page${n === 1 ? '' : 's'} read today`;
}

// What a reading asks for: "pp. 25-36 (12 pages)", or "to 23%" for a book
// tracked by percent, where a page count means little. (v1.4.2)
function versoReadingAmountText(chunk, book) {
  if (book && book.progressInputMode === 'percent') return `to ${chunk.label}`;
  const n = chunk.pagesEnd - chunk.pagesStart + 1;
  return `${chunk.label} (${n} page${n === 1 ? '' : 's'})`;
}

// When a reading is due, in words: "today", "tomorrow", a weekday within
// the coming week ("Tue"), otherwise a date ("Nov 3"). long adds the date
// to the weekday ("Tue, Oct 27"), for the book view. (v1.4.2)
function versoReadingDayText(dateString, long = false, now = new Date()) {
  const today = versoLocalDateString(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (dateString === today) return 'today';
  if (dateString === versoLocalDateString(tomorrow)) return 'tomorrow';
  const date = versoParseLocalDate(dateString);
  if (long) return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const weekAhead = new Date(now);
  weekAhead.setDate(weekAhead.getDate() + 6);
  if (dateString <= versoLocalDateString(weekAhead)) {
    return date.toLocaleDateString(undefined, { weekday: 'short' });
  }
  return versoFormatDate(dateString);
}

// "Next reading: pp. 25-36 (12 pages), tomorrow". (v1.4.2)
function versoNextReadingText(chunk, book, long = false) {
  return `Next reading: ${versoReadingAmountText(chunk, book)}, ${versoReadingDayText(chunk.scheduledDate, long)}`;
}

// The round reading checkboxes are divs, so they need a role, a label, a
// tab stop, and Enter/Space handling to work from the keyboard. (v1.3.2)
function versoMakeCheckboxAccessible(el, checked, label) {
  el.setAttribute('role', 'checkbox');
  el.setAttribute('aria-checked', checked ? 'true' : 'false');
  el.setAttribute('aria-label', label);
  el.tabIndex = 0;
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.click();
    }
  });
}

// "Log reading" and "Log more pages" are <a> elements with no href, which
// Tab skips. Give them a button role, a tab stop, and Enter/Space handling,
// the same as the reading checkboxes. (v1.4.1)
function versoMakeLinkAccessible(el) {
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      el.click();
    }
  });
}

// Unchecking a reading removes its logged pages, and on a finished book
// reopens it, so it asks first. Shared by the dashboard and the sidebar.
// (v1.3.2)
//
// todayRow (optional, v1.4.1): the row from versoTodayRows. For a row that
// combines several sittings, the dialog says only the latest sitting is
// removed and the others stay checked off.
function versoConfirmUnmark(app, plugin, chunk, onDone, todayRow = null) {
  // A later reading of this book is still checked off: uncheck that one
  // first, so the pages stay in order. (v1.4.1)
  const later = plugin.laterCompletedReading(chunk);
  if (later) {
    versoToast(`Mark "${later.label}" as not done first. It comes after "${chunk.label}".`, 6000);
    return;
  }
  const book = plugin.getBook(chunk.bookId);
  const pages = chunk.pagesEnd - chunk.pagesStart + 1;
  const pagesText = `${pages} page${pages === 1 ? '' : 's'}`;
  const others = todayRow ? todayRow.chunks.filter(c => c.id !== chunk.id) : [];

  let title, body, button, toast;
  if (others.length > 0) {
    // Combined row: removing the latest of several sittings. (v1.4.1)
    const start = Math.min(...others.map(c => c.pagesStart));
    const end = Math.max(...others.map(c => c.pagesEnd));
    const otherWord = others.length === 1 ? 'sitting' : 'sittings';
    title = 'Remove your latest sitting?';
    body = `This removes only your latest sitting today, ${chunk.label} (${pagesText}). ` +
      `Those pages will no longer count as read and go back into your schedule. ` +
      `Your other ${others.length === 1 ? '' : others.length + ' '}${otherWord} today, ` +
      `${buildChunkLabel(start, end, book)}, stay checked off. ` +
      `To remove another, uncheck the row again.`;
    button = 'Remove sitting';
    toast = `Removed your sitting, ${chunk.label}.`;
  } else if (chunk.extra) {
    // A logged sitting on its own. (v1.4.1)
    title = 'Remove this sitting?';
    body = `Your sitting, ${chunk.label} (${pagesText}), will be removed. ` +
      `Those pages will no longer count as read and go back into your schedule.`;
    button = 'Remove sitting';
    toast = `Removed your sitting, ${chunk.label}.`;
  } else {
    title = 'Mark as not done?';
    body = `"${chunk.label}" will go back to unread, and its pages will no longer count as read.`;
    button = 'Mark as not done';
    toast = `"${chunk.label}" marked as not done.`;
  }
  if (book && book.status === 'complete') {
    body += ` "${book.title}" will no longer be marked finished.`;
  }
  new VersoConfirmModal(app, title, body, button, async () => {
    await plugin.unmarkChunkComplete(chunk.id);
    versoToast(toast);
    if (onDone) onDone();
  }).open();
}


// ─── Book View ───────────────────────────────────────────────────────────────
//
// Per-book detail view, opened by clicking a book from the dashboard. Currently
// minimal: header (title/author/cover), status + progress, schedule summary,
// missed/pace info, and an Archive action (with undo via Settings → Archived
// books). Reading schedule list, notes, and plugin integrations (daily note /
// calendar / index cards) are future work.

const VIEW_TYPE_VERSO_BOOK = 'verso-book-view';

class VersoBookView extends ItemView {

  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.bookId = null;
    this.fromView = null;
    this.fromTab = null;
  }

  getViewType() {
    return VIEW_TYPE_VERSO_BOOK;
  }

  getDisplayText() {
    const book = this.bookId ? this.plugin.getBook(this.bookId) : null;
    return book ? book.title : 'Book';
  }

  getIcon() {
    return 'book';
  }

  // Obsidian passes persisted view state here (including our bookId and,
  // optionally, where the user navigated from).
  async setState(state, result) {
    if (state && state.bookId) {
      this.bookId = state.bookId;
    }
    if (state && 'fromView' in state) {
      this.fromView = state.fromView;
    }
    if (state && 'fromTab' in state) {
      this.fromTab = state.fromTab;
    }
    this.render();
    return super.setState(state, result);
  }

  getState() {
    return { bookId: this.bookId, fromView: this.fromView, fromTab: this.fromTab };
  }

  async onClose() {
    this.contentEl.empty();
  }

  render() {
    const container = this.contentEl;
    container.empty();
    container.addClass('verso-book-view');

    const book = this.bookId ? this.plugin.getBook(this.bookId) : null;

    if (!book) {
      container.createEl('p', {
        text: 'This book could not be found. It may have been deleted.',
        cls: 'verso-step-placeholder'
      });
      this.renderBackLink(container);
      return;
    }

    const progress = this.plugin.getBookProgress(book.id);

    this.renderBackLink(container);
    this.renderHeader(container, book, progress);
    if (book.status === 'archived') {
      this.renderArchiveSummary(container, book);
    } else {
      this.renderScheduleSummary(container, book, progress);
    }
  }

  renderBackLink(container) {
    const back = container.createDiv({ cls: 'verso-book-back' });

    const dashLink = back.createEl('a', { text: '← Back to dashboard', cls: 'verso-book-back-link' });
    dashLink.addEventListener('click', (e) => {
      e.preventDefault();
      this.plugin.activateDashboardView();
    });

    if (this.fromView === 'library') {
      const libLink = back.createEl('a', { text: '← Back to library', cls: 'verso-book-back-link' });
      libLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.plugin.activateLibraryView(this.fromTab || undefined);
      });
    }
  }

  renderHeader(container, book, progress) {
    const header = container.createDiv({ cls: 'verso-book-header' });

    const cover = header.createDiv({ cls: 'verso-book-cover' });
    cover.style.backgroundColor = book.coverColor || '#B5D4F4';

    const info = header.createDiv({ cls: 'verso-book-info' });
    info.createEl('h2', { text: book.title, cls: 'verso-book-title' });

    const sub = [];
    if (book.author) sub.push(book.author);
    sub.push(`${book.totalPages} pages`);
    info.createEl('div', { text: sub.join(' · '), cls: 'verso-book-subtitle' });

    if (progress) {
      const statusRow = info.createDiv({ cls: 'verso-book-status-row' });
      const badge = statusRow.createDiv({ cls: `verso-badge ${versoBadgeClassForStatus(progress.status)}` });
      badge.setText(versoBadgeLabelForStatus(progress.status));

      const barTrack = info.createDiv({ cls: 'verso-progress-bar-track verso-book-bar' });
      const barFill = barTrack.createDiv({ cls: `verso-progress-bar-fill ${versoBarClassForStatus(progress.status)}` });
      barFill.style.width = `${Math.min(progress.percentage, 100)}%`;

      info.createDiv({
        text: `${progress.percentage}% · ${progress.pagesRead} of ${book.totalPages} pages`,
        cls: 'verso-book-progress-text'
      });

      if (progress.status === 'behind' || progress.status === 'at-risk') {
        const dayWord = progress.missedDaysCount === 1 ? 'day' : 'days';
        const pageWord = progress.missedPages === 1 ? 'page' : 'pages';
        const pacePageWord = progress.paceNeeded === 1 ? 'page' : 'pages';
        info.createDiv({
          cls: 'verso-progress-catchup',
          text: `${progress.missedDaysCount} missed ${dayWord} (${progress.missedPages} ${pageWord}) · ` +
            `${progress.paceNeeded} ${pacePageWord}/day to catch up`
        });
      } else if (progress.status === 'off-pace') {
        info.createDiv({
          cls: 'verso-progress-catchup',
          text: `Target was ${versoFormatDate(book.targetFinishDate)} · no schedule until a new date is set`
        });
      }
    }
  }

  renderScheduleSummary(container, book, progress) {
    container.createDiv({ cls: 'verso-section-label verso-section-label-spaced', text: 'SCHEDULE' });

    const table = container.createDiv({ cls: 'verso-summary-table' });

    const collection = this.plugin.getCollection(book.collectionId);
    const collectionTerm = versoCollectionTerm(this.plugin.settings);
    versoAddSummaryRow(table, versoCapitalize(versoCollectionTermSingular(this.plugin.settings)), collection ? collection.name : '—');
    versoAddSummaryRow(table, 'Start date', versoFormatDate(book.startDate));
    versoAddSummaryRow(table, 'Finish by', versoFormatDate(book.targetFinishDate));
    versoAddSummaryRow(table, 'Reading days', this.describeReadingDays(book));
    // The next reading and its size, so the schedule can be checked
    // without the dashboard. (v1.4.2)
    const next = this.plugin.nextReadingFor(book.id);
    if (next) {
      versoAddSummaryRow(table, 'Next reading',
        `${versoReadingAmountText(next, book)}, ${versoReadingDayText(next.scheduledDate, true)}`);
    }
    const daysOff = this.plugin.upcomingDaysOff(book.id);
    if (daysOff.length) {
      versoAddSummaryRow(table, 'Days off', daysOff.map(x => versoDescribeDaysOff(x.range)).join('; '));
    }

    this.renderActions(container, book);
  }

  renderArchiveSummary(container, book) {
    container.createDiv({ cls: 'verso-section-label verso-section-label-spaced', text: 'ARCHIVE' });

    const table = container.createDiv({ cls: 'verso-summary-table' });

    const collection = this.plugin.getCollection(book.collectionId);
    const collectionTerm = versoCollectionTerm(this.plugin.settings);
    versoAddSummaryRow(table, versoCapitalize(versoCollectionTermSingular(this.plugin.settings)), collection ? collection.name : '—');

    const archivedOn = book.archivedDate
      ? new Date(book.archivedDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
    versoAddSummaryRow(table, 'Archived', archivedOn);
    versoAddSummaryRow(table, 'Reason', book.archiveReason || 'No reason given');

    this.renderArchiveActions(container, book);
  }

  renderArchiveActions(container, book) {
    const actions = container.createDiv({ cls: 'verso-book-actions' });

    const editBtn = actions.createEl('button', {
      text: 'Edit reason',
      cls: 'verso-btn verso-btn-secondary'
    });
    editBtn.addEventListener('click', () => {
      new VersoArchiveModal(this.app, this.plugin, book, 'edit', () => {
        this.render();
      }).open();
    });

    const restoreBtn = actions.createEl('button', {
      text: 'Restore',
      cls: 'verso-btn verso-btn-secondary'
    });
    restoreBtn.addEventListener('click', () => {
      versoRestoreBook(this.app, this.plugin, book, () => this.render());
    });

    const deleteBtn = actions.createEl('button', {
      text: 'Delete permanently',
      cls: 'verso-btn verso-btn-danger'
    });
    deleteBtn.addEventListener('click', () => {
      new VersoConfirmModal(
        this.app,
        'Delete this book permanently?',
        `"${book.title}" and its reading history will be permanently deleted. This cannot be undone — if you might want it back, use Restore instead.`,
        'Delete permanently',
        async () => {
          await this.plugin.deleteBook(book.id);
          new Notice(`"${book.title}" deleted.`);
          await this.plugin.activateLibraryView('archived');
        },
        'danger'
      ).open();
    });
  }

  renderActions(container, book) {
    const actions = container.createDiv({ cls: 'verso-book-actions' });

    // Planned and active books can be edited. Completed books can't —
    // editing total pages on a finished book is meaningless. Archived books
    // have VersoArchiveModal in 'edit' mode for their reason instead.
    if (book.status === 'active' || book.status === 'planned') {
      const editBookBtn = actions.createEl('button', {
        text: 'Edit book',
        cls: 'verso-btn verso-btn-secondary'
      });
      editBookBtn.addEventListener('click', () => {
        new VersoEditBookModal(this.app, this.plugin, book, () => {
          this.render();
        }).open();
      });
    }

    if (book.status === 'active') {
      const daysOffBtn = actions.createEl('button', {
        text: 'Add days off',
        cls: 'verso-btn verso-btn-secondary'
      });
      daysOffBtn.addEventListener('click', () => {
        new VersoDaysOffModal(this.app, this.plugin, book.id, () => this.render()).open();
      });
    }

    const archiveBtn = actions.createEl('button', {
      text: 'Archive this book',
      cls: 'verso-btn verso-btn-secondary'
    });
    archiveBtn.addEventListener('click', () => {
      this.confirmArchive(book);
    });

    // A planned book opened from the Library can be started from here too.
    // (v1.3.2)
    if (book.status === 'planned') {
      const startBtn = actions.createEl('button', {
        text: 'Start reading',
        cls: 'verso-btn verso-btn-primary'
      });
      startBtn.addEventListener('click', () => {
        new VersoActivateModal(this.app, this.plugin, book, () => {
          this.render();
        }).open();
      });
    }
  }

  confirmArchive(book) {
    new VersoArchiveModal(this.app, this.plugin, book, 'archive', () => {
      this.render();
    }).open();
  }

  describeReadingDays(book) {
    const days = versoWeeklyDays(this.plugin.getReadingDaysFor(book));
    if (days === 'everyday') return 'Every day';
    if (days === 'weekdays') return 'Weekdays';
    if (typeof days === 'object') {
      const labels = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
      const order = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      const active = order.filter(k => days[k]).map(k => labels[k]);
      if (active.length === 7) return 'Every day';
      if (active.length === 0) return 'No days selected';
      return active.join(', ');
    }
    return 'Every day';
  }
}


// ─── Library View ────────────────────────────────────────────────────────────
//
// The book's permanent home — separate from the Dashboard's "what's due
// today" focus. Three tabs:
//   Planned   — books with no active schedule yet, waiting their turn
//   Completed — books the reader has read through to the end
//   Archived  — books the reader stepped away from (restorable, deletable)
//
// Shell only for now: tab structure + basic lists. Reorder, the Activate
// modal, and the Delete action land in later steps.

const VIEW_TYPE_VERSO_LIBRARY = 'verso-library-view';

const LIBRARY_TABS = [
  { key: 'planned', label: 'Planned' },
  { key: 'completed', label: 'Completed' },
  { key: 'archived', label: 'Archived' }
];

// Archive reasons. A single flat list for every book regardless of
// collection — "Other" reveals free text for anything not covered.
const ARCHIVE_REASON_CATEGORIES = [
  { key: 'lost-interest', label: 'Lost interest' },
  { key: 'didnt-click', label: "Didn't click with the writing" },
  { key: 'switched-edition', label: 'Switched to a different edition/translation' },
  { key: 'wrong-timing', label: 'Just not the right time' },
  { key: 'other', label: 'Other' }
];

class VersoLibraryView extends ItemView {

  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.activeTab = 'planned';
  }

  getViewType() {
    return VIEW_TYPE_VERSO_LIBRARY;
  }

  getDisplayText() {
    return 'Library';
  }

  getIcon() {
    return 'library';
  }

  async setState(state, result) {
    if (state && state.activeTab && LIBRARY_TABS.some(t => t.key === state.activeTab)) {
      this.activeTab = state.activeTab;
    }
    this.render();
    return super.setState(state, result);
  }

  getState() {
    return { activeTab: this.activeTab };
  }

  async onOpen() {
    this.render();
  }

  async onClose() {
    this.contentEl.empty();
  }

  render() {
    const container = this.contentEl;
    container.empty();
    container.addClass('verso-library-view');

    this.renderBackLink(container);
    this.renderHeaderRow(container);

    this.renderTabBar(container);

    this.tabBody = container.createDiv({ cls: 'verso-library-body' });
    this.renderActiveTab();
  }

  // Title + Add book action — reuses the dashboard's header row classes so
  // the two views share one visual language for this control.
  renderHeaderRow(container) {
    const header = container.createDiv({ cls: 'verso-dashboard-header-row' });
    header.createEl('h2', { text: 'Library', cls: 'verso-dashboard-title' });

    const actions = header.createDiv({ cls: 'verso-dashboard-header-actions' });

    const addBookLink = actions.createEl('a', { text: '+ Add book', cls: 'verso-book-back-link' });
    addBookLink.addEventListener('click', (e) => {
      e.preventDefault();
      new AddBookModal(this.app, this.plugin, () => this.render()).open();
    });
  }


  renderBackLink(container) {
    const back = container.createDiv({ cls: 'verso-book-back' });
    const link = back.createEl('a', { text: '← Back to dashboard', cls: 'verso-book-back-link' });
    link.addEventListener('click', (e) => {
      e.preventDefault();
      this.plugin.activateDashboardView();
    });
  }

  renderTabBar(container) {
    const tabBar = container.createDiv({ cls: 'verso-library-tabs' });

    LIBRARY_TABS.forEach(tab => {
      const tabEl = tabBar.createDiv({ cls: 'verso-library-tab' });
      if (tab.key === this.activeTab) tabEl.addClass('verso-library-tab-active');

      const count = this.countForTab(tab.key);
      tabEl.setText(count > 0 ? `${tab.label} (${count})` : tab.label);

      tabEl.addEventListener('click', () => {
        if (this.activeTab === tab.key) return;
        this.activeTab = tab.key;
        this.renderTabBarOnly(container);
        this.renderActiveTab();
      });
    });
  }

  // Re-render just the tab bar (to update active styling) without rebuilding
  // the whole view — called after switching tabs.
  renderTabBarOnly(container) {
    const existing = container.querySelector('.verso-library-tabs');
    if (existing) existing.remove();
    const tabBar = container.createDiv({ cls: 'verso-library-tabs' });
    container.insertBefore(tabBar, this.tabBody);

    LIBRARY_TABS.forEach(tab => {
      const tabEl = tabBar.createDiv({ cls: 'verso-library-tab' });
      if (tab.key === this.activeTab) tabEl.addClass('verso-library-tab-active');

      const count = this.countForTab(tab.key);
      tabEl.setText(count > 0 ? `${tab.label} (${count})` : tab.label);

      tabEl.addEventListener('click', () => {
        if (this.activeTab === tab.key) return;
        this.activeTab = tab.key;
        this.renderTabBarOnly(container);
        this.renderActiveTab();
      });
    });
  }

  countForTab(tabKey) {
    const books = this.plugin.settings.books;
    if (tabKey === 'planned') return books.filter(b => b.status === 'planned').length;
    if (tabKey === 'completed') return books.filter(b => b.status === 'complete').length;
    if (tabKey === 'archived') return books.filter(b => b.status === 'archived').length;
    return 0;
  }

  // Keep archived-row reasons short — full text is shown in Book View.
  truncateReason(reason, maxLength = 40) {
    if (reason.length <= maxLength) return reason;
    return reason.slice(0, maxLength - 1).trimEnd() + '…';
  }

  renderActiveTab() {
    this.tabBody.empty();
    switch (this.activeTab) {
      case 'planned':
        this.renderPlannedTab(this.tabBody);
        break;
      case 'completed':
        this.renderCompletedTab(this.tabBody);
        break;
      case 'archived':
        this.renderArchivedTab(this.tabBody);
        break;
    }
  }

  // ── Planned tab ────────────────────────────────────────────────

  renderPlannedTab(container) {
    const books = this.plugin.settings.books.filter(b => b.status === 'planned');

    if (books.length === 0) {
      container.createEl('p', {
        text: 'No planned books. Add a book and choose "Add to my reading list" to queue it up here.',
        cls: 'verso-step-placeholder'
      });
      return;
    }

    const list = container.createDiv({ cls: 'verso-library-list' });

    books.forEach(book => {
      // Opens the book view, like rows on the other tabs. (v1.3.2)
      const row = list.createDiv({ cls: 'verso-library-row verso-library-row-clickable' });
      row.addEventListener('click', () => {
        this.plugin.activateBookView(book.id, 'library', this.activeTab);
      });

      const cover = row.createDiv({ cls: 'verso-library-cover' });
      cover.style.backgroundColor = book.coverColor || '#B5D4F4';

      const info = row.createDiv({ cls: 'verso-library-info' });
      info.createDiv({ text: book.title, cls: 'verso-library-title' });

      const meta = [];
      const collection = this.plugin.getCollection(book.collectionId);
      if (collection) meta.push(collection.name);
      if (book.author) meta.push(book.author);
      meta.push(`${book.totalPages} pages`);
      if (book.targetFinishDate) meta.push(`aiming for ${versoFormatDate(book.targetFinishDate)}`);
      info.createDiv({ text: meta.join(' · '), cls: 'verso-library-meta' });

      const actions = row.createDiv({ cls: 'verso-library-actions' });

      // Secondary action first, primary last — same ordering as the
      // Archived row (Restore + Delete).
      const editBtn = actions.createEl('button', {
        text: 'Edit',
        cls: 'verso-btn verso-btn-secondary'
      });
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        new VersoEditBookModal(this.app, this.plugin, book, () => {
          this.render();
          this.plugin.refreshOpenDashboard();
        }).open();
      });

      const activateBtn = actions.createEl('button', {
        text: 'Start reading',
        cls: 'verso-btn verso-btn-primary'
      });
      activateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        new VersoActivateModal(this.app, this.plugin, book, () => {
          this.render();
          this.plugin.refreshOpenDashboard();
        }).open();
      });
    });
  }

  // ── Completed tab ──────────────────────────────────────────────

  renderCompletedTab(container) {
    const books = this.plugin.settings.books.filter(b => b.status === 'complete');

    if (books.length === 0) {
      container.createEl('p', {
        text: 'No completed books yet.',
        cls: 'verso-step-placeholder'
      });
      return;
    }

    // Most recently completed first
    const sorted = [...books].sort((a, b) => {
      const aDate = a.dateCompleted || '';
      const bDate = b.dateCompleted || '';
      return bDate.localeCompare(aDate);
    });

    const list = container.createDiv({ cls: 'verso-library-list' });

    sorted.forEach(book => {
      const row = list.createDiv({ cls: 'verso-library-row verso-library-row-clickable' });
      row.addEventListener('click', () => {
        this.plugin.activateBookView(book.id, 'library', this.activeTab);
      });

      const cover = row.createDiv({ cls: 'verso-library-cover' });
      cover.style.backgroundColor = book.coverColor || '#B5D4F4';

      const info = row.createDiv({ cls: 'verso-library-info' });
      info.createDiv({ text: book.title, cls: 'verso-library-title' });

      if (book.author) {
        info.createDiv({ text: book.author, cls: 'verso-library-author' });
      }

      const meta = [];
      const collection = this.plugin.getCollection(book.collectionId);
      if (collection) meta.push(collection.name);
      meta.push(`${book.totalPages} pages`);
      if (book.dateCompleted) {
        const completedOn = new Date(book.dateCompleted).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        meta.push(`finished ${completedOn}`);
      }
      info.createDiv({ text: meta.join(' · '), cls: 'verso-library-meta' });
    });
  }

  // ── Archived tab ─────────────────────────────────────────────────

  renderArchivedTab(container) {
    const books = this.plugin.getArchivedBooks();

    if (books.length === 0) {
      container.createEl('p', {
        text: 'No archived books.',
        cls: 'verso-step-placeholder'
      });
      return;
    }

    const list = container.createDiv({ cls: 'verso-library-list' });

    books.forEach(book => {
      const row = list.createDiv({ cls: 'verso-library-row verso-library-row-clickable' });
      row.addEventListener('click', () => {
        this.plugin.activateBookView(book.id, 'library', this.activeTab);
      });

      const cover = row.createDiv({ cls: 'verso-library-cover' });
      cover.style.backgroundColor = book.coverColor || '#B5D4F4';

      const info = row.createDiv({ cls: 'verso-library-info' });
      info.createDiv({ text: book.title, cls: 'verso-library-title' });

      const meta = [];
      const collection = this.plugin.getCollection(book.collectionId);
      if (collection) meta.push(collection.name);
      if (book.archivedDate) {
        const archivedOn = new Date(book.archivedDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        meta.push(`archived ${archivedOn}`);
      }
      if (book.archiveReason) {
        meta.push(this.truncateReason(book.archiveReason));
      }
      info.createDiv({ text: meta.join(' · '), cls: 'verso-library-meta' });

      const actions = row.createDiv({ cls: 'verso-library-actions' });
      const restoreBtn = actions.createEl('button', {
        text: 'Restore',
        cls: 'verso-btn verso-btn-secondary'
      });
      restoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        versoRestoreBook(this.app, this.plugin, book, () => this.render());
      });

      const deleteBtn = actions.createEl('button', {
        text: 'Delete',
        cls: 'verso-btn verso-btn-danger'
      });
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        new VersoConfirmModal(
          this.app,
          'Delete this book permanently?',
          `"${book.title}" and its reading history will be permanently deleted. This cannot be undone — if you might want it back, use Restore instead.`,
          'Delete permanently',
          async () => {
            await this.plugin.deleteBook(book.id);
            new Notice(`"${book.title}" deleted.`);
            this.render();
          },
          'danger'
        ).open();
      });
    });
  }
}


// ─── Confirm Modal ───────────────────────────────────────────────────────────
//
// Generic yes/no confirmation modal used for destructive-ish actions like
// archiving.

class VersoConfirmModal extends Modal {
  constructor(app, title, body, confirmLabel, onConfirm, confirmVariant) {
    super(app);
    this.titleText = title;
    this.bodyText = body;
    this.confirmLabel = confirmLabel;
    this.onConfirm = onConfirm;
    this.confirmVariant = confirmVariant || 'primary';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('verso-confirm-modal');

    contentEl.createEl('h3', { text: this.titleText });
    contentEl.createEl('p', { text: this.bodyText, cls: 'verso-confirm-body' });

    const buttons = contentEl.createDiv({ cls: 'verso-confirm-buttons' });

    const cancelBtn = buttons.createEl('button', { text: 'Cancel', cls: 'verso-btn verso-btn-text' });
    cancelBtn.addEventListener('click', () => this.close());

    const confirmBtn = buttons.createEl('button', {
      text: this.confirmLabel,
      cls: `verso-btn verso-btn-${this.confirmVariant}`
    });
    confirmBtn.addEventListener('click', async () => {
      this.close();
      await this.onConfirm();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}


// Used both to archive a book (mode: 'archive') and to edit an already-set
// archive reason later from Book View (mode: 'edit'). Always a preset
// dropdown (see ARCHIVE_REASON_CATEGORIES), with "Other" revealing free
// text for anything not covered.
// Fully re-editable in 'edit' mode: switching between a preset and "Other"
// custom text is allowed in either direction.

class VersoArchiveModal extends Modal {
  constructor(app, plugin, book, mode, onDone) {
    super(app);
    this.plugin = plugin;
    this.book = book;
    this.mode = mode; // 'archive' | 'edit'
    this.onDone = onDone || null;

    this.categories = ARCHIVE_REASON_CATEGORIES;

    // Seed from existing values when editing.
    this.categoryKey = book.archiveReasonCategory || '';
    this.freeText = book.archiveReason || '';

    // Safety net for stale data predating this merged list (e.g. a book
    // archived under the old bookclub-only categories) — fall back to
    // "Other" with the stored text preserved rather than silently dropping it.
    if (this.categoryKey && !this.categories.some(c => c.key === this.categoryKey)) {
      this.categoryKey = 'other';
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('verso-confirm-modal');

    if (this.mode === 'archive') {
      contentEl.createEl('h3', { text: 'Archive this book?' });
      contentEl.createEl('p', {
        text: `"${this.book.title}" will be hidden from your dashboard. You can restore it anytime from the Library's Archived tab. Its schedule and progress are kept.`,
        cls: 'verso-confirm-body'
      });
    } else {
      contentEl.createEl('h3', { text: 'Edit archive reason' });
    }

    const form = contentEl.createDiv({ cls: 'verso-form' });
    this.renderReasonField(form);

    const buttons = contentEl.createDiv({ cls: 'verso-confirm-buttons' });

    const cancelBtn = buttons.createEl('button', { text: 'Cancel', cls: 'verso-btn verso-btn-text' });
    cancelBtn.addEventListener('click', () => this.close());

    const confirmLabel = this.mode === 'archive' ? 'Archive' : 'Save';
    const confirmBtn = buttons.createEl('button', { text: confirmLabel, cls: 'verso-btn verso-btn-primary' });
    confirmBtn.addEventListener('click', async () => {
      this.close();
      const reasonData = this.buildReasonData();
      if (this.mode === 'archive') {
        await this.plugin.archiveBook(this.book.id, reasonData);
        new Notice(`"${this.book.title}" archived.`);
        await this.plugin.activateDashboardView();
      } else {
        await this.plugin.updateArchiveReason(this.book.id, reasonData);
        new Notice('Archive reason updated.');
      }
      if (this.onDone) this.onDone();
    });
  }

  // Build the field(s) for capturing a reason. Always a preset dropdown
  // (see ARCHIVE_REASON_CATEGORIES) — "Other" reveals a free-text field
  // underneath for anything not covered by the list.
  renderReasonField(form) {
    const field = form.createDiv({ cls: 'verso-field' });
    field.createEl('label', { text: 'Reason (optional)', cls: 'verso-field-label' });

    const select = field.createEl('select', { cls: 'verso-input' });
    select.createEl('option', { text: 'Select a reason…', value: '' });
    this.categories.forEach(cat => {
      const opt = select.createEl('option', { text: cat.label, value: cat.key });
      if (cat.key === this.categoryKey) opt.selected = true;
    });
    if (!this.categoryKey) select.value = '';

    // "Other" reveals a free-text field underneath.
    const otherField = form.createDiv({ cls: 'verso-field' });
    otherField.style.display = this.categoryKey === 'other' ? '' : 'none';
    otherField.createEl('label', { text: 'Details', cls: 'verso-field-label' });
    const otherInput = otherField.createEl('input', {
      type: 'text',
      cls: 'verso-input',
      placeholder: 'Say a bit more…'
    });
    otherInput.value = this.categoryKey === 'other' ? this.freeText : '';

    select.addEventListener('change', (e) => {
      this.categoryKey = e.target.value || '';
      otherField.style.display = this.categoryKey === 'other' ? '' : 'none';
      if (this.categoryKey !== 'other') this.freeText = '';
    });
    otherInput.addEventListener('input', (e) => {
      this.freeText = e.target.value;
    });
  }

  // Resolve the current form state into { archiveReason, archiveReasonCategory }.
  buildReasonData() {
    if (!this.categoryKey) return { archiveReason: '', archiveReasonCategory: null };
    if (this.categoryKey === 'other') {
      return { archiveReason: this.freeText.trim(), archiveReasonCategory: 'other' };
    }
    const cat = this.categories.find(c => c.key === this.categoryKey);
    return { archiveReason: cat ? cat.label : '', archiveReasonCategory: this.categoryKey };
  }

  onClose() {
    this.contentEl.empty();
  }
}


// ─── Days Off Modal (v1.4.0) ─────────────────────────────────────────────────
//
// Adds a days-off range for one book or all books, and asks whether finish
// dates should move. Shows what each choice does to every affected book.

function versoDescribeDaysOff(range) {
  const dates = range.start === range.end
    ? versoFormatDate(range.start)
    : `${versoFormatDate(range.start)} – ${versoFormatDate(range.end)}`;
  return range.label ? `${dates} · ${range.label}` : dates;
}

// "Every day", "Weekdays", or "Mon, Wed, Fri" for a weekly pattern.
function versoDescribeWeeklyDays(weekly) {
  if (weekly === 'everyday') return 'every day';
  if (weekly === 'weekdays') return 'weekdays';
  if (weekly && typeof weekly === 'object') {
    const labels = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
    const active = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].filter(k => weekly[k]);
    if (active.length === 7) return 'every day';
    if (active.join() === 'mon,tue,wed,thu,fri') return 'weekdays';
    return active.map(k => labels[k]).join(', ');
  }
  return 'every day';
}

// All-book days off that fall inside a new schedule, and what they cost
// it. Used by Add book and Start reading, so days off set weeks ago (and
// forgotten) don't silently squeeze a new book into a few heavy days.
// Returns null when no days off take a reading day; otherwise
// { text, lost, total, left, laterFinish }, where laterFinish gives the
// lost reading days back after the finish date. (v1.4.0)
function versoDaysOffWarning(daysOff, weekly, startDate, finishDate) {
  if (!startDate || !finishDate) return null;
  const from = versoScheduleFrom(startDate);
  if (finishDate < from) return null;
  const ranges = (daysOff || []).filter(r => r && r.start && r.end && r.start <= finishDate && r.end >= from);
  if (ranges.length === 0) return null;
  const after = versoWithDaysOff(weekly, ranges);
  const total = countReadingDays(from, finishDate, weekly);
  const left = countReadingDays(from, finishDate, after);
  const lost = total - left;
  if (lost <= 0) return null;
  const laterFinish = versoFinishDateAfterDaysOff(
    { startDate: from, targetFinishDate: finishDate }, weekly, after);
  const days = n => `${n} reading day${n === 1 ? '' : 's'}`;
  const text = `Your days off (${ranges.map(versoDescribeDaysOff).join('; ')}) ` +
    `take ${days(lost)} from this book, leaving ${left === 0 ? 'none' : days(left)}.`;
  return { text, lost, total, left, laterFinish };
}

// Why a book has nothing to read on `date`: a day off, a day outside its
// reading days, or simply nothing left scheduled.
function versoNoReadingTodayReason(readingDays, date) {
  const dateString = versoLocalDateString(date);
  const off = (readingDays && readingDays.off || []).find(r => r.start <= dateString && dateString <= r.end);
  if (off) return off.label ? `Day off today (${off.label})` : 'Day off today';
  const weekly = versoWeeklyDays(readingDays);
  if (!isDayEnabled(date.getDay(), weekly)) {
    return `Not a reading day · reads ${versoDescribeWeeklyDays(weekly)}`;
  }
  return 'Nothing scheduled today';
}

// Lists the days off still to come, with remove buttons, and opens the add
// form. Reached from the dashboard. (v1.4.0)
class VersoDaysOffListModal extends Modal {
  constructor(app, plugin, onDone) {
    super(app);
    this.plugin = plugin;
    this.onDone = onDone || null;
  }

  onOpen() {
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Days off' });

    const upcoming = this.plugin.upcomingDaysOff(null);
    if (upcoming.length === 0) {
      contentEl.createEl('p', { text: 'No days off coming up.', cls: 'verso-confirm-body' });
    } else {
      const list = contentEl.createDiv({ cls: 'verso-days-off-list' });
      upcoming.forEach(({ range, book }) => {
        const row = list.createDiv({ cls: 'verso-days-off-row' });
        const info = row.createDiv({ cls: 'verso-up-next-info' });
        info.createDiv({ text: versoDescribeDaysOff(range), cls: 'verso-up-next-title' });
        info.createDiv({ text: book ? `Only "${book.title}"` : 'All books', cls: 'verso-up-next-meta' });
        const removeBtn = row.createEl('button', { text: 'Remove', cls: 'verso-btn verso-btn-text' });
        removeBtn.addEventListener('click', async () => {
          await this.plugin.removeDaysOff(range.id);
          this.render();
          if (this.onDone) this.onDone();
        });
      });
      contentEl.createEl('p', {
        text: 'Removing days off spreads the pages again but doesn\'t move finish dates back.',
        cls: 'verso-field-desc'
      });
    }

    const buttons = contentEl.createDiv({ cls: 'verso-confirm-buttons' });
    const closeBtn = buttons.createEl('button', { text: 'Close', cls: 'verso-btn verso-btn-text' });
    closeBtn.addEventListener('click', () => this.close());
    const addBtn = buttons.createEl('button', { text: 'Add days off', cls: 'verso-btn verso-btn-primary' });
    addBtn.addEventListener('click', () => {
      this.close();
      new VersoDaysOffModal(this.app, this.plugin, null, this.onDone).open();
    });
  }
}

class VersoDaysOffModal extends Modal {
  constructor(app, plugin, bookId, onDone) {
    super(app);
    this.plugin = plugin;
    this.onDone = onDone || null;
    this.bookId = bookId || null;      // null = all books
    this.start = versoToday();
    this.end = versoToday();
    this.label = '';
    this.moveFinishDates = null;       // must be chosen when a book loses days
  }

  onOpen() {
    this.modalEl.addClass('verso-days-off-modal');
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  isValid() {
    return !!this.start && !!this.end && this.start <= this.end;
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Add days off' });
    contentEl.createEl('p', {
      text: 'No reading is scheduled on these dates.',
      cls: 'verso-confirm-body'
    });

    const form = contentEl.createDiv({ cls: 'verso-form' });

    // ── Applies to ───────────────────────────────────────────────
    const scopeField = form.createDiv({ cls: 'verso-field' });
    scopeField.createEl('label', { text: 'Applies to', cls: 'verso-field-label' });
    const scope = scopeField.createEl('select', { cls: 'verso-input' });
    scope.createEl('option', { text: 'All books', value: '' });
    this.plugin.daysOffBooks(null).forEach(b => {
      const opt = scope.createEl('option', { text: b.title, value: b.id });
      if (b.id === this.bookId) opt.selected = true;
    });
    scope.addEventListener('change', (e) => {
      this.bookId = e.target.value || null;
      this.render();
    });

    // ── Dates ────────────────────────────────────────────────────
    const dateRow = form.createDiv({ cls: 'verso-days-off-dates' });
    const makeDate = (labelText, key) => {
      const field = dateRow.createDiv({ cls: 'verso-field' });
      field.createEl('label', { text: labelText, cls: 'verso-field-label' });
      const input = field.createEl('input', { type: 'date', cls: 'verso-input' });
      input.value = this[key];
      input.addEventListener('change', (e) => {
        this[key] = e.target.value;
        if (key === 'start' && this.end && this.end < this.start) this.end = this.start;
        this.render();
      });
    };
    makeDate('From', 'start');
    makeDate('To', 'end');
    if (this.start && this.end && this.end < this.start) {
      form.createDiv({ cls: 'verso-field-error', text: 'The end date is before the start date.' });
    }

    // ── Label ────────────────────────────────────────────────────
    const labelField = form.createDiv({ cls: 'verso-field' });
    labelField.createEl('label', { text: 'Label (optional)', cls: 'verso-field-label' });
    const labelInput = labelField.createEl('input', {
      type: 'text', cls: 'verso-input', attr: { placeholder: 'e.g. Travel' }
    });
    labelInput.value = this.label;
    labelInput.addEventListener('input', (e) => { this.label = e.target.value; });

    // ── Effect and finish-date choice ────────────────────────────
    const preview = this.isValid()
      ? this.plugin.previewDaysOff({ start: this.start, end: this.end }, this.bookId)
      : [];
    const affected = preview.filter(p => p.lost > 0);

    if (this.isValid()) {
      if (affected.length === 0) {
        form.createDiv({
          cls: 'verso-field-desc',
          text: this.bookId
            ? 'This book has no reading days on these dates, so its schedule won\'t change.'
            : 'None of your books have reading days on these dates. Books you start later will skip them.'
        });
      } else {
        // Books these dates leave with no reading days must move their
        // finish date; only the others get a choice. (v1.4.0)
        const choosable = affected.filter(p => !p.noneLeft);
        if (choosable.length > 0) {
          const choiceField = form.createDiv({ cls: 'verso-field' });
          choiceField.createEl('label', { text: 'Should finish dates change?', cls: 'verso-field-label' });
          const choice = (value, text) => {
            const row = choiceField.createEl('label', { cls: 'verso-toggle-label verso-days-off-choice' });
            const radio = row.createEl('input', { type: 'radio', attr: { name: 'verso-days-off-move' } });
            radio.checked = this.moveFinishDates === value;
            row.createSpan({ text });
            radio.addEventListener('change', () => { this.moveFinishDates = value; this.render(); });
          };
          choice(false, 'No, keep the finish dates. Read a little more on the other days.');
          choice(true, 'Yes, move the finish dates later by the days lost.');
        }

        const list = form.createDiv({ cls: 'verso-days-off-effects' });
        affected.forEach(p => {
          const days = `${p.lost} reading day${p.lost === 1 ? '' : 's'}`;
          const moves = `Finish moves from ${versoFormatDate(p.book.targetFinishDate)} to ${versoFormatDate(p.newFinish)}.`;
          let effect = `loses ${days}`;
          if (p.noneLeft) {
            effect += `, all it has left before its finish date. ${moves}`;
          } else if (this.moveFinishDates === true) {
            effect += `. ${moves}`;
          } else if (this.moveFinishDates === false) {
            effect += `. About ${p.paceBefore} → ${p.paceAfter} pages a day.`;
          } else {
            effect += '.';
          }
          const row = list.createDiv({ cls: 'verso-field-desc' });
          row.createEl('strong', { text: p.book.title });
          row.appendText(` ${effect}`);
        });
      }
    }

    // ── Buttons ──────────────────────────────────────────────────
    const buttons = contentEl.createDiv({ cls: 'verso-confirm-buttons' });
    const cancelBtn = buttons.createEl('button', { text: 'Cancel', cls: 'verso-btn verso-btn-text' });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = buttons.createEl('button', { text: 'Add days off', cls: 'verso-btn verso-btn-primary' });
    const needsChoice = affected.some(p => !p.noneLeft) && this.moveFinishDates === null;
    saveBtn.disabled = !this.isValid() || needsChoice;
    saveBtn.addEventListener('click', async () => {
      if (saveBtn.disabled) return;
      this.close();
      await this.plugin.addDaysOff(
        { start: this.start, end: this.end, label: this.label },
        this.bookId,
        this.moveFinishDates === true
      );
      new Notice('Days off added.');
      if (this.onDone) this.onDone();
    });
  }
}


// ─── Activate Modal ──────────────────────────────────────────────────────────
//
// Promotes a planned book to active: a small, focused modal asking only for
// start date and finish date. Pre-fills the finish date from the book's
// existing targetFinishDate if one was set at add-time (e.g. a syllabus due
// date), and defaults the start date to today.

class VersoActivateModal extends Modal {
  constructor(app, plugin, book, onActivated) {
    super(app);
    this.plugin = plugin;
    this.book = book;
    this.onActivated = onActivated || null;

    this.startDate = versoToday();
    this.targetFinishDate = book.targetFinishDate || '';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('verso-activate-modal');

    contentEl.createEl('h3', { text: `Start reading "${this.book.title}"` });
    contentEl.createEl('p', {
      text: "Verso will build a daily reading schedule between these dates.",
      cls: 'verso-confirm-body'
    });

    const form = contentEl.createDiv({ cls: 'verso-form' });

    // ── Start date ───────────────────────────────────────────────
    const startField = form.createDiv({ cls: 'verso-field' });
    startField.createEl('label', { text: 'Start date', cls: 'verso-field-label' });
    const startInput = startField.createEl('input', {
      type: 'date',
      cls: 'verso-input'
    });
    startInput.value = this.startDate;
    startInput.addEventListener('change', (e) => {
      this.startDate = e.target.value;
      this.updateConfirmButtonState();
    });

    // ── Finish date ──────────────────────────────────────────────
    const finishField = form.createDiv({ cls: 'verso-field' });
    finishField.createEl('label', { text: 'Finish by', cls: 'verso-field-label' });
    const finishInput = finishField.createEl('input', {
      type: 'date',
      cls: 'verso-input'
    });
    finishInput.value = this.targetFinishDate;
    finishInput.addEventListener('change', (e) => {
      this.targetFinishDate = e.target.value;
      this.updateConfirmButtonState();
    });

    this.finishInput = finishInput;
    this.finishErrorEl = finishField.createDiv({ cls: 'verso-field-error' });
    this.daysOffEl = finishField.createDiv();

    if (this.book.targetFinishDate) {
      finishField.createEl('div', {
        cls: 'verso-field-desc',
        text: 'Pre-filled from the date you set when adding this book — adjust if needed.'
      });
    }

    // ── Buttons ──────────────────────────────────────────────────
    const buttons = contentEl.createDiv({ cls: 'verso-confirm-buttons' });

    const cancelBtn = buttons.createEl('button', { text: 'Cancel', cls: 'verso-btn verso-btn-text' });
    cancelBtn.addEventListener('click', () => this.close());

    this.confirmBtn = buttons.createEl('button', { text: 'Start reading', cls: 'verso-btn verso-btn-primary' });
    this.confirmBtn.addEventListener('click', async () => {
      if (!this.isValid()) return;
      this.close();
      await this.plugin.activateBook(this.book.id, this.startDate, this.targetFinishDate);
      new Notice(`"${this.book.title}" is now on your schedule.`);
      if (this.onActivated) this.onActivated();
    });

    this.updateConfirmButtonState();
  }

  // Checked in priority order: missing fields first, then the relative
  // ordering of the dates, then the "not in the past" guard — Verso doesn't
  // support backdating a book's schedule, so a finish date has to be today
  // or later. (Start date can still be in the past here — activating a book
  // you actually started a few days ago is fine; it's the FINISH commitment
  // that can't already be broken the moment the schedule is built.)
  validationError() {
    if (!this.startDate || !this.targetFinishDate) return null;
    if (this.targetFinishDate < this.startDate) {
      return 'Finish date must be on or after the start date.';
    }
    if (this.targetFinishDate < versoToday()) {
      return "Finish date can't be in the past.";
    }
    return null;
  }

  isValid() {
    return !!this.startDate && !!this.targetFinishDate && !this.validationError();
  }

  updateConfirmButtonState() {
    if (!this.confirmBtn) return;
    const error = this.validationError();
    const valid = this.isValid();
    this.confirmBtn.disabled = !valid;
    this.confirmBtn.toggleClass('verso-btn-disabled', !valid);
    if (this.finishErrorEl) {
      this.finishErrorEl.setText(error || '');
    }
    this.renderDaysOffWarning(error);
  }

  // Days off reminder, as in Add book (v1.4.0).
  renderDaysOffWarning(error) {
    if (!this.daysOffEl) return;
    this.daysOffEl.empty();
    if (error) return;
    const weekly = versoWeeklyDays(this.plugin.getReadingDaysFor(this.book));
    const w = versoDaysOffWarning(this.plugin.settings.daysOff, weekly, this.startDate, this.targetFinishDate);
    if (!w) return;
    const box = this.daysOffEl.createDiv({ cls: 'verso-pace-note verso-pace-note-warning verso-days-off-warning' });
    box.createDiv({ text: w.text });
    if (w.laterFinish !== this.targetFinishDate) {
      const moveBtn = box.createEl('button', {
        text: `Finish ${versoFormatDateLong(w.laterFinish)} instead`,
        cls: 'verso-btn verso-btn-secondary verso-days-off-warning-btn'
      });
      moveBtn.addEventListener('click', () => {
        this.targetFinishDate = w.laterFinish;
        this.finishInput.value = w.laterFinish;
        this.updateConfirmButtonState();
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}


// ─── Restore ────────────────────────────────────────────────────────────────
//
// Restoring an active book whose schedule had begun asks for a new finish
// date first (v1.3.2). Previously the old plan kept running while the book
// sat in the archive, so every reading day in that stretch came back as
// missed and the book returned behind, at risk, or off pace.
function versoRestoreBook(app, plugin, book, onDone) {
  const finish = async (newTargetFinishDate) => {
    await plugin.restoreBook(book.id, newTargetFinishDate);
    new Notice(`"${book.title}" restored.`);
    if (onDone) onDone();
  };
  if (plugin.restoreNeedsNewFinishDate(book)) {
    new VersoRestoreModal(app, book, finish).open();
  } else {
    finish();
  }
}

class VersoRestoreModal extends Modal {
  constructor(app, book, onConfirm) {
    super(app);
    this.book = book;
    this.onConfirm = onConfirm;
    this.targetFinishDate = this.suggestedFinishDate();
  }

  // The old finish date pushed back by however long the book was archived,
  // so the remaining pages keep roughly the pace they had. Never in the past.
  suggestedFinishDate() {
    const today = versoToday();
    const old = this.book.targetFinishDate;
    if (!old) return '';
    let suggested = old;
    if (this.book.archivedDate) {
      const archived = versoParseLocalDate(versoLocalDateString(new Date(this.book.archivedDate)));
      const daysArchived = Math.round((versoParseLocalDate(today) - archived) / 86400000);
      if (daysArchived > 0) {
        const shifted = versoParseLocalDate(old);
        shifted.setDate(shifted.getDate() + daysArchived);
        suggested = versoLocalDateString(shifted);
      }
    }
    return suggested < today ? today : suggested;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('verso-restore-modal');

    contentEl.createEl('h3', { text: `Restore "${this.book.title}"` });
    contentEl.createEl('p', {
      text: 'Pick a new finish date. Verso will spread your remaining pages from today to that date. Days missed while the book was archived won\u2019t count against your pace.',
      cls: 'verso-confirm-body'
    });

    const form = contentEl.createDiv({ cls: 'verso-form' });
    const finishField = form.createDiv({ cls: 'verso-field' });
    finishField.createEl('label', { text: 'Finish by', cls: 'verso-field-label' });
    const finishInput = finishField.createEl('input', { type: 'date', cls: 'verso-input' });
    finishInput.value = this.targetFinishDate;
    finishInput.addEventListener('change', (e) => {
      this.targetFinishDate = e.target.value;
      this.updateConfirmButtonState();
    });
    this.finishErrorEl = finishField.createDiv({ cls: 'verso-field-error' });
    if (this.book.targetFinishDate) {
      finishField.createEl('div', {
        cls: 'verso-field-desc',
        text: `Your old finish date was ${versoFormatDate(this.book.targetFinishDate)}. The suggestion pushes it back by the time the book spent archived.`
      });
    }

    const buttons = contentEl.createDiv({ cls: 'verso-confirm-buttons' });
    const cancelBtn = buttons.createEl('button', { text: 'Cancel', cls: 'verso-btn verso-btn-text' });
    cancelBtn.addEventListener('click', () => this.close());

    this.confirmBtn = buttons.createEl('button', { text: 'Restore', cls: 'verso-btn verso-btn-primary' });
    this.confirmBtn.addEventListener('click', async () => {
      if (this.submitted || !this.isValid()) return;
      this.submitted = true;
      this.confirmBtn.disabled = true;
      const date = this.targetFinishDate;
      this.close();
      await this.onConfirm(date);
    });

    this.updateConfirmButtonState();
  }

  validationError() {
    if (!this.targetFinishDate) return null;
    if (this.targetFinishDate < versoToday()) return "Finish date can't be in the past.";
    return null;
  }

  isValid() {
    return !!this.targetFinishDate && !this.validationError();
  }

  updateConfirmButtonState() {
    if (!this.confirmBtn) return;
    const valid = this.isValid();
    this.confirmBtn.disabled = !valid;
    this.confirmBtn.toggleClass('verso-btn-disabled', !valid);
    if (this.finishErrorEl) this.finishErrorEl.setText(this.validationError() || '');
  }

  onClose() {
    this.contentEl.empty();
  }
}


// ─── Edit Book Modal ────────────────────────────────────────────────────────
//
// Edits a book's info (title, author, cover color, total pages, collection)
// and, where it has one, its schedule. Renders by status:
//  - Planned: book info, target finish date, and reading days. No start date —
//    a planned book doesn't have one until VersoActivateModal sets it. Every
//    field here is consequence-free; no chunks exist to disturb.
//  - Active, no progress yet: startDate, targetFinishDate, AND reading days
//    are all editable — this fully rebuilds the schedule.
//  - Active, progress exists: startDate is locked (a completed-chunk history
//    can't sit "before" the book started), but targetFinishDate and reading
//    days remain editable — recalculateSchedule() redistributes the remaining
//    pages forward across whichever days are now selected.
//
// Completed and archived books have no edit path here by design.

class VersoEditBookModal extends Modal {
  constructor(app, plugin, book, onUpdated) {
    super(app);
    this.plugin = plugin;
    this.book = book;
    this.onUpdated = onUpdated || null;

    this.timelineStarted = plugin.hasBookStarted(book);

    this.startDate = book.startDate || versoToday();
    this.targetFinishDate = book.targetFinishDate || '';

    this.selectedCollectionId = book.collectionId || null;
    this.isCreatingNewCollection = false;
    this.newCollectionName = '';

    // A book may have no override yet (readingDaysOverride === null, meaning
    // it currently follows the global default). Pre-fill the day grid with
    // the global default in that case, same fallback AddBookModal uses, so
    // toggling "Override" on starts from a sensible baseline rather than
    // all-unchecked.
    this.overrideReadingDays = !!book.readingDaysOverride;
    this.customReadingDays = book.readingDaysOverride
      ? { ...book.readingDaysOverride }
      : globalReadingDaysAsObject(this.plugin.settings);

    // ── Book info state ─────────────────────────────────────────
    this.title = book.title;
    this.author = book.author || '';
    this.coverColor = book.coverColor || '#B5D4F4';
    this.totalPages = book.totalPages;
    // 'page' or 'percent' — see progressInputMode on the book. Allowed to
    // flip mid-book (e.g. switching from print to Kindle); already-logged
    // chunks keep their stored page numbers regardless of mode.
    // (LiveAQuietLife, 2026-09-04)
    this.progressInputMode = book.progressInputMode || 'page';

    // A planned book has no start date yet — it's set when the book is
    // activated (VersoActivateModal). Schedule editing here is limited to
    // the target finish date and reading days: every field a planned book
    // can touch is consequence-free, since no chunks exist to disturb.
    this.isPlanned = book.status === 'planned';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('verso-activate-modal');

    contentEl.createEl('h3', { text: `Edit "${this.book.title}"` });

    const form = contentEl.createDiv({ cls: 'verso-form' });

    // ── Book info ────────────────────────────────────────────────
    // Field scope locked 2026-07-26: title, author, cover color,
    // total pages, plus the collection picker (metadata, not schedule —
    // it lives here rather than under Schedule below). isbn / publisher /
    // year / notes stay out — they're scaffolding for Book Search and
    // building edit UI for fields nothing displays yet is wasted work.
    form.createDiv({ cls: 'verso-section-label', text: 'BOOK INFO' });

    const titleField = form.createDiv({ cls: 'verso-field' });
    titleField.createEl('label', { text: 'Title', cls: 'verso-field-label' });
    const titleInput = titleField.createEl('input', {
      type: 'text',
      cls: 'verso-input'
    });
    titleInput.value = this.title;
    titleInput.addEventListener('input', (e) => {
      this.title = e.target.value;
      this.updateConfirmButtonState();
    });
    // Applied on blur, not per-keystroke — live title-casing fights the
    // cursor mid-word. (LiveAQuietLife, 2026-09-05)
    titleInput.addEventListener('blur', (e) => {
      this.title = versoTitleCase(e.target.value);
      e.target.value = this.title;
    });
    this.titleErrorEl = titleField.createDiv({ cls: 'verso-field-error' });

    const authorField = form.createDiv({ cls: 'verso-field' });
    authorField.createEl('label', { text: 'Author', cls: 'verso-field-label' });
    const authorInput = authorField.createEl('input', {
      type: 'text',
      cls: 'verso-input'
    });
    authorInput.value = this.author;
    authorInput.addEventListener('input', (e) => {
      this.author = e.target.value;
    });
    authorInput.addEventListener('blur', (e) => {
      this.author = versoNameCase(e.target.value);
      e.target.value = this.author;
    });

    const colorField = form.createDiv({ cls: 'verso-field verso-field-color' });
    colorField.createEl('label', { text: 'Cover color', cls: 'verso-field-label' });

    const swatchRow = colorField.createDiv({ cls: 'verso-color-swatch-row' });
    COVER_COLORS.forEach(color => {
      const swatch = swatchRow.createDiv({ cls: 'verso-color-swatch' });
      swatch.style.backgroundColor = color;
      if (color === this.coverColor) swatch.addClass('verso-color-swatch-selected');

      swatch.addEventListener('click', () => {
        this.coverColor = color;
        swatchRow.querySelectorAll('.verso-color-swatch').forEach(s =>
          s.removeClass('verso-color-swatch-selected')
        );
        swatch.addClass('verso-color-swatch-selected');
      });
    });

    const pagesField = form.createDiv({ cls: 'verso-field' });
    pagesField.createEl('label', { text: 'Total pages', cls: 'verso-field-label' });
    const pagesInput = pagesField.createEl('input', {
      type: 'number',
      cls: 'verso-input',
      attr: { min: '1' }
    });
    pagesInput.value = this.totalPages;
    pagesInput.addEventListener('input', (e) => {
      const value = parseInt(e.target.value, 10);
      this.totalPages = isNaN(value) ? null : value;
      this.updateConfirmButtonState();
    });
    this.pagesErrorEl = pagesField.createDiv({ cls: 'verso-field-error' });

    // ── Percent-based progress (e-readers) ────────────────────────
    const percentModeField = form.createDiv({ cls: 'verso-field verso-field-toggle' });
    const percentModeLabel = percentModeField.createEl('label', { cls: 'verso-toggle-label' });
    const percentModeCheckbox = percentModeLabel.createEl('input', {
      type: 'checkbox',
      cls: 'verso-checkbox'
    });
    percentModeCheckbox.checked = this.progressInputMode === 'percent';
    percentModeLabel.createSpan({ text: 'Track progress by percentage instead of page number' });
    percentModeCheckbox.addEventListener('change', (e) => {
      this.progressInputMode = e.target.checked ? 'percent' : 'page';
    });
    // See AddBookModal's identical toggle for why this is a sibling, not a
    // nested child, of percentModeField. (LiveAQuietLife, 2026-09-05)
    form.createEl('div', {
      cls: 'verso-field-desc',
      text: "For e-readers (Kindle, Kobo, etc.) that only show a percent, not a page number."
    });

    // ── Collection picker ────────────────────────────────────────
    // Shelf reassignment is metadata-only — changing a book's collection
    // does not affect its schedule in any way. A "— No shelf —" option is
    // always present so a book can stay (or be moved) outside any collection
    // without silently force-assigning it when the modal opens.
    const collectionTerm = versoCollectionTerm(this.plugin.settings);
    const singularTerm = versoCollectionTermSingular(this.plugin.settings);
    const collections = this.plugin.settings.collections;

    const collField = form.createDiv({ cls: 'verso-field' });
    collField.createEl('label', {
      text: versoCapitalize(singularTerm),
      cls: 'verso-field-label'
    });

    const collSelect = collField.createEl('select', { cls: 'verso-input' });

    const noneOpt = collSelect.createEl('option', {
      text: `\u2014 No ${singularTerm} \u2014`,
      value: '__none__'
    });

    collections.forEach(c => {
      const opt = collSelect.createEl('option', { text: c.name, value: c.id });
      if (this.book.collectionId === c.id) opt.selected = true;
    });

    collSelect.createEl('option', {
      text: `+ New ${singularTerm}`,
      value: '__new__'
    });

    if (!this.book.collectionId) {
      noneOpt.selected = true;
    }

    const newCollField = form.createDiv({ cls: 'verso-field verso-field-indent' });
    newCollField.createEl('label', {
      text: `New ${singularTerm} name`,
      cls: 'verso-field-label'
    });
    const newCollInput = newCollField.createEl('input', {
      type: 'text',
      cls: 'verso-input',
      attr: { placeholder: `e.g. ${versoExampleCollectionName(collectionTerm)}` }
    });
    newCollInput.value = this.newCollectionName;
    newCollInput.addEventListener('input', e => {
      this.newCollectionName = e.target.value;
      this.updateConfirmButtonState();
    });

    const updateCollectionSelection = () => {
      const val = collSelect.value;
      if (val === '__new__') {
        this.isCreatingNewCollection = true;
        this.selectedCollectionId = null;
        newCollField.style.display = 'flex';
        newCollInput.focus();
      } else {
        this.isCreatingNewCollection = false;
        this.selectedCollectionId = val === '__none__' ? null : val;
        newCollField.style.display = 'none';
      }
      this.updateConfirmButtonState();
    };

    collSelect.addEventListener('change', updateCollectionSelection);
    newCollField.style.display = 'none';

    // ── Schedule ─────────────────────────────────────────────────
    form.createDiv({ cls: 'verso-section-label verso-section-label-spaced', text: 'SCHEDULE' });
    form.createEl('p', {
      text: this.isPlanned
        ? "This book hasn't started yet — set a target date and reading days for when you begin."
        : this.timelineStarted
          ? "Verso will redistribute your remaining pages across the new dates and reading days."
          : "Verso will rebuild your daily reading schedule using these dates and reading days.",
      cls: 'verso-confirm-body'
    });

    // ── Start date ───────────────────────────────────────────────
    // Planned books don't have one yet — it's set on activation, not here.
    if (!this.isPlanned) {
      const startField = form.createDiv({ cls: 'verso-field' });
      startField.createEl('label', { text: 'Start date', cls: 'verso-field-label' });
      const startInput = startField.createEl('input', {
        type: 'date',
        cls: 'verso-input'
      });
      startInput.value = this.startDate;
      this.startErrorEl = null;

      if (this.timelineStarted) {
        startInput.disabled = true;
        startInput.title = 'Locked — this book\'s reading schedule has already begun.';
        startField.createEl('div', {
          cls: 'verso-field-desc',
          text: "Locked — this book's reading schedule has already begun, so the start date can't change."
        });
      } else {
        startInput.addEventListener('change', (e) => {
          this.startDate = e.target.value;
          this.updateConfirmButtonState();
        });
        this.startErrorEl = startField.createDiv({ cls: 'verso-field-error' });
      }
    }

    // ── Finish date ──────────────────────────────────────────────
    const finishField = form.createDiv({ cls: 'verso-field' });
    finishField.createEl('label', { text: 'Finish by', cls: 'verso-field-label' });
    const finishInput = finishField.createEl('input', {
      type: 'date',
      cls: 'verso-input'
    });
    finishInput.value = this.targetFinishDate;
    finishInput.addEventListener('change', (e) => {
      this.targetFinishDate = e.target.value;
      this.updateConfirmButtonState();
    });

    this.finishErrorEl = finishField.createDiv({ cls: 'verso-field-error' });

    // ── Reading days override ──────────────────────────────────────
    // Same toggle + 7-day grid pattern as AddBookModal's Step 2, so the
    // control feels identical wherever a reader encounters it.
    const overrideField = form.createDiv({ cls: 'verso-field verso-field-toggle' });
    const overrideLabel = overrideField.createEl('label', { cls: 'verso-toggle-label' });
    const overrideCheckbox = overrideLabel.createEl('input', {
      type: 'checkbox',
      cls: 'verso-checkbox'
    });
    overrideCheckbox.checked = this.overrideReadingDays;
    overrideLabel.createSpan({ text: 'Override reading days for this book' });

    const daysContainer = form.createDiv({ cls: 'verso-field verso-field-indent verso-days-grid' });
    daysContainer.style.display = this.overrideReadingDays ? 'grid' : 'none';

    const dayDefs = [
      { key: 'sun', label: 'Sun' },
      { key: 'mon', label: 'Mon' },
      { key: 'tue', label: 'Tue' },
      { key: 'wed', label: 'Wed' },
      { key: 'thu', label: 'Thu' },
      { key: 'fri', label: 'Fri' },
      { key: 'sat', label: 'Sat' }
    ];

    dayDefs.forEach(day => {
      const dayLabel = daysContainer.createEl('label', { cls: 'verso-day-toggle' });
      const dayCheckbox = dayLabel.createEl('input', {
        type: 'checkbox',
        cls: 'verso-checkbox'
      });
      dayCheckbox.checked = this.customReadingDays[day.key];
      dayLabel.createSpan({ text: day.label });

      dayCheckbox.addEventListener('change', (e) => {
        this.customReadingDays[day.key] = e.target.checked;
        this.updateConfirmButtonState();
      });
    });

    overrideCheckbox.addEventListener('change', (e) => {
      this.overrideReadingDays = e.target.checked;
      daysContainer.style.display = e.target.checked ? 'grid' : 'none';
      this.updateConfirmButtonState();
    });

    // ── Buttons ──────────────────────────────────────────────────
    const buttons = contentEl.createDiv({ cls: 'verso-confirm-buttons' });

    const cancelBtn = buttons.createEl('button', { text: 'Cancel', cls: 'verso-btn verso-btn-text' });
    cancelBtn.addEventListener('click', () => this.close());

    this.confirmBtn = buttons.createEl('button', { text: 'Save changes', cls: 'verso-btn verso-btn-primary' });
    this.confirmBtn.addEventListener('click', async () => {
      if (!this.isValid()) return;

      const progress = this.plugin.getBookProgress(this.book.id);
      const pagesRead = progress ? progress.pagesRead : 0;
      const remainingPages = Math.max(0, this.totalPages - pagesRead);

      // ── Completion case ──────────────────────────────────────────
      // Lowering total pages to exactly what's been read leaves nothing to
      // schedule. Doing nothing here would strand the book: recalculate
      // produces zero chunks, and completion only ever fires on chunk
      // completion, so it would sit at 100% on the dashboard forever,
      // unable to finish. Checked BEFORE the finish-today branch below,
      // which would otherwise offer to compress zero pages into a chunk.
      //
      // Confirmation is the only guard on this — completing prunes the
      // book's remaining chunks, and typing the old number back afterwards
      // will not bring them back. So the dialog says so plainly.
      if (this.isCompletionEdit()) {
        this.close();
        new VersoConfirmModal(
          this.app,
          'Mark this book complete?',
          `${this.totalPages} pages, and you've read all of them. Verso will mark "${this.book.title}" complete and clear its remaining schedule. This can't be undone from here.`,
          'Mark complete',
          async () => {
            await this.saveChanges();
          }
        ).open();
        return;
      }

      // Only when the finish date is being MOVED to today. A book already
      // due today used to show this on every save, even a title edit.
      // Planned books have no schedule to compress. (v1.3.2)
      if (!this.isPlanned &&
          this.targetFinishDate === versoToday() &&
          this.targetFinishDate !== (this.book.targetFinishDate || '')) {
        // Use the pending page count, not the saved one — if the reader just
        // corrected total pages in this same form, the old number would
        // describe a book that's about to stop existing.
        const pageWord = remainingPages === 1 ? 'page' : 'pages';
        this.close();
        new VersoConfirmModal(
          this.app,
          'Finish today?',
          `This will compress your remaining ${remainingPages} ${pageWord} into a single chunk due today. Are you sure?`,
          'Save changes',
          async () => {
            await this.saveChanges();
          }
        ).open();
        return;
      }

      this.close();
      await this.saveChanges();
    });

    this.updateConfirmButtonState();
  }

  // True when saving would leave this book with nothing left to read.
  // Only meaningful for active books: a planned book has no logged pages,
  // and completed books have no edit path at all.
  isCompletionEdit() {
    if (this.book.status !== 'active') return false;
    if (this.totalPages === null || this.totalPages === undefined) return false;
    const progress = this.plugin.getBookProgress(this.book.id);
    const pagesRead = progress ? progress.pagesRead : 0;
    // pagesRead can only ever equal totalPages here, not exceed it —
    // validationError() blocks anything lower before we get this far.
    return pagesRead > 0 && this.totalPages <= pagesRead;
  }

  // Save order matters: book info goes first so that a changed totalPages is
  // already persisted before updateBookDates() rebuilds or recalculates the
  // schedule. That internal rebuild is the only recalculation needed — calling
  // recalculateBook() again here would just redo work that already happened
  // against the correct page count.
  async saveChanges() {
    const readingDaysOverride = this.overrideReadingDays
      ? { ...this.customReadingDays }
      : null;

    // Determine this BEFORE writing anything: once the new totalPages is
    // persisted, isCompletionEdit() would be reading the post-save state.
    const completesBook = this.isCompletionEdit();

    // ── Book info ────────────────────────────────────────────────
    const trimmedTitle = this.title.trim();
    const trimmedAuthor = this.author.trim();

    const infoUpdates = {};
    if (trimmedTitle !== this.book.title) infoUpdates.title = trimmedTitle;
    if (trimmedAuthor !== (this.book.author || '')) infoUpdates.author = trimmedAuthor;
    if (this.coverColor !== (this.book.coverColor || '#B5D4F4')) infoUpdates.coverColor = this.coverColor;
    if (this.totalPages !== this.book.totalPages) infoUpdates.totalPages = this.totalPages;
    if (this.progressInputMode !== (this.book.progressInputMode || 'page')) {
      infoUpdates.progressInputMode = this.progressInputMode;
    }

    const infoChanged = Object.keys(infoUpdates).length > 0;
    if (infoChanged) {
      await this.plugin.updateBook(this.book.id, infoUpdates);
    }
    // Chunk labels are stored, and depend on the mode (pages or percent)
    // and, in percent mode, on the page count. They used to keep the old
    // form until a restart. (v1.3.2)
    if ('progressInputMode' in infoUpdates || 'totalPages' in infoUpdates) {
      await this.plugin.relabelChunks(this.book.id);
    }

    // ── Collection reassignment ──────────────────────────────────
    // Purely a metadata update — no schedule recalculation needed.
    // Manage both sides of the collection.books arrays so the data
    // stays consistent with addBook's own bookkeeping.
    let newCollectionId = this.selectedCollectionId;

    if (this.isCreatingNewCollection && this.newCollectionName.trim()) {
      const newColl = await this.plugin.addCollection({
        name: this.newCollectionName.trim()
      });
      newCollectionId = newColl.id;
    }

    const oldCollectionId = this.book.collectionId;
    const collectionChanged = oldCollectionId !== newCollectionId;

    if (collectionChanged) {
      if (oldCollectionId) {
        const oldColl = this.plugin.getCollection(oldCollectionId);
        if (oldColl) {
          await this.plugin.updateCollection(oldCollectionId, {
            books: oldColl.books.filter(id => id !== this.book.id)
          });
        }
      }
      if (newCollectionId) {
        const newColl = this.plugin.getCollection(newCollectionId);
        if (newColl) {
          await this.plugin.updateCollection(newCollectionId, {
            books: [...newColl.books, this.book.id]
          });
        }
      }
      await this.plugin.updateBook(this.book.id, { collectionId: newCollectionId });
    }

    // ── Completion, or schedule ──────────────────────────────────
    // These are mutually exclusive. If the edit zeroed out the remaining
    // pages there is no schedule to rebuild — updateBookDates() would
    // generate zero chunks and leave the book stranded at 100% and active.
    // Complete it instead, dated when the reading actually ended rather
    // than when the correction was typed.
    const title = trimmedTitle || this.book.title;

    if (completesBook) {
      const completionDate =
        this.plugin.lastChunkCompletionDate(this.book.id) || new Date().toISOString();
      await this.plugin.checkBookCompletion(this.book.id, completionDate);

      // Quiet by design. The celebration modal belongs to the moment a
      // reader finishes their last chunk; firing it from a correction form
      // would be performing at someone doing bookkeeping.
      new Notice(`"${title}" is complete.`);
      this.plugin.refreshAllViews();
      if (this.onUpdated) this.onUpdated();
      return;
    }

    // ── Schedule ─────────────────────────────────────────────────
    // updateBookDates() handles the planned / not-yet-begun / begun cases
    // itself, including refusing to build chunks for a planned book.
    // updateBook() replaces the stored object, so this.book still holds
    // the values from before this save.
    const scheduleChanged = this.scheduleFieldsChanged();

    if (scheduleChanged) {
      await this.plugin.updateBookDates(this.book.id, this.startDate, this.targetFinishDate, readingDaysOverride);
    }

    // ── Notice ───────────────────────────────────────────────────
    // Say only what actually happened. A title correction shouldn't claim
    // the schedule changed, and nothing at all shouldn't claim anything.
    if (scheduleChanged && !infoChanged && !collectionChanged) {
      new Notice(`Schedule updated for "${title}".`);
    } else if (infoChanged || collectionChanged || scheduleChanged) {
      new Notice(`"${title}" updated.`);
    }

    this.plugin.refreshAllViews();
    if (this.onUpdated) this.onUpdated();
  }

  isValid() {
    return !this.validationError();
  }

  // Returns { message, field } if something is invalid, or null if everything
  // is fine. `field` tells updateConfirmButtonState() which inline error slot
  // to write into, so a title problem doesn't surface under the finish date.
  // Checked in priority order: book info first, then collection, then the
  // dates (missing fields, relative ordering, then the "not in the past"
  // guard — a finish date can't be earlier than the start date OR today).
  validationError() {
    if (!this.title.trim()) {
      return { message: 'A book needs a title.', field: 'title' };
    }

    // ── Total pages, three tiers ─────────────────────────────────
    // Lowering the total below what's already logged is blocked outright,
    // not warned about: warn-and-allow would let a typo produce a book
    // sitting at 118% progress with an input.max below its own history.
    // Setting it EQUAL to pages read is deliberately allowed here — that's
    // the completion path, handled at save time, not a validation error.
    if (this.totalPages === null || this.totalPages === undefined) {
      return { message: 'Total pages is required.', field: 'pages' };
    }
    if (this.totalPages < 1) {
      return { message: 'A book needs at least one page.', field: 'pages' };
    }

    // Read live rather than caching at open time — cheap, and removes any
    // question about staleness if pages get logged while the modal is open.
    const progress = this.plugin.getBookProgress(this.book.id);
    const pagesRead = progress ? progress.pagesRead : 0;
    if (this.totalPages < pagesRead) {
      const pageWord = pagesRead === 1 ? 'page' : 'pages';
      return {
        message: `You've already logged ${pagesRead} ${pageWord}. Total pages can't be lower than that.`,
        field: 'pages'
      };
    }

    if (this.isCreatingNewCollection && !this.newCollectionName.trim()) {
      return {
        message: `Enter a name for the new ${versoCollectionTermSingular(this.plugin.settings)}.`,
        field: 'finish'
      };
    }
    // A planned book's due date is optional. An active book needs both
    // dates: saving without one used to wipe its whole schedule. (v1.3.2)
    if (this.isPlanned && !this.targetFinishDate) return null;
    if (!this.isPlanned && !this.startDate) {
      return { message: 'Choose a start date.', field: 'start' };
    }
    if (!this.targetFinishDate) {
      return { message: 'Choose a finish date.', field: 'finish' };
    }
    // A planned book shows no start date field, so an error mentioning one
    // would point at something the reader can't see. Only the "not in the
    // past" rule applies there.
    if (!this.isPlanned) {
      if (this.targetFinishDate < this.startDate) {
        return { message: 'Finish date must be on or after the start date.', field: 'finish' };
      }
    }
    // An off-pace book's finish date is already in the past. Keeping it is
    // fine for an edit that leaves the schedule alone (title, author,
    // color, collection). Changing the date, reading days, or page count
    // needs a new finish date. (v1.3.2)
    if (this.targetFinishDate < versoToday()) {
      const keptOldDate = this.targetFinishDate === (this.book.targetFinishDate || '');
      if (!keptOldDate) {
        return { message: "Finish date can't be in the past.", field: 'finish' };
      }
      if (this.scheduleFieldsChanged()) {
        return { message: 'Choose a new finish date to change the schedule.', field: 'finish' };
      }
    }
    return null;
  }

  // True when the edit touches anything the schedule is built from:
  // start date, finish date, reading days, or total pages.
  scheduleFieldsChanged() {
    const readingDaysOverride = this.overrideReadingDays ? { ...this.customReadingDays } : null;
    const readingDaysChanged =
      JSON.stringify(readingDaysOverride) !== JSON.stringify(this.book.readingDaysOverride || null);
    // A planned book has no startDate — this.startDate holds a today default
    // that's never shown and never saved (updateBookDates ignores it for
    // planned books). Comparing it against the book's null would report a
    // change on every open, so it's excluded from detection entirely.
    const startDateChanged = !this.isPlanned && this.startDate !== this.book.startDate;
    return startDateChanged ||
      this.targetFinishDate !== (this.book.targetFinishDate || '') ||
      readingDaysChanged ||
      // A changed page count means the schedule has to be rebuilt even if
      // no date moved — the pages no longer divide the same way.
      this.totalPages !== this.book.totalPages;
  }

  updateConfirmButtonState() {
    if (!this.confirmBtn) return;
    const error = this.validationError();
    const valid = !error;
    this.confirmBtn.disabled = !valid;
    this.confirmBtn.toggleClass('verso-btn-disabled', !valid);

    if (this.titleErrorEl) {
      this.titleErrorEl.setText(error && error.field === 'title' ? error.message : '');
    }
    if (this.pagesErrorEl) {
      this.pagesErrorEl.setText(error && error.field === 'pages' ? error.message : '');
    }
    if (this.finishErrorEl) {
      this.finishErrorEl.setText(error && error.field === 'finish' ? error.message : '');
    }
    if (this.startErrorEl) {
      this.startErrorEl.setText(error && error.field === 'start' ? error.message : '');
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Pages Read Modal ───────────────────────────────────────────────────────
//
// Fires when a reader checks off today's chunk. Captures the page they
// actually finished on (pre-filled with the scheduled end) so the schedule
// can redistribute against reality instead of the plan. The branched Notice
// keeps Verso's voice: gentle when behind, a small nod when ahead, quiet
// when right on plan.
//
// CAPTURE + MESSAGE only. The data work (mutate pagesEnd, record
// scheduledPagesEnd, recalc) happens in markChunkComplete via onConfirm —
// wired in the next piece.
class VersoPagesReadModal extends Modal {
  // options.extra: logging a reading on a day with nothing scheduled
  // (see extraReadingFor). Changes only the wording. (v1.4.0)
  constructor(app, plugin, chunk, book, onConfirm, options = {}) {
    super(app);
    this.plugin = plugin;
    this.chunk = chunk;
    this.book = book;
    this.onConfirm = onConfirm || null;
    this.extra = !!options.extra;
    // chunk.restOfToday: finishing today's reading after falling short of
    // it (see moreReadingFor). (v1.4.1)
    this.restOfToday = this.extra && !!chunk.restOfToday;
    this.readingName = this.restOfToday ? "The rest of today's reading"
      : this.extra ? 'Your next reading' : "Today's reading";

    this.scheduledEnd = chunk.pagesEnd;
    this.actualEnd = chunk.pagesEnd; // pre-fill with the plan — stays the
    // page-number source of truth throughout, in both modes. Percent mode
    // (below) only changes what the reader types; every existing consumer
    // of actualEnd (isValid, onConfirm, fireMessage) is untouched.

    // Percent-mode pre-fill, kept as its own field so the input can show a
    // whole percent without fighting rounding against actualEnd on every
    // keystroke. Recomputed from actualEnd whenever the percent input
    // changes; actualEnd is recomputed from it in the other direction.
    // (LiveAQuietLife, 2026-09-04)
    this.isPercentMode = book && book.progressInputMode === 'percent' && book.totalPages > 0;
    this.actualPercent = this.isPercentMode
      ? Math.round((chunk.pagesEnd / book.totalPages) * 100)
      : null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('verso-pages-read-modal');

    contentEl.createEl('h3', { text: 'Pages read' });

    const desc = contentEl.createEl('p', { cls: 'verso-confirm-body' });
    desc.createSpan({ text: this.restOfToday ? "Rest of today's reading: " : this.extra ? 'Next reading: ' : "Today's reading: " });
    // Percent mode shows start → target (e.g. "20% → 23%"), so the reader
    // can see where today's reading begins as well as where it ends — the
    // lowest percent the input accepts is the start. (v1.3.2)
    let chunkText = buildChunkLabel(this.chunk.pagesStart, this.chunk.pagesEnd, this.book);
    if (this.isPercentMode) {
      const startPct = this.pageToPercent(this.chunk.pagesStart);
      const endPct = this.pageToPercent(this.chunk.pagesEnd);
      if (startPct < endPct) chunkText = `${startPct}% → ${endPct}%`;
    }
    desc.createEl('strong', { text: chunkText });
    desc.createSpan({ text: this.book && this.book.title ? ` of ${this.book.title}.` : '.' });

    const form = contentEl.createDiv({ cls: 'verso-form' });

    const field = form.createDiv({ cls: 'verso-field' });

    if (this.isPercentMode) {
      // Percent mode: the reader types the percent their e-reader shows;
      // this converts to a page number under the hood so every downstream
      // consumer (isValid, onConfirm, markChunkComplete) keeps working in
      // pages, unchanged. (LiveAQuietLife, 2026-09-04)
      field.createEl('label', { text: "You've read up to", cls: 'verso-field-label' });

      const percentInput = field.createEl('input', { type: 'number', cls: 'verso-input' });
      percentInput.value = String(this.actualPercent);
      percentInput.min = '0';
      percentInput.max = '100';
      percentInput.addEventListener('input', (e) => {
        const raw = e.target.value;
        this.actualPercent = raw === '' ? null : parseInt(raw, 10);
        this.actualEnd = this.percentToPage(this.actualPercent);
        this.updateConfirmButtonState();
      });

      field.createEl('div', {
        cls: 'verso-field-desc',
        text: 'An estimate based on total page count, not your reader\u2019s exact position \u2014 it may not move if you\u2019ve only read a few pages today.'
      });
    } else {
      field.createEl('label', { text: 'You read to page', cls: 'verso-field-label' });

      const input = field.createEl('input', { type: 'number', cls: 'verso-input' });
      input.value = String(this.actualEnd);
      input.min = String(this.chunk.pagesStart);
      input.max = String(this.book.totalPages);
      input.addEventListener('input', (e) => {
        const raw = e.target.value;
        this.actualEnd = raw === '' ? null : parseInt(raw, 10);
        this.updateConfirmButtonState();
      });

      field.createEl('div', {
        cls: 'verso-field-desc',
        text: 'Pre-filled with where you were headed. Adjust it to match where you actually landed.'
      });
    }

    // Says why "Mark read" is disabled instead of leaving the button
    // silently greyed out. (v1.3.2)
    this.errorEl = field.createDiv({ cls: 'verso-field-error' });

    const buttons = contentEl.createDiv({ cls: 'verso-confirm-buttons' });

    const cancelBtn = buttons.createEl('button', { text: 'Cancel', cls: 'verso-btn verso-btn-text' });
    cancelBtn.addEventListener('click', () => this.close());

    this.confirmBtn = buttons.createEl('button', { text: 'Mark read', cls: 'verso-btn verso-btn-primary' });
    this.confirmBtn.addEventListener('click', async () => {
      // Guard against a double-click logging the chunk (and its session) twice.
      if (this.submitted || !this.isValid()) return;
      this.submitted = true;
      this.confirmBtn.disabled = true;
      const actualEnd = this.actualEnd;
      this.close();
      let bookJustCompleted = false;
      if (this.onConfirm) {
        const result = await this.onConfirm(actualEnd);
        bookJustCompleted = !!(result && result.bookJustCompleted);
      }
      // If the book just finished, the celebration modal already says
      // everything this toast would say (and more) — firing both at once
      // means the toast appears for a beat then gets covered by the
      // celebration modal opening right after. Skip it in that case.
      if (!bookJustCompleted) this.fireMessage(actualEnd);
    });

    this.updateConfirmButtonState();

    // Enter submits, same as clicking "Mark read". (v1.3.2)
    const activeInput = field.querySelector('input');
    activeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        this.confirmBtn.click();
      }
    });

    // Focus + select so an override is just "type the number"
    window.setTimeout(() => { activeInput.focus(); activeInput.select(); }, 0);
  }

  // Whole percent of the book at a given page — the same rounding the
  // pre-fill and chunk labels use.
  pageToPercent(page) {
    return Math.round((page / this.book.totalPages) * 100);
  }

  // Percent → page. One percent can span many pages, so a percent that
  // rounds to today's starting percent can land a page or two before
  // pagesStart. Clamp it up to pagesStart rather than rejecting it — the
  // reader typed exactly what their e-reader shows. (v1.3.2)
  percentToPage(percent) {
    if (percent === null || Number.isNaN(percent)) return null;
    // Typing back the pre-filled percent means "on plan" — keep the exact
    // scheduled page rather than a rounded one that reads as a few pages behind.
    if (percent === this.pageToPercent(this.scheduledEnd)) return this.scheduledEnd;
    const page = Math.round(this.book.totalPages * (percent / 100));
    if (page < this.chunk.pagesStart && percent >= this.pageToPercent(this.chunk.pagesStart)) {
      return this.chunk.pagesStart;
    }
    return page;
  }

  // Returns null when valid, otherwise a short reason for the reader.
  validationError() {
    const v = this.actualEnd;
    const start = this.chunk.pagesStart;
    const total = this.book.totalPages;
    if (this.isPercentMode) {
      const p = this.actualPercent;
      if (p === null || Number.isNaN(p)) return 'Enter a percent.';
      if (p > 100) return 'Enter a percent from 0 to 100.';
      if (v === null || v < start) {
        return `${this.readingName} starts at about ${this.pageToPercent(start)}%. Enter that or higher.`;
      }
      return null;
    }
    if (v === null || Number.isNaN(v)) return 'Enter a page number.';
    if (v < start) return `${this.readingName} starts on page ${start}. Enter ${start} or higher.`;
    if (v > total) return `This book has ${total} pages.`;
    return null;
  }

  isValid() {
    return this.validationError() === null;
  }

  updateConfirmButtonState() {
    if (!this.confirmBtn) return;
    const error = this.validationError();
    const valid = error === null;
    this.confirmBtn.disabled = !valid;
    this.confirmBtn.toggleClass('verso-btn-disabled', !valid);
    if (this.errorEl) this.errorEl.setText(error || '');
  }

  // Branch the post-confirm toast on where they actually landed.
  // "Caught up" gets folded into this same decision point (rather than a
  // separate check at each call site) so it never races against the ahead/
  // behind/exact-match branches below — exactly one toast fires per
  // completion, never two stacked back to back.
  fireMessage(actualEnd) {
    if (this.restOfToday && actualEnd === this.scheduledEnd) {
      versoToast('All done for today. Nice.');
      return;
    }
    // Reading more or less than planned changes the readings ahead, so
    // the message says what the next one is now. (v1.4.2)
    const next = this.plugin.nextReadingFor(this.book.id);
    const nextText = next ? ` ${versoNextReadingText(next, this.book)}.` : '';
    if (this.extra) {
      const n = actualEnd - this.chunk.pagesStart + 1;
      versoToast(`Logged ${n} page${n === 1 ? '' : 's'}.${nextText || ' Your next readings get a little lighter.'}`, nextText ? 6000 : undefined);
      return;
    }
    const scheduled = this.scheduledEnd;
    const stillToday = this.plugin.getAllTodaysChunks();
    const allDoneToday = stillToday.length > 0 && stillToday.every(c => c.status === 'complete');

    if (actualEnd < scheduled) {
      const behind = scheduled - actualEnd;
      versoToast(`No worries — we'll spread the remaining ${behind} page${behind === 1 ? '' : 's'} across your upcoming reading days.${nextText}`, nextText ? 6000 : undefined);
    } else if (actualEnd > scheduled) {
      const ahead = actualEnd - scheduled;
      versoToast(`You read ${ahead} page${ahead === 1 ? '' : 's'} ahead. Nice!${nextText}`, nextText ? 6000 : undefined);
    } else if (allDoneToday) {
      versoToast('All done for today. Nice.');
    } else {
      versoToast('Marked read.');
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}


// ─── Book Complete Modal ───────────────────────────────────────────────────
//
// Fires once, the moment checkBookCompletion() flips a book to 'complete'.
// Shown from both the dashboard and the Today sidebar via the same
// bookJustCompleted signal from markChunkComplete() — no parallel trigger
// logic per surface.
//
// Three honest states for the finish-date line, based on comparing
// targetFinishDate against originalTargetFinishDate (set once at book
// creation, never touched again — see createBook() / loadSettings()):
//   - never moved        → no note, plain congrats
//   - moved later         → named, non-punitive: this one's outside the
//                           on-time picture, but the book is still done
//   - moved earlier        → small, warm acknowledgment of the effort
//
// The shelf below is a pure live query — every 'complete' book with a
// dateCompleted in the current calendar year, same boundary the dashboard's
// "Books finished this year" stat already uses. Nothing new is stored for
// it; it's a different rendering of data that already exists.

// Quotes shown on the completion modal, picked at random each time a book
// finishes. Split at 500 pages — long books get a separate, smaller pool
// rather than a shared one, since a quote about finishing a doorstop reads
// oddly attached to a 180-page novel. (LiveAQuietLife, 2026-09-06)
// v1.3.2: long books also draw from the standard pool, and quotes don't
// repeat until the pool is used up (see versoPickCompleteQuote).
// Attributions checked in v1.3.2; misattributed lines were replaced or
// re-credited.
const VERSO_COMPLETE_QUOTES_STANDARD = [
  { text: 'If you have a garden in your library, you will lack nothing.', author: 'Cicero' },
  { text: 'From that moment, I understood the pathway from slavery to freedom.', author: 'Frederick Douglass' },
  { text: 'There is no Frigate like a Book / To take us Lands away.', author: 'Emily Dickinson' },
  { text: 'Books are a uniquely portable magic.', author: 'Stephen King' },
  { text: 'The world was hers for the reading.', author: 'Betty Smith' },
  { text: 'Reading is breathing in; writing is breathing out.', author: 'Pam Allyn' },
  { text: 'If you read only the books that everyone else is reading, you can only think what everyone else is thinking.', author: 'Haruki Murakami' },
  { text: 'Wear the old coat and buy the new book.', author: 'Austin Phelps' },
  // Added in v1.3.2, checked against their sources.
  { text: 'If one cannot enjoy reading a book over and over again, there is no use reading it at all.', author: 'Oscar Wilde' },
  { text: 'Never trust anyone who has not brought a book with them.', author: 'Lemony Snicket' },
  { text: "Books are the ultimate Dumpees: put them down and they'll wait for you forever; pay attention to them and they always love you back.", author: 'John Green' },
  { text: 'I, who had always thought of Paradise / in form and image as a library', author: 'Jorge Luis Borges, tr. Alastair Reid' },
  { text: 'I declare after all there is no enjoyment like reading! How much sooner one tires of any thing than of a book!', author: 'Jane Austen' },
  { text: 'I cannot live without books.', author: 'Thomas Jefferson' },
  { text: 'Read the best books first, or you may not have a chance to read them at all.', author: 'Henry David Thoreau' },
  { text: 'If a book is worth reading, it is worth buying.', author: 'John Ruskin' },
  { text: 'All good books are alike in that they are truer than if they had really happened.', author: 'Ernest Hemingway' },
  { text: 'Books are mirrors: you only see in them what you already have inside you.', author: 'Carlos Ruiz Zafón' },
  { text: "'Tis the good reader that makes the good book.", author: 'Ralph Waldo Emerson' },
  { text: 'If you love books enough, books will love you back.', author: 'Jo Walton' },
  { text: 'A book must be the axe for the frozen sea inside us.', author: 'Franz Kafka' },
  { text: 'A book is a version of the world. If you do not like it, ignore it; or offer your own version in return.', author: 'Salman Rushdie' },
  { text: 'A man will turn over half a library to make one book.', author: 'Samuel Johnson' },
  { text: 'Rereading, we find a new book.', author: 'Mason Cooley' },
  { text: 'In a sense, one can never read the book that the author originally wrote, and one can never read the same book twice.', author: 'Edmund Wilson' },
  { text: 'Always read something that will make you look good if you die in the middle of it.', author: "P.J. O'Rourke" },
  { text: 'A book is the only place in which you can examine a fragile thought without breaking it.', author: 'Edward P. Morgan' },
  { text: 'A book is proof that humans are capable of working magic.', author: 'Carl Sagan' },
  { text: 'Books are the guides of youth and the entertainment of age. They support us under solitude, and keep us from being a burden to ourselves.', author: 'Jeremy Collier' }
];

const VERSO_COMPLETE_QUOTES_LONG = [
  { text: "It is what you read when you don't have to that determines what you will be when you can't help it.", author: 'Charles Francis Potter' },
  { text: 'Some books leave us free, and some books make us free.', author: 'Ralph Waldo Emerson' },
  { text: 'A great book should leave you with many experiences, and slightly exhausted.', author: 'William Styron' },
  { text: 'Long books, when read, are usually overpraised, because the reader wishes to convince others and himself that he has not wasted his time.', author: 'E.M. Forster' },
  { text: 'Books are the quietest and most constant of friends; they are the most accessible and wisest of counselors, and the most patient of teachers.', author: 'Charles William Eliot' },
  // Added in v1.3.2, checked against their sources.
  { text: 'A mind needs books as a sword needs a whetstone, if it is to keep its edge.', author: 'George R.R. Martin' },
  { text: "What really knocks me out is a book that, when you're all done reading it, you wish the author that wrote it was a terrific friend of yours and you could call him up on the phone whenever you felt like it.", author: 'J.D. Salinger' },
  { text: 'A reader lives a thousand lives before he dies. The man who never reads lives only one.', author: 'George R.R. Martin' }
];

const VERSO_LONG_BOOK_PAGE_CUTOFF = 500;

// No repeats until a pool is used up (v1.3.2). Long books draw from both
// pools; other books draw from the standard pool only, so a quote about
// finishing a doorstop never lands on a short novel. Shown quotes are
// tracked by text in settings.quotesShown, shared across both pools, so a
// standard quote shown for a long book isn't repeated for a short one.
// When every quote in the book's pool has been shown, that pool's quotes
// are cleared from the list and the cycle starts again.
function versoPickCompleteQuote(plugin, totalPages) {
  const pool = (totalPages >= VERSO_LONG_BOOK_PAGE_CUTOFF)
    ? [...VERSO_COMPLETE_QUOTES_LONG, ...VERSO_COMPLETE_QUOTES_STANDARD]
    : VERSO_COMPLETE_QUOTES_STANDARD;

  const settings = plugin && plugin.settings;
  if (!settings) return pool[Math.floor(Math.random() * pool.length)];

  // Drop texts of quotes that no longer exist (edited or removed).
  const allTexts = new Set([...VERSO_COMPLETE_QUOTES_STANDARD, ...VERSO_COMPLETE_QUOTES_LONG].map(q => q.text));
  let shown = (settings.quotesShown || []).filter(t => allTexts.has(t));

  let unseen = pool.filter(q => !shown.includes(q.text));
  if (unseen.length === 0) {
    const poolTexts = new Set(pool.map(q => q.text));
    shown = shown.filter(t => !poolTexts.has(t));
    unseen = pool;
  }

  const quote = unseen[Math.floor(Math.random() * unseen.length)];
  shown.push(quote.text);
  settings.quotesShown = shown;
  plugin.saveSettings();
  return quote;
}

class VersoBookCompleteModal extends Modal {
  constructor(app, plugin, bookId) {
    super(app);
    this.plugin = plugin;
    this.bookId = bookId;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('verso-book-complete-modal');

    const book = this.plugin.getBook(this.bookId);
    if (!book) {
      contentEl.createEl('p', { text: 'This book could not be found.' });
      return;
    }

    // ── Header: cover + finished pill + title/author ──────────────
    const header = contentEl.createDiv({ cls: 'verso-complete-header' });
    const cover = header.createDiv({ cls: 'verso-complete-cover' });
    cover.style.backgroundColor = book.coverColor || '#B5D4F4';

    const headerInfo = header.createDiv();
    headerInfo.createDiv({ text: 'Finished', cls: 'verso-badge verso-badge-complete' });
    headerInfo.createDiv({ text: book.title, cls: 'verso-complete-title' });
    const metaParts = [];
    if (book.author) metaParts.push(book.author);
    metaParts.push(`${book.totalPages} pages`);
    headerInfo.createDiv({ text: metaParts.join(' · '), cls: 'verso-complete-meta' });

    // ── Voice copy: a book quote, picked at random per completion ─
    // Page count is already shown in the header meta above, so the quote
    // stands alone rather than repeating it. (LiveAQuietLife, 2026-09-06)
    const quote = versoPickCompleteQuote(this.plugin, book.totalPages);
    contentEl.createDiv({ text: `\u201C${quote.text}\u201D`, cls: 'verso-complete-headline' });
    contentEl.createDiv({ text: `— ${quote.author}`, cls: 'verso-complete-quote-author' });

    // ── Reschedule honesty ──────────────────────────────────────
    const original = book.originalTargetFinishDate;
    const current = book.targetFinishDate;
    if (original && current && original !== current) {
      const note = contentEl.createDiv({ cls: 'verso-complete-note' });
      if (current > original) {
        note.addClass('verso-complete-note-rescheduled');
        note.setText(
          "You moved this finish date back along the way, so this one's outside your on-time finishes — but the book's done, and that's what matters."
        );
      } else {
        note.addClass('verso-complete-note-early');
        note.setText('You moved this finish date up — nice. Finished ahead of where you first planned.');
      }
    }

    // ── Shelf: every book completed this calendar year ──────────
    const currentYear = new Date().getFullYear();
    const shelfBooks = this.plugin.settings.books
      .filter(b => versoIsFinishedBook(b) && b.dateCompleted)
      .filter(b => new Date(b.dateCompleted).getFullYear() === currentYear)
      .sort((a, b) => new Date(a.dateCompleted) - new Date(b.dateCompleted));

    if (shelfBooks.length > 0) {
      contentEl.createDiv({ text: 'Finished this year', cls: 'verso-complete-shelf-label' });
      const shelf = contentEl.createDiv({ cls: 'verso-complete-shelf' });
      shelfBooks.forEach(b => {
        const spine = shelf.createDiv({ cls: 'verso-complete-spine' });
        spine.style.backgroundColor = b.coverColor || '#B5D4F4';
        if (b.id === book.id) spine.addClass('verso-complete-spine-newest');
        spine.setAttribute('aria-label', b.title);
      });
      const countText = shelfBooks.length === 1
        ? '1 book finished this year'
        : `${shelfBooks.length} books finished this year`;
      contentEl.createDiv({ text: countText, cls: 'verso-complete-shelf-count' });
    }

    // ── Up next (v1.4.0): start a planned book from here ──────────
    // Books with a saved due date come first, soonest first; the rest in
    // the order they were added.
    const planned = this.plugin.settings.books
      .filter(b => b.status === 'planned')
      .sort((a, b) => {
        if (a.targetFinishDate && b.targetFinishDate) return a.targetFinishDate.localeCompare(b.targetFinishDate);
        if (a.targetFinishDate) return -1;
        if (b.targetFinishDate) return 1;
        return (a.dateAdded || '').localeCompare(b.dateAdded || '');
      });

    if (planned.length > 0) {
      contentEl.createDiv({ text: 'Up next', cls: 'verso-complete-shelf-label verso-up-next-label' });
      const list = contentEl.createDiv({ cls: 'verso-up-next-list' });
      planned.forEach(b => {
        const row = list.createDiv({ cls: 'verso-up-next-row' });
        const swatch = row.createDiv({ cls: 'verso-up-next-cover' });
        swatch.style.backgroundColor = b.coverColor || '#B5D4F4';
        const info = row.createDiv({ cls: 'verso-up-next-info' });
        info.createDiv({ text: b.title, cls: 'verso-up-next-title' });
        const meta = [];
        if (b.author) meta.push(b.author);
        meta.push(`${b.totalPages} pages`);
        if (b.targetFinishDate) meta.push(`due ${versoFormatDate(b.targetFinishDate)}`);
        info.createDiv({ text: meta.join(' · '), cls: 'verso-up-next-meta' });
        const startBtn = row.createEl('button', { text: 'Start', cls: 'verso-btn verso-btn-secondary' });
        startBtn.addEventListener('click', () => {
          this.close();
          new VersoActivateModal(this.app, this.plugin, b, () => this.plugin.refreshAllViews()).open();
        });
      });
    }

    // ── Footer ────────────────────────────────────────────────
    const footer = contentEl.createDiv({ cls: 'verso-modal-footer' });
    const leftGroup = footer.createDiv({ cls: 'verso-footer-left' });
    const rightGroup = footer.createDiv({ cls: 'verso-footer-right' });

    const closeButton = leftGroup.createEl('button', { text: 'Close', cls: 'verso-btn verso-btn-text' });
    closeButton.addEventListener('click', () => this.close());

    const addButton = rightGroup.createEl('button', { text: '+ Add your next book', cls: 'verso-btn verso-btn-primary' });
    addButton.addEventListener('click', () => {
      this.close();
      new AddBookModal(this.app, this.plugin, () => this.plugin.refreshAllViews()).open();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}


// ─── Add a Book Modal ────────────────────────────────────────────────────────
//
// Three-step flow: Find book (manual entry) → Set schedule → Confirm.
// Complete as of v0.4.0.

const ADD_BOOK_STEPS = [

  { key: 'find', label: 'Find book' },
  { key: 'schedule', label: 'Set schedule' },
  { key: 'confirm', label: 'Confirm' }
];

class AddBookModal extends Modal {

  constructor(app, plugin, onSave) {
    super(app);
    this.plugin = plugin;
    this.onSave = onSave || null;
    this.currentStep = 0;

    // Form state — populated as each step's UI is built
    this.formData = {
      title: '',
      author: '',
      totalPages: null,
      coverColor: '#B5D4F4',
      collectionId: null,
      newCollectionName: '',
      addMode: 'now', // 'now' = start reading immediately, 'later' = add to reading list (planned)
      startDate: this.getTodayString(),
      targetFinishDate: '',
      overrideReadingDays: false,
      customReadingDays: this.getGlobalReadingDaysAsObject(),
      // 'page' or 'percent' — see progressInputMode on the book itself.
      progressInputMode: 'page'
    };
  }

  onOpen() {
    this.modalEl.addClass('verso-add-book-modal');
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  getTodayString() {
    return versoToday();
  }

  // Returns the global reading-days setting as a { sun, mon, ... } object,
  // translating 'everyday' and 'weekdays' into the equivalent day grid.
  // Used to seed the "override reading days" grid so it starts from the
  // user's actual current setting, not stale/leftover custom-days data.
  getGlobalReadingDaysAsObject() {
    return globalReadingDaysAsObject(this.plugin.settings);
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();

    this.renderHeader(contentEl);
    this.renderBody(contentEl);
    this.renderFooter(contentEl);
  }

  renderHeader(containerEl) {
    const header = containerEl.createDiv({ cls: 'verso-modal-header' });
    header.createEl('h2', { text: 'Add a book', cls: 'verso-modal-title' });

    const steps = header.createDiv({ cls: 'verso-step-indicator' });

    ADD_BOOK_STEPS.forEach((step, index) => {
      if (index > 0) {
        steps.createDiv({ cls: 'verso-step-connector' });
      }

      const stepEl = steps.createDiv({ cls: 'verso-step' });

      let stateClass = 'verso-step-upcoming';
      if (index === this.currentStep) stateClass = 'verso-step-current';
      else if (index < this.currentStep) stateClass = 'verso-step-done';
      stepEl.addClass(stateClass);

      const dot = stepEl.createDiv({ cls: 'verso-step-dot' });
      if (index < this.currentStep) {
        dot.setText('✓');
      } else {
        dot.setText(String(index + 1));
      }

      stepEl.createSpan({ cls: 'verso-step-label', text: step.label });
    });
  }

  renderBody(containerEl) {
    const body = containerEl.createDiv({ cls: 'verso-modal-body' });
    const step = ADD_BOOK_STEPS[this.currentStep];

    switch (step.key) {
      case 'find':
        this.renderFindStep(body);
        break;
      case 'schedule':
        this.renderScheduleStep(body);
        break;
      case 'confirm':
        this.renderConfirmStep(body);
        break;
    }
  }

  // ── Step content (placeholders for now) ──────────────────────

  renderFindStep(body) {
    body.createDiv({ cls: 'verso-section-label', text: 'BOOK DETAILS' });

    const form = body.createDiv({ cls: 'verso-form' });

    // ── Fill in from a note (v1.4.0) ──────────────────────────
    const importField = form.createDiv({ cls: 'verso-field verso-import-field' });
    const importBtn = importField.createEl('button', {
      text: 'Fill in from a note…',
      cls: 'verso-btn verso-btn-secondary verso-import-btn'
    });
    importBtn.addEventListener('click', () => {
      new VersoNotePickerModal(this.app, file => this.importFromNote(file)).open();
    });
    if (this.importStatus) {
      importField.createDiv({ cls: 'verso-field-desc', text: this.importStatus.filled });
      this.importStatus.warnings.forEach(w =>
        importField.createDiv({ cls: 'verso-field-warning', text: w })
      );
    }

    // ── Title (required) ──────────────────────────────────────
    const titleField = form.createDiv({ cls: 'verso-field' });
    titleField.createEl('label', { text: 'Title', cls: 'verso-field-label' });
    const titleInput = titleField.createEl('input', {
      type: 'text',
      cls: 'verso-input',
      attr: { placeholder: 'e.g. The Brothers Karamazov' }
    });
    titleInput.value = this.formData.title;
    titleInput.addEventListener('input', (e) => {
      this.formData.title = e.target.value;
      this.updateNextButtonState();
    });
    titleInput.addEventListener('blur', (e) => {
      this.formData.title = versoTitleCase(e.target.value);
      e.target.value = this.formData.title;
    });

    // ── Author ───────────────────────────────────────────────
    const authorField = form.createDiv({ cls: 'verso-field' });
    authorField.createEl('label', { text: 'Author', cls: 'verso-field-label' });
    const authorInput = authorField.createEl('input', {
      type: 'text',
      cls: 'verso-input',
      attr: { placeholder: 'e.g. Fyodor Dostoevsky' }
    });
    authorInput.value = this.formData.author;
    authorInput.addEventListener('input', (e) => {
      this.formData.author = e.target.value;
    });
    authorInput.addEventListener('blur', (e) => {
      this.formData.author = versoNameCase(e.target.value);
      e.target.value = this.formData.author;
    });

    // ── Total pages (required) ──────────────────────────────────
    const pagesField = form.createDiv({ cls: 'verso-field' });
    pagesField.createEl('label', { text: 'Total pages', cls: 'verso-field-label' });
    const pagesInput = pagesField.createEl('input', {
      type: 'number',
      cls: 'verso-input',
      attr: { placeholder: 'e.g. 456', min: '1' }
    });
    if (this.formData.totalPages !== null) {
      pagesInput.value = this.formData.totalPages;
    }
    pagesInput.addEventListener('input', (e) => {
      const value = parseInt(e.target.value, 10);
      this.formData.totalPages = isNaN(value) ? null : value;
      this.updateNextButtonState();
    });

    // ── Percent-based progress (e-readers) ────────────────────────
    // For readers like Kindle/Kobo that only expose a percent-complete
    // figure, not a page number. Total pages above is still required —
    // it's the number percent gets converted against — this only changes
    // what you type in day to day. (LiveAQuietLife, 2026-09-04)
    const percentModeField = form.createDiv({ cls: 'verso-field verso-field-toggle' });
    const percentModeLabel = percentModeField.createEl('label', { cls: 'verso-toggle-label' });
    const percentModeCheckbox = percentModeLabel.createEl('input', {
      type: 'checkbox',
      cls: 'verso-checkbox'
    });
    percentModeCheckbox.checked = this.formData.progressInputMode === 'percent';
    percentModeLabel.createSpan({ text: 'Track progress by percentage instead of page number' });
    percentModeCheckbox.addEventListener('change', (e) => {
      this.formData.progressInputMode = e.target.checked ? 'percent' : 'page';
    });
    // Sibling of percentModeField, not nested inside it — verso-field-toggle
    // is row-flex (built for a single checkbox+label child), so a desc
    // nested inside it gets laid out beside the checkbox instead of below
    // it. (LiveAQuietLife, 2026-09-05)
    form.createEl('div', {
      cls: 'verso-field-desc',
      text: "For e-readers (Kindle, Kobo, etc.) that only show a percent, not a page number."
    });

    // ── Cover color ──────────────────────────────────────────────
    const colorField = form.createDiv({ cls: 'verso-field verso-field-color' });
    colorField.createEl('label', { text: 'Cover color', cls: 'verso-field-label' });

    const swatchRow = colorField.createDiv({ cls: 'verso-color-swatch-row' });
    COVER_COLORS.forEach(color => {
      const swatch = swatchRow.createDiv({ cls: 'verso-color-swatch' });
      swatch.style.backgroundColor = color;
      if (color === this.formData.coverColor) swatch.addClass('verso-color-swatch-selected');

      swatch.addEventListener('click', () => {
        this.formData.coverColor = color;
        swatchRow.querySelectorAll('.verso-color-swatch').forEach(s =>
          s.removeClass('verso-color-swatch-selected')
        );
        swatch.addClass('verso-color-swatch-selected');
      });
    });
  }


  // Copies title, author and pages from the chosen note's frontmatter into
  // the form. Fields the note doesn't have are left as they were. A missing
  // author only warns; title and pages fall to the usual required checks.
  importFromNote(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    const s = this.plugin.settings;
    const found = versoBookFromFrontmatter(cache && cache.frontmatter, s);

    const filled = [];
    const warnings = [];
    if (found.title) { this.formData.title = versoTitleCase(found.title); filled.push('title'); }
    else warnings.push(`No title found (property "${s.importTitleProperty || 'title'}").`);
    if (found.author) { this.formData.author = versoNameCase(found.author); filled.push('author'); }
    else warnings.push(`No author found (property "${s.importAuthorProperty || 'author'}").`);
    if (found.totalPages) { this.formData.totalPages = found.totalPages; filled.push('pages'); }
    else warnings.push(`No page count found (property "${s.importPagesProperty || 'pages'}").`);

    this.importStatus = {
      filled: filled.length
        ? `Filled in ${filled.join(', ')} from "${file.basename}".`
        : `Nothing filled in from "${file.basename}".`,
      warnings
    };
    this.render();
  }

  renderScheduleStep(body) {
    body.createDiv({ cls: 'verso-section-label', text: 'SCHEDULE DETAILS' });

    const form = body.createDiv({ cls: 'verso-form' });
    const collectionTerm = versoCollectionTerm(this.plugin.settings);

    // ── When to start ────────────────────────────────────────────
    const modeField = form.createDiv({ cls: 'verso-field' });
    modeField.style.paddingBottom = '8px';
    modeField.createEl('label', { text: 'When are you starting?', cls: 'verso-field-label' });

    const modeSelect = modeField.createEl('select', { cls: 'verso-input' });
    const nowOpt = modeSelect.createEl('option', { text: 'Start reading now', value: 'now' });
    const laterOpt = modeSelect.createEl('option', { text: "Add to my reading list — I'll start later", value: 'later' });
    if (this.formData.addMode === 'later') {
      laterOpt.selected = true;
    } else {
      nowOpt.selected = true;
    }

    modeField.createEl('div', {
      cls: 'verso-field-desc',
      text: this.formData.addMode === 'later'
        ? "This book goes to your Library's Planned shelf. You can start it — and set its schedule — anytime."
        : 'Verso will build a daily reading schedule starting from your chosen dates.'
    });

    modeSelect.addEventListener('change', (e) => {
      this.formData.addMode = e.target.value;
      this.render();
    });

    // ── Collection picker ───────────────────────────────────────
    const collectionField = form.createDiv({ cls: 'verso-field' });
    collectionField.createEl('label', {
      text: versoCapitalize(collectionTerm),
      cls: 'verso-field-label'
    });

    const collectionSelect = collectionField.createEl('select', { cls: 'verso-input' });
    const collections = this.plugin.settings.collections;

    collections.forEach(c => {
      const opt = collectionSelect.createEl('option', { text: c.name, value: c.id });
      if (this.formData.collectionId === c.id) opt.selected = true;
    });

    const newOpt = collectionSelect.createEl('option', {
      text: `+ New ${versoCollectionTermSingular(this.plugin.settings)}`,
      value: '__new__'
    });

    // Default selection: existing collectionId, or first collection, or "new"
    if (!this.formData.collectionId && collections.length > 0) {
      this.formData.collectionId = collections[0].id;
    }
    if (!this.formData.collectionId) {
      newOpt.selected = true;
    }

    // Container for the inline "new collection" name field
    const newCollectionField = form.createDiv({ cls: 'verso-field verso-field-indent' });
    newCollectionField.createEl('label', {
      text: `New ${versoCollectionTermSingular(this.plugin.settings)} name`,
      cls: 'verso-field-label'
    });
    const newCollectionInput = newCollectionField.createEl('input', {
      type: 'text',
      cls: 'verso-input',
      attr: { placeholder: `e.g. ${versoExampleCollectionName(collectionTerm)}` }
    });
    newCollectionInput.value = this.formData.newCollectionName;
    newCollectionInput.addEventListener('input', (e) => {
      this.formData.newCollectionName = e.target.value;
      this.updateNextButtonState();
    });

    const toggleNewCollectionField = () => {
      const showNew = collectionSelect.value === '__new__';
      newCollectionField.style.display = showNew ? 'flex' : 'none';
      if (showNew) {
        this.formData.collectionId = null;
      } else {
        this.formData.collectionId = collectionSelect.value;
      }
      this.updateNextButtonState();
    };

    collectionSelect.addEventListener('change', toggleNewCollectionField);
    toggleNewCollectionField();

    // ── Start date (only when starting now) ─────────────────────
    if (this.formData.addMode === 'now') {
      const startField = form.createDiv({ cls: 'verso-field' });
      startField.createEl('label', { text: 'Start date', cls: 'verso-field-label' });
      const startInput = startField.createEl('input', {
        type: 'date',
        cls: 'verso-input'
      });
      startInput.value = this.formData.startDate;
      startInput.addEventListener('change', (e) => {
        this.formData.startDate = e.target.value;
        this.updateNextButtonState();
      });
    }

    // ── Target finish date ──────────────────────────────────────
    // Required when starting now (drives the schedule). Optional when
    // adding to the reading list — but still useful for syllabus due
    // dates that exist before a reader has picked it up.
    const finishField = form.createDiv({ cls: 'verso-field' });
    finishField.createEl('label', {
      text: this.formData.addMode === 'later' ? 'Due date (optional)' : 'Finish by',
      cls: 'verso-field-label'
    });
    const finishInput = finishField.createEl('input', {
      type: 'date',
      cls: 'verso-input'
    });
    finishInput.value = this.formData.targetFinishDate;
    finishInput.addEventListener('change', (e) => {
      this.formData.targetFinishDate = e.target.value;
      this.updateNextButtonState();
    });
    if (this.formData.addMode === 'later') {
      finishField.createEl('div', {
        cls: 'verso-field-desc',
        text: "If this book has a deadline — like a book club meeting or a trip you're reading it for — set it now. You can still change it when you start reading."
      });
    }

    // ── Reading days override (only when starting now) ──────────
    if (this.formData.addMode === 'now') {
      const overrideField = form.createDiv({ cls: 'verso-field verso-field-toggle' });
      const overrideLabel = overrideField.createEl('label', { cls: 'verso-toggle-label' });
      const overrideCheckbox = overrideLabel.createEl('input', {
        type: 'checkbox',
        cls: 'verso-checkbox'
      });
      overrideCheckbox.checked = this.formData.overrideReadingDays;
      overrideLabel.createSpan({ text: 'Override reading days for this book' });

      const daysContainer = form.createDiv({ cls: 'verso-field verso-field-indent verso-days-grid' });
      daysContainer.style.display = this.formData.overrideReadingDays ? 'grid' : 'none';

      const dayDefs = [
        { key: 'sun', label: 'Sun' },
        { key: 'mon', label: 'Mon' },
        { key: 'tue', label: 'Tue' },
        { key: 'wed', label: 'Wed' },
        { key: 'thu', label: 'Thu' },
        { key: 'fri', label: 'Fri' },
        { key: 'sat', label: 'Sat' }
      ];

      dayDefs.forEach(day => {
        const dayLabel = daysContainer.createEl('label', { cls: 'verso-day-toggle' });
        const dayCheckbox = dayLabel.createEl('input', {
          type: 'checkbox',
          cls: 'verso-checkbox'
        });
        dayCheckbox.checked = this.formData.customReadingDays[day.key];
        dayLabel.createSpan({ text: day.label });

        dayCheckbox.addEventListener('change', (e) => {
          this.formData.customReadingDays[day.key] = e.target.checked;
          this.updateNextButtonState();
        });
      });

      overrideCheckbox.addEventListener('change', (e) => {
        this.formData.overrideReadingDays = e.target.checked;
        daysContainer.style.display = e.target.checked ? 'grid' : 'none';
        this.updateNextButtonState();
      });
    }
  }

  // ── Step 2 helpers ─────────────────────────────────────────────


  renderConfirmStep(body) {
    // ── Your book ────────────────────────────────────────────────
    body.createDiv({ cls: 'verso-section-label', text: 'YOUR BOOK' });

    const bookCard = body.createDiv({ cls: 'verso-confirm-book-card' });
    const cover = bookCard.createDiv({ cls: 'verso-confirm-cover' });
    cover.style.backgroundColor = this.formData.coverColor;

    const bookInfo = bookCard.createDiv({ cls: 'verso-confirm-book-info' });
    bookInfo.createEl('div', { text: this.formData.title, cls: 'verso-confirm-title' });
    if (this.formData.author) {
      bookInfo.createEl('div', { text: this.formData.author, cls: 'verso-confirm-author' });
    }
    bookInfo.createEl('div', {
      text: `${this.formData.totalPages} pages`,
      cls: 'verso-confirm-meta'
    });

    if (this.formData.addMode === 'later') {
      this.renderPlannedSummary(body);
    } else {
      this.renderScheduleSummary(body);
    }
  }

  // Confirm-step summary for books added to the reading list (no schedule
  // yet) — just collection and optional due date, plus a plain-language
  // note about where the book lands and what happens next.
  renderPlannedSummary(body) {
    body.createDiv({ cls: 'verso-section-label verso-section-label-spaced', text: 'READING LIST' });

    const summaryTable = body.createDiv({ cls: 'verso-summary-table' });

    const collectionTerm = versoCollectionTerm(this.plugin.settings);
    const collectionName = this.formData.collectionId
      ? (this.plugin.settings.collections.find(c => c.id === this.formData.collectionId)?.name || '—')
      : this.formData.newCollectionName;

    versoAddSummaryRow(summaryTable, versoCapitalize(versoCollectionTermSingular(this.plugin.settings)), collectionName);
    if (this.formData.targetFinishDate) {
      versoAddSummaryRow(summaryTable, 'Due date', this.formatDateLong(this.formData.targetFinishDate));
    }

    const noteBox = body.createDiv({ cls: 'verso-pace-note' });
    noteBox.setText(
      "This book will sit in your Library's Planned shelf — no daily reading schedule yet. " +
      'When you\'re ready to start, open it from the Library and choose "Start reading."'
    );
  }

  // Confirm-step summary for books with a schedule — the original
  // schedule summary, pace note, and preview.
  renderScheduleSummary(body) {
    const preview = this.buildPreview();

    // ── Schedule summary ─────────────────────────────────────────
    body.createDiv({ cls: 'verso-section-label verso-section-label-spaced', text: 'SCHEDULE SUMMARY' });

    const summaryTable = body.createDiv({ cls: 'verso-summary-table' });

    const collectionTerm = versoCollectionTerm(this.plugin.settings);
    const collectionName = this.formData.collectionId
      ? (this.plugin.settings.collections.find(c => c.id === this.formData.collectionId)?.name || '—')
      : this.formData.newCollectionName;

    versoAddSummaryRow(summaryTable, versoCapitalize(versoCollectionTermSingular(this.plugin.settings)), collectionName);
    versoAddSummaryRow(summaryTable, 'Start date', this.formatDateLong(this.formData.startDate));
    versoAddSummaryRow(summaryTable, 'Finish by', this.formatDateLong(this.formData.targetFinishDate));
    versoAddSummaryRow(summaryTable, 'Reading days', this.describeReadingDays());
    versoAddSummaryRow(summaryTable, 'Total reading days', String(preview.readingDayCount));

    if (this.formData.startDate < versoToday()) {
      const startedNote = body.createDiv({ cls: 'verso-pace-note' });
      startedNote.setText(
        "You started before today, so your schedule begins today. If you've already read some of it, " +
        "enter the page you're on when you mark today's reading."
      );
    }

    // ── Days off reminder (v1.4.0) ───────────────────────────────
    const daysOff = versoDaysOffWarning(this.plugin.settings.daysOff,
      versoWeeklyDays(preview.readingDays), this.formData.startDate, this.formData.targetFinishDate);
    if (daysOff) {
      const box = body.createDiv({ cls: 'verso-pace-note verso-pace-note-warning verso-days-off-warning' });
      box.createDiv({ text: daysOff.text });
      if (daysOff.laterFinish !== this.formData.targetFinishDate) {
        const moveBtn = box.createEl('button', {
          text: `Finish ${this.formatDateLong(daysOff.laterFinish)} instead`,
          cls: 'verso-btn verso-btn-secondary verso-days-off-warning-btn'
        });
        moveBtn.addEventListener('click', () => {
          this.formData.targetFinishDate = daysOff.laterFinish;
          this.render();
        });
      }
    }

    // ── Pace note ────────────────────────────────────────────────
    if (preview.readingDayCount === 0) {
      const noteBox = body.createDiv({ cls: 'verso-pace-note verso-pace-note-warning' });
      noteBox.setText('No reading days are selected, so Verso can\'t spread this out — everything will be scheduled on your start date. Pick at least one reading day to get a real pace.');
    } else if (preview.chunks.length > 0) {
      const avgPages = Math.round(this.formData.totalPages / preview.readingDayCount);
      const noteBox = body.createDiv({ cls: 'verso-pace-note' });
      noteBox.setText(this.buildPaceMessage(avgPages));
    }

    // ── Schedule preview ─────────────────────────────────────────
    body.createDiv({ cls: 'verso-section-label verso-section-label-spaced', text: 'SCHEDULE PREVIEW' });

    if (preview.chunks.length === 0) {
      body.createEl('p', {
        text: 'No reading days fall between the start and finish dates with the selected reading days.',
        cls: 'verso-step-placeholder'
      });
      return;
    }

    const first = preview.chunks[0];
    const last = preview.chunks[preview.chunks.length - 1];

    this.renderChunkPreviewCard(body, 'First reading day', first);

    if (preview.chunks.length > 1) {
      this.renderChunkPreviewCard(body, 'Last reading day', last);
    }

    if (preview.chunks.length > 2) {
      const middleNote = body.createDiv({ cls: 'verso-preview-middle-note' });
      const middleCount = preview.chunks.length - 2;
      middleNote.setText(`...and ${middleCount} more reading day${middleCount === 1 ? '' : 's'} in between.`);
    }
  }

  // ── Step 3 helpers ─────────────────────────────────────────────

  // Build a temporary book object and run it through generateSchedule()
  // for preview purposes only — nothing is saved.
  buildPreview() {
    const tempBook = {
      id: '__preview__',
      totalPages: this.formData.totalPages,
      startDate: this.formData.startDate,
      targetFinishDate: this.formData.targetFinishDate,
      progressInputMode: this.formData.progressInputMode
    };

    const readingDays = versoWithDaysOff(this.formData.overrideReadingDays
      ? this.formData.customReadingDays
      : this.plugin.settings.readingDays === 'custom'
        ? this.plugin.settings.customReadingDays
        : this.plugin.settings.readingDays, this.plugin.settings.daysOff);

    const chunks = generateSchedule(tempBook, readingDays);
    const readingDayCount = countReadingDays(
      versoScheduleFrom(this.formData.startDate),
      this.formData.targetFinishDate,
      readingDays
    );

    return { chunks, readingDayCount, readingDays };
  }

  renderChunkPreviewCard(body, headerText, chunk) {
    const card = body.createDiv({ cls: 'verso-chunk-preview-card' });
    card.createDiv({ cls: 'verso-chunk-preview-header', text: `${headerText} — ${this.formatDateLong(chunk.scheduledDate)}` });
    card.createDiv({ cls: 'verso-chunk-preview-label', text: chunk.label });
  }

  // Long form (includes the year) — the confirm step shows dates out of
  // context, so 'Jul 26' alone would be ambiguous across a year boundary.
  formatDateLong(dateString) {
    return versoFormatDateLong(dateString);
  }

  describeReadingDays() {
    if (this.formData.overrideReadingDays) {
      return this.describeDaysObject(this.formData.customReadingDays);
    }

    const globalSetting = this.plugin.settings.readingDays;
    if (globalSetting === 'everyday') return 'Every day';
    if (globalSetting === 'weekdays') return 'Weekdays';
    if (globalSetting === 'custom') return this.describeDaysObject(this.plugin.settings.customReadingDays);
    return 'Every day';
  }

  describeDaysObject(daysObj) {
    const labels = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
    const order = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const active = order.filter(key => daysObj[key]).map(key => labels[key]);

    if (active.length === 7) return 'Every day';
    if (active.length === 0) return 'No days selected';
    return active.join(', ');
  }

  // "Verso tells the truth about the math" — a brief, honest note about pace.
  buildPaceMessage(avgPages) {
    const base = `About ${avgPages} pages per reading day`;

    let descriptor;
    if (avgPages <= 15) descriptor = 'a relaxed pace';
    else if (avgPages <= 40) descriptor = 'very manageable';
    else if (avgPages <= 70) descriptor = 'a solid commitment';
    else descriptor = "that's a heavy pace — you may want to adjust your dates";

    if (avgPages > 70) {
      return `${base} — ${descriptor}.`;
    }
    return `${base} — ${descriptor}. You've got this!`;
  }


  // ── Footer / navigation ───────────────────────────────────────

  renderFooter(containerEl) {
    const footer = containerEl.createDiv({ cls: 'verso-modal-footer' });

    const leftGroup = footer.createDiv({ cls: 'verso-footer-left' });
    const rightGroup = footer.createDiv({ cls: 'verso-footer-right' });

    if (this.currentStep > 0) {
      const backBtn = leftGroup.createEl('button', {
        text: 'Back',
        cls: 'verso-btn verso-btn-text'
      });
      backBtn.addEventListener('click', () => this.goToStep(this.currentStep - 1));
    } else {
      const cancelBtn = leftGroup.createEl('button', {
        text: 'Cancel',
        cls: 'verso-btn verso-btn-text'
      });
      cancelBtn.addEventListener('click', () => this.close());
    }

    const isLastStep = this.currentStep === ADD_BOOK_STEPS.length - 1;

    if (!isLastStep) {
      const hint = rightGroup.createSpan({ cls: 'verso-footer-hint' });

      const nextBtn = rightGroup.createEl('button', {
        text: 'Next',
        cls: 'verso-btn verso-btn-primary'
      });
      nextBtn.addEventListener('click', () => this.goToStep(this.currentStep + 1));

      this.nextBtn = nextBtn;
      this.nextHint = hint;
      this.updateNextButtonState();
    } else {
      const addAnotherBtn = rightGroup.createEl('button', {
        text: 'Add another book',
        cls: 'verso-btn verso-btn-secondary'
      });
      const confirmBtn = rightGroup.createEl('button', {
        text: 'Confirm and go to dashboard',
        cls: 'verso-btn verso-btn-primary'
      });

      // Both buttons save, and saving is async — without a guard, a
      // double-click (or clicking one then the other) added the same book
      // twice. Disable both for the duration of the save.
      const saveOnce = async (after) => {
        if (this.saving) return;
        this.saving = true;
        addAnotherBtn.disabled = true;
        confirmBtn.disabled = true;
        try {
          await this.saveBook();
          new Notice(`"${this.formData.title}" added.`);
          if (this.onSave) this.onSave();
          await after();
        } finally {
          this.saving = false;
          addAnotherBtn.disabled = false;
          confirmBtn.disabled = false;
        }
      };

      addAnotherBtn.addEventListener('click', () => saveOnce(async () => {
        this.resetForm();
        this.goToStep(0);
      }));

      confirmBtn.addEventListener('click', () => saveOnce(async () => {
        this.close();
        await this.plugin.activateDashboardView();
      }));
    }
  }

  // Persist the book (and new collection, if any) using plugin data helpers.
  async saveBook() {
    let collectionId = this.formData.collectionId;

    if (!collectionId && this.formData.newCollectionName.trim()) {
      const collection = await this.plugin.addCollection({
        name: this.formData.newCollectionName.trim()
      });
      collectionId = collection.id;
    }

    if (this.formData.addMode === 'later') {
      // Planned: no schedule yet. targetFinishDate is preserved if the
      // reader set a due date (e.g. a syllabus deadline); startDate stays
      // null until the book is activated.
      await this.plugin.addBook({
        title: this.formData.title.trim(),
        author: this.formData.author.trim(),
        totalPages: this.formData.totalPages,
        coverColor: this.formData.coverColor,
        collectionId: collectionId,
        targetFinishDate: this.formData.targetFinishDate || null,
        status: 'planned',
        progressInputMode: this.formData.progressInputMode
      });
      return;
    }

    const readingDaysOverride = this.formData.overrideReadingDays
      ? { ...this.formData.customReadingDays }
      : null;

    await this.plugin.addBook({
      title: this.formData.title.trim(),
      author: this.formData.author.trim(),
      totalPages: this.formData.totalPages,
      coverColor: this.formData.coverColor,
      collectionId: collectionId,
      startDate: this.formData.startDate,
      targetFinishDate: this.formData.targetFinishDate,
      readingDaysOverride: readingDaysOverride,
      progressInputMode: this.formData.progressInputMode
    });
  }

  // Reset form state back to defaults for "Add another book"
  resetForm() {
    this.formData = {
      title: '',
      author: '',
      totalPages: null,
      coverColor: '#B5D4F4',
      collectionId: null,
      newCollectionName: '',
      addMode: 'now',
      startDate: this.getTodayString(),
      targetFinishDate: '',
      overrideReadingDays: false,
      customReadingDays: this.getGlobalReadingDaysAsObject(),
      progressInputMode: 'page'
    };
  }

  goToStep(index) {
    if (index < 0 || index >= ADD_BOOK_STEPS.length) return;
    this.currentStep = index;
    this.render();
  }

  // Returns true if the current step's required fields are filled in.
  isStepValid() {
    const step = ADD_BOOK_STEPS[this.currentStep];
    switch (step.key) {
      case 'find':
        return this.formData.title.trim().length > 0 &&
               this.formData.totalPages !== null &&
               this.formData.totalPages > 0;
      case 'schedule': {
        const hasCollection = this.formData.collectionId !== null ||
          this.formData.newCollectionName.trim().length > 0;

        if (this.formData.addMode === 'later') {
          // Planned books only need a collection — dates are optional,
          // reading days are irrelevant until the book is activated.
          return hasCollection;
        }

        // Verso doesn't support backdating a schedule, so the finish date
        // has to be today or later — same rule VersoEditBookModal
        // already enforces. Start date can still be in the past (a book
        // someone actually started a few days ago), but the finish date is
        // a forward commitment and can't already be broken at creation.
        const hasDates = this.formData.startDate && this.formData.targetFinishDate;
        const datesValid = hasDates &&
          this.formData.targetFinishDate >= this.formData.startDate &&
          this.formData.targetFinishDate >= versoToday();
        const hasReadingDay = !this.formData.overrideReadingDays ||
          Object.values(this.formData.customReadingDays).some(v => v === true);
        return hasCollection && datesValid && hasReadingDay;
      }
      default:
        return true;
    }
  }

  // Enable/disable the Next button and show/hide the hint, without a full re-render
  updateNextButtonState() {
    if (!this.nextBtn) return;

    const valid = this.isStepValid();
    this.nextBtn.disabled = !valid;
    this.nextBtn.toggleClass('verso-btn-disabled', !valid);

    if (this.nextHint) {
      const step = ADD_BOOK_STEPS[this.currentStep];
      let message = '';
      if (!valid) {
        if (step.key === 'find') {
          message = 'Enter a title and page count to continue';
        } else if (step.key === 'schedule') {
          if (this.formData.addMode === 'later') {
            message = `Choose a ${versoCollectionTermSingular(this.plugin.settings)} to continue`;
          } else {
            const hasReadingDay = !this.formData.overrideReadingDays ||
              Object.values(this.formData.customReadingDays).some(v => v === true);
            const hasDates = this.formData.startDate && this.formData.targetFinishDate;
            if (!hasReadingDay) {
              message = 'Select at least one reading day to continue';
            } else if (hasDates && this.formData.targetFinishDate < this.formData.startDate) {
              message = 'Finish date must be on or after the start date';
            } else if (hasDates && this.formData.targetFinishDate < versoToday()) {
              message = "Finish date can't be in the past";
            } else {
              message = 'Enter a collection, start date, and finish date to continue';
            }
          }
        }
      }
      this.nextHint.setText(message);
    }
  }
}



class VersoSettingTab extends PluginSettingTab {

  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Verso settings' });
    containerEl.createEl('p', { text: 'Your reading life, scheduled.', cls: 'verso-settings-tagline' });

    // ─── Vocabulary ────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Vocabulary' });
    containerEl.createEl('p', {
      text: 'What would you like to call your reading collections?',
      cls: 'verso-settings-desc'
    });

    new Setting(containerEl)
      .setName('Collection term')
      .setDesc('This word appears throughout Verso wherever your reading groups are referenced.')
      .addDropdown(drop => drop
        .addOption('projects', 'Projects')
        .addOption('lists', 'Lists')
        .addOption('shelves', 'Shelves')
        .addOption('custom', 'Custom...')
        .setValue(this.plugin.settings.collectionTerm)
        .onChange(async (value) => {
          this.plugin.settings.collectionTerm = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (this.plugin.settings.collectionTerm === 'custom') {
      // Both forms are asked for outright. Verso uses the singular in most
      // places ("+ New course", "Choose a course to continue") and the plural
      // in a few, and guessing one from the other gets English wrong often
      // enough to be worse than a second field.
      new Setting(containerEl)
        .setName('Custom term (plural)')
        .setDesc('e.g. "Courses", "Modules", "Tracks"')
        .addText(text => text
          .setPlaceholder('e.g. Courses, Modules, Tracks...')
          .setValue(this.plugin.settings.collectionTermCustomPlural)
          .onChange(async (value) => {
            this.plugin.settings.collectionTermCustomPlural = value;
            await this.plugin.saveSettings();
          })
        );

      new Setting(containerEl)
        .setName('Custom term (singular)')
        .setDesc('e.g. "Course", "Module", "Track"')
        .addText(text => text
          .setPlaceholder('e.g. Course, Module, Track...')
          .setValue(this.plugin.settings.collectionTermCustom)
          .onChange(async (value) => {
            this.plugin.settings.collectionTermCustom = value;
            await this.plugin.saveSettings();
          })
        );
    }

    // ─── Reading days ──────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Reading days' });
    containerEl.createEl('p', {
      text: 'When do you typically read? Verso uses this as the default when building schedules.',
      cls: 'verso-settings-desc'
    });

    new Setting(containerEl)
      .setName('Default reading days')
      .setDesc('You can always override this for individual books.')
      .addDropdown(drop => drop
        .addOption('everyday', 'Every day')
        .addOption('weekdays', 'Weekdays only')
        .addOption('custom', 'Custom days...')
        .setValue(this.plugin.settings.readingDays)
        .onChange(async (value) => {
          this.plugin.settings.readingDays = value;
          await this.plugin.saveSettings();
          await this.rescheduleForNewReadingDays();
          this.display();
        })
      );

    if (this.plugin.settings.readingDays === 'custom') {
      const days = [
        { key: 'sun', label: 'Sunday' },
        { key: 'mon', label: 'Monday' },
        { key: 'tue', label: 'Tuesday' },
        { key: 'wed', label: 'Wednesday' },
        { key: 'thu', label: 'Thursday' },
        { key: 'fri', label: 'Friday' },
        { key: 'sat', label: 'Saturday' }
      ];
      days.forEach(day => {
        new Setting(containerEl)
          .setName(day.label)
          .addToggle(toggle => toggle
            .setValue(this.plugin.settings.customReadingDays[day.key])
            .onChange(async (value) => {
              this.plugin.settings.customReadingDays[day.key] = value;
              await this.plugin.saveSettings();
              await this.rescheduleForNewReadingDays();
            })
          );
      });
    }

    // ─── Import from a note ────────────────────────────────────
    containerEl.createEl('h3', { text: 'Import from a note' });
    containerEl.createEl('p', {
      text: 'In Add book, "Fill in from a note" copies these properties from a note\'s frontmatter. Capitals don\'t matter.',
      cls: 'verso-settings-desc'
    });

    [
      { key: 'importTitleProperty', name: 'Title property', fallback: 'title' },
      { key: 'importAuthorProperty', name: 'Author property', fallback: 'author' },
      { key: 'importPagesProperty', name: 'Pages property', fallback: 'pages' }
    ].forEach(({ key, name, fallback }) => {
      new Setting(containerEl)
        .setName(name)
        .addText(text => text
          .setPlaceholder(fallback)
          .setValue(this.plugin.settings[key] || '')
          .onChange(async (value) => {
            this.plugin.settings[key] = value.trim() || fallback;
            await this.plugin.saveSettings();
          })
        );
    });

    // ─── About ─────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'About' });
    containerEl.createEl('p', {
      text: `Verso v${this.plugin.manifest.version} — Your reading life, scheduled.`,
      cls: 'verso-settings-desc'
    });
  }

  // Changing the default reading days used to leave every existing schedule
  // on the old days until the next restart. Recalculate active books that
  // follow the default (books with their own override come out unchanged).
  //
  // Skipped while a custom selection has no days at all: with zero reading
  // days every book would count as off-pace, and the off-pace freeze would
  // turn all upcoming chunks — including future-dated ones — into permanent
  // 'missed' history. That's an in-between state of the toggles, not a real
  // choice, so wait until at least one day is selected again.
  async rescheduleForNewReadingDays() {
    const settings = this.plugin.settings;
    if (settings.readingDays === 'custom' &&
        !Object.values(settings.customReadingDays).some(v => v === true)) {
      new Notice('Select at least one reading day — schedules will update once you do.');
      return;
    }
    const changed = await this.plugin.recalculateAllBooks();
    if (changed) this.plugin.refreshAllViews();
  }
}

module.exports = VersoPlugin;
