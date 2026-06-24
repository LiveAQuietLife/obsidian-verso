/*
 * Verso — Your reading life, scheduled.
 * v1.0.3 — Data Model
 */

const { Plugin, PluginSettingTab, Setting, Notice, Modal, ItemView } = require('obsidian');

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
  // Options: 'classes', 'projects', 'subjects', 'lists', 'shelves', 'custom'
  collectionTerm: 'lists',
  collectionTermCustom: '',

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
  sessions: []
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
function versoToast(message, timeout = 4000) {
  const el = document.body.createDiv({ cls: 'verso-toast', text: message });
  el.style.position = 'fixed';
  el.style.top = '40%';
  el.style.left = '50%';
  el.style.transform = 'translate(-50%, -50%)';
  el.style.zIndex = '99999';
  el.style.background = 'var(--interactive-accent)';
  el.style.border = 'none';
  el.style.color = 'var(--text-on-accent)';
  el.style.padding = '12px 18px';
  el.style.borderRadius = '8px';
  el.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.3)';
  el.style.maxWidth = '320px';
  el.style.textAlign = 'center';
  el.style.transition = 'opacity 0.3s ease';
  window.setTimeout(() => {
    el.style.opacity = '0';
    window.setTimeout(() => el.remove(), 300);
  }, timeout);
  return el;
}

// ─── Scheduling Helpers ──────────────────────────────────────────────────────

function isDayEnabled(dayNumber, readingDays) {
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
// VersoEditScheduleModal (fallback when a book has no override yet).
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
    if (isDayEnabled(current.getDay(), readingDays)) count++;
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

// Single source of truth for "is this chunk missed?" — a chunk already marked
// 'missed' by recalculation, OR an 'upcoming' chunk whose scheduled date has
// passed but hasn't been recalculated yet. Used by status, progress, and the
// book view so they can never drift apart.
function isChunkMissed(chunk, today) {
  return chunk.status === 'missed' ||
    (chunk.status === 'upcoming' && chunk.scheduledDate < today);
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
function getBookStatus(book, chunks) {
  if (book.status === 'planned') return 'planned';
  if (book.status === 'complete') return 'complete';

  const today = versoToday();
  if (book.startDate && book.startDate > today) return 'not-started';

  const bookChunks = chunks.filter(c => c.bookId === book.id);

  const missedChunks = bookChunks.filter(c => isChunkMissed(c, today));

  if (missedChunks.length === 0) return 'on-track';

  // Pages scheduled to have been read by today (complete + missed chunks —
  // i.e. every chunk whose scheduledDate is today or earlier)
  const dueByToday = bookChunks
    .filter(c => c.status === 'complete' || isChunkMissed(c, today))
    .reduce((sum, c) => sum + (c.pagesEnd - c.pagesStart + 1), 0);

  const pagesRead = bookChunks
    .filter(c => c.status === 'complete')
    .reduce((sum, c) => sum + (c.pagesEnd - c.pagesStart + 1), 0);

  if (pagesRead >= dueByToday) return 'on-track';

  return missedChunks.length <= 2 ? 'behind' : 'at-risk';
}

// ── Shared status/date display helpers (used by both dashboard and book view) ──

function versoFormatDate(dateString) {
  if (!dateString) return '—';
  const date = new Date(dateString + 'T00:00:00');
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Like versoFormatDate, but includes the year — used for date ranges where
// the year isn't otherwise implied (e.g. the semester view's header).
function versoFormatDateLong(dateString) {
  if (!dateString) return '—';
  const date = new Date(dateString + 'T00:00:00');
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function versoBadgeLabelForStatus(status) {
  if (status === 'on-track') return 'On track';
  if (status === 'behind') return 'Behind';
  if (status === 'at-risk') return 'At risk';
  if (status === 'planned') return 'Planned';
  if (status === 'complete') return 'Completed';
  if (status === 'not-started') return 'Not started';
  return status;
}

function versoBadgeClassForStatus(status) {
  if (status === 'on-track') return 'verso-badge-on-track';
  if (status === 'behind') return 'verso-badge-behind-soft';
  if (status === 'at-risk') return 'verso-badge-behind';
  if (status === 'planned') return 'verso-badge-planned';
  if (status === 'complete') return 'verso-badge-complete';
  if (status === 'not-started') return 'verso-badge-not-started';
  return '';
}

function versoBarClassForStatus(status) {
  if (status === 'on-track') return 'verso-bar-on-track';
  if (status === 'behind') return 'verso-bar-behind';
  if (status === 'at-risk') return 'verso-bar-at-risk';
  if (status === 'planned') return 'verso-bar-planned';
  if (status === 'complete') return 'verso-bar-complete';
  if (status === 'not-started') return 'verso-bar-not-started';
  return '';
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
    if (isDayEnabled(current.getDay(), readingDays)) {
      dates.push(versoLocalDateString(current));
    }
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

// Build a default label for a chunk based on its page range
function buildChunkLabel(pagesStart, pagesEnd) {
  if (pagesStart === pagesEnd) return `p. ${pagesStart}`;
  return `pp. ${pagesStart}-${pagesEnd}`;
}

// Distribute a page range evenly across a list of dates.
// Returns an array of { scheduledDate, pagesStart, pagesEnd } objects.
// The last entry absorbs any remainder so every page is accounted for.
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

// Generate the full initial schedule for a newly added book.
// Returns an array of chunk data objects ready to pass to createChunk().
function generateSchedule(book, readingDays) {
  const dates = getReadingDateRange(book.startDate, book.targetFinishDate, readingDays);

  if (dates.length === 0) {
    // No valid reading days in range — single chunk on the start date
    return [{
      bookId: book.id,
      label: buildChunkLabel(1, book.totalPages),
      pagesStart: 1,
      pagesEnd: book.totalPages,
      scheduledDate: book.startDate,
      status: 'upcoming'
    }];
  }

  const distributed = distributePages(1, book.totalPages, dates);

  return distributed.map(d => ({
    bookId: book.id,
    label: buildChunkLabel(d.pagesStart, d.pagesEnd),
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
  if (book.startDate > today) {
    const dates = getReadingDateRange(book.startDate, book.targetFinishDate, readingDays);
    const distributed = distributePages(1, book.totalPages, dates);
    return distributed.map(d => ({
      id: generateId(),
      bookId: book.id,
      label: buildChunkLabel(d.pagesStart, d.pagesEnd),
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
  // by the early return above, so by this point book.startDate <= today.)
  const usedDates = new Set(completeChunks.map(c => c.scheduledDate));
  const remainingDates = getReadingDateRange(today, book.targetFinishDate, readingDays)
    .filter(date => !usedDates.has(date));

  // If somehow there are no remaining dates (e.g. overdue), fall back to just "today"
  const dates = remainingDates.length > 0 ? remainingDates : [today];

  // Redistribute remaining pages across remaining dates
  const firstPage = pagesRead + 1;
  const distributed = distributePages(firstPage, remainingPages, dates);

  const newUpcoming = distributed.map(d => ({
    id: generateId(),
    bookId: book.id,
    label: buildChunkLabel(d.pagesStart, d.pagesEnd),
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

class VersoPlugin extends Plugin {

  async onload() {
    console.log(`Verso v${this.manifest.version} loading...`);
    await this.loadSettings();

    // Catch up any missed reading days and redistribute schedules
    await this.recalculateAllBooks();

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
      id: 'verso-add-book',
      name: 'Add a book',
      callback: () => {
        new AddBookModal(this.app, this, () => this.refreshOpenDashboard()).open();
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
    const active = workspace.activeLeaf;
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

    const active = workspace.activeLeaf;
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

    const active = workspace.activeLeaf;
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
    this.settings.books.forEach(book => {
      if (!book.originalTargetFinishDate) {
        book.originalTargetFinishDate = book.targetFinishDate;
      }
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
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

  async deleteCollection(id) {
    const bookIds = this.settings.books.filter(b => b.collectionId === id).map(b => b.id);
    this.settings.collections = this.settings.collections.filter(c => c.id !== id);
    this.settings.books = this.settings.books.filter(b => b.collectionId !== id);
    this.settings.chunks = this.settings.chunks.filter(c => !bookIds.includes(c.bookId));
    await this.saveSettings();
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

  async deleteBook(id) {
    this.settings.books = this.settings.books.filter(b => b.id !== id);
    this.settings.chunks = this.settings.chunks.filter(c => c.bookId !== id);
    await this.saveSettings();
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
    return this.updateBook(id, {
      status: 'archived',
      statusBeforeArchive,
      archivedDate: new Date().toISOString(),
      archiveReason: reasonData.archiveReason || '',
      archiveReasonCategory: reasonData.archiveReasonCategory || null
    });
  }

  // Edit the reason on an already-archived book (does not touch archivedDate).
  async updateArchiveReason(id, reasonData = {}) {
    return this.updateBook(id, {
      archiveReason: reasonData.archiveReason || '',
      archiveReasonCategory: reasonData.archiveReasonCategory || null
    });
  }

  async restoreBook(id) {
    const book = this.getBook(id);
    const restoredStatus = (book && book.statusBeforeArchive) || 'active';
    return this.updateBook(id, {
      status: restoredStatus,
      statusBeforeArchive: null,
      archivedDate: null,
      archiveReason: '',
      archiveReasonCategory: null
    });
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
    return this.getBook(bookId);
  }

  // Update an active book's schedule: dates and/or reading days.
  //  - If the book's timeline hasn't begun yet (startDate is today or in the
  //    future), startDate, targetFinishDate, AND readingDaysOverride can all
  //    change — the schedule is fully rebuilt from scratch, same as initial
  //    activation.
  //  - Once startDate is in the past, the book's timeline has begun: startDate
  //    becomes immutable (it's a historical fact, and the existing schedule may
  //    carry "missed" chunks recording that history — rebuilding from scratch
  //    would erase them). targetFinishDate and readingDaysOverride can still
  //    change, and recalculateSchedule() redistributes the remaining pages
  //    forward (across the new reading days, if changed) while preserving
  //    complete/missed chunks.
  //  - readingDaysOverride is optional (undefined = leave unchanged) so
  //    callers that only touch dates don't need to pass it.
  // Returns the updated book, or null if the book doesn't exist.
  async updateBookDates(bookId, startDate, targetFinishDate, readingDaysOverride) {
    const book = this.getBook(bookId);
    if (!book) return null;

    const timelineStarted = book.startDate < versoToday();
    const dateUpdates = { targetFinishDate };
    if (readingDaysOverride !== undefined) dateUpdates.readingDaysOverride = readingDaysOverride;

    if (!timelineStarted) {
      dateUpdates.startDate = startDate;
      await this.updateBook(bookId, dateUpdates);
      await this.buildScheduleForBook(bookId);
    } else {
      await this.updateBook(bookId, dateUpdates);
      await this.recalculateBook(bookId);
    }

    return this.getBook(bookId);
  }

  // ── Scheduling ──────────────────────────────────────────────

  // Get the effective reading-days setting for a book (its override, or the global default)
  getReadingDaysFor(book) {
    return book.readingDaysOverride || this.settings.readingDays === 'custom'
      ? (book.readingDaysOverride || this.settings.customReadingDays)
      : this.settings.readingDays;
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
    const book = this.getBook(bookId);
    if (!book || book.status === 'complete' || book.status === 'planned') return;

    const existingChunks = this.getChunksForBook(bookId);
    const readingDays = this.getReadingDaysFor(book);
    const updatedChunks = recalculateSchedule(book, existingChunks, readingDays);

    // Replace this book's chunks with the recalculated set
    this.settings.chunks = this.settings.chunks.filter(c => c.bookId !== bookId);
    this.settings.chunks.push(...updatedChunks);

    await this.saveSettings();
    return updatedChunks;
  }

  // Recalculate every active book — run on plugin load
  async recalculateAllBooks() {
    const activeBooks = this.settings.books.filter(b =>
      b.status !== 'complete' && b.status !== 'archived' && b.status !== 'planned'
    );
    for (const book of activeBooks) {
      await this.recalculateBook(book.id);
    }
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
  getTodaysChunks() {
    const today = versoToday();
    const activeBookIds = new Set(
      this.settings.books.filter(b => b.status === 'active').map(b => b.id)
    );
    return this.settings.chunks.filter(c =>
      c.scheduledDate === today && c.status !== 'complete' && activeBookIds.has(c.bookId)
    );
  }

  // Like getTodaysChunks(), but includes chunks already marked complete today —
  // used by the dashboard so checked-off items stay visible.
  getAllTodaysChunks() {
    const today = versoToday();
    const activeBookIds = new Set(
      this.settings.books.filter(b => b.status === 'active').map(b => b.id)
    );
    return this.settings.chunks.filter(c => c.scheduledDate === today && activeBookIds.has(c.bookId));
  }

  // Tomorrow's scheduled chunks, for the sidebar's read-ahead preview.
  // Includes chunks already completed (a reader who read ahead into
  // tomorrow's pages today) — same inclusive shape as getAllTodaysChunks().
  getTomorrowsChunks() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = versoLocalDateString(tomorrow);
    const activeBookIds = new Set(
      this.settings.books.filter(b => b.status === 'active').map(b => b.id)
    );
    return this.settings.chunks.filter(c => c.scheduledDate === tomorrowStr && activeBookIds.has(c.bookId));
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
      chunk.label = buildChunkLabel(chunk.pagesStart, chunk.pagesEnd);
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

    return { chunk, bookJustCompleted };
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

    return chunk;
  }

  // Mark a book complete if all its pages have been read
  async checkBookCompletion(bookId) {
    const book = this.getBook(bookId);
    if (!book || book.status === 'complete') return false;

    const chunks = this.getChunksForBook(bookId);
    const completeChunks = chunks.filter(c => c.status === 'complete');
    const pagesRead = completeChunks.reduce((sum, c) => sum + (c.pagesEnd - c.pagesStart + 1), 0);

    if (pagesRead >= book.totalPages) {
      await this.updateBook(bookId, {
        status: 'complete',
        dateCompleted: new Date().toISOString()
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
    const today = versoToday();
    const missedChunks = chunks.filter(c => isChunkMissed(c, today));
    const pagesRead = completedChunks.reduce((sum, c) => sum + (c.pagesEnd - c.pagesStart + 1), 0);
    const missedPages = missedChunks.reduce((sum, c) => sum + (c.pagesEnd - c.pagesStart + 1), 0);
    const percentage = book.totalPages > 0 ? Math.round((pagesRead / book.totalPages) * 100) : 0;
    const readingDays = this.getReadingDaysFor(book);

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

    return {
      bookId,
      totalPages: book.totalPages,
      pagesRead,
      percentage,
      chunksTotal: chunks.length,
      chunksComplete: completedChunks.length,
      missedDaysCount: missedChunks.length,
      missedPages,
      status: getBookStatus(book, this.settings.chunks),
      nextDueDate,
      paceNeeded: calculatePaceNeeded(
        book.totalPages,
        pagesRead,
        book.targetFinishDate,
        readingDays
      )
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
// books exist yet. Weekly/Monthly/Semester views are future work.

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

    const collectionTerm = this.singularize(this.getCollectionTerm());

    wrap.createEl('h2', {
      text: `Ready to add your first ${collectionTerm}?`,
      cls: 'verso-empty-title'
    });

    wrap.createEl('p', {
      text: 'Add your books, set your deadlines, and Verso will map out exactly what to read each day. No more falling behind — just steady, satisfying progress.',
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

    const libraryLink = actions.createEl('a', { text: 'Library →', cls: 'verso-book-back-link' });
    libraryLink.addEventListener('click', (e) => {
      e.preventDefault();
      this.plugin.activateLibraryView();
    });
  }

  // Status priority for dashboard ordering: most-needs-attention first.
  // at-risk/behind float to the top regardless of due date — a quietly
  // at-risk book is more urgent information than a calmer one due sooner.
  // on-track sits above not-started: real progress outranks "hasn't begun."
  static STATUS_PRIORITY = { 'at-risk': 0, 'behind': 1, 'on-track': 2, 'not-started': 3 };

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

      chunksForBook.forEach(chunk => {
        const row = card.createDiv({ cls: 'verso-dashboard-card-chunk-row' });
        if (chunk.status === 'complete') row.addClass('verso-today-row-complete');

        const checkbox = row.createDiv({ cls: 'verso-today-checkbox' });
        if (chunk.status === 'complete') {
          checkbox.addClass('verso-today-checkbox-checked');
          checkbox.setText('✓');
        }

        const info = row.createDiv({ cls: 'verso-today-info' });
        info.createSpan({ text: `${book.title} — ${chunk.label}`, cls: 'verso-today-label' });

        const pages = chunk.pagesEnd - chunk.pagesStart + 1;
        const meta = row.createDiv({ cls: 'verso-today-meta' });
        meta.createSpan({ text: `${pages} page${pages === 1 ? '' : 's'}`, cls: 'verso-today-pages' });

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
            await this.plugin.unmarkChunkComplete(chunk.id);
            versoToast(`"${chunk.label}" marked as not done.`);
            this.refreshAfterChunkUpdate();
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

    // Pages today — pages still REMAINING to read today: today's incomplete
    // chunks belonging to active books only. Completed chunks drop out (so the
    // count ticks down as readings are checked off via refreshAfterChunkUpdate),
    // and non-active books (complete/planned/archived) never contribute — which
    // keeps this in lockstep with the book cards below.
    const today = versoToday();
    const activeIds = new Set(activeBooks.map(b => b.id));
    const todaysChunks = this.plugin.settings.chunks.filter(c =>
      c.scheduledDate === today &&
      activeIds.has(c.bookId) &&
      c.status !== 'complete'
    );
    const pagesToday = todaysChunks.reduce((sum, c) => sum + (c.pagesEnd - c.pagesStart + 1), 0);
    const booksToday = new Set(todaysChunks.map(c => c.bookId)).size;

    // On track — active books with zero missed chunks (status === 'on-track').
    // Books with a future startDate return 'not-started' from getBookStatus
    // before this check is even reached, so they're correctly excluded here
    // without any extra filtering.
    const onTrackCount = activeBooks.filter(b => {
      const status = getBookStatus(b, this.plugin.settings.chunks);
      return status === 'on-track';
    }).length;

    // Books finished this year
    const currentYear = new Date().getFullYear();
    const booksFinishedThisYear = books.filter(b => {
      if (b.status !== 'complete' || !b.dateCompleted) return false;
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

  // Same vocabulary helpers as AddBookModal — collection term + singularization
  getCollectionTerm() {
    const term = this.plugin.settings.collectionTerm;
    if (term === 'custom') {
      return this.plugin.settings.collectionTermCustom || 'collection';
    }
    return term;
  }

  singularize(term) {
    const map = {
      classes: 'class',
      projects: 'project',
      subjects: 'subject',
      lists: 'list',
      shelves: 'shelf'
    };
    return map[term] || term;
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

    sorted.forEach(chunk => {
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
      info.createDiv({ text: chunk.label, cls: 'verso-today-sidebar-label' });

      if (!interactive) return;

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
          await this.plugin.unmarkChunkComplete(chunk.id);
          versoToast(`"${chunk.label}" marked as not done.`);
          this.render();
          this.plugin.refreshOpenDashboard();
        }
      });
    });
  }
}
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
      }
    }
  }

  renderScheduleSummary(container, book, progress) {
    container.createDiv({ cls: 'verso-section-label verso-section-label-spaced', text: 'SCHEDULE' });

    const table = container.createDiv({ cls: 'verso-summary-table' });

    const collection = this.plugin.getCollection(book.collectionId);
    const collectionTerm = this.getCollectionTerm();
    this.addSummaryRow(table, this.capitalize(this.singularize(collectionTerm)), collection ? collection.name : '—');
    this.addSummaryRow(table, 'Start date', versoFormatDate(book.startDate));
    this.addSummaryRow(table, 'Finish by', versoFormatDate(book.targetFinishDate));
    this.addSummaryRow(table, 'Reading days', this.describeReadingDays(book));

    this.renderActions(container, book);
  }

  renderArchiveSummary(container, book) {
    container.createDiv({ cls: 'verso-section-label verso-section-label-spaced', text: 'ARCHIVE' });

    const table = container.createDiv({ cls: 'verso-summary-table' });

    const collection = this.plugin.getCollection(book.collectionId);
    const collectionTerm = this.getCollectionTerm();
    this.addSummaryRow(table, this.capitalize(this.singularize(collectionTerm)), collection ? collection.name : '—');

    const archivedOn = book.archivedDate
      ? new Date(book.archivedDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
    this.addSummaryRow(table, 'Archived', archivedOn);
    this.addSummaryRow(table, 'Reason', book.archiveReason || 'No reason given');

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
    restoreBtn.addEventListener('click', async () => {
      await this.plugin.restoreBook(book.id);
      await this.plugin.recalculateBook(book.id);
      new Notice(`"${book.title}" restored.`);
      this.render();
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

    if (book.status === 'active') {
      const editScheduleBtn = actions.createEl('button', {
        text: 'Edit schedule',
        cls: 'verso-btn verso-btn-secondary'
      });
      editScheduleBtn.addEventListener('click', () => {
        new VersoEditScheduleModal(this.app, this.plugin, book, () => {
          this.render();
        }).open();
      });
    }

    const archiveBtn = actions.createEl('button', {
      text: 'Archive this book',
      cls: 'verso-btn verso-btn-secondary'
    });
    archiveBtn.addEventListener('click', () => {
      this.confirmArchive(book);
    });
  }

  confirmArchive(book) {
    new VersoArchiveModal(this.app, this.plugin, book, 'archive', () => {
      this.render();
    }).open();
  }

  addSummaryRow(table, label, value) {
    const row = table.createDiv({ cls: 'verso-summary-row' });
    row.createEl('span', { text: label, cls: 'verso-summary-label' });
    row.createEl('span', { text: value, cls: 'verso-summary-value' });
  }

  describeReadingDays(book) {
    const days = this.plugin.getReadingDaysFor(book);
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

  capitalize(str) {
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  getCollectionTerm() {
    const term = this.plugin.settings.collectionTerm;
    if (term === 'custom') {
      return this.plugin.settings.collectionTermCustom || 'collection';
    }
    return term;
  }

  singularize(term) {
    const map = {
      classes: 'class',
      projects: 'project',
      subjects: 'subject',
      lists: 'list',
      shelves: 'shelf'
    };
    return map[term] || term;
  }
}


// ─── Library View ────────────────────────────────────────────────────────────
//
// The book's permanent home — separate from the Dashboard's "what's due
// today" focus. Three tabs:
//   Planned   — books with no active schedule yet, waiting their turn
//   Completed — books that have finished a reading assignment
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
      const row = list.createDiv({ cls: 'verso-library-row' });

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
      const activateBtn = actions.createEl('button', {
        text: 'Start reading',
        cls: 'verso-btn verso-btn-primary'
      });
      activateBtn.addEventListener('click', () => {
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
      restoreBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.plugin.restoreBook(book.id);
        await this.plugin.recalculateBook(book.id);
        new Notice(`"${book.title}" restored.`);
        this.render();
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

  isValid() {
    return !!this.startDate && !!this.targetFinishDate && this.targetFinishDate >= this.startDate;
  }

  updateConfirmButtonState() {
    if (!this.confirmBtn) return;
    const valid = this.isValid();
    this.confirmBtn.disabled = !valid;
    this.confirmBtn.toggleClass('verso-btn-disabled', !valid);
  }

  onClose() {
    this.contentEl.empty();
  }
}


// ─── Edit Schedule Modal ────────────────────────────────────────────────────
//
// For an active book, lets the reader adjust its schedule: dates AND reading
// days. Reading days had no edit path before this — the override set at
// creation time (see AddBookModal) was permanent. This modal closes that gap.
//  - No progress yet: startDate, targetFinishDate, AND reading days are all
//    editable — this fully rebuilds the schedule (same as initial activation).
//  - Progress exists: startDate is locked (a completed-chunk history can't
//    sit "before" the book started), but targetFinishDate and reading days
//    remain editable — recalculateSchedule() redistributes the remaining
//    pages forward across whichever days are now selected.

class VersoEditScheduleModal extends Modal {
  constructor(app, plugin, book, onUpdated) {
    super(app);
    this.plugin = plugin;
    this.book = book;
    this.onUpdated = onUpdated || null;

    this.timelineStarted = book.startDate < versoToday();

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
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('verso-activate-modal');

    contentEl.createEl('h3', { text: `Edit schedule for "${this.book.title}"` });
    contentEl.createEl('p', {
      text: this.timelineStarted
        ? "Verso will redistribute your remaining pages across the new dates and reading days."
        : "Verso will rebuild your daily reading schedule using these dates and reading days.",
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

    // ── Collection picker ────────────────────────────────────────
    // Shelf reassignment is metadata-only — changing a book's collection
    // does not affect its schedule in any way. A "— No shelf —" option is
    // always present so a book can stay (or be moved) outside any collection
    // without silently force-assigning it when the modal opens.
    const collectionTerm = this.getCollectionTerm();
    const singularTerm = this.singularize(collectionTerm);
    const collections = this.plugin.settings.collections;

    const collField = form.createDiv({ cls: 'verso-field' });
    collField.createEl('label', {
      text: this.capitalize(singularTerm),
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
      attr: { placeholder: `e.g. ${this.exampleCollectionName(collectionTerm)}` }
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

    // ── Buttons ──────────────────────────────────────────────────
    const buttons = contentEl.createDiv({ cls: 'verso-confirm-buttons' });

    const cancelBtn = buttons.createEl('button', { text: 'Cancel', cls: 'verso-btn verso-btn-text' });
    cancelBtn.addEventListener('click', () => this.close());

    this.confirmBtn = buttons.createEl('button', { text: 'Save changes', cls: 'verso-btn verso-btn-primary' });
    this.confirmBtn.addEventListener('click', async () => {
      if (!this.isValid()) return;

      if (this.targetFinishDate === versoToday()) {
        const progress = this.plugin.getBookProgress(this.book.id);
        const remainingPages = progress ? progress.totalPages - progress.pagesRead : this.book.totalPages;
        const pageWord = remainingPages === 1 ? 'page' : 'pages';
        this.close();
        new VersoConfirmModal(
          this.app,
          'Finish today?',
          `This will compress your remaining ${remainingPages} ${pageWord} into a single chunk due today. Are you sure?`,
          'Save changes',
          async () => {
            await this.saveSchedule();
          }
        ).open();
        return;
      }

      this.close();
      await this.saveSchedule();
    });

    this.updateConfirmButtonState();
  }

  async saveSchedule() {
    const readingDaysOverride = this.overrideReadingDays
      ? { ...this.customReadingDays }
      : null;

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
    if (oldCollectionId !== newCollectionId) {
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

    await this.plugin.updateBookDates(this.book.id, this.startDate, this.targetFinishDate, readingDaysOverride);
    new Notice(`Schedule updated for "${this.book.title}".`);
    if (this.onUpdated) this.onUpdated();
  }

  isValid() {
    return !this.validationError();
  }

  // Returns a user-facing message if the current dates are invalid, or null
  // if they're fine. Checked in priority order: missing fields first, then
  // the relative ordering of the dates, then the "not in the past" guard —
  // a finish date can't be earlier than the start date OR earlier than today.
  validationError() {
    if (this.isCreatingNewCollection && !this.newCollectionName.trim()) {
      return `Enter a name for the new ${this.singularize(this.getCollectionTerm())}.`;
    }
    if (!this.startDate || !this.targetFinishDate) return null;
    if (this.targetFinishDate < this.startDate) {
      return 'Finish date must be on or after the start date.';
    }
    if (this.targetFinishDate < versoToday()) {
      return "Finish date can't be in the past.";
    }
    return null;
  }

  updateConfirmButtonState() {
    if (!this.confirmBtn) return;
    const error = this.validationError();
    const valid = !error;
    this.confirmBtn.disabled = !valid;
    this.confirmBtn.toggleClass('verso-btn-disabled', !valid);
    if (this.finishErrorEl) {
      this.finishErrorEl.setText(error || '');
    }
  }

  onClose() {
    this.contentEl.empty();
  }

  getCollectionTerm() {
    const term = this.plugin.settings.collectionTerm;
    if (term === 'custom') {
      return this.plugin.settings.collectionTermCustom || 'collection';
    }
    return term;
  }

  capitalize(str) {
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  singularize(term) {
    const map = {
      classes: 'class',
      projects: 'project',
      subjects: 'subject',
      lists: 'list',
      shelves: 'shelf'
    };
    return map[term] || term;
  }

  exampleCollectionName(term) {
    const examples = {
      classes: 'OT Survey',
      projects: 'Summer reading',
      subjects: 'Bible',
      lists: 'To read',
      shelves: 'Currently reading'
    };
    return examples[term] || 'New collection';
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
  constructor(app, plugin, chunk, book, onConfirm) {
    super(app);
    this.plugin = plugin;
    this.chunk = chunk;
    this.book = book;
    this.onConfirm = onConfirm || null;

    this.scheduledEnd = chunk.pagesEnd;
    this.actualEnd = chunk.pagesEnd; // pre-fill with the plan
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('verso-pages-read-modal');

    contentEl.createEl('h3', { text: 'Pages read' });

    const desc = contentEl.createEl('p', { cls: 'verso-confirm-body' });
    desc.createSpan({ text: "Today's reading: " });
    desc.createEl('strong', { text: buildChunkLabel(this.chunk.pagesStart, this.chunk.pagesEnd) });
    desc.createSpan({ text: this.book && this.book.title ? ` of ${this.book.title}.` : '.' });

    const form = contentEl.createDiv({ cls: 'verso-form' });

    const field = form.createDiv({ cls: 'verso-field' });
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

    const buttons = contentEl.createDiv({ cls: 'verso-confirm-buttons' });

    const cancelBtn = buttons.createEl('button', { text: 'Cancel', cls: 'verso-btn verso-btn-text' });
    cancelBtn.addEventListener('click', () => this.close());

    this.confirmBtn = buttons.createEl('button', { text: 'Mark read', cls: 'verso-btn verso-btn-primary' });
    this.confirmBtn.addEventListener('click', async () => {
      if (!this.isValid()) return;
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

    // Focus + select so an override is just "type the number"
    window.setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  isValid() {
    const v = this.actualEnd;
    if (v === null || Number.isNaN(v)) return false;
    if (v < this.chunk.pagesStart) return false;
    if (v > this.book.totalPages) return false;
    return true;
  }

  updateConfirmButtonState() {
    if (!this.confirmBtn) return;
    const valid = this.isValid();
    this.confirmBtn.disabled = !valid;
    this.confirmBtn.toggleClass('verso-btn-disabled', !valid);
  }

  // Branch the post-confirm toast on where they actually landed.
  // "Caught up" gets folded into this same decision point (rather than a
  // separate check at each call site) so it never races against the ahead/
  // behind/exact-match branches below — exactly one toast fires per
  // completion, never two stacked back to back.
  fireMessage(actualEnd) {
    const scheduled = this.scheduledEnd;
    const stillToday = this.plugin.getAllTodaysChunks();
    const allDoneToday = stillToday.length > 0 && stillToday.every(c => c.status === 'complete');

    if (actualEnd < scheduled) {
      const behind = scheduled - actualEnd;
      versoToast(`No worries — we'll spread the remaining ${behind} page${behind === 1 ? '' : 's'} across your upcoming reading days.`);
    } else if (actualEnd > scheduled) {
      const ahead = actualEnd - scheduled;
      versoToast(`You read ${ahead} page${ahead === 1 ? '' : 's'} ahead. Nice!`);
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

    // ── Voice copy ──────────────────────────────────────────────
    contentEl.createDiv({ text: 'You read the whole thing.', cls: 'verso-complete-headline' });
    contentEl.createDiv({
      text: `${book.totalPages} pages. That's not nothing.`,
      cls: 'verso-complete-subtext'
    });

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
      .filter(b => b.status === 'complete' && b.dateCompleted)
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

    // ── Footer ────────────────────────────────────────────────
    const footer = contentEl.createDiv({ cls: 'verso-modal-footer' });
    const leftGroup = footer.createDiv({ cls: 'verso-footer-left' });
    const rightGroup = footer.createDiv({ cls: 'verso-footer-right' });

    const closeButton = leftGroup.createEl('button', { text: 'Close', cls: 'verso-btn verso-btn-text' });
    closeButton.addEventListener('click', () => this.close());

    const addButton = rightGroup.createEl('button', { text: '+ Add your next book', cls: 'verso-btn verso-btn-primary' });
    addButton.addEventListener('click', () => {
      this.close();
      new AddBookModal(this.app, this.plugin, () => this.plugin.refreshOpenDashboard()).open();
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
      customReadingDays: this.getGlobalReadingDaysAsObject()
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


  renderScheduleStep(body) {
    body.createDiv({ cls: 'verso-section-label', text: 'SCHEDULE DETAILS' });

    const form = body.createDiv({ cls: 'verso-form' });
    const collectionTerm = this.getCollectionTerm();

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
      text: this.capitalize(collectionTerm),
      cls: 'verso-field-label'
    });

    const collectionSelect = collectionField.createEl('select', { cls: 'verso-input' });
    const collections = this.plugin.settings.collections;

    collections.forEach(c => {
      const opt = collectionSelect.createEl('option', { text: c.name, value: c.id });
      if (this.formData.collectionId === c.id) opt.selected = true;
    });

    const newOpt = collectionSelect.createEl('option', {
      text: `+ New ${this.singularize(collectionTerm)}`,
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
      text: `New ${this.singularize(collectionTerm)} name`,
      cls: 'verso-field-label'
    });
    const newCollectionInput = newCollectionField.createEl('input', {
      type: 'text',
      cls: 'verso-input',
      attr: { placeholder: `e.g. ${this.exampleCollectionName(collectionTerm)}` }
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

  getCollectionTerm() {
    const term = this.plugin.settings.collectionTerm;
    if (term === 'custom') {
      return this.plugin.settings.collectionTermCustom || 'collection';
    }
    return term;
  }

  capitalize(str) {
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  // Crude singularization for the built-in terms (all plural words/lists)
  singularize(term) {
    const map = {
      classes: 'class',
      projects: 'project',
      subjects: 'subject',
      lists: 'list',
      shelves: 'shelf'
    };
    return map[term] || term;
  }

  exampleCollectionName(term) {
    const examples = {
      classes: 'OT Survey',
      projects: 'Summer reading',
      subjects: 'Bible',
      lists: 'To read',
      shelves: 'Currently reading'
    };
    return examples[term] || 'New collection';
  }


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

    const collectionTerm = this.getCollectionTerm();
    const collectionName = this.formData.collectionId
      ? (this.plugin.settings.collections.find(c => c.id === this.formData.collectionId)?.name || '—')
      : this.formData.newCollectionName;

    this.addSummaryRow(summaryTable, this.capitalize(this.singularize(collectionTerm)), collectionName);
    if (this.formData.targetFinishDate) {
      this.addSummaryRow(summaryTable, 'Due date', this.formatDate(this.formData.targetFinishDate));
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

    const collectionTerm = this.getCollectionTerm();
    const collectionName = this.formData.collectionId
      ? (this.plugin.settings.collections.find(c => c.id === this.formData.collectionId)?.name || '—')
      : this.formData.newCollectionName;

    this.addSummaryRow(summaryTable, this.capitalize(this.singularize(collectionTerm)), collectionName);
    this.addSummaryRow(summaryTable, 'Start date', this.formatDate(this.formData.startDate));
    this.addSummaryRow(summaryTable, 'Finish by', this.formatDate(this.formData.targetFinishDate));
    this.addSummaryRow(summaryTable, 'Reading days', this.describeReadingDays());
    this.addSummaryRow(summaryTable, 'Total reading days', String(preview.readingDayCount));

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
      targetFinishDate: this.formData.targetFinishDate
    };

    const readingDays = this.formData.overrideReadingDays
      ? this.formData.customReadingDays
      : this.plugin.settings.readingDays === 'custom'
        ? this.plugin.settings.customReadingDays
        : this.plugin.settings.readingDays;

    const chunks = generateSchedule(tempBook, readingDays);
    const readingDayCount = countReadingDays(
      this.formData.startDate,
      this.formData.targetFinishDate,
      readingDays
    );

    return { chunks, readingDayCount, readingDays };
  }

  addSummaryRow(table, label, value) {
    const row = table.createDiv({ cls: 'verso-summary-row' });
    row.createEl('span', { text: label, cls: 'verso-summary-label' });
    row.createEl('span', { text: value, cls: 'verso-summary-value' });
  }

  renderChunkPreviewCard(body, headerText, chunk) {
    const card = body.createDiv({ cls: 'verso-chunk-preview-card' });
    card.createDiv({ cls: 'verso-chunk-preview-header', text: `${headerText} — ${this.formatDate(chunk.scheduledDate)}` });
    card.createDiv({ cls: 'verso-chunk-preview-label', text: chunk.label });
  }

  formatDate(dateString) {
    if (!dateString) return '—';
    const date = new Date(dateString + 'T00:00:00');
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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
      addAnotherBtn.addEventListener('click', async () => {
        await this.saveBook();
        new Notice(`"${this.formData.title}" added.`);
        if (this.onSave) this.onSave();
        this.resetForm();
        this.goToStep(0);
      });

      const confirmBtn = rightGroup.createEl('button', {
        text: 'Confirm and go to dashboard',
        cls: 'verso-btn verso-btn-primary'
      });
      confirmBtn.addEventListener('click', async () => {
        await this.saveBook();
        new Notice(`"${this.formData.title}" added.`);
        if (this.onSave) this.onSave();
        this.close();
        await this.plugin.activateDashboardView();
      });
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
        status: 'planned'
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
      readingDaysOverride: readingDaysOverride
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
      customReadingDays: this.getGlobalReadingDaysAsObject()
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

        const hasDates = this.formData.startDate && this.formData.targetFinishDate;
        const datesValid = hasDates &&
          this.formData.targetFinishDate >= this.formData.startDate;
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
            message = `Choose a ${this.singularize(this.getCollectionTerm())} to continue`;
          } else {
            const hasReadingDay = !this.formData.overrideReadingDays ||
              Object.values(this.formData.customReadingDays).some(v => v === true);
            if (!hasReadingDay) {
              message = 'Select at least one reading day to continue';
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
      new Setting(containerEl)
        .setName('Custom term')
        .setDesc('Singular form — e.g. "Course", "Module", "Track"')
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
            })
          );
      });
    }

    // ─── About ─────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'About' });
    containerEl.createEl('p', {
      text: `Verso v${this.plugin.manifest.version} — Your reading life, scheduled.`,
      cls: 'verso-settings-desc'
    });
  }
}

module.exports = VersoPlugin;
