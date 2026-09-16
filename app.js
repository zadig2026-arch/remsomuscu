// ===== RemsoMuscu =====
// PWA vanilla, tout est stocké sur le téléphone (localStorage + IndexedDB pour
// les photos). Même socle que l'app Sport, adapté au poids de corps : chaque
// exercice est une ÉCHELLE de niveaux, et la progression se fait en montant
// d'un niveau quand la fourchette haute de reps est atteinte deux fois de suite.

const LS_KEY = 'remsomuscu-v1';
const DEMO_BASE = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises';

const state = loadState();
let P = null;               // programme.json
let currentSessionId = null;
let demoIntervals = [];

// ===== State =====
function loadState() {
  let s;
  try { s = JSON.parse(localStorage.getItem(LS_KEY)) || defaultState(); }
  catch { s = defaultState(); }
  const d = defaultState();
  for (const k of Object.keys(d)) if (s[k] === undefined) s[k] = d[k];
  return s;
}
function defaultState() {
  return {
    onboarded: false,
    test: {},            // résultats du test de placement
    levels: {},          // { echelleId: index de niveau }
    streaks: {},         // { echelleId: nb de séances consécutives au max }
    pendingUp: {},       // { echelleId: true } proposition de monter
    pendingDown: {},     // { echelleId: true } proposition de descendre
    weekBase: 1,         // semaine au moment du dernier réglage manuel
    sessionsAtBase: 0,   // nb de séances dans l'historique à ce moment-là
    buffer: {},          // { sessionId: { exKey: { setIdx: { v: '12', done: true } } } }
    history: [],         // plus récent en tête
    weights: [],         // [{ date, kg }]
    measures: [],        // [{ date, taille, poitrine, bras, epaules }]
    lastSession: null
  };
}
function saveState() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
function today() { return new Date().toISOString().slice(0, 10); }
function fmtDate(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y.slice(2)}`; }

// ===== Init =====
async function init() {
  try {
    const res = await fetch('./data/programme.json');
    P = await res.json();
  } catch {
    document.body.innerHTML = '<p style="padding:20px;color:#f66">Impossible de charger le programme. Ouvre l\'app via un serveur HTTP, pas en file://.</p>';
    return;
  }
  setupTabs();
  setupSettings();
  setupOnboarding();
  setupSuivi();
  setupPhotos();
  setupCollapsibles();
  registerSW();
  setupWakeLock();

  if (!state.onboarded) {
    openOnboarding();
  } else {
    refreshAll();
  }
}

function refreshAll() {
  renderPhaseBadge();
  populateSessionSelect();
  renderSession();
  renderProgramme();
  renderSuivi();
}

// ===== Semaine / phase =====
function currentWeek() {
  const done = Math.max(0, state.history.length - state.sessionsAtBase);
  return state.weekBase + Math.floor(done / 3);
}
function currentPhase() {
  const w = currentWeek();
  return P.phases.find(p => w >= p.de && w <= p.a) || P.phases[P.phases.length - 1];
}
function renderPhaseBadge() {
  const ph = currentPhase();
  document.getElementById('current-phase').textContent = `Phase ${ph.numero} · S${currentWeek()}`;
}

// ===== Tabs =====
function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'suivi') renderSuivi();
      if (btn.dataset.tab === 'programme') renderProgramme();
      window.scrollTo(0, 0);
    });
  });
}

function setupCollapsibles() {
  const bind = (cardId, toggleId) => {
    const card = document.getElementById(cardId);
    document.getElementById(toggleId).onclick = () => card.classList.toggle('collapsed');
  };
  bind('warmup-card', 'warmup-toggle');
  bind('stretch-card', 'stretch-toggle');
}

// ===== Échelles =====
function ladder(id) { return P.echelles[id]; }
function levelIdx(id) {
  const l = ladder(id);
  const i = state.levels[id] ?? 0;
  return Math.max(0, Math.min(i, l.niveaux.length - 1));
}
function level(id) { return ladder(id).niveaux[levelIdx(id)]; }
function setLevel(id, idx) {
  const l = ladder(id);
  state.levels[id] = Math.max(0, Math.min(idx, l.niveaux.length - 1));
  state.streaks[id] = 0;
  delete state.pendingUp[id];
  delete state.pendingDown[id];
  saveState();
}
function targetText(lv, series) {
  const unit = lv.hold ? 's' : 'reps';
  const side = lv.parCote ? ' / côté' : '';
  return `${series} × ${lv.min}-${lv.max} ${unit}${side}`;
}

// Test de placement → niveau de départ par échelle
function computeLevelsFromTest(test) {
  const levels = {};
  for (const [id, l] of Object.entries(P.echelles)) {
    const pl = l.placement || {};
    if (!pl.epreuve) { levels[id] = pl.defaut ?? 0; continue; }
    const v = Number(test[pl.epreuve] ?? 0);
    let idx = 0;
    for (const [seuil, lvl] of pl.seuils) { if (v >= seuil) { idx = lvl; break; } }
    levels[id] = Math.min(idx, l.niveaux.length - 1);
  }
  return levels;
}

// ===== Séance =====
function populateSessionSelect() {
  const sel = document.getElementById('session-select');
  sel.innerHTML = '';
  P.seances.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.nom;
    sel.appendChild(opt);
  });
  currentSessionId = nextRotationSessionId();
  sel.value = currentSessionId;
  sel.onchange = () => { currentSessionId = sel.value; renderSession(); };
}
function nextRotationSessionId() {
  const i = P.seances.findIndex(s => s.id === state.lastSession);
  return P.seances[(i + 1) % P.seances.length].id;
}
function getCurrentSession() { return P.seances.find(s => s.id === currentSessionId); }

// Nombre de séries effectif selon la phase (phase 1 : 3 séries max sur les principaux)
function effectiveSeries(exo, phase) {
  if (exo.principal) return Math.min(exo.series, phase.series_max);
  return exo.series;
}

function renderSession() {
  const session = getCurrentSession();
  if (!session) return;
  demoIntervals.forEach(clearInterval); demoIntervals = [];
  const phase = currentPhase();

  document.getElementById('session-intro').textContent =
    `${session.focus} · Phase ${phase.numero} « ${phase.nom} » (semaines ${phase.semaines})${phase.amrap ? ' · dernière série des exercices principaux à l\'échec' : ''}`;

  renderBanners();
  renderWarmup();

  const container = document.getElementById('exercises');
  container.innerHTML = '';
  session.blocs.forEach((bloc, bi) => {
    const title = document.createElement('h3');
    title.className = 'bloc-title';
    title.textContent = bloc.nom;
    container.appendChild(title);
    bloc.exos.forEach((exo, ei) => {
      container.appendChild(renderExerciseCard(session, exo, `${bi}-${ei}`, phase));
    });
  });

  renderStretch();
}

function renderBanners() {
  const el = document.getElementById('banners');
  el.innerHTML = '';
  const ids = new Set([...Object.keys(state.pendingUp), ...Object.keys(state.pendingDown)]);
  ids.forEach(id => {
    const l = ladder(id);
    const cur = level(id);
    const idx = levelIdx(id);
    const up = state.pendingUp[id] && idx < l.niveaux.length - 1;
    const down = state.pendingDown[id] && idx > 0;
    if (!up && !down) { delete state.pendingUp[id]; delete state.pendingDown[id]; saveState(); return; }
    const next = up ? l.niveaux[idx + 1] : l.niveaux[idx - 1];
    const b = document.createElement('div');
    b.className = 'banner' + (up ? '' : ' down');
    b.innerHTML = up
      ? `🎉 <strong>${l.nom}</strong> : tu as tenu le haut de la fourchette sur « ${cur.nom} » deux séances de suite. On passe à <strong>« ${next.nom} »</strong> (${next.min}-${next.max} ${next.hold ? 's' : 'reps'}) ?`
      : `<strong>${l.nom}</strong> : « ${cur.nom} » semble encore trop dur (toutes les séries sous le minimum). Redescendre sur <strong>« ${next.nom} »</strong> le temps de consolider ?`;
    const row = document.createElement('div'); row.className = 'row';
    const yes = document.createElement('button'); yes.className = 'primary'; yes.textContent = up ? 'Oui, niveau suivant' : 'Oui, je redescends';
    const no = document.createElement('button'); no.className = 'ghost'; no.textContent = up ? 'Pas encore' : 'Non, je continue';
    yes.onclick = () => { setLevel(id, up ? idx + 1 : idx - 1); renderSession(); toast(up ? `Nouveau niveau : ${next.nom}` : `Retour sur : ${next.nom}`); };
    no.onclick = () => { delete state.pendingUp[id]; delete state.pendingDown[id]; state.streaks[id] = 0; saveState(); renderSession(); };
    row.appendChild(yes); row.appendChild(no);
    b.appendChild(row);
    el.appendChild(b);
  });
}

function renderWarmup() {
  document.getElementById('warmup-duration').textContent = `· ${P.echauffement.duree_min} min`;
  const list = document.getElementById('warmup-list');
  list.innerHTML = '';
  P.echauffement.items.forEach(it => list.appendChild(renderCheckRow(it.nom, it.detail, it.demo, null)));
}

function renderStretch() {
  document.getElementById('stretch-duration').textContent = `· ${P.etirements.duree_min} min`;
  document.getElementById('stretch-consigne').textContent = P.etirements.consigne;
  const list = document.getElementById('stretch-list');
  list.innerHTML = '';
  P.etirements.items.forEach(it => {
    const detail = `${it.secs} s${it.cotes === 2 ? ' par côté' : ''} · ${it.detail}`;
    list.appendChild(renderCheckRow(it.nom, detail, it.demo, it.secs));
  });
}

// Ligne cochable générique (échauffement, étirements, souplesse)
function renderCheckRow(name, detail, demo, holdSecs) {
  const row = document.createElement('div');
  row.className = 'check-row';
  if (demo) row.appendChild(renderDemoThumb(demo, name));
  const info = document.createElement('div'); info.className = 'check-info';
  info.innerHTML = `<div class="check-name">${name}</div>${detail ? `<div class="check-detail">${detail}</div>` : ''}`;
  row.appendChild(info);
  if (holdSecs) {
    const hb = document.createElement('button'); hb.className = 'hold-btn'; hb.textContent = `▶ ${holdSecs} s`;
    hb.onclick = () => startTimer(holdSecs, 'Maintien', () => { row.classList.add('done'); chk.classList.add('checked'); });
    row.appendChild(hb);
  }
  const chk = document.createElement('button'); chk.className = 'check-btn'; chk.textContent = '✓';
  chk.onclick = () => { chk.classList.toggle('checked'); row.classList.toggle('done'); };
  row.appendChild(chk);
  return row;
}

function renderDemoThumb(slug, name) {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'demo-thumb';
  btn.setAttribute('aria-label', `Voir la démo de ${name}`);
  const base = `${DEMO_BASE}/${encodeURIComponent(slug)}`;
  const mk = (i, cls) => { const im = document.createElement('img'); im.className = `demo-frame ${cls}`; im.src = `${base}/${i}.jpg`; im.alt = i === 0 ? name : ''; im.loading = 'lazy'; im.decoding = 'async'; return im; };
  const a = mk(0, 'demo-frame-a'), b = mk(1, 'demo-frame-b');
  a.onerror = () => btn.remove();
  btn.appendChild(a); btn.appendChild(b);
  const play = document.createElement('span'); play.className = 'demo-play'; play.textContent = '▶'; btn.appendChild(play);
  demoIntervals.push(setInterval(() => btn.classList.toggle('flipped'), 1200));
  btn.onclick = () => openDemoModal(slug, name);
  return btn;
}

function openDemoModal(slug, name) {
  const modal = document.createElement('div'); modal.className = 'demo-modal';
  const content = document.createElement('div'); content.className = 'demo-modal-content';
  content.onclick = e => e.stopPropagation();
  const base = `${DEMO_BASE}/${encodeURIComponent(slug)}`;
  content.innerHTML = `<h2>${name}</h2>
    <div class="demo-modal-frame"><img class="demo-frame demo-frame-a" src="${base}/0.jpg" alt="${name}"><img class="demo-frame demo-frame-b" src="${base}/1.jpg" alt=""></div>
    <p class="demo-modal-hint">Position de départ ↔ fin de mouvement (illustration proche, lis la consigne)</p>`;
  const close = document.createElement('button'); close.className = 'ghost'; close.textContent = 'Fermer';
  content.appendChild(close); modal.appendChild(content);
  const frame = content.querySelector('.demo-modal-frame');
  const t = setInterval(() => frame.classList.toggle('flipped'), 900);
  const cleanup = () => { clearInterval(t); modal.remove(); };
  modal.onclick = cleanup; close.onclick = cleanup;
  document.body.appendChild(modal);
}

function renderExerciseCard(session, exo, exKey, phase) {
  const id = exo.echelle;
  const l = ladder(id);
  const idx = levelIdx(id);
  const lv = l.niveaux[idx];
  const series = effectiveSeries(exo, phase);
  const amrap = phase.amrap && exo.principal;

  const card = document.createElement('div');
  card.className = 'exercise-card';

  const header = document.createElement('div'); header.className = 'exercise-header';
  if (lv.demo) header.appendChild(renderDemoThumb(lv.demo, lv.nom));
  const h3 = document.createElement('h3'); h3.textContent = lv.nom;
  header.appendChild(h3);
  card.appendChild(header);

  // Ligne de niveau : échelle + boutons ▼ ▲
  const lrow = document.createElement('div'); lrow.className = 'level-row';
  const chip = document.createElement('div'); chip.className = 'level-chip';
  chip.textContent = `${l.nom} · niveau ${idx + 1}/${l.niveaux.length}`;
  const down = document.createElement('button'); down.className = 'level-btn'; down.textContent = '▼'; down.disabled = idx === 0;
  down.setAttribute('aria-label', 'Niveau plus facile');
  const up = document.createElement('button'); up.className = 'level-btn'; up.textContent = '▲'; up.disabled = idx >= l.niveaux.length - 1;
  up.setAttribute('aria-label', 'Niveau plus dur');
  down.onclick = () => { setLevel(id, idx - 1); clearBuffer(session.id, exKey); renderSession(); };
  up.onclick = () => { setLevel(id, idx + 1); clearBuffer(session.id, exKey); renderSession(); };
  lrow.appendChild(chip); lrow.appendChild(down); lrow.appendChild(up);
  card.appendChild(lrow);

  const meta = document.createElement('div'); meta.className = 'exercise-meta';
  meta.textContent = `${targetText(lv, series)} · repos ${formatRest(exo.repos_s)} · ${l.muscle}`;
  card.appendChild(meta);

  if (lv.consigne) { const n = document.createElement('div'); n.className = 'exercise-note'; n.textContent = lv.consigne; card.appendChild(n); }
  if (exo.note) { const n = document.createElement('div'); n.className = 'exercise-start'; n.textContent = exo.note; card.appendChild(n); }

  const prev = getPrevious(id, idx);
  if (prev) { const p = document.createElement('div'); p.className = 'prev-load'; p.textContent = prev; card.appendChild(p); }

  const setsWrap = document.createElement('div'); setsWrap.className = 'sets';
  for (let i = 0; i < series; i++) {
    setsWrap.appendChild(renderSetRow(session.id, exKey, i, exo.repos_s, lv, amrap && i === series - 1));
  }
  card.appendChild(setsWrap);

  const restBtn = document.createElement('button'); restBtn.className = 'rest-btn';
  restBtn.textContent = `⏱ Lancer repos ${formatRest(exo.repos_s)}`;
  restBtn.onclick = () => startTimer(exo.repos_s, 'Repos');
  card.appendChild(restBtn);
  return card;
}

function bufferGet(sessionId, exKey, setIdx) { return state.buffer[sessionId]?.[exKey]?.[setIdx] || {}; }
function bufferSet(sessionId, exKey, setIdx, patch) {
  state.buffer[sessionId] = state.buffer[sessionId] || {};
  state.buffer[sessionId][exKey] = state.buffer[sessionId][exKey] || {};
  state.buffer[sessionId][exKey][setIdx] = { ...bufferGet(sessionId, exKey, setIdx), ...patch };
  saveState();
}
function clearBuffer(sessionId, exKey) { if (state.buffer[sessionId]) { delete state.buffer[sessionId][exKey]; saveState(); } }

function renderSetRow(sessionId, exKey, setIdx, restS, lv, isAmrap) {
  const row = document.createElement('div'); row.className = 'set-row';
  const lbl = document.createElement('div'); lbl.className = 'set-label' + (isAmrap ? ' amrap' : '');
  lbl.textContent = isAmrap ? `S${setIdx + 1} échec` : `S${setIdx + 1}`;
  row.appendChild(lbl);

  const input = document.createElement('input');
  input.type = 'number'; input.inputMode = 'numeric';
  input.placeholder = lv.hold ? `${lv.min}-${lv.max} s` : `${lv.min}-${lv.max}`;
  const saved = bufferGet(sessionId, exKey, setIdx);
  input.value = saved.v ?? '';
  input.oninput = () => bufferSet(sessionId, exKey, setIdx, { v: input.value });
  row.appendChild(input);

  const unit = document.createElement('div'); unit.className = 'set-unit'; unit.textContent = lv.hold ? 's' : 'reps';
  row.appendChild(unit);

  const check = document.createElement('button'); check.className = 'set-check'; check.textContent = '✓';
  if (saved.done) check.classList.add('checked');
  const markDone = (now) => {
    check.classList.toggle('checked', now);
    bufferSet(sessionId, exKey, setIdx, { done: now });
  };
  check.onclick = () => {
    const now = !check.classList.contains('checked');
    markDone(now);
    if (now && restS) startTimer(restS, 'Repos');
  };

  if (lv.hold) {
    const hb = document.createElement('button'); hb.className = 'hold-btn'; hb.textContent = `▶ ${lv.max} s`;
    hb.onclick = () => startTimer(lv.max, 'Maintien', () => {
      if (!input.value) { input.value = lv.max; bufferSet(sessionId, exKey, setIdx, { v: String(lv.max) }); }
      markDone(true);
      if (restS) setTimeout(() => startTimer(restS, 'Repos'), 600);
    });
    row.appendChild(hb);
  }
  row.appendChild(check);
  return row;
}

// « Dernière fois » : dernière séance où cette échelle a été faite.
function getPrevious(echelleId, idx) {
  for (const h of state.history) {
    const e = h.exercises.find(x => x.echelle === echelleId);
    if (e && e.sets.length) {
      const vals = e.sets.map(s => s.v).join(' · ');
      if (e.level === idx) return `Dernière fois : ${vals}${e.hold ? ' s' : ''}`;
      return `Dernière fois (« ${e.nom} ») : ${vals}${e.hold ? ' s' : ''}`;
    }
  }
  return null;
}

function formatRest(s) {
  if (!s) return '';
  const m = Math.floor(s / 60), r = s % 60;
  return m === 0 ? `${r} s` : (r === 0 ? `${m} min` : `${m}:${String(r).padStart(2, '0')}`);
}

document.getElementById('btn-finish-session').onclick = finishSession;

function finishSession() {
  const session = getCurrentSession();
  if (!session) return;
  const phase = currentPhase();
  const exercises = [];
  const upgrades = [];

  session.blocs.forEach((bloc, bi) => {
    bloc.exos.forEach((exo, ei) => {
      const exKey = `${bi}-${ei}`;
      const id = exo.echelle;
      const idx = levelIdx(id);
      const lv = level(id);
      const series = effectiveSeries(exo, phase);
      const sets = [];
      for (let i = 0; i < series; i++) {
        const b = bufferGet(session.id, exKey, i);
        if (b.v !== undefined && b.v !== '') sets.push({ v: Number(b.v), done: !!b.done });
      }
      if (!sets.length) return;
      exercises.push({ echelle: id, nom: lv.nom, level: idx, hold: !!lv.hold, sets });

      // Double progression : toutes les séries saisies ET toutes ≥ max → streak
      const complete = sets.length === series;
      const allMax = complete && sets.every(s => s.v >= lv.max);
      const allBelowMin = complete && sets.every(s => s.v < lv.min);
      const l = ladder(id);
      if (allMax) {
        state.streaks[id] = (state.streaks[id] || 0) + 1;
        if (state.streaks[id] >= 2 && idx < l.niveaux.length - 1) { state.pendingUp[id] = true; upgrades.push(l.nom); }
      } else {
        state.streaks[id] = 0;
      }
      if (allBelowMin && idx > 0) state.pendingDown[id] = true; else delete state.pendingDown[id];
    });
  });

  const hasData = exercises.length > 0;
  if (hasData) {
    state.history.unshift({
      date: today(), sessionId: session.id, sessionName: session.nom,
      phaseId: phase.id, week: currentWeek(), exercises
    });
    state.lastSession = session.id;
  }
  delete state.buffer[session.id];
  saveState();

  if (hasData) {
    const next = P.seances.find(s => s.id === nextRotationSessionId());
    toast(`Séance enregistrée 💪 Prochaine : ${next.nom}` + (upgrades.length ? ` · niveau à valider : ${upgrades.join(', ')}` : ''), 4500);
  } else {
    toast('Séance réinitialisée (rien de saisi).');
  }
  renderPhaseBadge();
  populateSessionSelect();
  renderSession();
  window.scrollTo(0, 0);
}

// ===== Timer (repos ou maintien) =====
// Calé sur une heure de fin absolue : iOS suspend le JS quand l'écran se
// verrouille, on resynchronise au retour (voir resyncTimer).
let timerInterval = null, timerEndAt = null, timerDone = null;

function startTimer(seconds, label, onDone) {
  timerEndAt = Date.now() + seconds * 1000;
  timerDone = onDone || null;
  const el = document.getElementById('rest-timer');
  el.classList.remove('hidden');
  el.classList.toggle('hold', label === 'Maintien');
  document.getElementById('rest-label').textContent = label;
  updateTimerDisplay();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(tickTimer, 250);
}
function tickTimer() {
  if (timerEndAt === null) return;
  if (Date.now() >= timerEndAt) { finishTimer(true); return; }
  updateTimerDisplay();
}
function updateTimerDisplay() {
  if (timerEndAt === null) return;
  const r = Math.max(0, Math.ceil((timerEndAt - Date.now()) / 1000));
  document.getElementById('rest-display').textContent = `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
}
function finishTimer(completed) {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null; timerEndAt = null;
  document.getElementById('rest-timer').classList.add('hidden');
  const cb = timerDone; timerDone = null;
  if (completed) { beep(); vibrate([200, 100, 200]); if (cb) cb(); }
}
function resyncTimer() {
  if (timerEndAt === null) return;
  if (Date.now() >= timerEndAt) { finishTimer(true); return; }
  if (!timerInterval) timerInterval = setInterval(tickTimer, 250);
  updateTimerDisplay();
}
document.getElementById('rest-cancel').onclick = () => finishTimer(false);

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.1; o.start();
    setTimeout(() => { o.stop(); ctx.close(); }, 250);
  } catch {}
}
function vibrate(p) { if (navigator.vibrate) navigator.vibrate(p); }

let toastTimer = null;
function toast(msg, ms = 2800) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ===== Programme (onglet) =====
function renderProgramme() {
  document.getElementById('prog-titre').textContent = P.meta.titre;
  document.getElementById('prog-profil').textContent = P.meta.profil;
  document.getElementById('prog-materiel').textContent = `Matériel : ${P.meta.materiel}`;

  const cur = currentPhase();
  document.getElementById('prog-phases').innerHTML = P.phases.map(ph => `
    <div class="phase-item${ph.id === cur.id ? ' current' : ''}">
      <span class="phase-name">Phase ${ph.numero} · ${ph.nom}</span><span class="phase-weeks">semaines ${ph.semaines}</span>
      <div class="phase-desc">${ph.description}</div>
    </div>`).join('');

  document.getElementById('prog-seances').innerHTML = P.seances.map(s => `
    <div class="prog-seance">
      <div class="prog-seance-name">${s.nom}</div>
      <div class="prog-seance-focus">${s.focus}</div>
      ${s.blocs.map(b => b.exos.map(e => {
        const lv = level(e.echelle);
        return `<div class="prog-exo"><span>${lv.nom}</span><span>${targetText(lv, effectiveSeries(e, cur))}</span></div>`;
      }).join('')).join('')}
    </div>`).join('');

  document.getElementById('prog-echelles').innerHTML = Object.entries(P.echelles).map(([id, l]) => {
    const idx = levelIdx(id), lv = l.niveaux[idx], next = l.niveaux[idx + 1];
    const pct = Math.round(((idx + 1) / l.niveaux.length) * 100);
    return `<div class="ladder">
      <div class="ladder-head"><span class="ladder-name">${l.nom}</span><span class="ladder-lvl">niveau ${idx + 1}/${l.niveaux.length}</span></div>
      <div class="ladder-bar"><div style="width:${pct}%"></div></div>
      <div class="ladder-cur">Actuel : ${lv.nom} (${lv.min}-${lv.max} ${lv.hold ? 's' : 'reps'}${lv.parCote ? ' / côté' : ''})</div>
      ${next ? `<div class="ladder-next">Suivant : ${next.nom}</div>` : '<div class="ladder-next">Dernier niveau de l\'échelle 🏆</div>'}
    </div>`;
  }).join('');

  document.getElementById('prog-principes').innerHTML = P.principes.map(p => `<li>${p}</li>`).join('');

  const sp = P.souplesse_jour_off;
  document.getElementById('souplesse-titre').textContent = sp.titre;
  document.getElementById('souplesse-consigne').textContent = sp.consigne;
  const sl = document.getElementById('souplesse-list');
  sl.innerHTML = '';
  demoIntervalsProg();
  sp.items.forEach(it => sl.appendChild(renderCheckRow(it.nom, `${it.secs} s`, it.demo, it.secs)));

  const nu = P.nutrition;
  document.getElementById('nutrition-titre').textContent = nu.titre;
  document.getElementById('nutrition-intro').textContent = nu.intro;
  document.getElementById('nutrition-regles').innerHTML = nu.regles.map(r => `<li>${r}</li>`).join('');
  document.getElementById('nutrition-pesee').textContent = nu.pesee;
}
// Les vignettes de l'onglet Programme ont leurs propres intervalles ; on ne
// les purge pas avec celles de la séance (renderSession) pour ne pas figer
// l'onglet Séance quand on ré-affiche le Programme.
function demoIntervalsProg() {}

// ===== Suivi =====
function setupSuivi() {
  document.getElementById('btn-save-weight').onclick = () => {
    const v = parseFloat(document.getElementById('input-weight').value);
    if (!v || v < 30 || v > 250) { document.getElementById('weight-feedback').textContent = 'Poids invalide.'; return; }
    state.weights = state.weights.filter(w => w.date !== today());
    state.weights.push({ date: today(), kg: v });
    state.weights.sort((a, b) => a.date.localeCompare(b.date));
    saveState();
    document.getElementById('input-weight').value = '';
    document.getElementById('weight-feedback').textContent = weightFeedback(v);
    renderWeights();
  };
  document.getElementById('btn-save-measures').onclick = () => {
    const g = id => { const v = parseFloat(document.getElementById(id).value); return isNaN(v) ? null : v; };
    const m = { date: today(), taille: g('m-taille'), poitrine: g('m-poitrine'), bras: g('m-bras'), epaules: g('m-epaules') };
    if (m.taille === null && m.poitrine === null && m.bras === null && m.epaules === null) {
      document.getElementById('measures-feedback').textContent = 'Saisis au moins une mesure.'; return;
    }
    state.measures = state.measures.filter(x => x.date !== today());
    state.measures.push(m);
    state.measures.sort((a, b) => a.date.localeCompare(b.date));
    saveState();
    ['m-taille', 'm-poitrine', 'm-bras', 'm-epaules'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('measures-feedback').textContent = measuresFeedback();
    renderMeasures();
  };
  document.getElementById('btn-reset').onclick = () => {
    if (!confirm('Effacer TOUTES les données (niveaux, historique, poids, mesures, photos) ?')) return;
    localStorage.removeItem(LS_KEY);
    photoDB.clear().finally(() => location.reload());
  };
}

function renderSuivi() {
  renderWeights();
  renderMeasures();
  renderPhotos();
  renderHistorique();
}

function weightFeedback(latest) {
  const w = state.weights;
  if (w.length < 2) return `Enregistré : ${latest} kg. Reviens chaque semaine, même jour, à jeun.`;
  const prev = w[w.length - 2];
  const diff = +(latest - prev.kg).toFixed(1);
  const sign = diff > 0 ? '+' : '';
  if (w.length >= 4) {
    const avg = (latest - w[w.length - 4].kg) / 3;
    if (avg > 0.1) return `${sign}${diff} kg. Sur 3 semaines ça monte : resserre l'assiette (-200 kcal/j) et les calories liquides.`;
    if (avg < -0.7) return `${sign}${diff} kg. Ça descend trop vite, tu vas perdre du muscle : remonte un peu les protéines et les féculents.`;
  }
  if (diff <= -0.3 && diff >= -0.6) return `${sign}${diff} kg cette semaine. Pile dans la cible, continue.`;
  return `${sign}${diff} kg cette semaine. Cible : -0,3 à -0,5 kg. Juge sur 3 semaines.`;
}
function renderWeights() {
  const list = document.getElementById('weight-list');
  list.innerHTML = '';
  const recent = state.weights.slice(-8).reverse();
  if (!recent.length) list.innerHTML = '<div class="muted" style="grid-column:1/-1">Aucune pesée enregistrée.</div>';
  recent.forEach(w => { const el = document.createElement('div'); el.textContent = `${fmtDate(w.date)} · ${w.kg} kg`; list.appendChild(el); });
  drawChart(document.getElementById('weight-chart'), state.weights.map(w => w.kg), state.weights.map(w => w.date.slice(5)), 'Au moins 2 pesées pour tracer la courbe');
}

function measuresFeedback() {
  const m = state.measures;
  if (m.length < 2) return 'Première mesure enregistrée. La prochaine dans un mois.';
  const a = m[m.length - 2], b = m[m.length - 1];
  const parts = [];
  const d = (k, label, goodDown) => {
    if (a[k] == null || b[k] == null) return;
    const diff = +(b[k] - a[k]).toFixed(1);
    if (diff === 0) return;
    const good = goodDown ? diff < 0 : diff > 0;
    parts.push(`${label} ${diff > 0 ? '+' : ''}${diff} cm ${good ? '✅' : ''}`);
  };
  d('taille', 'Taille', true); d('poitrine', 'Poitrine', false); d('bras', 'Bras', false); d('epaules', 'Épaules', false);
  return parts.length ? parts.join(' · ') : 'Stable depuis la dernière mesure.';
}
function renderMeasures() {
  const el = document.getElementById('measures-list');
  el.innerHTML = '';
  const recent = state.measures.slice(-6).reverse();
  if (!recent.length) { el.innerHTML = '<div class="muted">Aucune mesure enregistrée.</div>'; return; }
  recent.forEach(m => {
    const vals = [['Taille', m.taille], ['Poitrine', m.poitrine], ['Bras', m.bras], ['Épaules', m.epaules]].filter(x => x[1] != null).map(x => `${x[0]} ${x[1]}`).join(' · ');
    const r = document.createElement('div'); r.className = 'm-row';
    r.innerHTML = `<span>${fmtDate(m.date)}</span><span>${vals} cm</span>`;
    el.appendChild(r);
  });
}

function drawChart(canvas, values, labels, emptyMsg) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) {
    ctx.fillStyle = '#8b94a0'; ctx.font = '15px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(emptyMsg, w / 2, h / 2); return;
  }
  const pad = 40;
  const min = Math.min(...values) - 1, max = Math.max(...values) + 1, span = (max - min) || 1;
  const xStep = (w - pad * 2) / (values.length - 1);
  const yOf = v => pad + (h - pad * 2) * (1 - (v - min) / span);
  ctx.strokeStyle = '#2a3038'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + (h - pad * 2) * (i / 4);
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
    ctx.fillStyle = '#8b94a0'; ctx.font = '11px system-ui'; ctx.textAlign = 'right';
    ctx.fillText((max - span * (i / 4)).toFixed(1), pad - 6, y + 4);
  }
  ctx.fillStyle = '#8b94a0'; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
  [0, Math.floor((values.length - 1) / 2), values.length - 1].forEach(i => { if (labels[i]) ctx.fillText(labels[i], pad + xStep * i, h - pad + 18); });
  ctx.strokeStyle = '#ff6b35'; ctx.lineWidth = 3; ctx.beginPath();
  values.forEach((v, i) => { const x = pad + xStep * i, y = yOf(v); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.stroke();
  ctx.fillStyle = '#ffa45c';
  values.forEach((v, i) => { ctx.beginPath(); ctx.arc(pad + xStep * i, yOf(v), 4, 0, Math.PI * 2); ctx.fill(); });
}

function renderHistorique() {
  const el = document.getElementById('history-list');
  const sum = document.getElementById('history-summary');
  el.innerHTML = '';
  const n = state.history.length;
  if (!n) { sum.innerHTML = ''; el.innerHTML = '<div class="muted">Aucune séance enregistrée. Termine une séance pour la voir apparaître ici.</div>'; return; }
  const totalSets = state.history.reduce((a, h) => a + h.exercises.reduce((b, e) => b + e.sets.length, 0), 0);
  const first = state.history[n - 1].date;
  const weeks = Math.max(1, Math.round((Date.now() - new Date(first).getTime()) / (7 * 864e5)));
  sum.innerHTML = `
    <div class="prog-stat"><div class="prog-val">${n}</div><div class="prog-lbl">séances</div></div>
    <div class="prog-stat"><div class="prog-val">${totalSets}</div><div class="prog-lbl">séries</div></div>
    <div class="prog-stat"><div class="prog-val">${(n / weeks).toFixed(1)}</div><div class="prog-lbl">séances / sem</div></div>`;
  state.history.forEach(h => {
    const entry = document.createElement('div'); entry.className = 'history-entry';
    const sets = h.exercises.reduce((a, e) => a + e.sets.length, 0);
    const head = document.createElement('button'); head.type = 'button'; head.className = 'history-head';
    head.innerHTML = `<span class="history-info"><span class="history-name">${h.sessionName}</span>
      <span class="history-meta">${fmtDate(h.date)} · S${h.week} · ${h.exercises.length} exos · ${sets} séries</span></span><span class="history-chevron">▾</span>`;
    const body = document.createElement('div'); body.className = 'history-body hidden';
    body.innerHTML = h.exercises.map(e => `<div class="history-ex"><span class="history-ex-name">${e.nom}</span><span class="history-ex-sets">${e.sets.map(s => s.v).join(' · ')}${e.hold ? ' s' : ''}</span></div>`).join('');
    head.onclick = () => { body.classList.toggle('hidden'); entry.classList.toggle('open'); };
    entry.appendChild(head); entry.appendChild(body); el.appendChild(entry);
  });
}

// ===== Photos (IndexedDB) =====
const photoDB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('no idb'));
      const r = indexedDB.open('remsomuscu-photos', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(mode, fn) {
    return this.open().then(db => new Promise((res, rej) => {
      const t = db.transaction('photos', mode);
      const req = fn(t.objectStore('photos'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    }));
  },
  add(p) { return this.tx('readwrite', s => s.put(p)); },
  all() { return this.tx('readonly', s => s.getAll()); },
  del(id) { return this.tx('readwrite', s => s.delete(id)); },
  clear() { return this.tx('readwrite', s => s.clear()).catch(() => {}); }
};

function setupPhotos() {
  document.getElementById('input-photo').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const blob = await downscale(file, 1000, 0.8);
      await photoDB.add({ id: Date.now(), date: today(), blob });
      toast('Photo ajoutée.');
      renderPhotos();
    } catch { toast('Impossible d\'enregistrer la photo.'); }
    e.target.value = '';
  };
}
function downscale(file, maxSide, q) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const r = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => b ? res(b) : rej(new Error('blob')), 'image/jpeg', q);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('img')); };
    img.src = url;
  });
}
async function renderPhotos() {
  const grid = document.getElementById('photo-grid');
  let photos = [];
  try { photos = await photoDB.all(); } catch { grid.innerHTML = '<div class="muted">Photos non disponibles sur ce navigateur.</div>'; return; }
  grid.innerHTML = '';
  photos.sort((a, b) => b.id - a.id);
  if (!photos.length) { grid.innerHTML = '<div class="muted" style="grid-column:1/-1">Aucune photo pour l\'instant.</div>'; return; }
  photos.forEach(p => {
    const item = document.createElement('div'); item.className = 'photo-item';
    const img = document.createElement('img'); img.src = URL.createObjectURL(p.blob); img.alt = `Photo du ${fmtDate(p.date)}`;
    img.onclick = () => { const v = document.createElement('div'); v.className = 'photo-viewer'; const big = document.createElement('img'); big.src = img.src; v.appendChild(big); v.onclick = () => v.remove(); document.body.appendChild(v); };
    const date = document.createElement('div'); date.className = 'photo-date'; date.textContent = fmtDate(p.date);
    const del = document.createElement('button'); del.className = 'photo-del'; del.textContent = '✕';
    del.onclick = async () => {
      if (!del.classList.contains('confirm')) { del.classList.add('confirm'); del.textContent = 'Supprimer ?'; setTimeout(() => { del.classList.remove('confirm'); del.textContent = '✕'; }, 3000); return; }
      await photoDB.del(p.id); renderPhotos();
    };
    item.appendChild(img); item.appendChild(date); item.appendChild(del);
    grid.appendChild(item);
  });
}

// ===== Onboarding : test de placement =====
function setupOnboarding() {
  document.getElementById('test-intro').textContent = P.test_placement.intro;
  const wrap = document.getElementById('test-inputs');
  wrap.innerHTML = '';
  P.test_placement.epreuves.forEach(ep => {
    const f = document.createElement('div'); f.className = 'test-field';
    f.innerHTML = `<label for="test-${ep.id}">${ep.nom}</label><input id="test-${ep.id}" type="number" inputmode="numeric" min="0" value="${state.test[ep.id] ?? ep.defaut}"> <span class="muted">${ep.unite}</span>`;
    wrap.appendChild(f);
  });
  document.getElementById('test-compute').onclick = () => {
    const test = {};
    P.test_placement.epreuves.forEach(ep => { test[ep.id] = Number(document.getElementById(`test-${ep.id}`).value) || 0; });
    const levels = computeLevelsFromTest(test);
    state.test = test;
    state.levels = levels;
    state.streaks = {}; state.pendingUp = {}; state.pendingDown = {};
    saveState();
    const res = document.getElementById('test-result');
    res.classList.remove('hidden');
    res.innerHTML = `<p class="muted">Tes niveaux de départ :</p><div class="test-summary">${Object.entries(P.echelles).map(([id, l]) => `<div><span>${l.nom}</span><span>${l.niveaux[levels[id]].nom}</span></div>`).join('')}</div><p class="muted">Tu pourras ajuster chaque niveau avec les flèches ▼ ▲ sur la séance.</p>`;
    document.getElementById('test-start').classList.remove('hidden');
    document.getElementById('test-start').scrollIntoView({ behavior: 'smooth', block: 'end' });
  };
  document.getElementById('test-start').onclick = () => {
    state.onboarded = true;
    saveState();
    document.getElementById('onboarding-modal').classList.add('hidden');
    refreshAll();
    toast('Programme prêt. Bonne première séance, Rémy 💪', 3500);
  };
}
function openOnboarding() {
  document.getElementById('test-result').classList.add('hidden');
  document.getElementById('test-start').classList.add('hidden');
  P.test_placement.epreuves.forEach(ep => { document.getElementById(`test-${ep.id}`).value = state.test[ep.id] ?? ep.defaut; });
  document.getElementById('onboarding-modal').classList.remove('hidden');
}

// ===== Réglages =====
function setupSettings() {
  const modal = document.getElementById('settings-modal');
  document.getElementById('btn-settings').onclick = () => {
    document.getElementById('input-week').value = currentWeek();
    if (window.caches) {
      caches.keys().then(ks => {
        document.getElementById('app-version').textContent = ks.length ? `Version installée : ${ks.join(', ')}` : 'Version installée : aucune (pas de cache)';
      }).catch(() => {});
    }
    modal.classList.remove('hidden');
  };
  document.getElementById('settings-close').onclick = () => modal.classList.add('hidden');
  document.getElementById('settings-save').onclick = () => {
    state.weekBase = Math.max(1, parseInt(document.getElementById('input-week').value, 10) || 1);
    state.sessionsAtBase = state.history.length;
    saveState();
    modal.classList.add('hidden');
    refreshAll();
  };
  document.getElementById('btn-retest').onclick = () => { modal.classList.add('hidden'); openOnboarding(); };

  document.getElementById('btn-export').onclick = async () => {
    const data = JSON.stringify(state);
    try {
      if (navigator.share && navigator.canShare) {
        const file = new File([data], `remsomuscu-${today()}.json`, { type: 'application/json' });
        if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Sauvegarde RemsoMuscu' }); return; }
      }
      await navigator.clipboard.writeText(data);
      toast('Sauvegarde copiée dans le presse-papiers.');
    } catch { toast('Export impossible sur ce navigateur.'); }
  };
  document.getElementById('btn-import').onclick = () => {
    document.getElementById('import-area').classList.toggle('hidden');
    document.getElementById('btn-import-confirm').classList.toggle('hidden');
  };
  document.getElementById('btn-import-confirm').onclick = () => {
    try {
      const s = JSON.parse(document.getElementById('import-area').value);
      if (!s || typeof s !== 'object' || !('levels' in s)) throw new Error('format');
      localStorage.setItem(LS_KEY, JSON.stringify(s));
      location.reload();
    } catch { toast('Sauvegarde illisible.'); }
  };
}

// ===== Wake Lock =====
let wakeLock = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch {}
}
function setupWakeLock() {
  requestWakeLock();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { requestWakeLock(); resyncTimer(); }
  });
}

// ===== Service Worker =====
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloaded) return; reloaded = true; location.reload(); });
}

init();
