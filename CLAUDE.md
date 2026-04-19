# Card Capture App — Claude Build Instructions

## Context & Background

This is a PWA (Progressive Web App) business card scanner and CRM tool.
All design decisions are **locked** — do not redesign. Build exactly to this spec.

This was designed in a prior Claude Code session. A fresh Claude instance should
read this file and implement the full v1 build as specified.

---

## What This App Does

1. **Capture** — use iPhone camera or photo library to photograph business cards
2. **Detect** — automatically detect multiple cards in a single photo (OpenCV.js)
3. **OCR** — extract contact fields from each detected card (Tesseract.js)
4. **Confirm** — user reviews extracted fields, corrects errors, adds context
5. **Store** — save contacts to IndexedDB (persistent, offline)
6. **Export** — export as CSV / vCard / JSON for use in other tools

---

## Locked Decisions — Do Not Change

| Decision | Value |
|---|---|
| App type | PWA (installable via Safari "Add to Home Screen") |
| Framework | Vanilla JS (ES modules), no React/Vue/Angular |
| Build tool | None — plain files, deployable directly to GitHub Pages |
| Hosting | GitHub Pages at https://curioushy.github.io/card-capture-app/ |
| Offline | Service Worker caches app shell + OpenCV + Tesseract models |
| OCR | Tesseract.js (client-side, CDN), languages: eng + chi_sim |
| Card detection | OpenCV.js (client-side, CDN) |
| Primary storage | IndexedDB (browser, persistent) |
| Cloud sync | NOT in v1 — deferred to v2 |
| Export formats | JSON (backup), CSV (Workflow 2 input), vCard (.vcf) |
| Import formats | JSON restore, CSV, vCard |
| Two-sided cards | Per-card "Add back side" button in Confirm screen |
| Multi-card | Multiple cards detected in single photo via OpenCV |
| Session context | Event name + date set per session; optional per-card: tier, intro'd by, next action |
| Tier system | T1 (active), T2 (priority), T3 (orbit), T4 (archive/default) |
| Conflict handling | Not applicable in v1 (no cloud sync) |
| Languages | English + Simplified Chinese |

---

## v1 Build Scope (10 Blocks)

Build these blocks. Do NOT build Drive sync, dedicated Sessions list, or Send-to-Work-Email.

```
Block 1  — App Shell & PWA Infrastructure
Block 2  — Image Input
Block 3  — Card Detection (OpenCV.js)
Block 4  — OCR + Field Parsing (Tesseract.js)
Block 5  — Confirm + Enrich UI
Block 6  — Session Management
Block 7a — Local Store (IndexedDB)
Block 8  — Contacts List & Detail
Block 10 — Data Management (Export / Import / Clear)
Block 11 — Settings
```

Deferred to v2 (do not implement):
- Block 7b — Google Drive Sync
- Block 9 — Dedicated Sessions List
- Block 12 — Send to Work Email

---

## File Structure

Create exactly this structure under `app/`:

```
card-capture-app/
├── CLAUDE.md               ← this file
├── TRANSFER.md             ← setup instructions
├── .gitignore
└── app/
    ├── index.html          ← app shell, single page
    ├── manifest.json       ← PWA manifest
    ├── service-worker.js   ← offline cache
    ├── css/
    │   ├── app.css         ← global styles, variables, layout
    │   ├── capture.css     ← capture / detection screens
    │   └── components.css  ← reusable UI components
    ├── js/
    │   ├── app.js          ← entry point, router, nav
    │   ├── db.js           ← IndexedDB wrapper (all DB operations)
    │   ├── ocr.js          ← Tesseract.js wrapper
    │   ├── detect.js       ← OpenCV card detection + dewarp
    │   ├── export.js       ← CSV / vCard / JSON export
    │   ├── import.js       ← JSON / CSV / vCard import
    │   └── screens/
    │       ├── home.js           ← home screen
    │       ├── new-session.js    ← new session form
    │       ├── capture.js        ← camera + photo queue
    │       ├── detection.js      ← boundary confirmation UI
    │       ├── confirm.js        ← per-card confirm + enrich
    │       ├── contacts.js       ← contacts list
    │       ├── contact-detail.js ← single contact view/edit
    │       └── settings.js       ← settings + data management
    └── assets/
        ├── icon-192.png    ← PWA icon (192x192, generate a simple one)
        └── icon-512.png    ← PWA icon (512x512)
```

---

## Data Model

All IndexedDB operations live in `db.js`. Three object stores:

### sessions
```js
{
  id: string,           // uuid v4
  event_name: string,
  date: string,         // YYYY-MM-DD
  created_at: number,   // Date.now()
  updated_at: number
}
```

### contacts
```js
{
  id: string,           // uuid v4
  session_id: string,   // → sessions.id
  name: string,
  title: string,
  company: string,
  emails: string[],     // array (card may have multiple)
  phones: string[],     // array
  linkedin: string,
  website: string,
  tier: number|null,    // 1, 2, 3, or null (null = T4/archive)
  intro_by: string,
  next_action: string,
  next_action_date: string,   // YYYY-MM-DD or empty
  ocr_raw_front: string,      // raw OCR text from front side
  ocr_raw_back: string,       // raw OCR text from back side (may be empty)
  card_image_front: string,   // base64 JPEG compressed to ~50KB
  card_image_back: string,    // base64 JPEG compressed to ~50KB (may be empty)
  created_at: number,
  updated_at: number,
  _deleted: boolean           // soft delete flag
}
```

### meta
```js
{
  key: string,          // single record keyed 'app'
  schema_version: number,
  app_version: string,
  device_id: string,    // random uuid, generated once
  last_export_at: number
}
```

### IndexedDB setup
- Database name: `card-capture-db`
- Current schema version: `1`
- Indexes on contacts: `session_id`, `company`, `tier`, `created_at`, `_deleted`

---

## Block-by-Block Spec

### Block 1 — App Shell & PWA

**index.html:**
- Single-page app. All screens are `<div class="screen">` elements shown/hidden by router.
- Load OpenCV.js and Tesseract.js from CDN (lazy — only when capture starts).
- Register Service Worker.
- Bottom nav: Home | Capture | Contacts | Settings
- Top bar: app title "Card Capture" + sync status dot + settings icon
- Floating status bar for OCR/sync progress (hidden by default)

**manifest.json:**
```json
{
  "name": "Card Capture",
  "short_name": "CardCap",
  "start_url": "/card-capture-app/",
  "display": "standalone",
  "background_color": "#f5f5f5",
  "theme_color": "#1d6f42",
  "icons": [
    { "src": "assets/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "assets/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

**service-worker.js:**
- Cache name: `card-capture-v1`
- Cache on install: all app shell files (index.html, CSS, JS files)
- DO NOT cache OpenCV.js or Tesseract.js from CDN — they use their own caching
- Strategy: cache-first for app shell, network-first for CDN assets
- On activate: delete old caches

**Sync status dot (top bar):**
- Green: all data saved locally
- Yellow: unsaved changes (edit in progress)
- Grey: offline indicator
- (No Drive sync in v1 — just local save status)

### Block 2 — Image Input

**screen: capture.js**

Two tabs: Camera | Library

Camera tab:
- `<input type="file" accept="image/*" capture="environment">` — triggers native camera on iOS
- Large "Take Photo" button
- Show small preview thumbnail after capture
- User can take multiple photos; each adds to queue

Library tab:
- `<input type="file" accept="image/*" multiple>` — opens photo library
- Support selecting multiple images at once

Queue display:
- Horizontal strip of thumbnails at bottom
- Tap thumbnail to remove
- Count badge: "3 photos"
- [Process All N Photos →] button — only active when queue > 0
- Show loading indicator while processing

Session context banner:
- Shows current session name + date at top
- If no active session, prompt to start one first

### Block 3 — Card Detection

**detect.js** — OpenCV.js pipeline

Function: `detectCards(imageElement) → [{ corners: [4 points], cropCanvas: HTMLCanvasElement }]`

Pipeline per image:
1. Draw image to canvas
2. Convert to grayscale
3. Apply Gaussian blur (reduce noise)
4. Canny edge detection
5. Find contours
6. Filter contours: minimum area (5% of image), 4-corner approximation (cards are rectangles)
7. Sort by area descending
8. For each valid contour: perspective transform → dewarped card image
9. Return array of { corners, cropCanvas }

**detection.js** — UI for confirming detected cards

Screen shows:
- Full photo with colored overlays on each detected card
- Each card numbered (1, 2, 3…)
- Each card has accept/reject toggle (accepted = green border, rejected = red)
- "Add manually" button: user draws a rectangle by drag
- [Confirm N cards →] button

Card detail panel (tap a card to expand):
- Zoomed crop preview
- Accept / Reject buttons

If 0 cards detected: show "No cards detected — draw manually" with drawing tool.

**Manual crop tool:**
- Touch/drag to draw bounding rectangle on photo
- Shows draggable corner handles for adjustment
- Confirm adds it to the detected list

### Block 4 — OCR + Field Parsing

**ocr.js** — Tesseract.js wrapper

CDN: `https://unpkg.com/tesseract.js@5/dist/tesseract.min.js`

Languages: `eng+chi_sim`

Function: `runOCR(canvas) → { text: string, words: [{text, bbox, conf}] }`

- Initialize worker once, reuse for all cards in session
- Show progress: "Recognising card N of M…"
- Terminate worker when session ends (free memory)

**Field parser** — extract structured fields from raw OCR text

Rules (apply in order, return first match):

```
email:   regex /[\w.+-]+@[\w-]+\.[a-z]{2,}/gi
phone:   regex /(\+?[\d\s\-().]{8,20})/g — filter noise (too short/long)
website: regex /(https?:\/\/)?[\w.-]+\.(com|co|io|net|org|hk|sg|cn|com\.cn|com\.hk)[\/\w.-]*/gi
linkedin: regex /linkedin\.com\/in\/[\w-]+/gi

name:    heuristics —
         - Not an email, phone, website
         - 2–4 words
         - Title-case or ALL CAPS
         - Typically first non-empty line OR largest font (use word bbox height as proxy)
         - CJK: 2–4 characters common for names

title:   heuristics —
         - Line containing keywords: Director, Manager, VP, CEO, Founder, Partner,
           Head, Senior, Associate, Analyst, Officer, President, 总监, 经理, 总裁
         - Or line after name

company: heuristics —
         - Line containing: Ltd, LLC, Pte, Inc, Corp, Group, Capital, Fund, Partners,
           有限公司, 集团, 基金
         - Or last substantive line
```

Output per card:
```js
{
  name: string,
  title: string,
  company: string,
  emails: string[],
  phones: string[],
  linkedin: string,
  website: string,
  raw_text: string
}
```

Parser accuracy is moderate — the Confirm step (Block 5) handles errors.

### Block 5 — Confirm + Enrich UI

**confirm.js**

After OCR: show swipeable card stack — one card per screen, N total.

Layout per card:
```
┌────────────────────────────┐
│ [card front image]         │
│ [+ Add back side]          │  ← button to add back image
├────────────────────────────┤
│ Card 3 of 8       ● ● ● ●  │  ← progress dots
├────────────────────────────┤
│ Name     [John Smith     ] │
│ Title    [VP Credit      ] │
│ Company  [Acme Capital   ] │
│ Email    [j@acme.com     ] │
│ Phone    [+65 9123 4567  ] │
│ LinkedIn [               ] │
│ Website  [               ] │
├────────────────────────────┤
│ ▸ Add context             │  ← collapsible
│   Tier: [T1][T2][T3][T4]  │
│   Intro'd by: [         ] │
│   Next action: [        ] │
│   By date: [           ]  │
├────────────────────────────┤
│ [Skip]      [Save & Next →]│
└────────────────────────────┘
```

**"Add back side" flow:**
- Tap → camera/library picker opens
- User captures/selects back of same card
- OCR runs on back image
- Parser results merged with front (append new fields, don't overwrite existing)
- Back image stored as `card_image_back`
- Button changes to "✓ Back added — [view]"

**Navigation:**
- Swipe left = Skip
- Swipe right = Save & Next
- Progress dots at top

**Session context banner** (readonly, set in Block 6):
- "Milken 2026 · 17 Apr 2026"

**On last card → [Done]:**
- Save all contacts to IndexedDB
- Navigate to Session Summary screen (inside confirm.js)

**Session Summary:**
- "N contacts saved"
- List: name + company + tier chip
- [+ Add more photos] → back to Capture
- [Close session] → Home, sync status updates

### Block 6 — Session Management

**new-session.js**

Fields:
- Event name (text input + datalist of recent events from IndexedDB)
- Date (date picker, default today)
- [Start capturing →] button

Session state:
- A "current session" is held in memory (`app.currentSession`)
- If app is closed mid-session, resume on reopen (check IndexedDB for incomplete sessions)
- Session is "open" until user taps [Close session]
- Multiple sessions can exist; only one active at a time

Recent events: query last 10 distinct event_name values from sessions table, populate datalist.

### Block 7a — Local Store (IndexedDB)

**db.js** — all database operations

Expose these functions (use async/await throughout):

```js
// Init
db.init()                          // open DB, run migrations

// Sessions
db.createSession(data)             // → session object
db.getSession(id)
db.listSessions()                  // → array, newest first
db.updateSession(id, changes)
db.deleteSession(id)               // also deletes contacts

// Contacts
db.createContact(data)             // → contact object
db.getContact(id)
db.listContacts(filters)           // filters: { session_id, tier, search, deleted }
db.updateContact(id, changes)      // auto-sets updated_at
db.softDeleteContact(id)           // sets _deleted = true
db.purgeDeleted()                  // hard delete all _deleted records

// Meta
db.getMeta()
db.setMeta(changes)

// Export helpers
db.exportAll()                     // → { sessions, contacts, meta } object
db.importAll(data, mode)           // mode: 'replace' | 'merge'
db.clearAll()                      // wipe entire DB
```

**Schema migrations:**
- `onupgradeneeded` handles version bumps
- Before any migration: call `db.exportAll()`, trigger JSON download as backup
- Log migration in console: `[DB] Migrated from v1 to v2`

**Image compression:**
- Before storing card images: compress to JPEG quality 0.7, max dimension 800px
- Use canvas to resize: `const compressed = compressImage(blob, 800, 0.7)`
- Target ~50KB per image

### Block 8 — Contacts List & Detail

**contacts.js — Contacts List**

Layout:
- Search bar (searches name, company, email, event)
- Filter chips: All | T1 | T2 | T3 | T4 | [Event name ▼]
- Sorted: newest first (default), or alphabetical
- Each row: avatar initial circle + name + company + tier chip + event name small
- Tap → Contact Detail
- Swipe left on row → Delete (with confirmation)
- Empty state: "No contacts yet. Start a capture session."

**contact-detail.js — Contact Detail**

Layout:
- Back arrow
- Card front image thumbnail (tap to expand full screen)
- If back image exists: [Show back] toggle
- All fields inline-editable (tap to edit, blur to save)
- Session context: event name + date + tier
- History: "Captured Apr 17 2026 · Milken 2026"
- Actions: [Delete] [Export as vCard]
- Auto-saves on field blur → sets updated_at

Two-field editing:
- Emails: multiple email chips, tap + to add, tap x to remove
- Phones: same pattern

### Block 10 — Data Management

**Inside settings.js — Data Management section**

#### Export

Options (show as modal with checkboxes):

Scope:
- All contacts
- This session only
- By tier (T1 / T2 / T3 / T4 chips)

Format:
- **JSON** (full backup — includes images as base64)
- **CSV** (no images, flat structure — used for Workflow 2)
- **vCard** (standard .vcf, for importing to Contacts app)

CSV column order:
```
name,title,company,email,phone,linkedin,website,tier,intro_by,next_action,next_action_date,event,date_met,session_id,contact_id
```
(multiple emails/phones: pipe-separated within field)

vCard format: standard VCF 3.0 per contact.

JSON format:
```json
{
  "schema_version": 1,
  "app_version": "1.0.0",
  "exported_at": "2026-04-17T08:00:00Z",
  "device_id": "...",
  "sessions": [...],
  "contacts": [...]
}
```

File naming: `card-capture-export-YYYY-MM-DD.{json|csv|vcf}`

#### Import

Accept: `.json`, `.csv`, `.vcf` files

JSON import:
- Check schema_version for compatibility
- Show preview: "This backup contains N contacts from N sessions"
- Two modes:
  - **Merge** (default): append sessions and contacts; skip exact duplicates (same id)
  - **Replace**: confirm dialog → wipe current data → load backup
- Progress bar during import

CSV import:
- Map CSV columns to contact fields (auto-map by column header)
- Show preview table (first 5 rows)
- All imported contacts go into a new session: "CSV Import — [date]"
- [Import N contacts] button

vCard import:
- Parse standard VCF
- Show count: "Found N contacts in file"
- Import to session: "vCard Import — [date]"

#### Clear

Three options:
- **Clear this session** — deletes session + all its contacts (after confirmation)
- **Clear selected** — multi-select in contacts list, then delete
- **Clear all data** — factory reset:
  1. Force export: shows export modal, must download JSON first
  2. "Type CLEAR to confirm" text field
  3. Delete all IndexedDB data
  4. Show "All data cleared" toast

### Block 11 — Settings

**settings.js**

Sections:

**Storage**
- Total contacts: N
- Total sessions: N
- DB size estimate: ~X MB
- Card images stored: N

**Google Drive Sync** (placeholder for v2)
- Greyed out section: "Coming in next version"
- [Connect Google Drive] button — disabled

**Data Management** — see Block 10 above

**About**
- App version: 1.0.0
- Schema version: 1
- Device ID: (truncated uuid)
- [View on GitHub] link

**Appearance** (optional, implement last)
- Theme: System | Light | Dark

---

## Screens & Navigation

```
Home
├── [+ New Session] → new-session
├── Recent sessions list (last 5)
└── [View all contacts →] → contacts

new-session → capture

capture
└── [Process N photos →] → detection

detection (per photo, loop)
└── [Confirm N cards →] → confirm (starts OCR)

confirm (swipeable N cards)
└── [Close session] → home

contacts → contact-detail

settings → (data management modal)
```

Bottom nav: Home | [+ Capture] | Contacts | Settings
- Centre button [+] is always [New session → Capture]

---

## CSS Design System

Use CSS custom properties (variables) for the design system.
Mobile-first. All layouts work at 375px width minimum.

```css
:root {
  --bg: #f5f5f5;
  --surface: #ffffff;
  --border: #e0e0e0;
  --text: #1a1a1a;
  --text-muted: #888888;
  --accent: #1d6f42;       /* green — same as existing capture.html */
  --accent-light: #e8f5ee;
  --t1: #c0392b;  --t1-bg: #fdf0ef;
  --t2: #e67e22;  --t2-bg: #fef9ec;
  --t3: #2980b9;  --t3-bg: #eaf4fd;
  --t4: #888888;  --t4-bg: #f5f5f5;
  --danger: #e74c3c;
  --radius: 12px;
  --radius-sm: 8px;
  --shadow: 0 2px 8px rgba(0,0,0,0.08);
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
```

---

## CDN Dependencies

Load from CDN, not bundled:

```html
<!-- OpenCV.js — load lazily when capture starts -->
<script id="opencv-script"
  src="https://docs.opencv.org/4.8.0/opencv.js"
  async defer></script>

<!-- Tesseract.js — load lazily when capture starts -->
<script src="https://unpkg.com/tesseract.js@5/dist/tesseract.min.js"></script>
```

Both should only be injected into DOM when user starts a capture session, not on app load.
Show "Loading recognition engine… first time only" progress when loading.

---

## Service Worker Cache Strategy

Cache on install (app shell):
- `/card-capture-app/` (index.html)
- `/card-capture-app/css/app.css`
- `/card-capture-app/css/capture.css`
- `/card-capture-app/css/components.css`
- `/card-capture-app/js/app.js`
- All other JS files under `/card-capture-app/js/`
- `/card-capture-app/manifest.json`
- `/card-capture-app/assets/icon-192.png`
- `/card-capture-app/assets/icon-512.png`

Do NOT cache OpenCV.js or Tesseract.js CDN URLs — they are large and have their own CDN caching. The browser's HTTP cache handles them.

Fetch strategy: cache-first for cached assets, network-first with cache fallback for everything else.

On activation: delete caches with names that don't match `card-capture-v1`.

---

## Build Order (recommended)

Build in this sequence — each step produces testable output:

1. `index.html` + `manifest.json` + `app.css` — bare shell, PWA installable
2. `service-worker.js` — offline works
3. `db.js` — IndexedDB, test with browser console
4. `home.js` + `new-session.js` — basic navigation
5. `capture.js` — camera + photo queue (test with real phone)
6. `detect.js` — card detection (can test with static test image first)
7. `detection.js` — detection confirmation UI
8. `ocr.js` — Tesseract wrapper (test with a card scan)
9. `confirm.js` — full confirm + enrich UI
10. `contacts.js` + `contact-detail.js` — browse + edit
11. `export.js` + `import.js` — data portability
12. `settings.js` — settings + data management UI
13. PWA icons (generate simple placeholder icons)
14. Test end-to-end on real iPhone

---

## Important Implementation Notes

1. **UUID generation:** use `crypto.randomUUID()` — available in all modern browsers
2. **Image compression:** always compress before storing. Max 800px on longest side, JPEG quality 0.7
3. **OpenCV loading:** OpenCV.js sets `cv` as a global. Listen for `cv['onRuntimeInitialized']` before calling any OpenCV functions
4. **Tesseract:** use worker pool for multiple cards. Terminate workers when session ends
5. **iOS camera:** `<input type="file" accept="image/*" capture="environment">` — this is the correct approach. `getUserMedia` has additional permission complexity on iOS
6. **iOS PWA:** on iOS, PWA uses its own storage partition separate from Safari. Data will survive "Clear History" in Safari. Good.
7. **Safe areas:** add `padding: env(safe-area-inset-bottom)` to bottom nav — critical for iPhone with home indicator
8. **Viewport:** `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover">`
9. **Back side merge:** when merging back OCR into front fields, only fill empty fields. Never overwrite existing data from front. Append additional emails/phones.
10. **IndexedDB transactions:** wrap multi-step operations in a single transaction where possible. Handle `onerror` and `onabort` on all transactions

---

## Testing Checklist

After building, test these flows on a real iPhone:

- [ ] Install via Safari "Add to Home Screen"
- [ ] App opens offline after first load
- [ ] New session: event name + date saved
- [ ] Take photo of 1 card: detected, OCR runs, fields extracted
- [ ] Take photo of multiple cards: N boundaries shown
- [ ] Reject a detected card, confirm remaining
- [ ] Add back side to a card
- [ ] Confirm fields, skip one, save rest
- [ ] Close session, see contacts in list
- [ ] Search contacts by name
- [ ] Filter by T2
- [ ] Edit a contact, changes persist after app restart
- [ ] Export as CSV: file downloads
- [ ] Export as JSON: file downloads
- [ ] Import JSON: contacts appear
- [ ] Export as vCard: file downloads, imports to Apple Contacts
- [ ] Clear a session: confirms, contacts gone
- [ ] Clear all: forces export first
- [ ] Settings shows correct DB stats

---

## Deployment to GitHub Pages

After building, deploy:

1. Create repo: `github.com/curioushy/card-capture-app`
2. Push all files
3. Settings → Pages → Source: main branch, root: `/app`
   (or use `/docs` if you prefer — just put app files there)
4. App live at: `https://curioushy.github.io/card-capture-app/`
5. Update `manifest.json` `start_url` and Service Worker cache paths to match this URL

Note: The Service Worker cache paths must match the GitHub Pages URL path prefix.
If hosted at `/card-capture-app/`, all paths in SW cache list must start with `/card-capture-app/`.

---

## Version History

- **v1.0** — Initial build. Scope: Blocks 1–8, 10, 11. No Drive sync.
- **v2.0** — (future) Add Google Drive sync (Block 7b), dedicated Sessions list (Block 9)
- **v3.0** — (future) Add Send to Work Email / Workflow 2 coupling (Block 12)
