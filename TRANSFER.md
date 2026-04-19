# Transfer & Setup Guide

How to move this project to another Mac and continue development with Claude Code.

---

## Option A — Google Drive (easiest, already done)

This folder lives in your Google Drive (`ClaudeCode/card-capture-app/`).
If your other Mac has **Google Drive for Desktop** installed and signed in
to the same account, the folder is already there — just open it.

**On the other Mac:**
1. Open Finder → Google Drive → My Drive → ClaudeCode → card-capture-app
2. Open Terminal in that folder: `cd` into it
3. Start Claude Code: `claude`
4. Claude will read `CLAUDE.md` automatically and know what to build

That's it. No transfer needed.

---

## Option B — GitHub (recommended for development)

Using Git means full version history, easy deployment to GitHub Pages, and
clean collaboration between machines.

### First-time setup (on this Mac)

```bash
# 1. Navigate to the project
cd ~/Library/CloudStorage/GoogleDrive-*/My\ Drive/ClaudeCode/card-capture-app

# 2. Initialise git
git init
git add .
git commit -m "Initial project spec"

# 3. Create repo on GitHub
# Go to https://github.com/new
# Name: card-capture-app
# Visibility: Private (recommended — your contact data will live here)
# Do NOT initialise with README (you already have files)

# 4. Push
git remote add origin https://github.com/curioushy/card-capture-app.git
git branch -M main
git push -u origin main
```

### On the other Mac

```bash
# 1. Install Claude Code if not already installed
npm install -g @anthropic-ai/claude-code

# 2. Clone the repo
git clone https://github.com/curioushy/card-capture-app.git
cd card-capture-app

# 3. Start Claude Code — it reads CLAUDE.md automatically
claude
```

### Keeping both Macs in sync

```bash
# Before starting work on any machine:
git pull

# After Claude builds files:
git add .
git commit -m "describe what was built"
git push
```

---

## Option C — AirDrop (quick one-off)

1. Right-click `card-capture-app` folder in Finder
2. Share → AirDrop → select other Mac
3. On other Mac: folder lands in Downloads
4. Move to preferred location
5. Open Terminal in folder, run `claude`

**Downside:** no sync. Changes on one Mac don't automatically appear on the other.
Use this only for a one-time handoff, then switch to Option B.

---

## Option D — USB

1. Copy `card-capture-app` folder to USB drive
2. On other Mac: copy from USB to preferred location
3. Open Terminal in folder, run `claude`

Same downside as Option C — no sync.

---

## How to Start Claude Code on the Other Mac

Once the folder is on the other Mac:

```bash
# Navigate to the project
cd /path/to/card-capture-app

# Start Claude Code
claude
```

Claude Code reads `CLAUDE.md` automatically. The first message you send
can be as simple as:

> "Read CLAUDE.md and start building the app, beginning with Block 1."

Or to pick up where you left off:

> "Read CLAUDE.md. Which blocks are already built? Continue from where we left off."

---

## Testing the App During Development

The app is a PWA — no build step needed. To test locally:

```bash
# From the app/ directory, serve with any static server
npx serve app/
# or
python3 -m http.server 8080 --directory app/
```

Open `http://localhost:8080` in Chrome or Safari.

**For testing on iPhone:**
- Your Mac and iPhone must be on the same WiFi network
- Find your Mac's local IP: System Settings → WiFi → Details → IP address
- Open `http://192.168.x.x:8080` on iPhone Safari
- Service Worker won't install on HTTP (requires HTTPS or localhost)
- For full PWA testing including offline: deploy to GitHub Pages (see below)

---

## Deploying to GitHub Pages

Once the app is built and pushed to GitHub:

1. Go to `https://github.com/curioushy/card-capture-app/settings/pages`
2. Source: Deploy from a branch
3. Branch: main | Folder: `/app`
4. Save
5. Wait ~2 minutes
6. App live at: `https://curioushy.github.io/card-capture-app/`

**On iPhone:**
1. Open `https://curioushy.github.io/card-capture-app/` in Safari
2. Tap Share → Add to Home Screen
3. App installs as icon on home screen
4. Opens fullscreen, works offline

---

## Folder Structure (what Claude will create)

```
card-capture-app/
├── CLAUDE.md               ← build spec (already exists)
├── TRANSFER.md             ← this file (already exists)
├── .gitignore              ← already exists
└── app/                    ← Claude builds everything inside here
    ├── index.html
    ├── manifest.json
    ├── service-worker.js
    ├── css/
    ├── js/
    └── assets/
```

Claude Code builds into `app/`. Only `CLAUDE.md`, `TRANSFER.md`, and `.gitignore`
exist before the build starts.

---

## Continuing Development (Workflow 2 and v2 features)

When you're ready to add features deferred from v1:

- **Google Drive sync (Block 7b):** tell Claude "Implement Block 7b from CLAUDE.md"
- **Send to Work Email (Block 12):** a separate workflow design session is needed first
- **Sessions list (Block 9):** tell Claude "Implement Block 9 from CLAUDE.md"

The CLAUDE.md will be updated as new blocks are designed.
