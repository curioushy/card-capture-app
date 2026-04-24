# Name Card Processor — Rebuild Plan (v2)

Complete redesign of `Name Card Processor.html`. The current multi-screen flow
(upload → detect → adjust → swipeable confirm) is replaced by a single
three-panel workspace. Desktop-first. Client-side only. Static file on Vercel.

---

## Why rebuild

The current flow has two fundamental problems:

1. **Auto-detection is the critical path.** Every downstream step assumes
   OpenCV found the card boundaries correctly. When detection misses or
   finds false rectangles, the user has to fight draggable handles, manual
   redraw tools, and multi-step state drift. ~40% of real-world photos hit
   this path.

2. **OCR output is hidden.** The parser makes one best-guess assignment
   (Name / Title / Company / …) and shows only the result. When it's wrong,
   the user has no visibility into what OCR actually captured — they just
   see the wrong answer and have to retype from the card image.

The redesign fixes both:
- Manual crop becomes the primary path; auto-detect becomes an optional assist
- Raw OCR tokens are shown in a dedicated panel; user drags tokens into
  contact fields with full visibility

---

## Target UX

```
┌─────────────┬──────────────────┬─────────────────────────┐
│ 1. SCAN     │ 2. OCR TOKENS    │ 3. CONTACTS             │
│  ~280px     │  ~380px          │  flex                   │
└─────────────┴──────────────────┴─────────────────────────┘
```

Single screen. Three panels. Always visible. No wizard.

### Panel 1 — Scan
- Upload: drag-drop, click-to-browse, **paste-from-clipboard (Cmd+V)**
- Photo list (thumbnails of uploaded photos)
- Active photo: shown large with card-boundary overlays
- **Manual crop tool is primary**: drag rectangle on photo → adds a card
- **"✨ Auto-detect cards"** button (optional, runs OpenCV on demand)
- Per-card controls appear when a card is active:
  - Rotate (−45° to +45° slider + 90° buttons)
  - Redraw/resize crop
  - Run OCR / Re-run OCR
  - Delete card
- Language toggle: English / English + Chinese
- "Start over" (clears all state with confirmation)

### Panel 2 — OCR Tokens
Populated as each card's OCR completes (not all-at-once).

**Detected values** (pattern-matched, shown as chips):
- Emails · Phones · URLs · LinkedIn handles

**Text lines** (one line per draggable item)

Every token shows a source tag ("C1", "C2", …) indicating which card it came from.

**Highlight rules** relative to the active contact in Panel 3:
- 🟢 Green border: currently assigned to this contact
- 🔵 Subtle tint: from this contact's source card (likely candidates)
- ⚪ Neutral: from other cards — still fully draggable

Nothing is ever disabled. Cross-card drags are supported because OCR sometimes
cross-contaminates tokens between adjacent cards.

### Panel 3 — Contacts
One row per card. Field slots:
- **Name · Title · Company** (single-value — drop replaces)
- **Emails · Phones** (multi-value — drop appends as chips)
- **LinkedIn · Website** (single-value — drop replaces)

Each field:
- Is a drop target (lights up on drag-start)
- Is click-editable (type directly)
- Has a small × to unassign (returns token to Panel 2 neutral state)

Click a contact row → becomes active. Panel 1 shows its image/adjust,
Panel 2 updates highlights.

Footer: Add contact (manual), Export CSV / JSON / vCard.

### Assignment mechanics
1. **Drag**: token → field slot
2. **Click-to-assign**: click field slot first (becomes active) → click token
3. **Type**: click field, type directly

---

## Scanning → OCR pipeline (redesigned)

This is the section that's been buggy. Redesigned from scratch.

### Current pipeline (buggy)

```
upload → auto-detect (3-strategy) → confirm boundaries →
per-card rotate/crop adjust → dewarp → preprocess → OCR
```

Every arrow is a chance for state drift. Auto-detect fails ~40% of the time
because all three current strategies (Otsu + Adaptive + Canny) operate on the
same grayscale image — when lighting is uneven or the background has texture,
they fail together.

### New pipeline

```
upload → multi-variant auto-detect → green boxes on photo →
user accepts/rejects/adjusts (or adds manual) → per-card rotate/crop →
preview preprocessed image → explicit OCR → tokens to Panel 2
```

Key principles:

1. **Auto-detect runs automatically on every upload.** User sees green boxes
   appear after ~1 second. Common case is one-click confirm.
2. **Robustness via variant diversity**, not threshold tuning. See below.
3. **Manual add is always available**, not a fallback mode. User can drag
   a rectangle on the photo at any time to add a missed card.
4. **Green-box UX makes state obvious.** Detected cards = green outline with
   numbered badge. Rejected = removed. Adjusted = handles on corners.
5. **Preprocessed preview is visible** before OCR runs, so bad crops are caught
   in <1 second instead of after 20s of wasted OCR.
6. **OCR is per-card and explicit.** Re-running one card after adjusting
   doesn't redo others.
7. **Minimum-resolution enforcement.** Preprocess always upscales to ≥1800px
   long edge. If source crop < 600px, warn: "Low source resolution — OCR
   accuracy will be limited."

### Detection — TTA + Weighted Box Fusion

Same algorithm, multiple image variants, then confidence-weighted coordinate
averaging. This is **Test-Time Augmentation (TTA)** combined with
**Weighted Box Fusion (WBF)** — standard practice in state-of-the-art object
detection ([Solovyev et al. 2019](https://arxiv.org/abs/1910.13302)).

Why not 5 different algorithms? Different algorithms have systematic biases;
averaging their output adds bias. Same algorithm on 5 lighting variants —
successful detections land in near-identical positions and random noise cancels.
Classic variance reduction.

**Image variants** (7 in total):

| V | Preprocessing | Addresses |
|---|---|---|
| V1 | Original | Baseline |
| V2 | Gamma 0.7 | Shadows (brighten dark regions) |
| V3 | Gamma 1.4 | Glare (tame highlights) |
| V4 | CLAHE (clip=3.0, tile=8×8) | Uneven local lighting |
| V5 | Histogram equalization | Low global contrast |
| V6 | Bilateral filter (d=9, σ=75/75) | Textured backgrounds |
| V7 | Unsharp mask | Soft-edged cards |

**Detection pipeline per variant** (same code path for all 7):
```
grayscale → GaussianBlur(5×5) → Canny(75, 200) →
morphological dilate(3×3) → findContours →
approxPolyDP(epsilon=2% of perimeter) →
filter quadrilaterals (4 vertices, area 3–90% of image, aspect 0.3–3.0)
```

Output per variant: list of candidate boxes with synthesized confidence.

**Synthesized confidence score per box** (classical CV has none natively):
- **40% edge alignment**: sum of Canny edge pixels along the box perimeter,
  normalized by perimeter length
- **30% aspect ratio prior**: Gaussian centered on 1.65 (business-card mean),
  σ=0.4 → boosts ratios 1.5–1.75
- **30% contour regularity**: deviation of internal angles from 90°; penalizes
  skewed quadrilaterals

**Weighted Box Fusion (WBF)** merge step:
1. Collect all candidate boxes from all 7 variants with confidence scores
2. Sort by confidence descending
3. For each box:
   - If IoU > 0.55 with an existing cluster's average → add to that cluster
   - Else → start new cluster
4. Per cluster, final coordinates = Σ (conf_i × corner_i) / Σ conf_i
5. Cluster score = Σ conf_i / N_variants
6. Keep clusters with cluster score > 0.3 (roughly: ≥3 variants agreed OR
   fewer but very high-quality detections)

**Performance budget:**
- Each variant's detection: ~150–250ms on 1080p image in OpenCV.js
- Total 7 variants: ~1.5–2s on upload
- Acceptable for one-time detection; show a progress indicator

**When all variants fail (empty result):**
Panel 1 shows "No cards detected — drag to add one manually." Manual drag
tool is pre-armed. User can also click "Re-run detection" to retry after
rotating/cropping the photo.

**Explicitly not in v2:**
- CNN-based detection (MobileNet-class + ONNX Runtime Web). Would dominate
  classical but adds ~5–10MB model download + training pipeline. Deferred
  to v3.
- Rotation variants (classical contour detection is rotation-invariant,
  low ROI).
- MSER, HoughLines — unstable for card detection, high tuning cost.

### Multi-card and multi-photo

The system supports both forms of "multiple":

1. **Multiple photos uploaded at once** — Cmd-click file picker, drag-drop
   multiple files, paste multiple images. Each photo gets its own detection
   pass.
2. **Multiple cards in one photo** — detection finds all cards per photo, each
   gets a green box with its own numbered badge ("C1", "C2", "C3").

Cards from different photos share the same numbering namespace
(global: C1, C2, C3 across all photos).

### Detection mode — axis-aligned vs 4-corner

Two modes per card:

- **Rectangular crop**: axis-aligned, no dewarp. Fast, perfect for
  near-top-down photos. Output = source pixels inside the rectangle.
- **4-corner dewarp**: user marks (or auto-detect found) 4 corners.
  Perspective transform to a flat rectangle. Used when the photo is angled.

Auto-detect returns 4-corner quadrilaterals. If the quadrilateral is close to
rectangular (corners ~90°, sides roughly axis-aligned), system auto-converts
to rect mode. Otherwise stays in dewarp mode.

Manual-add defaults to rect mode (user drags a rectangle). User can toggle a
card to dewarp mode and drag corners individually.

### Preprocessing (unchanged from Tier A)

Already implemented in the current file:
- Upscale to ~1800px long edge (bicubic, canvas `imageSmoothingQuality: 'high'`)
- Grayscale (luminance weights)
- 1st/99th percentile histogram contrast stretch
- Output is what Tesseract sees; also what the preview panel shows

### OCR (unchanged from Tier A)

- Tesseract.js v5, PSM 6, `preserve_interword_spaces: '1'`
- Two workers cached: `eng` and `eng+chi_sim`
- Language chosen by panel 1 toggle

---

## Data model

In-memory state only (no persistence in v2 yet). Single `state` object:

```js
state = {
  photos: [                 // uploaded photos
    {
      id: uuid,
      dataUrl: string,
      width, height: number,
      cards: [cardId, ...]  // refs
    }
  ],
  cards: {                  // map keyed by cardId
    [cardId]: {
      id: uuid,
      photoId: uuid,
      mode: 'rect' | 'dewarp',
      rect: {x, y, w, h}        // if mode === 'rect'
      corners: [[x,y], ...]     // if mode === 'dewarp' (4 points)
      rotation90: 0 | 90 | 180 | 270,
      rotationFine: -45..45,
      cropCanvas: <Canvas>      // cached after generate
      preprocessed: <Canvas>    // cached after generate
      ocrStatus: 'idle' | 'running' | 'done' | 'error',
      ocrText: string,
      ocrWords: [...],
      ocrConfidence: number,
      tokens: [tokenId, ...]    // refs into state.tokens
    }
  },
  tokens: {                 // all OCR tokens, draggable units
    [tokenId]: {
      id: uuid,
      cardId: uuid,           // source card
      kind: 'email'|'phone'|'url'|'linkedin'|'line',
      value: string,
      assignedTo: {contactId, field} | null
    }
  },
  contacts: {               // one per card (1:1)
    [contactId]: {
      id: uuid,
      cardId: uuid,
      name: string,
      title: string,
      company: string,
      emails: [string],
      phones: [string],
      linkedin: string,
      website: string,
      // each field also tracks which tokenIds are assigned to it
      _assignedTokens: { name: [tokenId|null], emails: [tokenId,...], ... }
    }
  },
  activeContactId: uuid | null,
  useCJK: boolean,
}
```

Why this shape:
- Tokens are first-class and draggable. `assignedTo` tracks state for
  highlighting and unassign.
- Cards 1:1 with contacts (simpler than m:n).
- Canvases are cached so redraws are cheap; regenerated on rotate/crop change.

---

## Staged build plan

Each stage is independently shippable and testable. Deploy after each stage so
regressions are isolated.

### Stage 0 — Scaffold
- New file: `Name Card Processor.html` (overwrite — full rebuild; the current
  file is already in git history)
- CSS grid layout: three columns (280px / 380px / 1fr)
- Empty panels with headings
- Basic state object + event bus (or just a render() function)
- **DoD:** Opens in browser, three panels visible, responsive down to 1024px

### Stage 1 — Upload & photo list
- Drag-drop zone in Panel 1
- Click-to-browse `<input type="file" multiple accept="image/*">`
- **Paste from clipboard** (`window.addEventListener('paste')`)
- Thumbnail list of uploaded photos
- Click a thumbnail → active photo shown large
- Delete photo (×)
- **DoD:** Can upload multiple photos, select between them, delete. No
  processing yet.

### Stage 2 — Auto-detect (TTA + WBF)
- Load OpenCV.js lazily on first upload
- Implement 7 preprocessing variants (V1–V7 from pipeline spec)
- Single detection function reused across all variants
- Synthesized confidence per box (edge alignment 40% + aspect prior 30% +
  regularity 30%)
- WBF merge: IoU > 0.55 clustering, confidence-weighted corner averaging
- Progress indicator during detection (~1.5–2s for 7 variants)
- Run on every uploaded photo automatically
- Draw green boxes (numbered C1, C2, C3…) on active photo
- × button on each box to reject
- "Re-run detection" button to retry after photo adjustments
- If nothing detected: "No cards detected — drag to add one manually"
- **DoD:** Upload a photo with 1, 2, or 3 cards → correct green boxes appear
  within ~2s. Shadowed/glare-heavy photos that failed in v1 now succeed.
  Multiple photos can each have their own detections.

### Stage 3 — Manual add + corner adjust
- Drag a rectangle on the active photo → adds a card in rect mode
- Each card overlay has 4 draggable corner handles for fine-tune
- Toggle a card between rect mode and 4-corner dewarp mode
- Rotate controls (`rotation90` buttons + `rotationFine` slider −45° to +45°)
- `applyAdjustments()` generates `cropCanvas` from source photo + rect/corners
  + rotation
- Small preview thumb of `cropCanvas` visible in Panel 1
- **DoD:** Any auto-detection mistake is 2 clicks to fix. Missed card can be
  drawn manually. Rotation/adjust preview updates live.

### Stage 4 — Preprocessing preview
- Generate `preprocessed` canvas from `cropCanvas` (Tier A pipeline already exists)
- Show preprocessed preview in Panel 1 (toggle: "Show what OCR sees")
- Warning banner if cropCanvas < 600px on long edge
- **DoD:** User can visually verify preprocessing is sane before running OCR.

### Stage 5 — OCR trigger + tokens
- "Run OCR" button on active card
- "Run OCR on all" button in Panel 1 header
- Async: card ocrStatus goes idle → running → done
- Spinner on card while running
- On completion: parse tokens (emails / phones / urls / linkedin / lines) and
  populate Panel 2 with source-tagged chips
- **DoD:** Cards show OCR status. Panel 2 populates with draggable chips/lines.

### Stage 6 — Panel 2 interactions
- Chips render by category (Emails · Phones · URLs · LinkedIn · Lines)
- Each token shows source tag (C1, C2, ...)
- Highlight rules: green = assigned, tinted = same-source-as-active, neutral = other
- Hover on token: show full value if truncated
- **DoD:** Panel 2 reflects active contact correctly; hover works.

### Stage 7 — Panel 3 drag-drop + click-to-assign
- Contact rows with field slots (name/title/company/emails/phones/linkedin/website)
- On drag-start in Panel 2: all valid drop targets in Panel 3 highlight
- Drop on single-value field: replace
- Drop on multi-value field: append
- Click field slot → becomes "active field" → click token in Panel 2 → assign
- × button on each field to unassign (returns token to Panel 2)
- Direct typing also works (typed values don't consume a token)
- **DoD:** Can fully populate a contact via drag only, via click-assign only,
  or via typing only.

### Stage 8 — Auto-populate contacts from OCR
- When a card finishes OCR, pre-fill its contact row with the current parser's
  best guess (name/title/company/emails/phones/linkedin/website)
- Tokens used in the auto-fill show the green "assigned" highlight in Panel 2
- User edits are always non-destructive: overwriting or clearing a field
  releases the previously-assigned token back to the neutral pool in Panel 2
- **DoD:** Common-case flow (upload clean photo → auto-detect → auto-OCR →
  auto-fill contact → 1-click export) works end-to-end. Mistakes are always
  fixable by drag.

### Stage 9 — Export
- CSV (pipe-delimited emails/phones within a field)
- JSON (full state, for backup)
- vCard (.vcf, standard format)
- Download as `card-capture-YYYY-MM-DD.{csv|json|vcf}`
- **DoD:** All three formats download correctly. Round-trip JSON (export → re-import)
  in future is possible but not built in v2.

### Stage 10 — Polish
- Keyboard shortcuts: `Cmd+V` paste, `Delete` removes active card, arrow keys
  cycle contacts, `Escape` clears active field
- "Start over" confirmation dialog
- Error toasts for failed OCR, bad files
- Responsive down to 1024px; below that show "Desktop-only" notice
- Loading states everywhere

---

## Non-goals (deferred)

- IndexedDB persistence (v3 — for now, session is lost on refresh)
- Multiple sessions / event metadata
- Cloud sync
- Mobile / touch-first layout
- Back-of-card support
- Import (JSON / CSV / vCard → contacts)
- Undo stack

---

## File changes

- **Overwrite:** `Name Card Processor.html`
- Git history preserves the old version if rollback needed
- No new dependencies; same CDNs (OpenCV.js + Tesseract.js v5)
- Deploy via `vercel --prod --yes` after each stage

---

## Testing per stage

After every stage, verify on real input before moving to next:

| Stage | Test |
|---|---|
| 1 | Upload 3 photos via drag, 1 via paste, 2 via browse. Delete one. |
| 2 | Draw 2 cards on one photo. Resize. Switch photos. Come back. |
| 3 | Rotate a card 90°. Fine-tune 12°. Verify preview. |
| 4 | See preprocessed preview. Intentionally bad crop triggers warning. |
| 5 | Run OCR on one card. Tokens appear in Panel 2 with correct source tag. |
| 6 | Switch active contact, highlights update correctly. |
| 7 | Drag an email from C2 onto C1's Email field. Verify appends. × removes. |
| 8 | Auto-detect on a clean photo — produces correct crops. |
| 9 | Export CSV, open in Numbers. Export vCard, open in Contacts. |
| 10 | Keyboard only — add card, rotate, OCR, assign fields. |
