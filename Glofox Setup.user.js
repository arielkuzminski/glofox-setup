// ==UserScript==
// @name         Klub - Setup (Konfiguracja)
// @namespace    wotan91
// @version      1.3
// @description  Kreator konfiguracji pakietu wtyczek: aktywuje licencję dla Twojego klubu i ustawia klienta sprzedażowego oraz kaucję. Uruchom raz po zakupie; zostaje jako „Ustawienia wtyczek".
// @match        https://app.glofox.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @author       Ariel Kuźmiński (ariel.kuzminski@gmail.com)
// @github       https://github.com/arielkuzminski/glofox-setup
// @updateURL    https://raw.githubusercontent.com/arielkuzminski/glofox-setup/master/Glofox%20Setup.user.js
// @downloadURL  https://raw.githubusercontent.com/arielkuzminski/glofox-setup/master/Glofox%20Setup.user.js
// ==/UserScript==

(async function () {
  "use strict";

  // === LICENSE MODULE START ===
  const KLUB_LICENSE = {
    LICENSE_SERVER: 'https://glofox-license-api.vercel.app',
    LICENSE_CACHE_KEY: 'glofox:license:cache',
    LICENSE_KEY_STORAGE_KEY: 'glofox:license:key',
    WATERMARK_KEY: 'glofox:license:watermark',

    // Klucz wpiekany przez serwer przy /api/serve/<KEY>/<slug>.user.js. Gdy skrypt jest serwowany
    // przez gated endpoint, serwer podmienia ten placeholder na prawdziwy klucz — dzieki temu runtime
    // NIE zalezy od ?key= w URL-u strony (app.glofox.com nigdy go nie ma). Wartosc '__...__'
    // (niepodmieniona) oznacza "brak wpieczonego klucza" i jest ignorowana.
    BAKED_LICENSE_KEY: '__KLUB_LICENSE_KEY__',
    CACHE_FRESH_MS: 60 * 60 * 1000,           // 1h — within this window the server is not asked
    CACHE_GRACE_MS: 72 * 60 * 60 * 1000,      // 72h — cache survives a server OUTAGE (weekend AFK bufor)
    REQUEST_TIMEOUT_MS: 15000,                // 15s — bufor na cold-start Vercela (było 10s)
    LOCATION_RETRY_MS: 10000,                 // how long to wait for the session locationId
    LOCATION_POLL_INTERVAL_MS: 300,

    // Wygaśnięcie / odnowa (model: 12 mies. + odnowa 50%). Wygaśnięcie MA zęby (twardy stop),
    // ale outage NIE — patrz enforce(). RENEWAL_URL to placeholder (Opcja B): teraz cennik/kontakt,
    // podmień na live renewal-checkout przy przejściu Stripe na live.
    RENEWAL_URL: 'https://wtyczki.wotan91.pl/#cennik',
    REMINDER_DAYS: 7,                          // reminder przez ostatnie N dni ważności
    NUDGE_STORAGE_KEY: 'glofox:license:nudge', // throttle remindera „raz dziennie" (data|klucz)
    MS_PER_DAY: 86400000,

    // State
    currentConfig: null,
    licenseKey: null,
    sessionLocationId: null,
    scriptSlug: 'unknown',
    validationInProgress: false,

    /**
     * Main gate. Validates the license AND binds execution to the licensed club.
     * `opts.script` is the stable slug of the host script (used for server-side telemetry
     * and the per-script kill-switch `config.disabledScripts`).
     * Returns the club config on success, or null (after showing a blocking modal)
     * when the license is invalid, the club differs, or the script is remotely disabled.
     */
    async enforce(opts) {
      this.scriptSlug = String(
        (opts && opts.script) ||
        (typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.name) ||
        'unknown'
      );

      // 0. Baked key from the gated serve endpoint — authoritative. When the script was served by
      //    /api/serve the server replaced the placeholder with the real key; persist it (and overwrite
      //    any older stored key, so re-serving with a rotated key takes effect). '__…__' = not baked.
      const baked = this.BAKED_LICENSE_KEY;
      if (baked && baked.slice(0, 2) !== '__') {
        GM_setValue(this.LICENSE_KEY_STORAGE_KEY, baked.trim());
      }

      // 1. Legacy fallback: pick up ?key=XXXX from the URL, persist it, then strip it from history.
      //    (Kept for manual installs; served scripts carry the baked key above instead.)
      const urlParams = new URLSearchParams(window.location.search);
      const keyFromUrl = urlParams.get('key');
      if (keyFromUrl) {
        GM_setValue(this.LICENSE_KEY_STORAGE_KEY, keyFromUrl.trim());
        const newUrl = window.location.toString().replace(/[?&]key=[^&]*/, '').replace(/[?&]$/, '');
        if (newUrl !== window.location.toString()) {
          window.history.replaceState({}, document.title, newUrl);
        }
      }
      this.licenseKey = GM_getValue(this.LICENSE_KEY_STORAGE_KEY) || null;

      // 2. Validate against server (fresh cache / revalidate / grace — see header).
      const result = await this.validate();

      // 3. Enforcement policy — świadomie MIĘKKA (nie strasz klienta niepotrzebnie).
      //    Blokujemy CICHO tylko realne naruszenia: zły klub / licencja odebrana. Reszta (wygasła,
      //    misconfig, brak łączności) → działaj z ostatniej potwierdzonej licencji albo cicho odpuść.
      //    Ciężar egzekwowania przeniesiony na serwer + panel (telemetria, „Uwagi/problemy").
      if (result && result.valid) {
        // Wygaśnięcie MA zęby: sprawdzamy LOKALNIE (z expiresAt), więc łapie też świeży cache (<1h)
        // i grace/outage (który zwraca cached.data z valid:true). Wygaśnięcie to fakt czasowy — nie
        // zależy od łączności. Niewygasła licencja przy outage dalej działa (grace, bez zmian).
        const exp = this._expiryInfo(result);
        if (exp && exp.expired) {
          this._renewalNotice({ expired: true });
          return null;
        }
        const cfg = await this._bindAndFinish(result.config || {}, result);
        // Reminder przez ostatnie REMINDER_DAYS dni (raz dziennie) — tylko dla realnie związanego klubu.
        if (cfg && exp && exp.daysLeft > 0 && exp.daysLeft <= this.REMINDER_DAYS) {
          this._maybeNudge(exp.daysLeft);
        }
        return cfg;
      }
      const reason = (result && result.reason) || '';

      // Twardy, ale CICHY blok: odebrana / usunięta / nierozpoznane odrzucenie (fail-safe → blok).
      if (reason === 'inactive' || reason === 'not_found' || reason === '') {
        this.showBlockNotice('Licencja nieaktywna. Kontakt: ariel.kuzminski@gmail.com');
        return null;
      }

      // Wygasła (serwer definitywnie 403 expired przy stale cache) → twardy stop z linkiem odnowy.
      //   Backstop: zwykle łapie to już lokalny stop wyżej (expired NIE kasuje cache — :218), ale gdy
      //   cache był stale i serwer potwierdza wygaśnięcie, blokujemy tutaj. Model odnowy MUSI mieć zęby.
      if (reason === 'expired') {
        this._renewalNotice({ expired: true });
        return null;
      }

      // Misconfig (NASZ błąd, np. locationId='PENDING' nieuzupełniony) → łagodnie: działaj z ostatniej
      //   potwierdzonej licencji (config w cache), nadal egzekwując binding per-klub. To nie wina klienta.
      if (reason === 'misconfigured') {
        const cached = this._readCache();
        if (cached && cached.data && cached.data.config) {
          console.info('[KLUB] Tryb łagodny (misconfigured) — działam z ostatniej potwierdzonej licencji.');
          return this._bindAndFinish(cached.data.config, cached.data);
        }
      }

      // Outage (poza oknem grace lub brak cache) i wszystko inne → CICHO, bez modala. Nie ryzykujemy
      //   działania na nieznanej licencji; ponowimy przy następnym uruchomieniu/odświeżeniu strony.
      console.info(`[KLUB] Licencja niepotwierdzona (${reason || 'outage'}) — ponowię przy następnym odświeżeniu.`);
      return null;
    },

    /**
     * Bind an (already validated OR last-known) config to the logged-in club and finish.
     * Blocks CICHO (mały toast) na niezgodny klub / wyłączony skrypt; transient (brak sesji Glofox /
     * brak locationId) → cicho, bez UI (ponów przy odświeżeniu). Zwraca config lub null.
     */
    async _bindAndFinish(config, result) {
      const licensedLocationId = config && config.locationId ? String(config.locationId) : '';
      if (!licensedLocationId) {
        // Nasz błąd konfiguracji (np. locationId='PENDING' nieuzupełniony) — nie strasz klienta;
        // serwer i tak widzi to jako 'misconfigured' w telemetrii.
        console.info('[KLUB] Licencja bez przypisanego klubu (locationId) — pomijam po cichu.');
        return null;
      }

      const sessionLocationId = await this._waitForLocationId(this.LOCATION_RETRY_MS);
      if (!sessionLocationId) {
        // Glofox jeszcze się nie załadował / brak JWT sesji — transient, nie problem licencyjny. Cicho.
        console.info('[KLUB] Nie wykryto zalogowanego klubu Glofox — ponowię przy odświeżeniu.');
        return null;
      }
      this.sessionLocationId = sessionLocationId;

      // Binding per-klub (rdzeń anty-piracki R1) — blokada zostaje, ale cicha.
      if (sessionLocationId !== licensedLocationId) {
        this.showBlockNotice('Ten skrypt jest przypisany do innego klubu.');
        return null;
      }

      // Per-script kill-switch (config.disabledScripts, edytowany w panelu) — blokada zostaje, cicha.
      const disabled = Array.isArray(config.disabledScripts) ? config.disabledScripts : [];
      if (disabled.includes(this.scriptSlug)) {
        this.showBlockNotice('Ten skrypt został wyłączony dla Twojego klubu. Kontakt: ariel.kuzminski@gmail.com');
        return null;
      }

      // Watermark — record the key/club that unlocked this session (traceable leak).
      this._stampWatermark(
        (result && result.key) || this.licenseKey,
        (result && result.clubName) || config.clientName || '',
        licensedLocationId
      );
      this.currentConfig = config;
      return config;
    },

    /**
     * Validate license against server. Fresh cache (≤1h) short-circuits the request.
     * FAIL-CLOSED: a definitive `valid:false` blocks immediately and wipes the cache;
     * an outage falls back to cache only while it is within the 72h grace window,
     * afterwards a blocking "server unreachable" result is returned.
     */
    async validate() {
      if (this.validationInProgress) return null;
      this.validationInProgress = true;

      const storedKey = GM_getValue(this.LICENSE_KEY_STORAGE_KEY);
      if (!storedKey) { this.validationInProgress = false; return null; }

      const cached = this._readCache();
      if (cached && (Date.now() - cached.fetchedAt) < this.CACHE_FRESH_MS) {
        this.validationInProgress = false;
        return cached.data;
      }

      const version =
        (typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version) || '';
      // locationId sesji dosyłany do serwera (telemetria — wykrywanie „klucz na cudzym klubie"
      // i sharingu w panelu). Best-effort, synchroniczny odczyt (bez czekania) → nie dodaje latencji.
      const loc = this.sessionLocationId || this._captureSessionLocationId() || '';
      const url = `${this.LICENSE_SERVER}/api/validate` +
        `?key=${encodeURIComponent(storedKey)}` +
        `&script=${encodeURIComponent(this.scriptSlug)}` +
        `&v=${encodeURIComponent(version)}` +
        (loc ? `&loc=${encodeURIComponent(loc)}` : '');

      return new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: this.REQUEST_TIMEOUT_MS,
          onload: (res) => {
            let data = null;
            try { data = JSON.parse(res.responseText); } catch (_e) { /* unparseable → outage */ }
            const definitive = data && res.status >= 200 && res.status < 500 && res.status !== 429;

            if (definitive) {
              if (data.valid) {
                GM_setValue(this.LICENSE_CACHE_KEY, JSON.stringify({ data, fetchedAt: Date.now(), key: storedKey }));
              } else {
                // Definitywne odrzucenie. Kasujemy cache TYLKO dla revocation (odebrana/usunięta/
                // nierozpoznane — fail-safe), żeby grace nie wskrzesił odebranej licencji. Dla
                // 'expired'/'misconfigured' ZACHOWUJEMY cache — tryb łagodny w enforce() bierze z niego config.
                const r = data.reason || '';
                if (r !== 'expired' && r !== 'misconfigured') {
                  GM_setValue(this.LICENSE_CACHE_KEY, '');
                }
              }
              this.validationInProgress = false;
              resolve(data);
              return;
            }
            // 5xx / 429 / broken body → treat as outage.
            this.validationInProgress = false;
            resolve(this._graceFallback());
          },
          onerror: () => { this.validationInProgress = false; resolve(this._graceFallback()); },
          ontimeout: () => { this.validationInProgress = false; resolve(this._graceFallback()); }
        });
      });
    },

    /** Parse the cache entry ({ data, fetchedAt }) or return null. */
    _readCache() {
      const raw = GM_getValue(this.LICENSE_CACHE_KEY);
      if (!raw) return null;
      try {
        const entry = JSON.parse(raw);
        if (!entry || typeof entry.fetchedAt !== 'number' || !entry.data) return null;
        // Cache MUSI należeć do AKTUALNEGO klucza licencji. Po zmianie klucza (reinstalacja skryptu z
        // innym kluczem / rotacja) stary config NIE może być serwowany — był bug: config poprzedniego
        // klubu przez 1h (np. autoklient wybierał klienta poprzedniego klubu). Legacy wpis bez `key`
        // (sprzed tego fixa) też odrzucamy — wymusza świeże pobranie pod właściwym kluczem.
        const storedKey = GM_getValue(this.LICENSE_KEY_STORAGE_KEY);
        if (!storedKey || entry.key !== storedKey) return null;
        return entry;
      } catch (_e) {
        return null;
      }
    },

    /**
     * Server unreachable (outage): serve cache while within grace (72h), otherwise signal 'outage'.
     * NIE zwraca już straszącego modala — enforce() decyduje CICHO (odpuść / soft-blok po grace).
     */
    _graceFallback() {
      const cached = this._readCache();
      if (cached && (Date.now() - cached.fetchedAt) <= this.CACHE_GRACE_MS) {
        return cached.data;
      }
      // Poza grace lub brak cache. Bez modala — sygnał 'outage' dla enforce().
      return { valid: false, reason: 'outage' };
    },

    // ---- Session locationId capture (self-contained, own namespace) -------------
    // Reads the locationId of the logged-in Glofox club from the session JWT
    // (payload.user.branch_id). Independent of any host `AUTH` object.

    _pickJwt(raw) {
      const s = String(raw || '');
      const m1 = s.match(/Bearer\s+([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)/i);
      if (m1 && m1[1]) return m1[1];
      const m2 = s.match(/\b([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)\b/);
      return m2 && m2[1] ? m2[1] : '';
    },

    _jwtPayload(token) {
      const p = String(token || '').split('.');
      if (p.length < 2) return null;
      try {
        const b64 = p[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        return JSON.parse(atob(padded));
      } catch (_e) {
        return null;
      }
    },

    _locationFromRaw(raw) {
      const token = this._pickJwt(raw);
      if (!token) return '';
      const payload = this._jwtPayload(token);
      const branchId = payload && payload.user ? payload.user.branch_id : '';
      return branchId ? String(branchId) : '';
    },

    _captureSessionLocationId() {
      let found = '';
      [localStorage, sessionStorage].forEach((store) => {
        if (found) return;
        try {
          for (let i = 0; i < store.length; i += 1) {
            const val = store.getItem(store.key(i));
            if (!val) continue;
            found = this._locationFromRaw(val);
            if (found) return;
            try {
              const obj = JSON.parse(val);
              if (obj && typeof obj === 'object') {
                found = this._locationFromRaw(obj.token || obj.accessToken || obj.access_token || obj.id_token || '');
                if (found) return;
              }
            } catch (_e) { /* not JSON */ }
          }
        } catch (_e) { /* storage access denied */ }
      });
      return found;
    },

    _waitForLocationId(timeoutMs) {
      return new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
          const id = this._captureSessionLocationId();
          if (id) { resolve(id); return; }
          if (Date.now() - start >= timeoutMs) { resolve(''); return; }
          setTimeout(tick, this.LOCATION_POLL_INTERVAL_MS);
        };
        tick();
      });
    },

    // ---- Watermark --------------------------------------------------------------
    _stampWatermark(key, club, locationId) {
      const mark = {
        key: key || '',
        club: club || '',
        locationId: locationId || '',
        ts: new Date().toISOString()
      };
      try { window.__KLUB_LICENSE__ = mark; } catch (_e) { /* noop */ }
      try { GM_setValue(this.WATERMARK_KEY, JSON.stringify(mark)); } catch (_e) { /* noop */ }
      console.info(`[KLUB] Licencja aktywna: ${mark.key} | ${mark.club} | ${mark.locationId}`);
    },

    // ---- Cicha notka (nie straszący modal) --------------------------------------
    // Mały, neutralny toast w rogu, auto-znikający. Używany TYLKO dla realnych blokad
    // (zły klub / skrypt wyłączony / licencja nieaktywna). Transient i tryb łagodny → console.info,
    // bez UI. Świadomie NIE full-screen i NIE czerwony (decyzja: „nie strasz klientów").
    showBlockNotice(message) {
      console.info(`[KLUB] ${message}`);
      try {
        if (document.getElementById('glofox-license-notice')) return;
        const el = document.createElement('div');
        el.id = 'glofox-license-notice';
        el.style.cssText = `position: fixed; bottom: 16px; right: 16px; max-width: 300px; background: #2f2f2f; color: #fff; padding: 10px 14px; border-radius: 8px; font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,0.25); z-index: 2147483647; opacity: 0.96;`;
        el.textContent = `Wtyczki: ${message}`;
        const mount = () => {
          if (!document.body) return;
          document.body.appendChild(el);
          setTimeout(() => { try { el.remove(); } catch (_e) { /* noop */ } }, 8000);
        };
        if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
      } catch (_e) { /* noop */ }
    },

    // ---- Wygaśnięcie / odnowa ---------------------------------------------------
    // Lokalne liczenie z expiresAt (ISO z /api/validate). Brak/zły format → null (FAIL-OPEN:
    // nie wyłączamy działającej licencji przez niepoprawną datę). daysLeft: dodatnie = zostało N dni.
    _expiryInfo(data) {
      const iso = data && data.expiresAt;
      if (!iso) return null;
      const exp = new Date(iso).getTime();
      if (!exp || isNaN(exp)) return null;
      const now = Date.now();
      return { expired: now > exp, daysLeft: Math.ceil((exp - now) / this.MS_PER_DAY) };
    },

    // Reminder o zbliżającym się końcu — raz dziennie na klucz (throttle w GM storage: „YYYY-MM-DD|klucz").
    _maybeNudge(daysLeft) {
      try {
        const token = new Date().toISOString().slice(0, 10) + '|' + (this.licenseKey || '');
        if (GM_getValue(this.NUDGE_STORAGE_KEY) === token) return;
        GM_setValue(this.NUDGE_STORAGE_KEY, token);
      } catch (_e) { /* brak GM storage → pokaż mimo to */ }
      this._renewalNotice({ expired: false, daysLeft });
    },

    // Notka o odnowie (wygaśnięcie / zbliżający się koniec). Świadomie mała, neutralna (NIE czerwona,
    // NIE full-screen) — z klikalnym linkiem odnowy i „×". expired → zostaje na ekranie (stop musi być
    // widoczny); reminder → auto-znika po 15 s. Cała praca na DOM w try/catch → w node/harness no-op.
    _renewalNotice({ expired, daysLeft }) {
      const msg = expired
        ? 'Licencja wygasła.'
        : `Licencja wygasa za ${daysLeft} ${daysLeft === 1 ? 'dzień' : 'dni'}.`;
      console.info(`[KLUB] ${msg} Odnów: ${this.RENEWAL_URL}`);
      try {
        const id = 'glofox-license-renewal';
        if (document.getElementById(id)) return;
        const el = document.createElement('div');
        el.id = id;
        el.style.cssText = `position: fixed; bottom: 16px; right: 16px; max-width: 320px; background: #2f2f2f; color: #fff; padding: 12px 30px 12px 14px; border-radius: 8px; font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,0.28); z-index: 2147483647; opacity: 0.97;`;
        const close = document.createElement('span');
        close.textContent = '×';
        close.setAttribute('role', 'button');
        close.setAttribute('aria-label', 'Zamknij');
        close.style.cssText = 'position:absolute; top:6px; right:10px; cursor:pointer; opacity:.7; font-size:16px; line-height:1;';
        close.addEventListener('click', () => { try { el.remove(); } catch (_e) { /* noop */ } });
        const text = document.createElement('div');
        text.textContent = `Wtyczki: ${msg}`;
        const link = document.createElement('a');
        link.href = this.RENEWAL_URL;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Odnów licencję →';
        link.style.cssText = 'display:inline-block; margin-top:6px; color:#8ab4ff; font-weight:600; text-decoration:none;';
        el.appendChild(close);
        el.appendChild(text);
        el.appendChild(link);
        const mount = () => {
          if (!document.body) return;
          document.body.appendChild(el);
          if (!expired) setTimeout(() => { try { el.remove(); } catch (_e) { /* noop */ } }, 15000);
        };
        if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
      } catch (_e) { /* noop */ }
    },

    getConfig() { return this.currentConfig; }
  };
  // === LICENSE MODULE END ===

  const L = (typeof KLUB_LICENSE !== 'undefined') ? KLUB_LICENSE : null;
  if (!L) { console.error('[GLOFOX Setup] brak modułu licencji (build?)'); return; }

  const CLAIM_URL = `${L.LICENSE_SERVER}/api/claim`;
  const PENDING = 'PENDING';

  // --- Klucz: wpieczony przez /api/serve, ewentualnie ?key= (legacy), inaczej z GM storage. ----------
  (function persistBakedKey() {
    const baked = L.BAKED_LICENSE_KEY;
    if (baked && baked.slice(0, 2) !== '__') GM_setValue(L.LICENSE_KEY_STORAGE_KEY, String(baked).trim());
    const kp = new URLSearchParams(window.location.search).get('key');
    if (kp) GM_setValue(L.LICENSE_KEY_STORAGE_KEY, kp.trim());
  })();
  const KEY = GM_getValue(L.LICENSE_KEY_STORAGE_KEY) || null;

  // --- POST /api/claim przez GM_xmlhttpRequest (omija CORS; spójnie z resztą wtyczek). ---------------
  function postClaim(payload) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST', url: CLAIM_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(payload),
        timeout: L.REQUEST_TIMEOUT_MS,
        onload: (r) => {
          let body = {}; try { body = JSON.parse(r.responseText || '{}'); } catch (_e) {}
          resolve({ status: r.status, body });
        },
        onerror: () => resolve({ status: 0, body: { error: 'network' } }),
        ontimeout: () => resolve({ status: 0, body: { error: 'timeout' } })
      });
    });
  }

  // --- „Testuj dopasowanie" (BEST-EFFORT v1): wpisuje zapytanie w pole wyszukiwarki klienta Glofox,
  //     jeśli jest na stronie (te same selektory co autoklient), i liczy wyniki. Gdy pola brak —
  //     podpowiada, że test działa w widoku koszyka. NIE blokuje zapisu. -----------------------------
  const CLIENT_INPUT_SEL = '[data-testid="cart-client-search"] input, input[placeholder*="Wyszukaj klienta"], input[placeholder*="Search client"], input[placeholder*="Client"]';
  // Superset selektorów wyników — MUSI być zgodny z autoklient (RESULT_ITEM_SELECTOR),
  // bo to on jest sprawdzony w boju. Nie zawężaj go tutaj.
  const CLIENT_RESULT_SEL = '.searchResult, [data-testid^="client-"], [data-testid*="client-result"], [data-testid^="search_result_"], [data-testid*="search-result"], li[data-testid^="search_result_"], .ant-list-item, [role="option"], [role="listitem"]';
  function setReactInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const normalizeText = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  function countClientMatches(query) {
    const target = normalizeText(query);
    const items = [...document.querySelectorAll(CLIENT_RESULT_SEL)];
    if (!target) return items.length;
    // Liczymy tylko karty, których tekst zawiera wpisaną nazwę — a jak Glofox już przefiltrował
    // (żadna karta nie pasuje tekstowo, ale wyniki są), traktujemy surową liczbę jako fallback.
    const matched = items.filter((el) => normalizeText(el.innerText).includes(target)).length;
    return matched || items.length;
  }
  async function testClientMatch(query) {
    const input = document.querySelector(CLIENT_INPUT_SEL);
    if (!input) return { ok: false, hint: 'Otwórz koszyk (widok wyboru klienta), aby przetestować dopasowanie.' };
    setReactInputValue(input, query);
    // Polling zamiast sztywnego czekania: wyniki Glofoxa pojawiają się asynchronicznie,
    // więc pytamy do skutku aż do deadline'u zamiast zgadywać jeden opóźnienie.
    const deadline = Date.now() + 4000;
    let count = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      count = countClientMatches(query);
      if (count > 0) break;
    }
    return { ok: true, count };
  }

  // --- UI (scoped, prefiks gfxs-) -------------------------------------------------------------------
  const CSS = `
    #gfxs-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;background:#6c5ce7;color:#fff;
      border:none;border-radius:999px;padding:12px 16px;font:600 13px/1 system-ui,sans-serif;cursor:pointer;
      box-shadow:0 6px 20px rgba(108,92,231,.4)}
    #gfxs-fab:hover{background:#5a4bd1}
    #gfxs-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(20,18,40,.55);display:grid;
      place-items:center;padding:16px;font-family:system-ui,Segoe UI,sans-serif}
    #gfxs-modal{background:#fff;color:#1a1a2e;border-radius:16px;max-width:460px;width:100%;padding:26px 24px;
      box-shadow:0 20px 60px rgba(0,0,0,.3);max-height:90vh;overflow:auto}
    #gfxs-modal h2{margin:0 0 4px;font-size:19px}
    #gfxs-modal .sub{color:#666;font-size:13px;margin:0 0 18px}
    #gfxs-modal label{display:block;font-weight:600;font-size:13px;margin:14px 0 5px}
    #gfxs-modal input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d9d9e6;
      border-radius:8px;font-size:14px}
    #gfxs-modal input:disabled{background:#f3f3f8;color:#888}
    #gfxs-modal .hint{font-size:12px;color:#888;margin:4px 0 0}
    #gfxs-row{display:flex;gap:8px;margin-top:8px}
    #gfxs-modal button.act{flex:1;padding:11px;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:14px}
    #gfxs-save{background:#6c5ce7;color:#fff}#gfxs-save:disabled{opacity:.6;cursor:not-allowed}
    #gfxs-test{background:#eee;color:#333}
    #gfxs-close{background:transparent;border:none;color:#999;cursor:pointer;font-size:13px;margin-top:12px;width:100%}
    #gfxs-msg{margin-top:12px;font-size:13px;padding:10px 12px;border-radius:8px;display:none}
    #gfxs-msg.ok{display:block;background:#e8f8ef;color:#1a7f4b}
    #gfxs-msg.err{display:block;background:#fdecec;color:#c0392b}
    @media (prefers-color-scheme: dark){
      #gfxs-modal{background:#25232f;color:#eee}#gfxs-modal input{background:#1e1c28;border-color:#3a3850;color:#eee}
      #gfxs-modal input:disabled{background:#2a2836}#gfxs-test{background:#3a3850;color:#eee}
      #gfxs-modal .sub,#gfxs-modal .hint{color:#a8a6b8}
    }`;

  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
  function injectCssOnce() { if (document.getElementById('gfxs-css')) return; const s = document.createElement('style'); s.id = 'gfxs-css'; s.textContent = CSS; document.head.appendChild(s); }

  function openWizard({ config, clubName, sessionLoc, isPending }) {
    injectCssOnce();
    if (document.getElementById('gfxs-overlay')) return;
    const cfg = config || {};
    const locValue = isPending ? (sessionLoc || '') : (cfg.locationId || '');
    const overlay = el(`
      <div id="gfxs-overlay">
        <div id="gfxs-modal" role="dialog" aria-modal="true">
          <h2>${isPending ? 'Aktywuj wtyczki dla swojego klubu' : 'Ustawienia wtyczek'}</h2>
          <p class="sub">${isPending
            ? 'Wykryliśmy Twój klub z sesji Glofox. Uzupełnij dane sprzedaży i zapisz — wtyczki się uaktywnią.'
            : 'Zmień nazwę sklepu, klienta sprzedażowego lub kaucję. Zapis od razu obowiązuje.'}</p>

          <label>Nazwa sklepu / klubu</label>
          <input id="gfxs-club" type="text" value="${(clubName || '').replace(/"/g, '&quot;')}" placeholder="np. Sigma Sklep Lębork">

          <label>ID lokalizacji (locationId)</label>
          <input id="gfxs-loc" type="text" value="${locValue.replace(/"/g, '&quot;')}" ${isPending ? '' : 'disabled'}>
          <p class="hint">${isPending
            ? 'Pobrane automatycznie z Twojej sesji Glofox. Zwykle nie trzeba zmieniać.'
            : 'Przypisane do klubu. Zmiana wyłącznie przez administratora.'}</p>

          <label>Klient sprzedażowy — nazwa do wyszukania (autoklient)</label>
          <input id="gfxs-client" type="text" value="${(cfg.clientQuery || cfg.clientName || '').replace(/"/g, '&quot;')}" placeholder="np. Sprzedaż detaliczna">
          <div id="gfxs-row">
            <button class="act" id="gfxs-test" type="button">Testuj dopasowanie</button>
          </div>

          <label>Kaucja — nazwa produktu do wyszukania (autokaucja)</label>
          <input id="gfxs-deposit" type="text" value="${(cfg.depositQuery || cfg.depositNameFallback || 'Kaucja Plastik').replace(/"/g, '&quot;')}" placeholder="Kaucja Plastik">
          <p class="hint">Opcjonalnie ID produktu kaucji, jeśli je znasz:</p>
          <input id="gfxs-depositId" type="text" value="${(cfg.depositProductId || '').replace(/"/g, '&quot;')}" placeholder="(opcjonalne) ID produktu">

          <div id="gfxs-msg"></div>
          <div id="gfxs-row">
            <button class="act" id="gfxs-save" type="button">${isPending ? 'Aktywuj i zapisz' : 'Zapisz zmiany'}</button>
          </div>
          <button id="gfxs-close" type="button">Zamknij</button>
        </div>
      </div>`);
    document.body.appendChild(overlay);

    const $ = (id) => overlay.querySelector(id);
    const msg = $('#gfxs-msg');
    const setMsg = (text, kind) => { msg.className = kind || ''; msg.textContent = text; };
    $('#gfxs-close').onclick = () => overlay.remove();

    $('#gfxs-test').onclick = async () => {
      const q = $('#gfxs-client').value.trim();
      if (!q) return setMsg('Wpisz najpierw nazwę klienta.', 'err');
      setMsg('Testuję…', 'ok');
      const res = await testClientMatch(q);
      if (!res.ok) return setMsg(res.hint, 'err');
      setMsg(res.count > 0 ? `Znaleziono ${res.count} pasujących wyników w Glofox ✔` : 'Brak wyników — sprawdź pisownię nazwy.', res.count > 0 ? 'ok' : 'err');
    };

    $('#gfxs-save').onclick = async () => {
      const clubNameVal = $('#gfxs-club').value.trim();
      const locVal = $('#gfxs-loc').value.trim();
      const clientVal = $('#gfxs-client').value.trim();
      const depositVal = $('#gfxs-deposit').value.trim();
      const depositIdVal = $('#gfxs-depositId').value.trim();
      if (isPending && !locVal) return setMsg('Brak ID lokalizacji — zaloguj się do swojego klubu w Glofox.', 'err');

      const payload = {
        key: KEY,
        clubName: clubNameVal,
        config: {
          locationId: locVal,
          clientName: clientVal, clientQuery: clientVal,
          depositQuery: depositVal, depositNameFallback: depositVal,
          depositProductId: depositIdVal
        }
      };
      $('#gfxs-save').disabled = true;
      setMsg('Zapisuję…', 'ok');
      const { status, body } = await postClaim(payload);
      $('#gfxs-save').disabled = false;
      if (status === 200 && body.ok) {
        setMsg('Zapisano! Odśwież stronę Glofox — wtyczki się uaktywnią.', 'ok');
        // Wymuś świeżą walidację przy następnym uruchomieniu (busta lokalny cache Setupu).
        try { GM_setValue(L.LICENSE_CACHE_KEY, ''); } catch (_e) {}
      } else {
        setMsg(body.error || `Błąd zapisu (${status}).`, 'err');
      }
    };
  }

  function openNoKey() {
    injectCssOnce();
    if (document.getElementById('gfxs-overlay')) return;
    const overlay = el(`<div id="gfxs-overlay"><div id="gfxs-modal">
      <h2>Brak klucza licencyjnego</h2>
      <p class="sub">Ten kreator uruchamiaj z instalatora (wtyczki.wotan91.pl), który wpieka Twój klucz.
      Jeśli masz klucz, zainstaluj skrypt „Setup" ponownie przez przycisk w instalatorze.</p>
      <button id="gfxs-close" class="act" style="background:#6c5ce7;color:#fff">OK</button>
    </div></div>`);
    document.body.appendChild(overlay);
    overlay.querySelector('#gfxs-close').onclick = () => overlay.remove();
  }

  function addFab() {
    injectCssOnce();
    if (document.getElementById('gfxs-fab')) return;
    const fab = el('<button id="gfxs-fab" title="Konfiguracja wtyczek">⚙ Ustawienia wtyczek</button>');
    document.body.appendChild(fab);
    fab.onclick = () => main(true);
    return fab;
  }

  // --- Główny przepływ ------------------------------------------------------------------------------
  async function main(userTriggered) {
    if (!KEY) { if (userTriggered) openNoKey(); return; }
    const result = await L.validate();
    if (!result || !result.valid) {
      if (userTriggered) { injectCssOnce(); openNoKey(); }
      console.info('[GLOFOX Setup] licencja nieaktywna/niepotwierdzona — kreator wstrzymany.');
      return;
    }
    const config = result.config || {};
    const isPending = !config.locationId || config.locationId === PENDING;
    const sessionLoc = await L._waitForLocationId(L.LOCATION_RETRY_MS);
    // Auto-otwórz kreator tylko gdy PENDING (pierwsza konfiguracja). Później dostępny pod FAB-em.
    if (isPending || userTriggered) {
      openWizard({ config, clubName: result.clubName, sessionLoc, isPending });
    }
  }

  addFab();
  main(false);
})();
