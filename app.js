// MemoLight dashboard <-> Arduino over Web Serial (Chrome / Edge only)

const CMD = { ON: '1\n', OFF: '0\n' };

const PAGES = {
  dashboard: 'DASHBOARD', live: 'LIVE MODE', record: 'RECORD ENVIRONMENT',
  library: 'MEMORY LIBRARY', replay: 'REPLAY MODE', test: 'TEST LAB', status: 'SYSTEM STATUS'
};

const SD_FILE = 'MEMORY.CSV';

// The 16 colors, in the same order as the Arduino palette (dark -> light).
// t / h / l = a typical room (temperature °C, humidity %, light %) that gives that color.
const PALETTE = [
  { name: 'Chestnut Plum',         hex: '#853115', t: 28.7, h: 70, l: 32 },
  { name: 'Brown Red',             hex: '#923007', t: 28.9, h: 68, l: 36 },
  { name: 'Kara Cha Brown',        hex: '#7E3F1D', t: 29.1, h: 66, l: 40 },
  { name: 'Mummy Brown',           hex: '#814826', t: 29.3, h: 64, l: 43 },
  { name: 'Crimson Blaze',         hex: '#A5401B', t: 29.6, h: 62, l: 46 },
  { name: 'Brandy Bear',           hex: '#AC5614', t: 29.8, h: 60, l: 50 },
  { name: 'Mid Century Furniture', hex: '#B15A1A', t: 30.0, h: 58, l: 54 },
  { name: 'Rusty Nail',            hex: '#C95224', t: 30.2, h: 56, l: 57 },
  { name: 'Splinter',              hex: '#A2723C', t: 30.4, h: 54, l: 60 },
  { name: 'Cinnamon',              hex: '#D26D08', t: 30.6, h: 52, l: 64 },
  { name: 'Acorn Spice',           hex: '#B47636', t: 30.8, h: 50, l: 68 },
  { name: 'Maine Coon Orange',     hex: '#C57A2B', t: 31.1, h: 48, l: 71 },
  { name: 'Basketball',            hex: '#EE6A2F', t: 31.3, h: 46, l: 74 },
  { name: 'French Toast',          hex: '#E08523', t: 31.5, h: 44, l: 78 },
  { name: 'Carrot Orange',         hex: '#EC8D1B', t: 31.7, h: 42, l: 82 },
  { name: 'White',                 hex: '#FFFFFF', t: 32.0, h: 40, l: 85 }
];

let port = null, writer = null, reader = null, readClosed = null, buf = '';
let disconnecting = false;
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const sleep = ms => new Promise(res => setTimeout(res, ms));
const enc = s => new TextEncoder().encode(s);
const send = s => writer ? writer.write(enc(s)).catch(() => {}) : Promise.resolve();

// ---------- Helpers ----------
function fmtDateTime(d) {
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtClock(sec) {
  const p = n => String(n).padStart(2, '0');
  return p(Math.floor(sec / 3600)) + ':' + p(Math.floor(sec % 3600 / 60)) + ':' + p(sec % 60);
}
function fmtDur(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return (h ? h + 'h ' : '') + (h || m ? m + 'm ' : '') + s + 's';
}
function lightLabel(v) { return v < 250 ? 'LOW' : v < 600 ? 'MEDIUM' : 'HIGH'; }
// This is the computer's clock (shown in the top bar). The lamp has no clock.
function tickClock() { $('#clock').textContent = '🕒 ' + fmtDateTime(new Date()); }

function mkBtn(cls, text, tip, fn) {
  const b = document.createElement('button');
  b.className = cls + ' btn-small';
  b.textContent = text;
  b.title = tip;
  b.onclick = fn;
  return b;
}

// Wait, but wake up early if the user presses STOP
async function sleepStop(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && !stopReplayFlag) await sleep(Math.min(100, end - Date.now()));
}

// ---------- Manual recordings (saved in this browser only) ----------
// Each session: { id, name, start, end, samples[, fromSd] }
// Each sample:  { ts, sec, t, h, ldr, r, g, b, p, ci }
//   ts  = computer clock when the reading arrived (browser recordings only)
//   sec = seconds since the recording started (all recordings; for SD memory it is approximate)
let sessions = loadSessions();
let session = null;            // the recording in progress
let pausedMemory = false;      // true if starting a recording paused the lamp's night replay
let ignoreUntil = 0;           // ignore live readings right after a replay/test ends
const MAX_SAMPLES = 3600;      // about 2 hours at one reading every 2 seconds

function loadSessions() {
  try {
    const data = JSON.parse(localStorage.getItem('memolightSessions') || '[]');
    if (!Array.isArray(data)) return [];
    return data.filter(s => s && Array.isArray(s.samples) && s.samples.length);
  } catch (err) {
    return [];       // storage blocked or damaged: start with an empty library
  }
}

function saveSessions() {
  try {
    localStorage.setItem('memolightSessions', JSON.stringify(sessions));
    return true;
  } catch (err) {
    alert('Browser storage is full or blocked. Your newest changes are only kept until you close or refresh this page.\n' +
          'Download the recording with ⬇ CSV, or delete older recordings.');
    return false;
  }
}

function secOf(s, x) {
  if (x.sec !== undefined) return x.sec;
  if (x.ts !== undefined && s.start) return Math.max(0, Math.round((x.ts - s.start) / 1000));
  return 0;
}

function updateRecUI() {
  const on = !!session;
  const st = $('#rec-state');
  st.textContent = on ? '● RECORDING (this browser)' : '○ NOT RECORDING';
  st.classList.toggle('on', on);
  if (on) {
    $('#rec-timer').textContent = fmtClock(Math.floor((Date.now() - session.start) / 1000));
    $('#rec-count').textContent = session.samples.length;
  }
}

function canStartSomething() {
  if (!writer) { alert('Connect the Arduino first (🔌 CONNECT ARDUINO).'); return false; }
  if (replaying) { alert('Stop the replay first.'); return false; }
  if (testing) { alert('Stop the test first.'); return false; }
  if (session) { alert('Stop the recording first.'); return false; }
  return true;
}

function startRecording() {
  if (session) return;
  if (!canStartSomething()) return;
  pausedMemory = (lampMode === 'REPLAYING');
  send('N\n');                       // stop the lamp's night memory replay so we record the live room
  ignoreUntil = Date.now() + 2500;   // skip the last replayed reading
  session = { id: Date.now(), start: Date.now(), samples: [] };
  $('#rec-started').textContent = fmtDateTime(new Date(session.start));
  updateRecUI();
}

function stopRecording() {
  if (!session) return;
  const s = session;
  s.end = Date.now();
  session = null;                    // from this moment no more readings are added
  if (pausedMemory) { pausedMemory = false; send('U\n'); }   // give the night replay back
  updateRecUI();
  if (!s.samples.length) { alert('No readings were captured. Make sure the Arduino is connected.'); return; }

  const fallback = 'Recording ' + new Date(s.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const name = prompt('Name this recording (example: Afternoon study):', fallback);
  s.name = (name && name.trim()) ? name.trim().slice(0, 40) : fallback;

  sessions.unshift(s);
  sessions = sessions.slice(0, 20);  // the library keeps the 20 newest recordings
  saveSessions();
  renderSessions();
}

function renameSession(id) {
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  const name = prompt('Rename this recording:', s.name || '');
  if (name && name.trim()) {
    s.name = name.trim().slice(0, 40);
    saveSessions();
    renderSessions();
  }
}

function colorOf(x) {
  if (x.ci >= 0 && PALETTE[x.ci]) return PALETTE[x.ci].name;
  return (x.r !== undefined && x.r + x.g + x.b === 0) ? 'LAMP OFF' : '';
}

// Download a browser recording as a spreadsheet (CSV).
// Note: these columns are NOT the same as the lamp's MEMORY.CSV on the SD card.
function exportCsv(s) {
  const local = ts => (ts === undefined || ts === null || isNaN(ts)) ? '' :
    new Date(ts - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
  const rows = ['time,temp_c,humidity_pct,ldr,r,g,b,color,light_pct,elapsed_s'];
  s.samples.forEach(x => rows.push([local(x.ts), x.t, x.h, x.ldr, x.r ?? '', x.g ?? '', x.b ?? '', colorOf(x), x.p ?? '', secOf(s, x)].join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  a.download = ((s.name || '').replace(/[^\w\- ]+/g, '') || 'recording') + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

function statsText(s) {
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const ts = s.samples.map(x => x.t), hs = s.samples.map(x => x.h), ls = s.samples.map(x => x.ldr);
  return 'Temp avg ' + avg(ts).toFixed(1) + ' °C (' + Math.min(...ts) + '–' + Math.max(...ts) + ')' +
         ' · Humidity avg ' + avg(hs).toFixed(0) + ' % (' + Math.min(...hs) + '–' + Math.max(...hs) + ')' +
         ' · Light avg ' + Math.round(avg(ls));
}

function renderSessions() {
  const list = $('#session-list');
  const pick = $('#replay-pick');
  list.innerHTML = sessions.length ? '' : '<li>No manual recordings yet. Go to Record Environment and press Start Recording.</li>';
  pick.innerHTML = sessions.length ? '' : '<option value="">No recordings yet</option>';

  sessions.forEach(s => {
    const dur = Math.max(0, Math.round((s.end - s.start) / 1000));
    const name = s.name || 'Untitled recording';

    const li = document.createElement('li');
    li.className = 'session-item';

    const info = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = name;
    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.textContent = s.fromSd
      ? 'Copied from the lamp\'s SD memory on ' + fmtDateTime(new Date(s.start)) + ' · about ' + fmtDur(dur) +
        ' · ' + s.samples.length + ' readings · the lamp has no clock, so there are no real recording times'
      : fmtDateTime(new Date(s.start)) + ' → ' + new Date(s.end).toLocaleTimeString() +
        ' · ' + fmtDur(dur) + ' · ' + s.samples.length + ' readings · saved in this browser';
    const stats = document.createElement('div');
    stats.className = 'session-stats';
    stats.textContent = statsText(s);
    info.append(title, meta, stats);

    const box = document.createElement('span');
    box.append(
      mkBtn('btn-cyan', '▶ Replay', 'Replay this recording', () => replaySession(s.id)), ' ',
      mkBtn('btn-dark', '⬇ CSV', 'Download as a spreadsheet', () => exportCsv(s)), ' ',
      mkBtn('btn-dark', '✏️', 'Rename', () => renameSession(s.id)), ' ',
      mkBtn('btn-red', '🗑', 'Delete', () => {
        if (confirm('Delete "' + name + '"?')) {
          sessions = sessions.filter(x => x.id !== s.id);
          saveSessions();
          renderSessions();
        }
      })
    );
    li.append(info, box);
    list.appendChild(li);

    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = name + ' · ' + fmtDur(dur);
    pick.appendChild(opt);
  });
}

// ---------- SD card (the lamp's automatic memory) ----------
let sd = { ok: null, files: [], autoRec: null };
let memNote = '';
let dl = null;                       // download in progress: { rows, resolve, reject, timer }

function resetSd() {
  sd = { ok: null, files: [], autoRec: null };
  memNote = '';
  if (dl) { clearTimeout(dl.timer); dl.reject(new Error('Disconnected.')); dl = null; }
}

function sdMsg(t) { $('#sd-msg').textContent = t || ''; }

function updateSdUI() {
  const sdTxt = !writer ? 'Not connected'
    : sd.ok === null ? 'Checking…'
    : sd.ok ? '✅ Ready'
    : '⚠ No SD card found (check the wiring, and that the card is FAT32)';
  $('#sd-status').textContent = '💾 SD card: ' + sdTxt;
  $('#status-sd').textContent = sdTxt;
  $('#sdrec-state').textContent = !writer ? 'Not connected'
    : sd.autoRec === null ? 'Checking…'
    : sd.autoRec ? '● ON (confirmed by the lamp)' : '○ OFF (confirmed by the lamp)';
  $('#sd-note').textContent = memNote;
  $('#status-sd-note').textContent = memNote;
}

// Automatic SD recording on / off. Separate from manual (browser) recording.
// The state shown on the page changes only when the Arduino answers SDREC,...
function setAutoSdRec(on) {
  if (!writer) { alert('Connect the Arduino first (🔌 CONNECT ARDUINO).'); return; }
  if (!on && !confirm('Turn off automatic SD recording? Any daytime recording in progress will be discarded. The saved memory is kept.')) return;
  send('R' + (on ? 1 : 0) + '\n');
}

function requestStatus() {
  if (!writer) { alert('Connect the Arduino first (🔌 CONNECT ARDUINO).'); return; }
  send('S\n');
}

function sdRefreshList() {
  if (!writer) { renderSdList(); return; }
  sdMsg('Reading the SD card...');
  send('F\n');
}

function renderSdList() {
  const ul = $('#sd-list');
  ul.innerHTML = '';
  const note = t => { ul.innerHTML = '<li>' + t + '</li>'; };
  if (!writer) return note('Connect the Arduino, then press Refresh.');
  if (sd.ok === false) return note('No SD card found. Check the wiring and that the card is FAT32.');
  if (!sd.files.length) return note('No saved memory yet. The lamp saves one automatically when night begins, after enough daytime readings.');

  sd.files.forEach(f => {
    const li = document.createElement('li');
    li.className = 'session-item';
    const info = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = SD_FILE;
    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.textContent = (f.size / 1024).toFixed(1) + ' KB · recorded automatically by the lamp (no real clock times)';
    info.append(title, meta);

    const box = document.createElement('span');
    box.append(
      mkBtn('btn-cyan', '▶ Replay', 'Replay the lamp\'s SD memory', () => replayFromSd()), ' ',
      mkBtn('btn-dark', '📥 Import', 'Copy into the browser library', () => sdImport()), ' ',
      mkBtn('btn-red', '🗑', 'Delete from the SD card', () => {
        if (confirm('Delete ' + SD_FILE + ' from the SD card? The lamp will have no night memory until it records a new one.')) send('D\n');
      })
    );
    li.append(info, box);
    ul.appendChild(li);
  });
}

// Download the memory file from the SD card (slow: about 20 rows per second at 9600 baud)
function bumpDl() {
  clearTimeout(dl.timer);
  dl.timer = setTimeout(() => {
    const d = dl; dl = null;
    d.reject(new Error('The SD card did not answer (timeout).'));
  }, 15000);
}

function sdDownload() {
  return new Promise((resolve, reject) => {
    if (!writer) return reject(new Error('Connect the Arduino first.'));
    if (dl) return reject(new Error('Another SD download is still running.'));
    dl = { rows: [], resolve, reject, timer: null };
    bumpDl();
    send('O\n');
  });
}

// "SDROW" payload: "<sec>,31.5,60.0,512,236,141,27,Carrot Orange,45"  ->  sample object
// <sec> is the approximate seconds since the recording began (the lamp has no clock).
function parseSdRows(rows) {
  const items = [];
  rows.forEach(line => {
    const p = line.split(',');
    if (p.length < 9) return;
    const nums = [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[8]].map(Number);
    if (nums.some(v => !isFinite(v))) return;                 // skips damaged rows
    items.push({
      sec: nums[0], t: nums[1], h: nums[2], ldr: nums[3], r: nums[4], g: nums[5], b: nums[6],
      p: nums[7], ci: PALETTE.findIndex(c => c.name === p[7])
    });
  });
  return items.slice(0, MAX_SAMPLES);
}

async function sdImport() {
  try {
    sdMsg('Reading ' + SD_FILE + ' from the SD card...');
    const samples = await sdDownload();
    if (!samples.length) { sdMsg('The file has no readings.'); return; }
    const fallback = 'Lamp memory ' + new Date().toLocaleDateString();
    const nm = prompt('Name this memory:', fallback);
    const now = Date.now();
    const s = {
      id: now,
      name: (nm && nm.trim()) ? nm.trim().slice(0, 40) : fallback,
      fromSd: true,
      start: now,
      end: now + samples[samples.length - 1].sec * 1000,
      samples
    };
    sessions.unshift(s);
    sessions = sessions.slice(0, 20);
    const saved = saveSessions();
    renderSessions();
    sdMsg(saved ? '✅ Copied ' + samples.length + ' readings into the browser library.'
                : '⚠ Copied into the library, but it could not be stored in the browser (storage full).');
  } catch (err) {
    sdMsg('⚠ ' + err.message);
  }
}

async function replayFromSd() {
  if (!canStartSomething()) return;
  try {
    sdMsg('Reading ' + SD_FILE + ' from the SD card...');
    const samples = await sdDownload();
    sdMsg('');
    if (!samples.length) { sdMsg('The file has no readings.'); return; }
    playSession({ name: 'SD ' + SD_FILE, start: 0, samples });
  } catch (err) {
    sdMsg('⚠ ' + err.message);
  }
}

// ---------- Page switching ----------
function switchPage(name) {
  $$('.page').forEach(p => p.classList.remove('active'));
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  $('#page-' + name).classList.add('active');
  $('#nav-' + name).classList.add('active');
  $('#breadcrumb').textContent = 'MEMOLIGHT > ' + PAGES[name];
  if (name === 'library') {
    renderSdList();
    if (writer && sd.ok !== false && !dl) sdRefreshList();
  }
  return false;               // keeps the "#" links from jumping the page
}

// ---------- Day / night badge (the lamp switches by itself) ----------
let lampMode = '';
function setLampMode(mode) {
  lampMode = mode;
  let el = $('#mode-badge');
  if (!el) {
    el = document.createElement('span');
    el.id = 'mode-badge';
    el.style.cssText = 'padding:4px 10px;border-radius:12px;font-size:12px;font-weight:bold;border:1px solid currentColor;margin-right:8px;';
    $('#clock').before(el);
  }
  const look = {
    RECORDING: ['☀ DAY · SD RECORDING', '#f6b042'],
    REPLAYING: ['🌙 NIGHT · REPLAYING MEMORY', '#9ec5ff'],
    NOMEMORY:  ['🌙 NIGHT · NO MEMORY YET', '#b8a9c9'],
    LIVE:      ['● LIVE · MEMORY STOPPED', '#9fe3a0'],
    DAYOFF:    ['☀ DAY · SD RECORDING OFF', '#c9b08a']
  }[mode];
  el.style.display = look ? '' : 'none';
  if (look) { el.textContent = look[0]; el.style.color = look[1]; }
  el.title = memNote;
}

// Stop / resume the lamp's own night memory replay
function stopMemoryReplay() {
  if (!writer) { alert('Connect the Arduino first (🔌 CONNECT ARDUINO).'); return; }
  pausedMemory = false;       // the user chose this, so a recording must not undo it
  send('N\n');
}

function resumeMemoryReplay() {
  if (!writer) { alert('Connect the Arduino first (🔌 CONNECT ARDUINO).'); return; }
  send('U\n');
}

function log(msg) {
  const box = $('#log-box');
  box.textContent += msg + '\n';
  if (box.textContent.length > 8000) box.textContent = box.textContent.slice(-6000);
  box.scrollTop = box.scrollHeight;
}

function resetReadings() {
  $$('.temp-value').forEach(e => e.textContent = '— °C');
  $$('.humidity-value').forEach(e => e.textContent = '— %');
  $$('.light-value').forEach(e => e.textContent = '—');
  $$('.color-preview').forEach(e => { e.style.backgroundColor = ''; e.style.boxShadow = ''; });
  $$('.color-name').forEach(e => e.textContent = '—');
  markActive('');
  document.documentElement.style.removeProperty('--lamp');
  $('#lamp-state').textContent = 'Lamp: —';
  memNote = '';
  setLampMode('');
}

function setConnected(on) {
  const b = $('#btn-connect');
  b.textContent = on ? '⛔ DISCONNECT' : '🔌 CONNECT ARDUINO';
  b.classList.toggle('connected', on);
  $('#badge-conn').textContent = on ? '● ONLINE' : '○ OFFLINE';
  $('#conn-sub').textContent = on ? 'Connected at 9600 baud' : 'No Arduino connected';
  $('#sys-state').textContent = on ? 'ARDUINO CONNECTED' : 'NOT CONNECTED';
  $('#status-conn').textContent = on ? 'Connected' : 'Not connected';
  if (on) { $('#bright').value = 100; $('#bright-val').textContent = '100%'; }
}

// ---------- Arduino connection (Web Serial) ----------
async function connectArduino() {
  if (port) return disconnectArduino();
  if (!('serial' in navigator)) {
    alert('Web Serial is not supported here. Open this page in Chrome or Edge.');
    return;
  }
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600 });
    writer = port.writable.getWriter();
    const decoder = new TextDecoderStream();
    readClosed = port.readable.pipeTo(decoder.writable);
    reader = decoder.readable.getReader();
    buf = '';
    resetSd();
    setConnected(true);
    updateSdUI();
    renderSdList();
    log('Connected. The Arduino restarts when the port opens - wait ~4 seconds (it checks the SD card).');
    readLoop();
    // backup: if the Arduino did not say READY, ask for the SD status anyway
    setTimeout(() => { if (writer && sd.ok === null) send('S\n'); }, 6000);
  } catch (err) {
    port = null;
    log('Connect failed: ' + err.message);
    alert('Could not connect: ' + err.message + '\nPick your Arduino in the popup and click Connect.');
  }
}

async function readLoop() {
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i).trim());
        buf = buf.slice(i + 1);
      }
    }
  } catch (err) {
    log('Read error: ' + err.message);
  }
  if (port && !disconnecting) {            // cable pulled out or Arduino reset
    log('Connection lost.');
    disconnectArduino();
  }
}

async function disconnectArduino() {
  disconnecting = true;
  stopReplayFlag = true;
  stopTest();
  stopRecording();                       // save any manual recording in progress
  try {
    if (reader) await reader.cancel();
    if (readClosed) await readClosed.catch(() => {});
    if (writer) writer.releaseLock();
    if (port) await port.close();
  } catch (err) { /* ignore */ }
  port = writer = reader = readClosed = null;
  buf = '';
  pausedMemory = false;
  resetSd();
  setConnected(false);
  resetReadings();
  updateSdUI();
  renderSdList();
  log('Disconnected.');
  disconnecting = false;
}

// Lamp on / off. Sends the single characters the Arduino understands ('1' / '0').
// The lamp state shown on the page changes only when the Arduino answers LAMP,...
async function sendCommand(name) {
  if (!writer) { alert('Connect the Arduino first (🔌 CONNECT ARDUINO).'); return; }
  if (!CMD[name]) return;
  await send(CMD[name]);
  log('→ sent lamp ' + name + ' (waiting for the lamp to answer)');
}

// ---------- Brightness slider ----------
let brightTimer = null;
function setBrightness(v) {
  v = Math.max(5, +v);                       // the lamp never goes below 5% from the slider
  $('#bright-val').textContent = v + '%';
  if (!writer) return;
  clearTimeout(brightTimer);
  brightTimer = setTimeout(() => send('B' + v + '\n'), 150);
}

// ---------- Test Lab ----------
// Two ways to test:
//   1) pick a color  -> sends  C<number>  and the lamp shows EXACTLY that palette color
//   2) move a slider -> sends  T<temp>,<hum>,<light%>  and the lamp works out the color
let testing = false, testTimer = null, testColor = null;

function testSend() {
  if (!writer || !testing) return;
  const msg = testColor !== null
    ? 'C' + testColor + '\n'
    : 'T' + $('#test-temp').value + ',' + $('#test-hum').value + ',' + $('#test-light').value + '\n';
  send(msg);
}

function testLabels() {
  $('#test-temp-val').textContent = (+$('#test-temp').value).toFixed(1) + ' °C';
  $('#test-hum-val').textContent = $('#test-hum').value + ' %';
  $('#test-light-val').textContent = $('#test-light').value + ' %';
}

function testChange() { testLabels(); testSend(); }

function testSliderMoved() {            // the user moved a slider: leave "exact color" mode
  testColor = null;
  testChange();
}

function startTest() {
  if (!writer) { alert('Connect the Arduino first (🔌 CONNECT ARDUINO).'); return; }
  if (session || replaying) { alert('Stop the recording or replay first.'); return; }
  testing = true;
  $('#replay-badge').textContent = '🧪 TESTING';
  $('#replay-badge').style.display = '';
  $('#test-state').textContent = testColor !== null
    ? 'Test is ON. The lamp shows ' + PALETTE[testColor].name + '.'
    : 'Test is ON. The lamp shows the values above.';
  testSend();
  clearInterval(testTimer);
  testTimer = setInterval(testSend, 3000);     // keep the lamp holding the test
}

function stopTest() {
  if (!testing) return;
  testing = false;
  testColor = null;
  clearInterval(testTimer);
  ignoreUntil = Date.now() + 2500;
  $('#replay-badge').style.display = 'none';
  $('#test-state').textContent = 'Test is off. The lamp follows the room.';
  send('X\n');                                  // back to live readings
}

// Test Lab color picker: the lamp shows exactly the color you clicked
function pickColor(i) {
  const c = PALETTE[i];
  testColor = i;
  $('#pal-detail').innerHTML = 'The lamp is showing <strong>' + c.name + '</strong>. In a real room this color comes from about: temperature <strong>' +
    c.t.toFixed(1) + ' °C</strong>, humidity <strong>' + c.h + ' %</strong>, light level <strong>' + c.l + ' %</strong>';
  $('#test-temp').value = c.t;
  $('#test-hum').value = c.h;
  $('#test-light').value = c.l;
  testLabels();
  markActive(c.name);
  setWheel(i);
  if (testing) {
    $('#test-state').textContent = 'Test is ON. The lamp shows ' + c.name + '.';
    testSend();
  } else startTest();
}

function markActive(name) {
  $$('.pal-item').forEach(b => b.classList.toggle('active', b.dataset.name === name));
}

// Sunset wheel: the palette colors around a circle, dark at the top going clockwise to white
function buildWheel() {
  const n = PALETTE.length;
  const stops = PALETTE.map((c, i) => c.hex + ' ' + ((i + 0.5) / n * 360).toFixed(2) + 'deg').join(', ');
  $('#wheel').style.background = 'conic-gradient(from 0deg, ' + stops + ')';
}

function wheelClick(e) {
  const rect = $('#wheel').getBoundingClientRect();
  const dx = e.clientX - (rect.left + rect.width / 2);
  const dy = e.clientY - (rect.top + rect.height / 2);
  const R = rect.width / 2;
  const dist = Math.hypot(dx, dy);
  if (dist < R * 0.5 || dist > R) return;                 // only the colored ring counts
  let angle = Math.atan2(dx, -dy);                          // 0 = top, clockwise
  if (angle < 0) angle += Math.PI * 2;
  pickColor(Math.min(PALETTE.length - 1, Math.floor(angle / (Math.PI * 2) * PALETTE.length)));
}

function setWheel(i) {
  const c = PALETTE[i];
  const a = (i + 0.5) / PALETTE.length * Math.PI * 2;
  const m = $('#wheel-marker');
  m.style.display = '';
  m.style.left = (50 + 37.5 * Math.sin(a)) + '%';
  m.style.top  = (50 - 37.5 * Math.cos(a)) + '%';
  $('#wheel-name').textContent = c.name;
  $('#wheel-vals').innerHTML = '🌡 ' + c.t.toFixed(1) + ' °C<br>💧 ' + c.h + ' % humidity<br>☀ ' + c.l + ' % light';
  const hole = $('#wheel-hole');
  hole.style.borderColor = c.hex;
  hole.style.boxShadow = '0 0 30px ' + c.hex;
}

function buildPicker() {
  const grid = $('#pal-grid');
  PALETTE.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'pal-item';
    b.dataset.name = c.name;
    b.onclick = () => pickColor(i);
    b.innerHTML = '<span class="pal-dot" style="background:' + c.hex + '"></span>' +
      '<span class="pal-text"><b>' + c.name + '</b><small>' + c.t.toFixed(1) + ' °C · ' + c.h + ' % · ' + c.l + ' %</small></span>';
    grid.appendChild(b);
  });
}

// ---------- Lines from the Arduino ----------
// DATA,temp,hum,ldr,r,g,b,colorName,lightPercent    (every 2 seconds, and on every replayed/tested reading)
// READY | LAMP,.. | SDSTAT,.. | MODE,.. | MEMORY,.. | SDLIST,.. | SDITEM,.. | SDDL,.. | SDROW,.. | SDDEL,..
function handleLine(line) {
  if (!line) return;

  if (line.startsWith('SDROW,')) {                         // a row of the file being downloaded (not logged)
    if (dl) {
      dl.rows.push(line.slice(6));
      bumpDl();
      if (dl.rows.length % 20 === 0) sdMsg('Reading from the SD card... ' + dl.rows.length + ' rows');
    }
    return;
  }

  log(line);
  const p = line.split(',');

  switch (p[0]) {
    case 'READY':
      send('S\n');
      return;
    case 'LAMP':
      $('#lamp-state').textContent = 'Lamp: ' + p[1];
      return;
    case 'SDSTAT':
      sd.ok = p[1] === 'OK';
      updateSdUI();
      return;
    case 'SDREC':
      sd.autoRec = p[1] === 'ON';
      if (!sd.autoRec && lampMode === 'RECORDING') setLampMode('DAYOFF');
      else if (sd.autoRec && lampMode === 'DAYOFF') setLampMode('');
      updateSdUI();
      return;
    case 'SDLIST':
      if (p[1] === 'BEGIN') sd.files = [];
      else if (p[1] === 'END') { sd.ok = true; sdMsg(''); updateSdUI(); renderSdList(); }
      return;
    case 'SDITEM':
      sd.files.push({ num: +p[1], size: +p[2] });
      return;
    case 'SDDL':
      if (!dl) return;
      if (p[1] === 'END') {
        const d = dl; dl = null;
        clearTimeout(d.timer);
        d.resolve(parseSdRows(d.rows));
      } else if (p[1] === 'ERR') {
        const d = dl; dl = null;
        clearTimeout(d.timer);
        d.reject(new Error(p[2] === 'NOCARD' ? 'No SD card found.'
          : p[2] === 'NOFILE' ? 'The lamp has no saved memory file yet.'
          : 'The lamp is recording to the SD card right now (daytime). Try again at night.'));
      }
      return;
    case 'SDDEL':
      if (p[1] === 'OK') { sdMsg('Deleted ' + SD_FILE + '.'); send('F\n'); }
      else sdMsg('⚠ Could not delete (the file may be in use).');
      return;
    case 'MODE':
      if (p[1] === 'RECORDING') setLampMode('RECORDING');
      else if (p[1] === 'REPLAYING_MEMORY') {
        if (session) {                     // night began during a manual recording: keep the live room
          pausedMemory = true;
          ignoreUntil = Date.now() + 2500;
          send('N\n');
        }
        setLampMode('REPLAYING');
      }
      else if (p[1] === 'NIGHT_BUT_NO_MEMORY_YET') setLampMode('NOMEMORY');
      else if (p[1] === 'LIVE') setLampMode('LIVE');
      return;
    case 'MEMORY':
      if (p[1] === 'SAVED') { memNote = 'The lamp saved its daytime recording to the SD card (' + SD_FILE + ').'; if (!dl) send('F\n'); }
      else if (p[1] === 'TOO_SHORT_NOT_SAVED') memNote = 'The lamp\'s last daytime recording was too short, so it was not saved. The previous memory was kept.';
      else if (p[1] === 'REC_DISCARDED') memNote = 'Automatic SD recording was turned off. The unfinished recording was discarded and the previous saved memory was kept.';
      else if (p[1] === 'ERASED') { memNote = 'Memory erased.'; setLampMode(''); }
      else memNote = 'SD card problem (' + p[1] + '). The previous saved memory was kept.';
      updateSdUI();
      return;
    case 'DATA':
      break;
    default:
      return;
  }

  if (p.length < 8) return;
  const [, t, h, ldr, r, g, b, name, pct] = p;
  const hex = '#' + [r, g, b].map(v => (+v).toString(16).padStart(2, '0')).join('').toUpperCase();
  const lp = pct !== undefined ? +pct : null;
  const level = lp === null ? lightLabel(+ldr) : (lp < 35 ? 'LOW' : lp < 70 ? 'MEDIUM' : 'HIGH');

  $$('.temp-value').forEach(e => e.textContent = t + ' °C');
  $$('.humidity-value').forEach(e => e.textContent = h + ' %');
  $$('.light-value').forEach(e => e.textContent = level + ' · ' + ldr);
  $$('.color-preview').forEach(e => { e.style.backgroundColor = hex; e.style.boxShadow = '0 0 40px ' + hex; });
  $$('.color-name').forEach(e => e.textContent = name);
  markActive(name);                                                                  // highlight it in the Test Lab
  if (+r + +g + +b > 0) document.documentElement.style.setProperty('--lamp', hex);   // dashboard follows the lamp

  if (session && !replaying && !testing && Date.now() > ignoreUntil) {
    const now = Date.now();
    session.samples.push({
      ts: now, sec: Math.round((now - session.start) / 1000),
      t: +t, h: +h, ldr: +ldr, r: +r, g: +g, b: +b, p: lp,
      ci: PALETTE.findIndex(c => c.name === name)
    });
    updateRecUI();
    if (session.samples.length >= MAX_SAMPLES) {
      stopRecording();
      alert('Reached the maximum recording length (about 2 hours). It was saved.');
    }
  }
}

// ---------- Replay (loops until you press Stop) ----------
let replaying = false, stopReplayFlag = false, replayStart = 0;

function updateReplayUI() {
  if (replaying) $('#replay-elapsed').textContent = fmtClock(Math.floor((Date.now() - replayStart) / 1000));
}

function replaySession(id) {
  if (!canStartSomething()) return;
  const s = sessions.find(x => String(x.id) === String(id));
  if (s) playSession(s);
}

async function playSession(s) {
  if (!writer || replaying) return;
  const n = s.samples.length;
  if (!n) return;

  switchPage('replay');
  const name = s.name || 'Untitled recording';
  let loops = 0, endMsg = 'Stopped.';

  replaying = true;
  stopReplayFlag = false;
  replayStart = Date.now();
  $('#replay-now').textContent = name;
  $('#replay-badge').textContent = '▶ REPLAYING';
  $('#replay-badge').style.display = '';

  try {
    do {
      loops++;
      for (let i = 0; i < n && !stopReplayFlag; i++) {
        const x = s.samples[i];
        const when = (x.ts !== undefined && !s.fromSd)
          ? 'recorded at ' + new Date(x.ts).toLocaleTimeString()
          : 'about ' + fmtClock(secOf(s, x)) + ' into the recording';
        $('#replay-pos').textContent = 'Reading ' + (i + 1) + ' of ' + n + ' · Loop ' + loops + ' · ' + when;
        $('#replay-fill').style.width = ((i + 1) / n * 100) + '%';
        // New recordings carry the exact lamp color (H). Old ones only have the sensor values (P).
        const cmd = (x.r !== undefined && x.r + x.g + x.b > 0)
          ? 'H' + [x.t, x.h, x.ldr, x.r, x.g, x.b, x.p ?? 0].join(',') + '\n'
          : 'P' + x.t + ',' + x.h + ',' + x.ldr + '\n';
        await writer.write(enc(cmd));
        await sleepStop(+$('#replay-speed').value);
      }
    } while (!stopReplayFlag && $('#replay-loop').checked);
    if (!stopReplayFlag) endMsg = 'Finished.';
  } catch (err) {
    endMsg = 'Stopped: ' + err.message;
  }

  replaying = false;
  ignoreUntil = Date.now() + 2500;
  send('X\n');                                           // back to live readings
  $('#replay-badge').style.display = 'none';
  $('#replay-now').textContent = 'Nothing playing';
  $('#replay-pos').textContent = endMsg;
  $('#replay-fill').style.width = '0';
}

function replayPicked() {
  const id = $('#replay-pick').value;
  if (!id) { $('#replay-pos').textContent = 'No recording selected.'; return; }
  replaySession(id);
}

function stopReplay() { stopReplayFlag = true; }

// ---------- Start ----------
tickClock();
setInterval(() => { tickClock(); updateRecUI(); updateReplayUI(); }, 1000);
renderSessions();
renderSdList();
updateSdUI();
buildPicker();
buildWheel();
testLabels();
