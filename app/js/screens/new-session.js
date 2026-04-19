import { navigate, app } from '../app.js';
import { createSession, listSessions } from '../db.js';

export async function renderNewSession(el) {
  const today = new Date().toISOString().split('T')[0];

  // Load recent event names for datalist
  let recentEvents = [];
  try {
    const sessions = await listSessions();
    const names = [...new Set(sessions.map(s => s.event_name))].slice(0, 10);
    recentEvents = names;
  } catch (_) {}

  el.innerHTML = `
    <div style="padding:16px;">
      <h2 style="font-size:20px;font-weight:700;margin-bottom:20px;">New Session</h2>

      <div class="form-group">
        <label class="form-label" for="eventName">Event Name</label>
        <input class="form-input" id="eventName" type="text"
          placeholder="e.g. Milken 2026" autocomplete="off" list="recentEventsList">
        <datalist id="recentEventsList">
          ${recentEvents.map(n => `<option value="${n}">`).join('')}
        </datalist>
      </div>

      <div class="form-group">
        <label class="form-label" for="eventDate">Date</label>
        <input class="form-input" id="eventDate" type="date" value="${today}">
      </div>

      <div id="formError" style="color:var(--danger);font-size:13px;margin-bottom:12px;display:none;"></div>

      <button class="btn btn-primary btn-full" id="startBtn" style="margin-top:8px;">
        Start Capturing →
      </button>
      <button class="btn btn-ghost btn-full" id="cancelBtn" style="margin-top:8px;">
        Cancel
      </button>
    </div>
  `;

  const nameInput = el.querySelector('#eventName');
  const dateInput = el.querySelector('#eventDate');
  const errorEl = el.querySelector('#formError');

  el.querySelector('#cancelBtn').addEventListener('click', () => navigate('home'));

  el.querySelector('#startBtn').addEventListener('click', async () => {
    const event_name = nameInput.value.trim();
    const date = dateInput.value;

    if (!event_name) {
      errorEl.textContent = 'Please enter an event name.';
      errorEl.style.display = 'block';
      nameInput.focus();
      return;
    }
    if (!date) {
      errorEl.textContent = 'Please select a date.';
      errorEl.style.display = 'block';
      return;
    }

    errorEl.style.display = 'none';

    try {
      const session = await createSession({ event_name, date });
      app.currentSession = session;
      app.pendingPhotos = [];
      navigate('capture');
    } catch (e) {
      errorEl.textContent = 'Failed to create session. Please try again.';
      errorEl.style.display = 'block';
    }
  });
}
