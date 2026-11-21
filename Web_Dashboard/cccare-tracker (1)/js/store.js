/* Accounts, the class roster, saved sessions, profiles and the live session shared with
   the patient's screen.

   Two places the data can live, chosen in js/config.js:
   - this browser (the default): sessionStorage for the sign-in, localStorage for data,
     so the prototype runs without a server;
   - a backend, through the REST API in API.md. Sign-in is then checked by the server.

   Either way the pages read from in-memory caches, so reads stay simple and synchronous.
   CC.start(fn) loads the caches (from the backend, if there is one) and then runs the
   page. Writes update the cache straight away and return a promise for the save. */
(function () {
  'use strict';
  const CC = (window.CC = window.CC || {});
  const { mulberry32, gauss, clamp, round1, half, pad2, pick, shuffle, toInt, deepCopy } = CC.util;

  const MAX = 30;
  const DATA_VERSION = '2';
  const KEY = {
    auth: 'cccare.auth',
    feed: 'cccare.feed',
    roster: 'cccare.roster',
    sessions: 'cccare.sessions',
    version: 'cccare.version',
    lastCount: 'cccare.lastCount',
    live: 'cccare.live',
    accounts: 'cccare.accounts',
    profiles: 'cccare.profiles',
    api: 'cccare.api',
  };

  // Sample accounts from the brief. Hard-coded passwords are only acceptable in a
  // prototype; a real deployment has to check them on a server.
  const ACCOUNTS = [
    { username: 'InsU', password: 'InsP', role: 'instructor' },
    { username: 'PatU', password: 'PatP', role: 'patient', participantId: 'P01' },
  ];

  function read(storage, key, fallback) {
    try {
      const raw = storage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }
  function write(storage, key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn('Could not save', key, e);
      return false;
    }
  }

  // ---------- backend ----------

  // The API address: ?api= in the page address (remembered), then js/config.js.
  function apiBase() {
    const given = CC.util.param('api');
    try {
      if (given === 'off') localStorage.removeItem(KEY.api);
      else if (given) localStorage.setItem(KEY.api, given);
      const saved = localStorage.getItem(KEY.api);
      if (saved) return saved.replace(/\/+$/, '');
    } catch (e) {
      /* storage blocked: fall through to the config file */
    }
    const base = CC.CONFIG && CC.CONFIG.apiBase;
    return base ? String(base).replace(/\/+$/, '') : '';
  }
  const API = apiBase();

  // Calls the backend. Resolves with the parsed JSON, or rejects with an Error whose
  // message is the server's { "error": "..." } text when it sends one.
  async function api(method, path, body, opts) {
    const headers = { Accept: 'application/json' };
    const signedIn = read(sessionStorage, KEY.auth, null);
    if (signedIn && signedIn.token) headers.Authorization = 'Bearer ' + signedIn.token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        keepalive: !!(opts && opts.keepalive),
        cache: 'no-store',
      });
    } catch (e) {
      throw new Error(`Can’t reach the server at ${API}.`);
    }
    let data = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error(`The server sent something that isn’t JSON (HTTP ${res.status}).`);
      }
    }
    if (res.status === 401 && path !== '/auth/signin') {
      // The sign-in has expired or the server forgot it: sign in again.
      sessionStorage.removeItem(KEY.auth);
      if (!/index\.html$|\/$/.test(location.pathname)) location.replace('index.html');
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `The server answered HTTP ${res.status}.`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const backend = {
    // The API address, or '' when data is kept in this browser.
    url: API,
    enabled: !!API,
    request: api,
  };

  // ---------- participants ----------

  const pid = (n) => 'P' + pad2(n);
  const slotNumber = (id) => parseInt(String(id).slice(1), 10);
  const defaultName = (id) => 'Patient ' + slotNumber(id);

  // ---------- sign-in ----------

  // Accounts made on the sign-up page, kept in localStorage alongside the sample ones.
  // Like the sample accounts, the password is stored as typed: fine for a prototype only.
  function savedAccounts() {
    const list = read(localStorage, KEY.accounts, []);
    return Array.isArray(list)
      ? list.filter((a) => a && typeof a.username === 'string' && typeof a.password === 'string' &&
        (a.role === 'instructor' || a.role === 'patient'))
      : [];
  }
  const allAccounts = () => ACCOUNTS.concat(savedAccounts());
  const findAccount = (username) => {
    const u = String(username || '').trim().toLowerCase();
    return allAccounts().find((a) => a.username.toLowerCase() === u) || null;
  };

  function startSession(account, token) {
    const signedIn = { username: account.username, role: account.role, participantId: account.participantId || null };
    write(sessionStorage, KEY.auth, token ? Object.assign({ token }, signedIn) : signedIn);
    return signedIn;
  }

  // Sign-in and sign-up through the backend. Resolves with { account } or { error }.
  async function remoteAuth(path, body) {
    try {
      const data = await api('POST', path, body);
      if (!data || !data.account || !data.token) return { error: 'The server’s reply was missing the account.' };
      return { account: startSession(data.account, data.token) };
    } catch (e) {
      return { error: e.message };
    }
  }

  const USERNAME = /^[A-Za-z0-9._-]{3,24}$/;

  const auth = {
    // Resolves with { account } on success, or { error }. The account decides whether this
    // is an instructor or a patient.
    async signIn(username, password) {
      if (backend.enabled) return remoteAuth('/auth/signin', { username: String(username || '').trim(), password });
      const account = findAccount(username);
      if (!account || account.password !== password) return { error: 'That username and password don’t match an account.' };
      return { account: startSession(account) };
    },
    // Makes a new account and signs in with it. Resolves with { account } or { error }.
    // A patient account is linked to the first block number no other account uses.
    async signUp(username, password, role) {
      const name = String(username || '').trim();
      if (!USERNAME.test(name)) return { error: 'Usernames are 3 to 24 letters, numbers, dots, dashes or underscores.' };
      if (findAccount(name)) return { error: 'That username is taken. Choose another.' };
      if (String(password || '').length < 4) return { error: 'Use a password of at least 4 characters.' };
      if (role !== 'instructor' && role !== 'patient') return { error: 'Choose instructor or patient.' };
      if (backend.enabled) return remoteAuth('/auth/signup', { username: name, password, role });
      const account = { username: name, password, role };
      if (role === 'patient') {
        const used = new Set(allAccounts().map((a) => a.participantId).filter(Boolean));
        let n = 1;
        while (n <= MAX && used.has(pid(n))) n++;
        if (n > MAX) return { error: `All ${MAX} patient places are taken.` };
        account.participantId = pid(n);
        // Shows the new patient's username on the instructor's roster until a name is set.
        const slot = roster.get(account.participantId);
        if (slot && !slot.name) {
          slot.name = name;
          roster.save([slot]);
        }
      }
      if (!write(localStorage, KEY.accounts, savedAccounts().concat([account]))) {
        return { error: 'Could not save the account in this browser.' };
      }
      return { account: startSession(account) };
    },
    current() {
      const a = read(sessionStorage, KEY.auth, null);
      return a && (a.role === 'instructor' || a.role === 'patient') ? a : null;
    },
    home(account) {
      return account.role === 'instructor' ? 'instructor.html' : 'patient.html';
    },
    // Sends anyone not signed in to the sign-in page, and anyone with the wrong role home.
    require(role) {
      const a = auth.current();
      if (!a) {
        location.replace('index.html');
        return null;
      }
      if (role && a.role !== role) {
        location.replace(auth.home(a));
        return null;
      }
      return a;
    },
    signOut() {
      if (backend.enabled) api('POST', '/auth/signout', {}, { keepalive: true }).catch(() => {});
      sessionStorage.removeItem(KEY.auth);
      if (CC.go) CC.go('index.html');
      else location.href = 'index.html';
    },
  };

  // ---------- roster ----------

  const defaultWorkout = (n) => deepCopy(CC.WORKOUTS[(n - 1) % CC.WORKOUTS.length]);

  // Names start blank, and a blank name shows as "Patient <number>".
  function defaultRoster() {
    const list = [];
    for (let n = 1; n <= MAX; n++) list.push({ id: pid(n), name: '', workout: defaultWorkout(n) });
    return list;
  }

  function cleanWorkout(list, fallback) {
    if (!Array.isArray(list)) return fallback;
    const L = CC.WORKOUT_LIMITS;
    const out = list
      .filter((w) => w && typeof w === 'object' && CC.EXERCISES[w.exercise])
      .slice(0, L.exercises)
      .map((w) => ({
        exercise: w.exercise,
        sets: toInt(w.sets, 1, L.sets, 2),
        reps: toInt(w.reps, 1, L.reps, 10),
        rest: toInt(w.rest, L.restMin, L.restMax, L.rest),
      }));
    return out.length ? out : fallback;
  }

  function cleanSlot(slot, fallback) {
    return {
      id: fallback.id,
      name: String(slot.name || '').trim().slice(0, 40),
      workout: cleanWorkout(slot.workout, fallback.workout),
    };
  }

  // Fills in the full roster of MAX places from what was saved. Saved places are matched
  // by id (a backend may only send some of them), or by position for older saved data.
  function fullRoster(saved) {
    const list = Array.isArray(saved) ? saved.filter((s) => s && typeof s === 'object') : [];
    return defaultRoster().map((slot, i) => {
      const given = list.find((s) => s.id === slot.id) || (list[i] && !list[i].id ? list[i] : null);
      return given ? cleanSlot(given, slot) : slot;
    });
  }

  let rosterCache = null;
  const roster = {
    all() {
      if (!rosterCache) rosterCache = fullRoster(read(localStorage, KEY.roster, null));
      return deepCopy(rosterCache);
    },
    get(id) {
      return roster.all().find((s) => s.id === id) || null;
    },
    save(list) {
      const base = defaultRoster();
      const current = rosterCache || base;
      rosterCache = base.map((slot) => {
        const given = list.find((s) => s.id === slot.id);
        return given ? cleanSlot(given, slot) : current.find((s) => s.id === slot.id);
      });
      // Resolves when saved; rejects with the reason if the backend couldn't save it.
      if (backend.enabled) return api('PUT', '/roster', rosterCache);
      return write(localStorage, KEY.roster, rosterCache) ? Promise.resolve() : Promise.reject(new Error('Could not save in this browser.'));
    },
  };

  // The name to show for a participant: the name recorded with the result, then the
  // current roster name, then "Patient <number>".
  function displayName(entry) {
    if (entry && entry.name && String(entry.name).trim()) return String(entry.name).trim();
    const slot = roster.get(entry.id);
    return (slot && slot.name) || defaultName(entry.id);
  }

  // ---------- sessions ----------

  function newId(date, suffix) {
    const d = new Date(date);
    const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    return `S${stamp}-${suffix || Math.random().toString(36).slice(2, 6)}`;
  }

  // Sample results so the progress graphs have something to show on day one.
  function sampleExercise(w, p, k, rnd) {
    const habits = p.habits[w.exercise];
    const codes = Object.keys(CC.EXERCISES[w.exercise].faults);
    const quality = Math.round(clamp(p.quality + p.gain * k + p.offset[w.exercise] + gauss(rnd) * 5, 30, 98));
    const under = p.under * Math.max(0.2, 1 - k / 18);
    const done = [];
    for (let s = 0; s < w.sets; s++) {
      const r = rnd();
      if (r < under) done.push(Math.max(1, w.reps - 1 - Math.floor(rnd() * 3)));
      else if (r < under + p.over) done.push(w.reps + 1 + Math.floor(rnd() * 3));
      else done.push(w.reps);
    }
    const extra = rnd() < 0.03 ? 2 + Math.floor(rnd() * 4) : 0;
    const total = done.reduce((a, b) => a + b, 0) + extra;

    // Spread the weaker reps over this person's usual faults, plus the odd other one.
    const faults = {};
    let weak = Math.round(total * (1 - quality / 100) * 1.5);
    while (weak > 0) {
      const code = rnd() < 0.8 ? pick(habits, rnd) : pick(codes, rnd);
      const n = Math.min(weak, 1 + Math.floor(rnd() * 3));
      faults[code] = Math.min(total, (faults[code] || 0) + n);
      weak -= n;
    }
    const e = { exercise: w.exercise, sets: w.sets, reps: w.reps, done, extra, quality, faults };
    e.success = CC.score.exerciseSuccess(e);
    return e;
  }

  function skippedExercise(w) {
    return {
      exercise: w.exercise, sets: w.sets, reps: w.reps, done: new Array(w.sets).fill(0),
      extra: 0, quality: null, faults: {}, success: 0,
    };
  }

  function sampleResult(slot, p, k, rnd) {
    const last = slot.workout.length - 1;
    const exercises = slot.workout.map((w, i) =>
      i === last && last > 0 && rnd() < 0.05 ? skippedExercise(w) : sampleExercise(w, p, k, rnd));
    const score = CC.score;
    const repsDone = exercises.reduce((n, e) => n + score.repsDone(e), 0);
    let qualitySum = 0;
    exercises.forEach((e) => {
      if (e.quality != null) qualitySum += e.quality * score.repsDone(e);
    });
    const exertionAvg = round1(clamp(3 + rnd() * 2.5 + p.over * 6, 0, 10));
    return {
      id: slot.id,
      name: '',
      exercises,
      repsDone,
      repsPlanned: exercises.reduce((n, e) => n + score.planned(e), 0),
      setsDone: exercises.reduce((n, e) => n + e.done.filter((d) => d >= e.reps).length, 0),
      setsPlanned: exercises.reduce((n, e) => n + e.sets, 0),
      quality: repsDone ? Math.round(qualitySum / repsDone) : null,
      exertionAvg,
      exertionPeak: half(clamp(exertionAvg + 1 + rnd() * 2.5, 0, 10)),
      success: score.workoutSuccess(exercises),
    };
  }

  function sampleSessions() {
    const rnd = mulberry32(20261108);
    const slots = defaultRoster();
    const profiles = slots.map((slot, i) => {
      const habits = {};
      const offset = {};
      for (const w of slot.workout) {
        habits[w.exercise] = shuffle(Object.keys(CC.EXERCISES[w.exercise].faults), rnd).slice(0, 2);
        offset[w.exercise] = (rnd() - 0.5) * 12;
      }
      return {
        quality: 56 + rnd() * 26, // movement quality at the first session
        gain: 0.5 + rnd() * 1.5, // quality points gained per session
        attendance: i < 12 ? 0.82 + rnd() * 0.16 : 0.6 + rnd() * 0.3,
        joined: i < 12 ? 0 : Math.floor(rnd() * 7), // later slots joined part-way through
        under: 0.04 + rnd() * 0.22, // chance of stopping a set short
        over: rnd() * 0.14, // chance of going past a set
        habits,
        offset,
      };
    });

    // Tuesday and Thursday classes at 10:00, counting back from yesterday.
    const dates = [];
    const day = new Date();
    day.setHours(10, 0, 0, 0);
    while (dates.length < 14) {
      day.setDate(day.getDate() - 1);
      if (day.getDay() === 2 || day.getDay() === 4) dates.unshift(new Date(day.getTime()));
    }

    return dates.map((start, k) => {
      const participants = [];
      slots.forEach((slot, i) => {
        const p = profiles[i];
        if (k < p.joined || rnd() > p.attendance) return;
        participants.push(sampleResult(slot, p, k, rnd));
      });
      const minutes = 38 + Math.floor(rnd() * 12);
      return {
        id: newId(start, 'sample'),
        startedAt: start.toISOString(),
        endedAt: new Date(start.getTime() + minutes * 60000).toISOString(),
        sample: true,
        participants,
      };
    });
  }

  const validSession = (s) =>
    s && typeof s.id === 'string' && Array.isArray(s.participants) &&
    s.participants.every((p) => p && Array.isArray(p.exercises));

  const sortSessions = (list) => (Array.isArray(list) ? list : [])
    .filter(validSession)
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));

  let sessionCache = null;
  function loadSessions() {
    if (sessionCache) return sessionCache;
    if (backend.enabled) return (sessionCache = []); // filled in by CC.start
    if (localStorage.getItem(KEY.version) !== DATA_VERSION) {
      // Saved data from an older version can't be shown, so start again with sample data.
      write(localStorage, KEY.sessions, sampleSessions());
      localStorage.removeItem(KEY.live);
      localStorage.setItem(KEY.version, DATA_VERSION);
    }
    sessionCache = sortSessions(read(localStorage, KEY.sessions, []));
    return sessionCache;
  }

  const sessions = {
    newId,
    all() {
      return loadSessions().slice();
    },
    get(id) {
      return loadSessions().find((s) => s.id === id) || null;
    },
    latest() {
      const list = loadSessions();
      return list[list.length - 1] || null;
    },
    // Resolves when saved; rejects with the reason if it couldn't be.
    add(session) {
      const list = loadSessions().concat([session]);
      sessionCache = list;
      if (backend.enabled) return api('POST', '/sessions', session);
      return write(localStorage, KEY.sessions, list) ? Promise.resolve() : Promise.reject(new Error('Could not save in this browser. Its storage may be full.'));
    },
    // Every session this participant was in, oldest first.
    historyFor(id) {
      return loadSessions()
        .map((session) => ({ session, result: session.participants.find((p) => p.id === id) }))
        .filter((entry) => entry.result);
    },
    latestFor(id) {
      const history = sessions.historyFor(id);
      return history.length ? history[history.length - 1].session : null;
    },
  };

  // ---------- live session ----------
  // While a session runs, the instructor's page writes every participant's block here
  // twice a second. Patient pages in the same browser read it to show their own block.
  // state is 'live', 'ended' (results saved) or 'abandoned' (the instructor left the page).
  // With a backend this also works across devices: the instructor's page sends each update
  // to the server, and patient pages ask the server for it once a second.
  const validLive = (v) => (v && typeof v === 'object' && typeof v.id === 'string' ? v : null);
  let liveCache = null;
  let liveSending = false;
  let liveQueued = null;

  async function sendLive(state, keepalive) {
    if (keepalive) return api('PUT', '/live', state, { keepalive: true }).catch(() => {});
    // Only one update in flight at a time; if more come meanwhile, send the newest next.
    if (liveSending) {
      liveQueued = state;
      return null;
    }
    liveSending = true;
    try {
      await api('PUT', '/live', state);
    } catch (e) {
      console.warn('Live update not sent:', e.message);
    } finally {
      liveSending = false;
    }
    if (liveQueued) {
      const next = liveQueued;
      liveQueued = null;
      return sendLive(next);
    }
    return null;
  }

  const live = {
    key: KEY.live,
    read() {
      return backend.enabled ? liveCache : validLive(read(localStorage, KEY.live, null));
    },
    // opts.final: the last update before leaving the page (sent even as the page closes).
    write(state, opts) {
      if (!backend.enabled) return Promise.resolve(write(localStorage, KEY.live, state));
      return sendLive(state, !!(opts && opts.final));
    },
    // Calls onChange(state) about once a second, and as soon as another tab in this
    // browser changes it. Patient pages use this to follow the instructor.
    watch(onChange) {
      if (!backend.enabled) {
        window.addEventListener('storage', (e) => {
          if (e.key === KEY.live) onChange(live.read());
        });
        setInterval(() => onChange(live.read()), 1000);
        onChange(live.read());
        return;
      }
      let busy = false;
      const poll = async () => {
        if (busy) return;
        busy = true;
        try {
          const v = validLive(await api('GET', '/live'));
          // The server says how old the update is, so clocks on different devices don't matter.
          if (v && Number.isFinite(v.ageMs)) v.updatedAt = Date.now() - v.ageMs;
          liveCache = v;
        } catch (e) {
          console.warn('Live update not received:', e.message);
        } finally {
          busy = false;
        }
        onChange(liveCache);
      };
      setInterval(poll, 1000);
      poll();
    },
  };

  // ---------- profiles ----------
  // One per username: { bio, birthday: 'YYYY-MM-DD' or '', photo: data URL or '' }.
  // Photos are shrunk before saving (see profile.js) so they fit in localStorage.

  const BIO_MAX = 500;
  const NICK_MAX = 30;
  const PHOTO_MAX = 200000; // characters of data URL
  const profileKey = (username) => String(username || '').trim().toLowerCase();

  function cleanProfile(p) {
    p = p && typeof p === 'object' ? p : {};
    const birthday = /^\d{4}-\d{2}-\d{2}$/.test(p.birthday || '') ? p.birthday : '';
    const photo = typeof p.photo === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(p.photo) && p.photo.length <= PHOTO_MAX
      ? p.photo : '';
    const nickname = String(p.nickname || '').replace(/\s+/g, ' ').trim().slice(0, NICK_MAX);
    return { nickname, bio: String(p.bio || '').slice(0, BIO_MAX), birthday, photo };
  }

  const profileCache = {};
  const profiles = {
    BIO_MAX,
    NICK_MAX,
    // What to call the signed-in person on their own screens: their nickname, if they've
    // set one, otherwise their username.
    nameFor(account) {
      return (account && profiles.get(account.username).nickname) || (account && account.username) || '';
    },
    get(username) {
      if (backend.enabled) return cleanProfile(profileCache[profileKey(username)]);
      const all = read(localStorage, KEY.profiles, {});
      return cleanProfile(all && typeof all === 'object' ? all[profileKey(username)] : null);
    },
    // Resolves when saved; rejects with the reason if it couldn't be.
    save(username, profile) {
      const clean = cleanProfile(profile);
      if (backend.enabled) {
        profileCache[profileKey(username)] = clean;
        return api('PUT', '/profiles/' + encodeURIComponent(username), clean);
      }
      const all = read(localStorage, KEY.profiles, {});
      const next = all && typeof all === 'object' && !Array.isArray(all) ? all : {};
      next[profileKey(username)] = clean;
      return write(localStorage, KEY.profiles, next)
        ? Promise.resolve()
        : Promise.reject(new Error('Could not save. The browser’s storage may be full; try a smaller picture.'));
    },
  };

  // ---------- misc ----------

  const store = {
    lastCount() {
      return read(localStorage, KEY.lastCount, null);
    },
    setLastCount(n) {
      write(localStorage, KEY.lastCount, n);
    },
    // Address of the live camera feed, kept for this browser tab. See README.
    feedUrl() {
      const given = CC.util.param('feed');
      if (given === 'off') sessionStorage.removeItem(KEY.feed);
      else if (given) sessionStorage.setItem(KEY.feed, given);
      return sessionStorage.getItem(KEY.feed);
    },
    // Deletes saved sessions and names, then the sample history is generated again.
    // With a backend, the server replaces its sessions with the sample history.
    reset() {
      [KEY.roster, KEY.sessions, KEY.version, KEY.lastCount, KEY.live].forEach((k) => localStorage.removeItem(k));
      rosterCache = null;
      sessionCache = null;
      if (backend.enabled) return api('POST', '/reset', { sessions: sampleSessions() });
      return Promise.resolve();
    },
  };

  // ---------- page start ----------

  // Loads what the signed-in person can see from the backend into the caches. With data
  // kept in this browser there is nothing to load.
  async function load() {
    if (!backend.enabled) return;
    const me = auth.current();
    if (!me) return; // the sign-in page: nothing to load yet
    const [rosterData, sessionData, profile] = await Promise.all([
      api('GET', '/roster'),
      api('GET', '/sessions'),
      api('GET', '/profiles/' + encodeURIComponent(me.username)).catch(() => null),
    ]);
    rosterCache = fullRoster(rosterData);
    sessionCache = sortSessions(sessionData);
    if (profile) profileCache[profileKey(me.username)] = profile;
  }

  // Runs a page once its data is loaded. If the backend can't be reached, says so on the
  // page instead. opts.load = false skips loading (the sign-in page needs no data).
  function start(page, opts) {
    const loading = opts && opts.load === false ? Promise.resolve() : load();
    loading.then(page, (e) => {
      if (e.status === 401) {
        // The sign-in expired: api() has already signed out; start again from sign-in.
        location.replace('index.html');
        return;
      }
      const box = document.createElement('section');
      box.className = 'server-error';
      box.setAttribute('role', 'alert');
      const h = document.createElement('h1');
      h.textContent = 'Can’t load the data';
      const p = document.createElement('p');
      p.textContent = `${e.message} Check that the server is running, then reload the page.`;
      const p2 = document.createElement('p');
      p2.className = 'mono muted';
      p2.textContent = `Server: ${API}. To use this browser’s storage instead, add ?api=off to the address.`;
      box.append(h, p, p2);
      const main = document.querySelector('main');
      if (main) main.replaceChildren(box);
      else document.body.prepend(box);
    });
  }

  CC.MAX_PARTICIPANTS = MAX;
  CC.slotNumber = slotNumber;
  CC.defaultName = defaultName;
  CC.displayName = displayName;
  CC.auth = auth;
  CC.roster = roster;
  CC.sessions = sessions;
  CC.live = live;
  CC.store = store;
  CC.profiles = profiles;
  CC.backend = backend;
  CC.start = start;
})();
