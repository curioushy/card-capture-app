import { initDB, getOpenSession } from './db.js';
import { renderHome } from './screens/home.js';
import { renderNewSession } from './screens/new-session.js';
import { renderCapture } from './screens/capture.js';
import { renderDetection } from './screens/detection.js';
import { renderConfirm } from './screens/confirm.js';
import { renderContacts } from './screens/contacts.js';
import { renderContactDetail } from './screens/contact-detail.js';
import { renderSessions } from './screens/sessions.js';
import { renderSettings } from './screens/settings.js';

// Global app state
export const app = {
  currentSession: null,
  currentScreen: 'home',
  pendingPhotos: [],
  detectedCards: [],
  confirmedCards: [],
};

// Screen registry
const SCREENS = {
  'home':           renderHome,
  'new-session':    renderNewSession,
  'capture':        renderCapture,
  'detection':      renderDetection,
  'confirm':        renderConfirm,
  'contacts':       renderContacts,
  'contact-detail': renderContactDetail,
  'sessions':       renderSessions,
  'settings':       renderSettings,
};

// Navigate to a screen
export function navigate(screenName, params = {}) {
  const prev = document.querySelector('.screen.active');
  const next = document.getElementById(`screen-${screenName}`);
  if (!next) return;

  if (prev) prev.classList.remove('active');
  next.classList.add('active');
  app.currentScreen = screenName;

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.screen === screenName);
  });

  const renderer = SCREENS[screenName];
  if (renderer) renderer(next, params);

  next.scrollTop = 0;
}

// Show floating status bar
export function showStatus(text, progress = null) {
  const bar = document.getElementById('statusBar');
  const textEl = document.getElementById('statusBarText');
  const fill = document.getElementById('statusBarFill');
  bar.hidden = false;
  textEl.textContent = text;
  if (progress !== null) fill.style.width = `${progress}%`;
}

export function hideStatus() {
  document.getElementById('statusBar').hidden = true;
  document.getElementById('statusBarFill').style.width = '0%';
}

// Sync dot
export function setSyncDot(state) {
  const dot = document.getElementById('syncDot');
  dot.className = 'sync-dot';
  if (state === 'yellow') dot.classList.add('yellow');
  if (state === 'grey') dot.classList.add('grey');
  dot.title = state === 'green' ? 'All saved' : state === 'yellow' ? 'Unsaved changes' : 'Offline';
}

// Toast
let toastTimer;
export function showToast(msg, duration = 2500) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}

// ─── Theme ────────────────────────────────────────────────────────────────────

const THEME_KEY = 'cc-theme'; // 'system' | 'light' | 'dark'

export function getTheme() {
  return localStorage.getItem(THEME_KEY) || 'system';
}

export function setTheme(theme) {
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}

function applyTheme(theme) {
  const root = document.documentElement;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const useDark = theme === 'dark' || (theme === 'system' && prefersDark);
  root.setAttribute('data-theme', useDark ? 'dark' : 'light');
}

function initTheme() {
  applyTheme(getTheme());
  // Re-apply if system preference changes while app is open
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getTheme() === 'system') applyTheme('system');
  });
}

// ─── Nav ──────────────────────────────────────────────────────────────────────

function initNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.screen));
  });
  document.getElementById('settingsBtn').addEventListener('click', () => navigate('settings'));
}

function initOffline() {
  const update = () => setSyncDot(navigator.onLine ? 'green' : 'grey');
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./service-worker.js');
    } catch (e) {
      console.warn('[SW] Registration failed:', e);
    }
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function init() {
  await initDB();
  initTheme();
  initNav();
  initOffline();
  registerSW();

  // Resume any session that was open when app last closed
  const openSession = await getOpenSession();
  if (openSession) {
    app.currentSession = openSession;
  }

  navigate('home');
}

init();
