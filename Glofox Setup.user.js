// ==UserScript==
// @name         Klub - Setup (Konfiguracja)
// @namespace    wotan91
// @version      1.6
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

  // === KLUB UI START ===
  const KLUB_UI = (function (CSS) {
    'use strict';

    const HOST = 'data-klub-ui-modal';
    const CLOSING = 'data-klub-ui-closing';
    const TOAST = 'data-klub-ui-toast';
    const BELOW_PROFILE = 'data-klub-ui-below-profile';
    const STYLE = 'data-klub-ui';
    const CLOSE_FALLBACK_MS = 200;
    const ENTER_MS = 320;
    const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

    const ICONS = {
      close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
      check: '<polyline points="20 6 9 17 4 12"/>',
      'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
      'chevron-up': '<polyline points="18 15 12 9 6 15"/>',
      'chevron-left': '<polyline points="15 18 9 12 15 6"/>',
      'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
      'chevrons-left': '<polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/>',
      'chevrons-right': '<polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>',
      alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
      info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
      calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
      search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
      refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
      tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
      phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
      pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
      upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
      'trending-up': '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
      sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
      pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    };

    const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

    const icon = (name) => (ICONS[name] ? `<svg class="klub-ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>` : '');

    // Skrót stylów odróżnia wersje modułu: wtyczki aktualizują się osobno, więc na jednej stronie mogą być dwie.
    const styleVersion = (() => {
      let hash = 5381;
      for (let i = 0; i < CSS.length; i += 1) hash = (hash * 33 + CSS.charCodeAt(i)) % 2147483647;
      return String(hash);
    })();

    function ensureStyles(root = document) {
      const scope = root.nodeType === 9 ? root.head : root;
      if (scope.querySelector(`style[${STYLE}="${styleVersion}"]`)) return;
      const style = document.createElement('style');
      style.setAttribute(STYLE, styleVersion);
      style.textContent = CSS;
      scope.appendChild(style);
    }

    // Każda wtyczka ma własną kopię modułu, dlatego stan wspólny (stos modali, przewijanie) trzymamy w DOM.
    const openHosts = () => document.querySelectorAll(`[${HOST}]`);

    function topHost() {
      const hosts = document.querySelectorAll(`[${HOST}]:not([${CLOSING}])`);
      return hosts[hosts.length - 1] || null;
    }

    function lockScroll() {
      if (!openHosts().length) document.documentElement.dataset.klubUiOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }

    function unlockScroll() {
      if (openHosts().length) return;
      const root = document.documentElement;
      document.body.style.overflow = root.dataset.klubUiOverflow || '';
      delete root.dataset.klubUiOverflow;
    }

    function deepActiveElement() {
      let active = document.activeElement;
      while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
      return active;
    }

    function createHost(attribute) {
      const host = document.createElement('div');
      host.setAttribute(attribute, '');
      const shadow = host.attachShadow({ mode: 'open' });
      ensureStyles(shadow);
      const wrapper = document.createElement('div');
      wrapper.className = 'klub-root';
      shadow.appendChild(wrapper);
      return { host, shadow, wrapper };
    }

    // Usuwa po animacji albo po czasie, jeśli zdarzenie nie przyjdzie (np. zakładka w tle).
    function removeAfterClosing(el, done) {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        done();
      };
      el.addEventListener('animationend', (e) => { if (e.target === el) finish(); });
      setTimeout(finish, CLOSE_FALLBACK_MS);
      el.classList.remove('is-entering');
      el.classList.add('is-closing');
    }

    function modal({ size = 'md', title, sub, bodyHtml = '', footHtml, belowProfile = false, dismissOnBackdrop = false, onClose, closeButton = true, focus } = {}) {
      const opener = deepActiveElement();
      lockScroll();
      const { host, shadow, wrapper } = createHost(HOST);
      if (belowProfile) host.setAttribute(BELOW_PROFILE, '');
      const sizeClass = size === 'sm' ? ' klub-modal--sm' : size === 'full' ? ' klub-modal--full' : '';
      wrapper.innerHTML = `<div class="klub-overlay is-entering${belowProfile ? ' klub-overlay--below-profile' : ''}">
        <div class="klub-modal${sizeClass}" role="dialog" aria-modal="true" aria-labelledby="klub-ui-title" tabindex="-1">
          <div class="klub-modal__head">
            <div><h2 class="klub-modal__title" id="klub-ui-title">${esc(title)}</h2>${sub ? `<p class="klub-modal__sub">${esc(sub)}</p>` : ''}</div>
            ${closeButton ? `<button class="klub-btn klub-btn--ghost klub-btn--icon" type="button" data-klub-close aria-label="Zamknij">${icon('close')}</button>` : ''}
          </div>
          <div class="klub-modal__body">${bodyHtml}</div>
          ${footHtml ? `<div class="klub-modal__foot">${footHtml}</div>` : ''}
        </div>
      </div>`;
      document.body.appendChild(host);
      const overlay = wrapper.querySelector('.klub-overlay');
      const dialog = wrapper.querySelector('[role=dialog]');
      const body = wrapper.querySelector('.klub-modal__body');
      setTimeout(() => overlay.classList.remove('is-entering'), ENTER_MS);

      let closing = null;
      const onEscape = (e) => {
        if (e.key !== 'Escape' || topHost() !== host) return;
        e.stopPropagation();
        e.preventDefault();
        close('esc');
      };
      function close(reason = 'api') {
        if (closing) return closing;
        host.setAttribute(CLOSING, '');
        window.removeEventListener('keydown', onEscape, true);
        closing = new Promise((resolve) => {
          removeAfterClosing(overlay, () => {
            host.remove();
            unlockScroll();
            if (opener && opener.isConnected && opener.focus) opener.focus();
            try {
              if (onClose) onClose(reason);
            } finally {
              resolve();
            }
          });
        });
        return closing;
      }

      window.addEventListener('keydown', onEscape, true);
      shadow.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const items = dialog.querySelectorAll(FOCUSABLE);
        if (!items.length) { e.preventDefault(); return; }
        const first = items[0];
        const last = items[items.length - 1];
        const active = shadow.activeElement;
        if (e.shiftKey && (active === first || active === dialog)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      });
      overlay.addEventListener('click', (e) => { if (dismissOnBackdrop && e.target === overlay) close('backdrop'); });
      const closer = wrapper.querySelector('[data-klub-close]');
      if (closer) closer.addEventListener('click', () => close('button'));

      const start = (focus && dialog.querySelector(focus)) || body.querySelector(FOCUSABLE) || dialog.querySelector(`.klub-modal__foot ${FOCUSABLE}`) || dialog;
      start.focus();
      return { root: shadow, el: dialog, body, close };
    }

    function confirm({ title, summary = [], warning, confirmLabel, cancelLabel = 'Anuluj', tone = 'primary' }) {
      return new Promise((resolve) => {
        let result = false;
        const rows = summary.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('');
        const dialog = modal({
          size: 'sm',
          title,
          closeButton: false,
          bodyHtml: `<div class="klub-confirm">${rows ? `<dl class="klub-confirm__summary">${rows}</dl>` : ''}${warning ? `<div class="klub-notice klub-notice--warning" role="alert">${icon('alert')}<span>${esc(warning)}</span></div>` : ''}</div>`,
          footHtml: `<button class="klub-btn" type="button" data-klub-cancel>${esc(cancelLabel)}</button><button class="klub-btn klub-btn--${tone === 'danger' ? 'danger' : 'primary'}" type="button" data-klub-ok>${esc(confirmLabel)}</button>`,
          focus: tone === 'danger' ? '[data-klub-cancel]' : '[data-klub-ok]',
          onClose: () => resolve(result),
        });
        dialog.root.querySelector('[data-klub-cancel]').addEventListener('click', () => dialog.close('button'));
        dialog.root.querySelector('[data-klub-ok]').addEventListener('click', () => {
          result = true;
          dialog.close('button');
        });
      });
    }

    function toast(message, { duration = 4000, actionLabel, onAction } = {}) {
      document.querySelectorAll(`[${TOAST}]`).forEach((old) => old.remove());
      const { host, wrapper } = createHost(TOAST);
      wrapper.innerHTML = `<div class="klub-toast" role="status"><span>${esc(message)}</span>${actionLabel ? `<button class="klub-toast__action" type="button">${esc(actionLabel)}</button>` : ''}</div>`;
      document.body.appendChild(host);
      const el = wrapper.querySelector('.klub-toast');
      const action = wrapper.querySelector('.klub-toast__action');
      if (action) {
        action.addEventListener('click', () => {
          if (onAction) onAction();
          host.remove();
        });
      }
      setTimeout(() => {
        if (host.isConnected) removeAfterClosing(el, () => host.remove());
      }, duration);
    }

    function replayClass(el, name, ms) {
      el.classList.remove(name);
      void el.offsetWidth;
      el.classList.add(name);
      setTimeout(() => el.classList.remove(name), ms);
    }
    const enterRows = (table) => replayClass(table, 'klub-table--enter', 520);
    const pop = (tag) => replayClass(tag, 'klub-tag--pop', 300);

    return { css: CSS, ensureStyles, modal, confirm, toast, icon, esc, enterRows, pop };
  })(":host, .klub-root {\n  --surface: #ffffff;\n  --surface-2: #fbfbff;\n  --surface-hover: #f4f6ff;\n  --paper: oklch(0.968 0.004 264);\n  --surface-inverse: oklch(0.275 0.028 280);\n  --ink: #222245;\n  --ink-2: #40466f;\n  --muted: oklch(0.53 0.028 278);\n  --on-inverse: #ffffff;\n  --on-inverse-muted: #c9cbe0;\n  --rule: #ececf6;\n  --border-control: oklch(0.62 0.02 278);\n  --accent: #5f63e9;\n  --accent-strong: #4b46c1;\n  --on-accent: #ffffff;\n  --accent-wash: #eef1ff;\n  --accent-wash-ink: #444bb5;\n  --success: #1e7d3f;\n  --on-success: #ffffff;\n  --success-wash: #e3f6e9;\n  --danger: #b4233f;\n  --on-danger: #ffffff;\n  --danger-wash: #ffe6ea;\n  --warning: #8a5200;\n  --warning-wash: #fff4df;\n  --neutral-ink: #4a4f6b;\n  --neutral-wash: #eceef5;\n  --focus: var(--accent-strong);\n  --backdrop: rgba(10, 14, 28, 0.45);\n  --shadow-modal: 0 10px 30px rgba(0, 0, 0, 0.25);\n  --shadow-popover: 0 12px 28px rgba(0, 0, 0, 0.18);\n  --shadow-launcher: 0 6px 20px rgba(95, 99, 233, 0.4);\n  --space-3xs: 4px;\n  --space-2xs: 8px;\n  --space-xs: 12px;\n  --space-sm: 16px;\n  --space-md: 24px;\n  --space-lg: 32px;\n  --radius-sm: 8px;\n  --radius-pill: 999px;\n  --control-sm: 28px;\n  --control-md: 32px;\n  --control-lg: 36px;\n  --cell-x: 10px;\n  --cell-y: 9px;\n  --row-y: 10px;\n  --bar-y: 6px;\n  --field-gap: 2px;\n  --modal-sm: 520px;\n  --modal-md: 760px;\n  --modal-full: 1500px;\n  --z-below-profile: 104;\n  --z-dialog: 1100;\n  --z-nested: 1200;\n  --z-popover: 1300;\n  --z-toast: 2000;\n  --font-ui: \"Nunito Sans\", system-ui, -apple-system, \"Segoe UI\", sans-serif;\n  --font-mono: \"JetBrains Mono\", ui-monospace, Menlo, monospace;\n}\n/* Klub: komponenty modali i tabel. Wszystkie wartości pochodzą z tokenów. */\n\n.klub-root, .klub-root *, .klub-root *::before, .klub-root *::after { box-sizing: border-box; }\n.klub-root { font-family: var(--font-ui); font-size: 13px; line-height: 18px; color: var(--ink); }\n.klub-root :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }\n.klub-root svg.klub-ic { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }\n\n/* Gospodarz Shadow DOM wyznacza warstwę względem aplikacji. */\n:host { position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: var(--z-dialog); }\n:host([data-klub-ui-below-profile]) { z-index: var(--z-below-profile); }\n:host([data-klub-ui-toast]) { z-index: var(--z-toast); }\n\n/* Button */\n.klub-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: var(--control-md); padding: 0 var(--space-xs); border: 1px solid var(--border-control); border-radius: var(--radius-sm); background: var(--surface); color: var(--ink); font: inherit; font-size: 13px; font-weight: 600; white-space: nowrap; cursor: pointer; }\n.klub-btn:hover { background: var(--accent-wash); }\n.klub-btn:disabled { opacity: .55; cursor: not-allowed; }\n.klub-btn--primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }\n.klub-btn--primary:hover { background: var(--accent-strong); border-color: var(--accent-strong); }\n.klub-btn--danger { background: var(--danger); border-color: var(--danger); color: var(--on-danger); }\n.klub-btn--danger:hover { background: var(--danger); filter: brightness(.92); }\n.klub-btn--success { background: var(--success); border-color: var(--success); color: var(--on-success); }\n.klub-btn--success:hover { background: var(--success); filter: brightness(.92); }\n.klub-btn--ghost { background: transparent; border-color: transparent; color: var(--ink-2); }\n.klub-btn--icon { width: var(--control-md); padding: 0; }\n.klub-btn--sm { min-height: var(--control-sm); font-size: 12px; padding: 0 var(--space-2xs); }\n.klub-btn--sm.klub-btn--icon { width: var(--control-sm); padding: 0; }\n\n/* Modal */\n.klub-overlay { position: fixed; inset: 0; z-index: var(--z-dialog); display: flex; align-items: center; justify-content: center; padding: var(--space-md); background: var(--backdrop); }\n.klub-overlay--nested { z-index: var(--z-nested); }\n.klub-overlay--below-profile { z-index: var(--z-below-profile); }\n.klub-modal { display: flex; flex-direction: column; width: var(--modal-md); max-width: 100%; max-height: calc(100vh - 2 * var(--space-md)); overflow: hidden; background: var(--surface); border-radius: var(--radius-sm); box-shadow: var(--shadow-modal); color: var(--ink); }\n.klub-modal--sm { width: var(--modal-sm); }\n.klub-modal--full { width: var(--modal-full); height: calc(100vh - 2 * var(--space-md)); }\n.klub-modal__head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-xs); padding: var(--row-y) var(--space-sm); border-bottom: 1px solid var(--rule); }\n.klub-modal__title { margin: 0; font-size: 16px; line-height: 22px; font-weight: 700; color: var(--ink); }\n.klub-modal__sub { margin: 0; font-size: 12px; line-height: 16px; color: var(--muted); }\n.klub-modal__actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2xs); }\n.klub-modal__body { flex: 1; min-height: 0; overflow: auto; padding: var(--space-xs) var(--space-sm); }\n.klub-modal__body--flush { padding: 0; display: flex; flex-direction: column; }\n.klub-modal__foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2xs); padding: var(--row-y) var(--space-sm); border-top: 1px solid var(--rule); background: var(--surface-2); }\n.klub-modal__foot--between { justify-content: space-between; }\n.klub-modal__foot--pages { padding: var(--space-2xs) var(--space-sm); font-size: 12px; color: var(--ink-2); }\n\n/* ConfirmDialog */\n.klub-confirm { display: flex; flex-direction: column; gap: var(--row-y); }\n.klub-confirm__summary dd { min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }\n.klub-confirm__summary { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: var(--field-gap) var(--space-xs); }\n.klub-confirm__summary dt { color: var(--muted); }\n.klub-confirm__summary dd { margin: 0; color: var(--ink); font-weight: 600; }\n\n/* Table */\n.klub-table-wrap { flex: 1; min-height: 0; overflow: auto; }\n.klub-table { width: 100%; border-collapse: collapse; font-size: 12px; line-height: 16px; }\n.klub-table th, .klub-table td { padding: var(--cell-y) var(--cell-x); border-bottom: 1px solid var(--rule); text-align: left; vertical-align: middle; white-space: nowrap; }\n.klub-table th { position: sticky; top: 0; z-index: 1; background: var(--surface-2); color: var(--ink-2); font-weight: 700; }\n.klub-table tbody tr:hover td { background: var(--surface-hover); }\n.klub-table tr.is-selected td { background: var(--accent-wash); }\n.klub-table__sort { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }\n.klub-table__sort svg.klub-ic { width: 12px; height: 12px; }\n.klub-table__check { width: 32px; }\n.klub-table__check input { display: block; margin: 0; width: 16px; height: 16px; accent-color: var(--accent); }\n.klub-table__num { text-align: right; font-variant-numeric: tabular-nums; }\n.klub-table__link { padding: 0; border: 0; background: none; color: var(--accent-strong); font: inherit; cursor: pointer; }\n.klub-table__link:hover { text-decoration: underline; }\n.klub-table__expand td { background: var(--surface-2); color: var(--ink-2); white-space: normal; }\n.klub-table__empty { padding: var(--space-lg); text-align: center; color: var(--muted); }\n\n/* Pagination */\n.klub-pages { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }\n.klub-pages__range { margin-right: auto; font-size: 12px; color: var(--ink-2); }\n.klub-page { display: inline-flex; align-items: center; justify-content: center; min-width: var(--control-sm); height: var(--control-sm); padding: 0 6px; border: 1px solid var(--border-control); border-radius: var(--radius-sm); background: var(--surface); color: var(--ink); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }\n.klub-page:hover { background: var(--accent-wash); }\n.klub-page:disabled { opacity: .55; cursor: not-allowed; }\n.klub-page[aria-current=\"page\"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }\n\n/* Field */\n.klub-field { display: flex; flex-direction: column; gap: var(--field-gap); min-width: 0; }\n.klub-field__label { font-size: 12px; line-height: 16px; font-weight: 600; color: var(--ink-2); }\n.klub-input { width: 100%; min-height: var(--control-md); padding: 5px var(--space-2xs); border: 1px solid var(--border-control); border-radius: var(--radius-sm); background: var(--surface); color: var(--ink); font: inherit; font-size: 13px; font-weight: 400; line-height: 18px; }\n.klub-input:focus-visible { outline-offset: 0; border-color: var(--focus); }\n.klub-field__label .klub-input { display: block; margin-top: var(--field-gap); }\n.klub-input::placeholder { color: var(--muted); }\ntextarea.klub-input { min-height: 88px; resize: vertical; }\n.klub-input:disabled { background: var(--paper); color: var(--muted); cursor: not-allowed; }\n.klub-input[readonly] { background: var(--surface-2); border-color: var(--rule); color: var(--ink-2); }\n.klub-field.is-invalid .klub-input { border-color: var(--danger); }\n.klub-field__hint { font-size: 12px; line-height: 16px; color: var(--muted); }\n.klub-field__error { display: flex; align-items: center; gap: 4px; font-size: 12px; line-height: 16px; color: var(--danger); }\n.klub-field__error svg.klub-ic { width: 14px; height: 14px; }\n.klub-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); gap: var(--row-y) var(--space-xs); }\n.klub-form__full { grid-column: 1 / -1; }\n\n/* FilterPanel */\n.klub-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(140px, 100%), 1fr)); gap: var(--space-2xs); padding: var(--space-2xs) var(--space-sm); border-bottom: 1px solid var(--rule); }\n.klub-filters .klub-field__label { font-size: 11px; line-height: 14px; }\n.klub-filters .klub-input { font-size: 12px; }\n.klub-filters__actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2xs); padding: var(--bar-y) var(--space-sm); border-bottom: 1px solid var(--rule); }\n.klub-filters__group { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2xs); }\n.klub-filters__selection { font-size: 12px; font-weight: 700; color: var(--ink-2); }\n\n/* Tag */\n.klub-tag { display: inline-block; padding: 3px var(--space-2xs); border-radius: var(--radius-pill); font-size: 11px; line-height: 14px; font-weight: 700; white-space: nowrap; }\n.klub-tag--accent { background: var(--accent-wash); color: var(--accent-wash-ink); }\n.klub-tag--warning { background: var(--warning-wash); color: var(--warning); }\n.klub-tag--danger { background: var(--danger-wash); color: var(--danger); }\n.klub-tag--success { background: var(--success-wash); color: var(--success); }\n.klub-tag--neutral { background: var(--neutral-wash); color: var(--neutral-ink); }\n\n/* FilterChip */\n.klub-chips { display: flex; flex-wrap: wrap; gap: 6px; }\n.klub-chip { display: inline-flex; align-items: center; gap: 6px; min-height: var(--control-md); padding: 0 var(--space-xs); border: 1px solid var(--border-control); border-radius: var(--radius-pill); background: var(--surface); color: var(--ink-2); font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }\n.klub-chip:hover { background: var(--accent-wash); }\n.klub-chip[aria-pressed=\"true\"] { background: var(--accent-strong); border-color: var(--accent-strong); color: var(--on-accent); }\n.klub-chip__count { font-weight: 600; font-variant-numeric: tabular-nums; }\n\n/* Menu */\n.klub-menu-wrap { position: relative; display: inline-block; }\n.klub-menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: var(--z-popover); display: flex; flex-direction: column; min-width: 220px; padding: var(--space-3xs); border: 1px solid var(--rule); border-radius: var(--radius-sm); background: var(--surface); box-shadow: var(--shadow-popover); }\n.klub-menu__item { display: flex; align-items: center; gap: var(--space-2xs); width: 100%; min-height: var(--control-md); padding: 0 var(--space-2xs); border: 0; border-radius: 6px; background: none; color: var(--ink); font: inherit; font-size: 12px; font-weight: 600; text-align: left; cursor: pointer; }\n.klub-menu__item:hover:not(:disabled) { background: var(--accent-wash); }\n.klub-menu__item:disabled { color: var(--muted); cursor: not-allowed; }\n.klub-menu__note { padding: var(--space-3xs) var(--space-2xs); font-size: 11px; line-height: 14px; color: var(--muted); }\n\n/* DatePicker */\n.klub-cal { width: 264px; padding: var(--space-2xs); border: 1px solid var(--rule); border-radius: var(--radius-sm); background: var(--surface); box-shadow: var(--shadow-popover); z-index: var(--z-popover); }\n.klub-cal__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2xs); margin-bottom: var(--space-2xs); }\n.klub-cal__title { font-size: 13px; font-weight: 700; color: var(--ink); }\n.klub-cal__table { width: 100%; border-collapse: collapse; }\n.klub-cal__table th { height: 28px; font-size: 11px; font-weight: 700; color: var(--ink-2); text-align: center; }\n.klub-cal__table td { padding: 1px; text-align: center; }\n.klub-cal__day { width: 100%; height: 30px; border: 0; border-radius: 6px; background: none; color: var(--ink); font: inherit; font-size: 12px; font-variant-numeric: tabular-nums; cursor: pointer; }\n.klub-cal__day:hover { background: var(--accent-wash); }\n.klub-cal__day.is-today { box-shadow: inset 0 0 0 1px var(--accent-strong); }\n.klub-cal__day.is-selected { background: var(--accent); color: var(--on-accent); }\n.klub-cal__foot { display: flex; justify-content: space-between; gap: var(--space-2xs); margin-top: var(--space-2xs); }\n\n/* Notice */\n.klub-notice { display: flex; align-items: flex-start; gap: var(--space-2xs); padding: var(--space-2xs) var(--space-xs); border-radius: var(--radius-sm); font-size: 13px; line-height: 18px; }\n.klub-notice svg.klub-ic { margin-top: 1px; }\n.klub-notice--info { background: var(--accent-wash); color: var(--accent-wash-ink); }\n.klub-notice--success { background: var(--success-wash); color: var(--success); }\n.klub-notice--warning { background: var(--warning-wash); color: var(--warning); }\n.klub-notice--danger { background: var(--danger-wash); color: var(--danger); }\n\n/* Toast */\n.klub-toast { position: fixed; right: 18px; bottom: 18px; z-index: var(--z-toast); display: flex; align-items: flex-start; gap: var(--space-2xs); max-width: 320px; padding: 10px var(--space-xs); border-radius: var(--radius-sm); background: var(--surface-inverse); color: var(--on-inverse); box-shadow: var(--shadow-popover); font-size: 13px; line-height: 18px; }\n.klub-toast--static { position: static; }\n.klub-toast__action { margin-left: var(--space-2xs); padding: 0; border: 0; background: none; color: var(--on-inverse); font: inherit; font-weight: 700; text-decoration: underline; cursor: pointer; }\n\n/* Progress */\n.klub-progress { display: flex; flex-direction: column; gap: 6px; }\n.klub-progress__row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-xs); font-size: 12px; color: var(--ink-2); }\n.klub-progress__track { height: 8px; overflow: hidden; border-radius: var(--radius-pill); background: var(--neutral-wash); }\n.klub-progress__fill { display: block; height: 100%; border-radius: var(--radius-pill); background: var(--accent); }\n.klub-log { max-height: 140px; margin: 0; overflow: auto; padding: var(--space-2xs); border-radius: var(--radius-sm); background: var(--surface-inverse); color: var(--on-inverse-muted); font-family: var(--font-mono); font-size: 11px; line-height: 16px; white-space: pre-wrap; }\n\n/* LauncherButton */\n.klub-launcher { position: fixed; right: 18px; bottom: 18px; z-index: calc(var(--z-dialog) - 1); display: inline-flex; align-items: center; gap: var(--space-2xs); min-height: var(--control-lg); padding: 0 var(--space-sm); border: 0; border-radius: var(--radius-pill); background: var(--accent); color: var(--on-accent); box-shadow: var(--shadow-launcher); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }\n.klub-launcher:hover { background: var(--accent-strong); }\n.klub-launcher--static { position: static; }\n\n/* Ruch. Krótko i miękko: animujemy transform i opacity. Wejście włącza klasa .is-entering, dodana raz przy otwarciu. */\n.klub-root { --klub-ease: cubic-bezier(0.16, 1, 0.3, 1); --klub-fast: 120ms; --klub-mid: 180ms; --klub-slow: 260ms; }\n\n@keyframes klub-fade { from { opacity: 0; } to { opacity: 1; } }\n@keyframes klub-fade-out { from { opacity: 1; } to { opacity: 0; } }\n@keyframes klub-rise { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }\n@keyframes klub-fall { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(6px) scale(.99); } }\n@keyframes klub-drop { from { opacity: 0; transform: translateY(-4px) scale(.98); } to { opacity: 1; transform: none; } }\n@keyframes klub-toast-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }\n@keyframes klub-row-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }\n@keyframes klub-pop { 0% { transform: scale(1); } 40% { transform: scale(1.14); } 100% { transform: scale(1); } }\n@keyframes klub-spin { to { transform: rotate(360deg); } }\n\n.klub-btn, .klub-page, .klub-chip, .klub-menu__item, .klub-launcher, .klub-cal__day { transition: background-color var(--klub-fast) ease, border-color var(--klub-fast) ease, color var(--klub-fast) ease, box-shadow var(--klub-fast) ease, transform var(--klub-fast) ease; }\n.klub-table td { transition: background-color var(--klub-fast) ease; }\n.klub-input { transition: border-color var(--klub-fast) ease; }\n.klub-btn:hover:not(:disabled), .klub-page:hover:not(:disabled):not([aria-current=\"page\"]) { transform: translateY(-1px); }\n.klub-btn--primary:hover:not(:disabled) { box-shadow: var(--shadow-launcher); }\n.klub-btn:active:not(:disabled), .klub-page:active:not(:disabled), .klub-chip:active, .klub-launcher:active { transform: scale(.97); }\n.klub-launcher:hover { transform: translateY(-2px); }\n.klub-progress__fill { transition: width var(--klub-slow) var(--klub-ease); }\n\n.klub-overlay.is-entering { animation: klub-fade var(--klub-mid) ease both; }\n.klub-overlay.is-entering .klub-modal { animation: klub-rise var(--klub-slow) var(--klub-ease) both; }\n.klub-overlay.is-closing { animation: klub-fade-out var(--klub-fast) ease both; }\n.klub-overlay.is-closing .klub-modal { animation: klub-fall var(--klub-fast) ease both; }\n.klub-menu.is-entering, .klub-cal.is-entering, .klub-notice.is-entering, .klub-field__error.is-entering { animation: klub-drop var(--klub-mid) var(--klub-ease) both; }\n.klub-toast { animation: klub-toast-in var(--klub-slow) var(--klub-ease) both; }\n.klub-toast--static { animation: none; }\n.klub-toast.is-closing { animation: klub-fade-out var(--klub-fast) ease both; }\n.klub-table--enter tbody tr { animation: klub-row-in var(--klub-mid) var(--klub-ease) both; animation-delay: 240ms; }\n.klub-table--enter tbody tr:nth-child(1) { animation-delay: 0ms; }\n.klub-table--enter tbody tr:nth-child(2) { animation-delay: 20ms; }\n.klub-table--enter tbody tr:nth-child(3) { animation-delay: 40ms; }\n.klub-table--enter tbody tr:nth-child(4) { animation-delay: 60ms; }\n.klub-table--enter tbody tr:nth-child(5) { animation-delay: 80ms; }\n.klub-table--enter tbody tr:nth-child(6) { animation-delay: 100ms; }\n.klub-table--enter tbody tr:nth-child(7) { animation-delay: 120ms; }\n.klub-table--enter tbody tr:nth-child(8) { animation-delay: 140ms; }\n.klub-table--enter tbody tr:nth-child(9) { animation-delay: 160ms; }\n.klub-table--enter tbody tr:nth-child(10) { animation-delay: 180ms; }\n.klub-table--enter tbody tr:nth-child(11) { animation-delay: 200ms; }\n.klub-table--enter tbody tr:nth-child(12) { animation-delay: 220ms; }\n.klub-tag--pop { animation: klub-pop var(--klub-slow) var(--klub-ease); }\n.klub-btn.is-busy svg.klub-ic { animation: klub-spin 800ms linear infinite; }\n\n@media (prefers-reduced-motion: reduce) {\n  .klub-root, .klub-root * { transition-duration: 1ms !important; transform: none !important; }\n  .klub-overlay.is-entering, .klub-overlay.is-entering .klub-modal, .klub-menu.is-entering, .klub-cal.is-entering, .klub-notice.is-entering, .klub-field__error.is-entering, .klub-toast { animation: klub-fade 120ms ease both !important; }\n  .klub-table--enter tbody tr, .klub-tag--pop, .klub-btn.is-busy svg.klub-ic { animation: none !important; }\n}\n\n.klub-root { font-family: inherit; }\n");
  // === KLUB UI END ===

  const L = (typeof KLUB_LICENSE !== 'undefined') ? KLUB_LICENSE : null;
  if (!L) { console.error('[KLUB Setup] brak modułu licencji (build?)'); return; }

  // Setup woła L.validate() bezpośrednio (nie przez enforce()), więc slug nie ustawia się sam —
  // ustawiamy go tu ręcznie, inaczej telemetria/kill-switch widzą 'unknown' zamiast 'setup'.
  L.scriptSlug = 'setup';

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

  // --- Lista e-maili bez ograniczeń: czyta ją wtyczka Uprawnienia, pod tym samym kluczem w localStorage. -
  const EXEMPT_STORAGE_KEY = 'klub:uprawnienia:exemptEmails';
  function readExemptEmails() {
    try {
      const list = JSON.parse(window.localStorage.getItem(EXEMPT_STORAGE_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (_e) {
      return [];
    }
  }
  function saveExemptEmails(text) {
    const emails = text.split(/[\s,;]+/).map((v) => v.toLowerCase()).filter(Boolean);
    window.localStorage.setItem(EXEMPT_STORAGE_KEY, JSON.stringify([...new Set(emails)]));
  }

  // --- UI: wygląd i zachowanie z modułu KLUB_UI. Identyfikatory gfxs- zostają dla logiki i testów. ----
  const { esc, icon } = KLUB_UI;
  let openDialog = null;

  const textInput = (id, value, placeholder, attrs = '') =>
    `<input class="klub-input" id="${id}" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" ${attrs}>`;
  const field = (id, label, control, hint) =>
    `<div class="klub-field"><label class="klub-field__label" for="${id}">${esc(label)}</label>${control}${hint ? `<span class="klub-field__hint">${esc(hint)}</span>` : ''}</div>`;

  function openWizard({ config, clubName, sessionLoc, isPending }) {
    if (openDialog) return;
    const cfg = config || {};
    const locValue = isPending ? (sessionLoc || '') : (cfg.locationId || '');
    const dialog = KLUB_UI.modal({
      size: 'sm',
      title: isPending ? 'Aktywuj wtyczki dla swojego klubu' : 'Ustawienia wtyczek',
      sub: isPending
        ? 'Wykryliśmy Twój klub z sesji w aplikacji. Uzupełnij dane sprzedaży i zapisz, a wtyczki się uaktywnią.'
        : 'Zmień nazwę sklepu, klienta sprzedażowego lub kaucję. Zapis od razu obowiązuje.',
      bodyHtml: `<div class="klub-form">
        ${field('gfxs-club', 'Nazwa sklepu / klubu', textInput('gfxs-club', clubName || '', 'np. Nazwa Twojego klubu'))}
        ${field('gfxs-loc', 'ID lokalizacji (locationId)', textInput('gfxs-loc', locValue, '', isPending ? '' : 'disabled'), isPending
          ? 'Pobrane automatycznie z Twojej sesji. Zwykle nie trzeba zmieniać.'
          : 'Przypisane do klubu. Zmiana wyłącznie przez administratora.')}
        ${field('gfxs-client', 'Klient sprzedażowy: nazwa do wyszukania (autoklient)', textInput('gfxs-client', cfg.clientQuery || cfg.clientName || '', 'np. Sprzedaż detaliczna'))}
        <div><button class="klub-btn" id="gfxs-test" type="button">Testuj dopasowanie</button></div>
        ${field('gfxs-deposit', 'Kaucja: nazwa produktu do wyszukania (autokaucja)', textInput('gfxs-deposit', cfg.depositQuery || cfg.depositNameFallback || 'Kaucja Plastik', 'Kaucja Plastik'))}
        ${field('gfxs-depositId', 'ID produktu kaucji (opcjonalnie)', textInput('gfxs-depositId', cfg.depositProductId || '', ''))}
        ${field('gfxs-exempt', 'Osoby bez ograniczeń (wtyczka Uprawnienia)', '<textarea class="klub-input" id="gfxs-exempt" rows="3" spellcheck="false" placeholder="np. wlasciciel@klub.pl"></textarea>', 'Jeden e-mail w linii, ten sam, którym dana osoba loguje się do aplikacji. Lista działa w tej przeglądarce.')}
        <div id="gfxs-msg" hidden></div>
      </div>`,
      footHtml: `<button class="klub-btn" id="gfxs-close" type="button">Zamknij</button>
        <button class="klub-btn klub-btn--primary" id="gfxs-save" type="button">${isPending ? 'Aktywuj i zapisz' : 'Zapisz zmiany'}</button>`,
      onClose: () => { openDialog = null; },
    });
    openDialog = dialog;

    const $ = (selector) => dialog.root.querySelector(selector);
    const msg = $('#gfxs-msg');
    const MSG_STYLES = {
      info: ['klub-notice--info', 'info'],
      ok: ['klub-notice--success', 'check'],
      err: ['klub-notice--danger', 'alert'],
    };
    const setMsg = (text, kind) => {
      const [tone, iconName] = MSG_STYLES[kind];
      msg.hidden = false;
      msg.className = `klub-notice ${tone}`;
      msg.innerHTML = `${icon(iconName)}<span>${esc(text)}</span>`;
      void msg.offsetWidth;
      msg.classList.add('is-entering');
    };
    $('#gfxs-close').onclick = () => dialog.close('button');
    $('#gfxs-exempt').value = readExemptEmails().join('\n');

    $('#gfxs-test').onclick = async () => {
      const q = $('#gfxs-client').value.trim();
      if (!q) return setMsg('Wpisz najpierw nazwę klienta.', 'err');
      setMsg('Testuję…', 'info');
      const res = await testClientMatch(q);
      if (!res.ok) return setMsg(res.hint, 'err');
      setMsg(res.count > 0 ? `Znaleziono ${res.count} pasujących wyników.` : 'Brak wyników. Sprawdź pisownię nazwy.', res.count > 0 ? 'ok' : 'err');
    };

    $('#gfxs-save').onclick = async () => {
      const clubNameVal = $('#gfxs-club').value.trim();
      const locVal = $('#gfxs-loc').value.trim();
      const clientVal = $('#gfxs-client').value.trim();
      const depositVal = $('#gfxs-deposit').value.trim();
      const depositIdVal = $('#gfxs-depositId').value.trim();
      if (isPending && !locVal) return setMsg('Brak ID lokalizacji. Zaloguj się do swojego klubu w aplikacji.', 'err');
      saveExemptEmails($('#gfxs-exempt').value);

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
      setMsg('Zapisuję…', 'info');
      const { status, body } = await postClaim(payload);
      $('#gfxs-save').disabled = false;
      if (status === 200 && body.ok) {
        setMsg('Zapisano! Odśwież stronę, a wtyczki się uaktywnią.', 'ok');
        // Wymuś świeżą walidację przy następnym uruchomieniu (busta lokalny cache Setupu).
        try { GM_setValue(L.LICENSE_CACHE_KEY, ''); } catch (_e) {}
      } else {
        setMsg(body.error || `Błąd zapisu (${status}).`, 'err');
      }
    };
  }

  function openNoKey() {
    if (openDialog) return;
    const dialog = KLUB_UI.modal({
      size: 'sm',
      title: 'Brak klucza licencyjnego',
      bodyHtml: '<p style="margin:0">Ten kreator uruchamiaj z instalatora (wtyczki.wotan91.pl), który wpieka Twój klucz. Jeśli masz klucz, zainstaluj skrypt „Setup” ponownie przez przycisk w instalatorze.</p>',
      footHtml: '<button class="klub-btn klub-btn--primary" id="gfxs-close" type="button">OK</button>',
      onClose: () => { openDialog = null; },
    });
    openDialog = dialog;
    dialog.root.querySelector('#gfxs-close').onclick = () => dialog.close('button');
  }

  function addFab() {
    if (document.getElementById('gfxs-fab')) return;
    KLUB_UI.ensureStyles(document);
    const fab = document.createElement('button');
    fab.id = 'gfxs-fab';
    fab.type = 'button';
    fab.className = 'klub-root klub-launcher';
    fab.title = 'Konfiguracja wtyczek';
    fab.innerHTML = `${icon('sliders')}Ustawienia wtyczek`;
    document.body.appendChild(fab);
    fab.onclick = () => main(true);
    return fab;
  }

  // --- Główny przepływ ------------------------------------------------------------------------------
  async function main(userTriggered) {
    if (!KEY) { if (userTriggered) openNoKey(); return; }
    const result = await L.validate();
    if (!result || !result.valid) {
      if (userTriggered) openNoKey();
      console.info('[KLUB Setup] licencja nieaktywna/niepotwierdzona — kreator wstrzymany.');
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
