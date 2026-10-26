/* ABUD FUN Company OS V2 — internal shell. Served only by the loopback Local Bridge (never part of the public Pages artifact).
 * Provides: bridge-backed data layer, the six-workspace navigation (with contextual tabs and legacy-route compatibility),
 * the application shell (sidebar, top bar, global search, quick create, notifications) and shared UI primitives.
 * All text is inserted with textContent; no data from the bridge is ever interpreted as HTML. */
(() => {
  "use strict";
  if (window.AbudOps) return;

  // The Company OS is Arabic-only. `tr` is kept so modules shared with the public Universe still compile.
  const lang = () => "ar";
  const tr = (ar) => ar;

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === "class") el.className = value;
        else if (key === "text") el.textContent = value;
        else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
        else el.setAttribute(key, value === true ? "" : String(value));
      }
    }
    for (const kid of kids.flat(2)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  /** replaceChildren that ignores null/false (a bare null would otherwise be rendered as the text "null"). When a reused
   * node (e.g. a quick-add input) is re-inserted during a data refresh, its focus and caret are restored. */
  function fill(el, ...kids) {
    const active = document.activeElement;
    let caret = null;
    try { caret = active && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null; } catch (_) { caret = null; }
    el.replaceChildren(...kids.flat(2).filter((kid) => kid != null && kid !== false));
    if (active && active !== document.body && active !== document.activeElement && active.isConnected && el.contains(active)) {
      active.focus({ preventScroll: true });
      if (caret) try { active.setSelectionRange(caret[0], caret[1]); } catch (_) { /* not a text control */ }
    }
  }

  // ------------------------------------------------------------------ icons (hand-drawn 24px stroke set, no external assets)
  const ICONS = {
    home: ["M3 10.5 12 3l9 7.5", "M5 9v11a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9"],
    projects: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M8 12v4", "M12 11v5", "M16 13v3"],
    work: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "m8 12 3 3 5-6"],
    agents: ["M12 3v3", "M7 7h10a3 3 0 0 1 3 3v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-6a3 3 0 0 1 3-3z", "M9.5 13h.01", "M14.5 13h.01", "M2 12v3", "M22 12v3"],
    resources: ["M8 7h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z", "M10 3v4", "M14 3v4", "M10 17v4", "M14 17v4", "M3 10h4", "M3 14h4", "M17 10h4", "M17 14h4"],
    system: ["M5 4h14a1 1 0 0 1 1 1v5H4V5a1 1 0 0 1 1-1z", "M4 14h16v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z", "M8 7h.01", "M8 17h.01", "M12 7h4", "M12 17h4"],
    search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "m20 20-4.2-4.2"],
    plus: ["M12 5v14", "M5 12h14"],
    bell: ["M6 9a6 6 0 1 1 12 0c0 6.5 3 8 3 8H3s3-1.5 3-8", "M10 20.5a2 2 0 0 0 4 0"],
    refresh: ["M20 11a8 8 0 0 0-14.3-4.9L4 8", "M4 4v4h4", "M4 13a8 8 0 0 0 14.3 4.9L20 16", "M20 20v-4h-4"],
    chevronLeft: ["m15 18-6-6 6-6"], chevronRight: ["m9 18 6-6-6-6"], chevronDown: ["m6 9 6 6 6-6"],
    external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
    menu: ["M4 6h16", "M4 12h16", "M4 18h16"], close: ["M6 6l12 12", "M18 6 6 18"],
    calendar: ["M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M4 10h16", "M8 3v4", "M16 3v4"],
    board: ["M4 4h4v16H4z", "M10 4h4v10h-4z", "M16 4h4v13h-4z"], list: ["M9 6h11", "M9 12h11", "M9 18h11", "M4.5 6h.01", "M4.5 12h.01", "M4.5 18h.01"],
    alert: ["M12 4 2.5 20h19z", "M12 10v4", "M12 17h.01"], info: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 11v5", "M12 8h.01"],
    check: ["m5 12 5 5 9-10"], clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7v5l3 2"], play: ["M7 4v16l13-8z"],
    user: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 21a8 8 0 0 1 16 0"], branch: ["M6 3v12", "M6 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4z", "M18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z", "M18 9c0 6-12 3-12 8"],
    database: ["M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z", "M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6", "M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"],
    shield: ["M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z", "m9 12 2 2 4-4"], link: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"],
    download: ["M12 4v11", "m7 10 5 5 5-5", "M5 20h14"], upload: ["M12 20V9", "m7 14 5-5 5 5", "M5 4h14"],
    sparkle: ["M12 3v4", "M12 17v4", "M3 12h4", "M17 12h4", "m6 6 2.5 2.5", "m15.5 15.5 2.5 2.5", "m6 18 2.5-2.5", "m15.5 8.5 2.5-2.5"],
    sidebar: ["M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z", "M15 4v16"], flag: ["M5 21V4", "M5 4h11l-2 4 2 4H5"],
    globe: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M3 12h18", "M12 3c2.5 2.7 3.5 5.7 3.5 9s-1 6.3-3.5 9c-2.5-2.7-3.5-5.7-3.5-9s1-6.3 3.5-9z"],
    activity: ["M3 12h4l3-8 4 16 3-8h4"], gauge: ["M4 18a8 8 0 1 1 16 0", "m12 14 4-5"], wallet: ["M4 7h15a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z", "M4 7l11-3v3", "M16 13h.01"]
  };
  function icon(name, size = 20) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", size); svg.setAttribute("height", size);
    svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    svg.setAttribute("class", "os-icon");
    for (const d of ICONS[name] || ICONS.info) {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  const number = new Intl.NumberFormat("en-US");
  /** Company timezone (Settings → default Africa/Cairo); every displayed timestamp is converted to it. */
  const companyZone = () => resources.get("co:settings")?.data?.settings?.timezone || "Africa/Cairo";
  const fmt = {
    num: (value) => (Number.isFinite(value) ? number.format(value) : "—"),
    compact: (value) => (Number.isFinite(value) ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value) : "—"),
    pct: (value, digits = 0) => (Number.isFinite(value) ? `${value.toFixed(digits)}%` : "—"),
    usd: (value) => (Number.isFinite(value) ? `$${value.toFixed(value >= 100 ? 0 : 2)}` : "—"),
    /** Application-measured spend: runs whose router cost was not reported stay "unknown"; they are never counted as $0. */
    cost: (u) => {
      const unknown = u?.unknownCostEvents || 0;
      if (!u || (u.runs > 0 && unknown >= u.runs)) return "غير معروفة";
      return unknown ? `${fmt.usd(u.costUsd)} + ${unknown} غير معروفة` : fmt.usd(u.costUsd);
    },
    ms: (value) => (Number.isFinite(value) ? (value >= 1000 ? `${(value / 1000).toFixed(1)} ث` : `${Math.round(value)} م.ث`) : "—"),
    when(iso) {
      if (!iso) return "—";
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "—";
      return new Intl.DateTimeFormat("ar-EG-u-nu-latn", { dateStyle: "medium", timeStyle: "short", timeZone: companyZone() }).format(date);
    },
    relative(iso) {
      if (!iso) return "";
      const diff = Date.parse(iso) - Date.now();
      if (!Number.isFinite(diff)) return "";
      const rtf = new Intl.RelativeTimeFormat("ar", { numeric: "auto" });
      const abs = Math.abs(diff);
      if (abs < 60_000) return rtf.format(Math.round(diff / 1000), "second");
      if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
      if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
      return rtf.format(Math.round(diff / 86_400_000), "day");
    }
  };

  const BADGE_TONES = new Set(["ok", "warn", "bad", "info", "muted", "accent"]);
  /** Status badge: tone is never the only signal — every badge carries a text label and a shape marker. */
  const badge = (tone, text, title) => h("span", { class: `ops-badge ops-${BADGE_TONES.has(tone) ? tone : "muted"}`, title }, text);

  /** Kind-of-data label so provider-reported, router-observed, manual and unknown figures are never visually confused. */
  const SOURCE_KINDS = {
    "provider-reported": () => badge("accent", "مُبلَّغ من المزوّد", "رقم يعيده المزوّد نفسه عبر OmniRoute"),
    "router-observed": () => badge("info", "مرصود من الراوتر", "محسوب من سجل OmniRoute الخاص"),
    "application-measured": () => badge("ok", "قياس التطبيق", "محسوب من تشغيلات وكلاء الشركة فقط"),
    estimated: () => badge("warn", "تقدير", "تقدير من جدول أسعار الراوتر وليس فاتورة"),
    manual: () => badge("muted", "إدخال يدوي", "أدخلته أنت على هذا الجهاز"),
    unknown: () => badge("muted", "غير معروف", "لا يوجد مصدر موثوق"),
    local: () => badge("info", "فحص محلي", "قراءة للقراءة فقط من هذا الجهاز")
  };
  const source = (kind) => (SOURCE_KINDS[kind] || SOURCE_KINDS.unknown)();

  function meter(percent, state, labelText) {
    const known = Number.isFinite(percent);
    const bar = h("span", { class: `ops-meter-fill ops-state-${state || "unknown"}` });
    bar.style.inlineSize = known ? `${Math.min(Math.max(percent, 0), 100)}%` : "0%";
    return h("span", { class: "ops-meter", role: "meter", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": known ? Math.round(percent) : null, "aria-valuetext": known ? `${Math.round(percent)}%` : "غير معروف", "aria-label": labelText }, bar);
  }

  const stateLabel = (state) => ({ exhausted: "نفد", critical: "حرج", low: "منخفض", ok: "جيد", unlimited: "غير محدود", unknown: "غير معروف" }[state] || state);
  const stateTone = (state) => ({ exhausted: "bad", critical: "bad", low: "warn", ok: "ok", unlimited: "ok", unknown: "muted" }[state] || "muted");

  // ------------------------------------------------------------------ data layer
  const resources = new Map();
  const listeners = new Map();
  const emit = (key) => (listeners.get(key) || []).forEach((fn) => { try { fn(resources.get(key)); } catch (error) { console.error("ops listener failed", error); } });
  const on = (key, fn) => { listeners.set(key, [...(listeners.get(key) || []), fn]); const r = resources.get(key); if (r?.data) fn(r); };
  const peek = (key) => resources.get(key);

  async function load(key, path, { force = false, ttl = 30_000 } = {}) {
    let resource = resources.get(key);
    if (!resource) { resource = { state: "idle", data: null, error: null, at: 0, promise: null, path }; resources.set(key, resource); }
    resource.path = path;
    if (resource.promise) return resource.promise;
    if (!force && resource.data && Date.now() - resource.at < ttl) return resource.data;
    resource.state = "loading";
    emit(key);
    resource.promise = (async () => {
      try {
        const url = force && !/[?&]refresh=/.test(path) ? `${path}${path.includes("?") ? "&" : "?"}refresh=1` : path;
        const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
        if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.message || `HTTP ${response.status}`); }
        resource.data = await response.json();
        resource.error = null;
        resource.at = Date.now();
        resource.state = "ready";
      } catch (error) {
        resource.error = error?.message || "request-failed";
        resource.state = resource.data ? "stale" : "error";
      } finally {
        resource.promise = null;
        emit(key);
      }
      return resource.data;
    })();
    return resource.promise;
  }

  const api = {
    overview: (force) => load("overview", "/local-api/omniroute/overview", { force, ttl: 25_000 }),
    usage: (range, force) => load(`usage:${range}`, `/local-api/omniroute/usage?range=${encodeURIComponent(range)}`, { force, ttl: 25_000 }),
    agents: (force) => load("agents", "/local-api/agents", { force, ttl: 45_000 }),
    workspace: (force, target) => load("workspace", `/local-api/workspace${target ? `?refresh=${encodeURIComponent(target)}` : ""}`, { force: Boolean(force) || Boolean(target), ttl: 45_000 }),
    policy: (force) => load("policy", "/local-api/policy", { force, ttl: 25_000 }),
    settings: (force) => load("settings", "/local-api/settings", { force, ttl: 60_000 }),
    infra: (force) => load("infra", "/local-api/infra", { force, ttl: 30_000 }),
    account: (force) => load("account", "/local-api/account", { force, ttl: 600_000 }),
    co: (key, path, opts) => load(`co:${key}`, `/local-api/company${path}`, opts)
  };

  // ------------------------------------------------------------------ company writes (session token + JSON; see bridge)
  let sessionToken = null;
  async function session(refresh = false) {
    if (sessionToken && !refresh) return sessionToken;
    const response = await fetch("/local-api/session", { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error("تعذر بدء جلسة آمنة مع الـ Bridge");
    sessionToken = (await response.json()).token;
    return sessionToken;
  }
  /** POST/PATCH/DELETE to the company API. Throws an Error whose message is the bridge's Arabic message. */
  async function mutate(method, path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await session(attempt > 0);
      const response = await fetch(`/local-api/company${path}`, {
        method, cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-Abud-Session": token },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const data = await response.json().catch(() => null);
      if (response.status === 403 && data?.error === "session-required" && attempt === 0) continue; // bridge restarted: new token
      if (!response.ok) {
        const error = new Error(data?.message || `تعذر تنفيذ الطلب (${response.status})`);
        error.code = data?.error; error.details = data?.details; error.status = response.status;
        throw error;
      }
      return data;
    }
    throw new Error("انتهت الجلسة؛ أعد تحميل الصفحة");
  }
  /** Marks cached company resources stale and reloads the ones that were already loaded. */
  function invalidate(...prefixes) {
    for (const [key, resource] of resources) {
      if (!prefixes.some((prefix) => key.startsWith(`co:${prefix}`))) continue;
      resource.at = 0;
      if (resource.path) load(key, resource.path, { force: true });
    }
  }

  // ------------------------------------------------------------------ safe local storage (non-secret preferences only)
  const store = {
    read(key, fallback) { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; } },
    write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; } },
    remove(key) { try { localStorage.removeItem(key); } catch (_) { /* storage unavailable */ } }
  };

  // ------------------------------------------------------------------ shared UI primitives
  function notice(tone, title, body, extra) {
    return h("div", { class: `ops-notice ops-notice-${tone}`, role: tone === "bad" ? "alert" : "status" },
      icon(tone === "bad" || tone === "warn" ? "alert" : "info", 20), h("div", { class: "ops-notice-main" }, h("strong", null, title), body ? h("p", null, body) : null, extra || null));
  }
  function resourceStatus(resource, labelText) {
    if (!resource || resource.state === "idle") return null;
    if (resource.state === "loading" && !resource.data) return skeleton(3);
    if (resource.state === "error") return notice("bad", "تعذر الاتصال بالـ Local Bridge", `${labelText} — ${resource.error}`);
    return null;
  }
  const skeleton = (lines = 3) => h("div", { class: "os-skeleton", role: "status", "aria-label": "جارٍ التحميل" }, Array.from({ length: lines }, () => h("span")));
  /** Panel: the standard surface for a block of content. */
  const panel = (title, hint, ...children) => h("section", { class: "ops-panel" },
    title ? h("header", { class: "ops-panel-head" }, h("div", null, h("h3", null, title), hint ? h("p", null, hint) : null)) : null, ...children);
  /** Panel with an action slot in the header. */
  const panelX = ({ title, hint, actions, cls }, ...children) => h("section", { class: `ops-panel${cls ? ` ${cls}` : ""}` },
    h("header", { class: "ops-panel-head" }, h("div", null, h("h3", null, title), hint ? h("p", null, hint) : null), actions ? h("div", { class: "ops-panel-actions" }, actions) : null), ...children);
  const empty = (text, action) => h("div", { class: "co-empty" }, h("p", null, text), action || null);
  const button = (text, onclick, { kind = "secondary", icon: ic = null, attrs = {} } = {}) => h("button", { type: "button", class: `btn btn-${kind} co-btn`, onclick, ...attrs },
    ic ? (ICONS[ic] ? icon(ic, 18) : h("span", { class: "icon", "aria-hidden": "true" }, ic)) : null, text);
  const linkButton = (text, href, { kind = "secondary", icon: ic = null } = {}) => h("a", { class: `btn btn-${kind} co-btn`, href }, ic ? icon(ic, 18) : null, text);
  const field = (labelText, control, hint) => h("label", { class: "co-field" }, h("span", null, labelText), control, hint ? h("small", null, hint) : null);
  function select(name, options, value, attrs = {}) {
    return h("select", { class: "ops-input", name, ...attrs }, options.map(([v, text]) => h("option", { value: v, selected: v === (value ?? "") ? true : null }, text)));
  }
  /** Date field shown in Arabic (Cairo calendar day) while keeping a native date input for the value and picker. */
  function dateInput(name, value = "", ariaLabel = "التاريخ", { placeholder = "بلا موعد" } = {}) {
    const text = h("span", null);
    const input = h("input", { type: "date", name, value: value || "", "aria-label": ariaLabel });
    const clear = h("button", { type: "button", class: "os-date-clear", "aria-label": `مسح ${ariaLabel}`, onclick: (e) => { e.stopPropagation(); input.value = ""; sync(); input.dispatchEvent(new Event("change", { bubbles: true })); } }, icon("close", 12));
    const wrap = h("label", { class: "os-date" }, icon("calendar", 16), text, input, clear);
    function sync() {
      const v = input.value;
      text.textContent = v ? new Intl.DateTimeFormat("ar-EG-u-nu-latn", { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${v}T12:00:00Z`)) : placeholder;
      text.className = v ? "" : "os-date-empty";
      clear.hidden = !v;
    }
    input.addEventListener("input", sync); input.addEventListener("change", sync);
    input.addEventListener("click", (e) => { try { input.showPicker?.(); } catch (_) { /* picker unavailable */ } e.stopPropagation(); });
    wrap.reset = sync;
    sync();
    return wrap;
  }
  const formValues = (form) => Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]));
  /** KPI tile. Values must come from real data; pass null to render an honest "—". */
  const kpi = ({ label: text, value, hint, tone, href, ic }) => h(href ? "a" : "div", { class: `os-kpi${tone ? ` os-kpi-${tone}` : ""}`, href },
    h("span", { class: "os-kpi-label" }, ic ? icon(ic, 18) : null, text), h("strong", { class: "os-kpi-value" }, value == null ? "—" : String(value)), hint ? h("small", null, hint) : null);
  /** Segmented control for in-page filters (not navigation). */
  function segmented(options, value, onChange, ariaLabel) {
    return h("div", { class: "ops-seggroup", role: "group", "aria-label": ariaLabel }, options.map(([id, text]) => h("button", {
      type: "button", class: "ops-seg", "aria-pressed": String(value === id), onclick: () => onChange(id)
    }, text)));
  }
  const sectionShell = ({ id, title, subtitle, actions }) => h("div", { class: "section-heading" },
    h("div", null, h("h2", { id: `${id}Title`, tabindex: "-1" }, title), subtitle ? h("p", null, subtitle) : null), actions ? h("div", { class: "ops-actions" }, actions) : null);

  // ------------------------------------------------------------------ shared Arabic UI vocabulary + small widgets
  const L = {
    taskStatus: { backlog: "متراكم", todo: "للتنفيذ", in_progress: "قيد التنفيذ", blocked: "متعطّل", review: "للمراجعة", done: "منجز", cancelled: "ملغى" },
    projectStatus: { active: "نشط", planned: "مخطط", paused: "متوقف مؤقتًا", blocked: "متعطّل", shipped: "مُطلق", archived: "مؤرشف" },
    priority: { high: "عالية", medium: "متوسطة", low: "منخفضة" },
    runStatus: { queued: "في الطابور", running: "قيد التنفيذ", succeeded: "اكتمل", failed: "فشل", blocked: "متوقف", cancelled: "ملغى" },
    availability: { available: "جاهز", working: "يعمل الآن", disabled: "معطّل", "router-offline": "الراوتر غير متصل", "no-eligible-model": "لا نموذج مؤهل" },
    level: { critical: "حرج", warning: "تحذير", info: "معلومة", optimization: "تحسين" },
    approval: { pending: "بانتظار القرار", approved: "مُعتمد", rejected: "مرفوض", applied: "مُطبَّق", failed: "فشل", rolled_back: "تم التراجع" },
    owner: "المالك", none: "غير مُسند"
  };
  const tones = {
    taskStatus: { blocked: "bad", in_progress: "info", review: "accent", done: "ok", cancelled: "muted", todo: "muted", backlog: "muted" },
    projectStatus: { active: "ok", planned: "info", paused: "muted", blocked: "bad", shipped: "accent", archived: "muted" },
    runStatus: { queued: "muted", running: "info", succeeded: "ok", failed: "bad", blocked: "warn", cancelled: "muted" },
    priority: { high: "bad", medium: "warn", low: "muted" },
    availability: { available: "ok", working: "info", disabled: "muted", "router-offline": "bad", "no-eligible-model": "warn" },
    level: { critical: "bad", warning: "warn", info: "info", optimization: "accent" },
    approval: { pending: "warn", approved: "info", rejected: "muted", applied: "ok", failed: "bad", rolled_back: "muted" }
  };
  const label = (group, key) => h("span", { class: `ops-badge ops-${tones[group]?.[key] || "muted"}` }, L[group]?.[key] ?? key);
  /** English technical strings (model ids, repo names, paths) inside Arabic text are isolated so RTL never reorders them. */
  const bdi = (value, cls) => h("bdi", { class: cls || "co-tech", dir: "ltr" }, value ?? "—");
  /** Arabic sentence with embedded Latin identifiers (providers, models, repos): each Latin run is isolated in <bdi> so
   * neutral characters such as "(", "-" or ":" next to it keep their Arabic order. Returns nodes; never HTML. */
  function rich(text) {
    const out = [];
    // A leading digit run belongs to the identifier when a letter follows it directly ("3bud-ZC/…", "2fa"), so it is not
    // split off and moved to the other end by the RTL paragraph.
    const re = /(?:\d+(?=[A-Za-z]))?[A-Za-z][\w./:@+#-]*(?:[ ][A-Za-z0-9][\w./:@+#-]*)*/g;
    const value = String(text ?? "");
    let last = 0, m;
    while ((m = re.exec(value))) {
      if (m.index > last) out.push(value.slice(last, m.index));
      out.push(h("bdi", { dir: "ltr", class: "co-tech-inline" }, m[0]));
      last = m.index + m[0].length;
    }
    if (last < value.length) out.push(value.slice(last));
    return out;
  }
  const dateOnly = (value) => {
    if (!value) return "—";
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("ar-EG-u-nu-latn", { day: "numeric", month: "short", weekday: "short", timeZone: "UTC" }).format(date);
  };
  const todayIso = () => new Intl.DateTimeFormat("en-CA", { timeZone: companyZone() }).format(new Date());

  let toastHost = null;
  function toast(message, tone = "ok") {
    if (!toastHost) { toastHost = h("div", { class: "co-toasts", role: "status", "aria-live": "polite" }); document.body.append(toastHost); }
    const item = h("div", { class: `co-toast co-toast-${tone}` }, icon(tone === "bad" ? "alert" : tone === "ok" ? "check" : "info", 18), h("span", null, message));
    toastHost.append(item);
    setTimeout(() => item.remove(), tone === "bad" ? 7000 : 3800);
  }
  /** Side drawer (inline-end in RTL) with focus trap and focus restore; returns {body, close, heading}. */
  function drawer(title, { wide = false, onClose } = {}) {
    document.querySelector(".co-drawer-backdrop")?.remove();
    const previous = document.activeElement;
    const body = h("div", { class: "co-drawer-body" });
    let backdrop = null;
    const onKey = (event) => {
      if (event.key === "Escape") close();
      if (event.key === "Tab" && backdrop) {
        const focusable = [...backdrop.querySelectorAll("a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex='-1'])")].filter((n) => n.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    function close() { backdrop?.remove(); document.removeEventListener("keydown", onKey); document.body.classList.remove("os-modal-open"); onClose?.(); previous?.focus?.(); }
    const heading = h("h2", { tabindex: "-1" }, title);
    const panelEl = h("aside", { class: `co-drawer${wide ? " co-drawer-wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title },
      h("header", { class: "co-drawer-head" }, heading, h("button", { type: "button", class: "co-icon-btn", "aria-label": "إغلاق", onclick: close }, icon("close", 20))), body);
    backdrop = h("div", { class: "co-drawer-backdrop", onclick: (event) => { if (event.target === backdrop) close(); } }, panelEl);
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    document.body.classList.add("os-modal-open");
    heading.focus();
    return { body, close, heading };
  }
  /** Reusable confirmation dialog. Resolves true only on explicit confirmation. */
  function confirmDialog({ title, body, confirm = "تأكيد", tone = "primary" }) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const done = (value) => { backdrop.remove(); document.removeEventListener("keydown", onKey); previous?.focus?.(); resolve(value); };
      const onKey = (event) => { if (event.key === "Escape") done(false); };
      const ok = h("button", { type: "button", class: `btn btn-${tone}`, onclick: () => done(true) }, confirm);
      const backdrop = h("div", { class: "os-dialog-backdrop", onclick: (e) => { if (e.target === backdrop) done(false); } },
        h("div", { class: "os-dialog", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "osDialogTitle" },
          h("h2", { id: "osDialogTitle" }, title), body ? h("p", null, body) : null,
          h("div", { class: "os-dialog-actions" }, ok, h("button", { type: "button", class: "btn btn-secondary", onclick: () => done(false) }, "إلغاء"))));
      document.addEventListener("keydown", onKey);
      document.body.append(backdrop);
      ok.focus();
    });
  }
  /** Text input dialog (replaces window.prompt): Enter saves, Escape cancels, focus returns to the trigger. Resolves the
   * trimmed value, or null when cancelled or unchanged-and-empty. `validate` may return an Arabic error to keep it open. */
  function promptDialog({ title, label: fieldLabel, value = "", confirm = "حفظ", maxlength = 160, placeholder = "", validate = null }) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const done = (result) => { backdrop.remove(); document.removeEventListener("keydown", onKey); previous?.focus?.(); resolve(result); };
      const onKey = (event) => { if (event.key === "Escape") done(null); };
      const input = h("input", { class: "ops-input", value, maxlength, placeholder, "aria-label": fieldLabel, required: true });
      const error = h("p", { class: "ops-bad-text", role: "alert", hidden: true });
      const form = h("form", { class: "os-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "osPromptTitle", onsubmit: (event) => {
        event.preventDefault();
        const next = input.value.trim();
        const problem = !next ? "هذا الحقل مطلوب" : validate?.(next);
        if (problem) { error.textContent = problem; error.hidden = false; input.focus(); return; }
        done(next);
      } },
        h("h2", { id: "osPromptTitle" }, title), h("label", { class: "co-field" }, h("span", null, fieldLabel), input), error,
        h("div", { class: "os-dialog-actions" }, h("button", { type: "submit", class: "btn btn-primary" }, confirm), h("button", { type: "button", class: "btn btn-secondary", onclick: () => done(null) }, "إلغاء")));
      const backdrop = h("div", { class: "os-dialog-backdrop", onclick: (e) => { if (e.target === backdrop) done(null); } }, form);
      document.addEventListener("keydown", onKey);
      document.body.append(backdrop);
      input.focus(); input.select();
    });
  }
  /** Returns true (and schedules `render` for when the user leaves) if a form control inside `host` is being edited, so
   * background refreshes never wipe what the owner is typing. */
  function editing(host, render) {
    const active = document.activeElement;
    if (!host || !active || !host.contains(active) || !/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.type === "checkbox" || active.type === "search") return false;
    if (!host.dataset.osDeferred) {
      host.dataset.osDeferred = "1";
      const leave = () => setTimeout(() => {
        if (host.contains(document.activeElement)) return;
        host.removeEventListener("focusout", leave);
        delete host.dataset.osDeferred;
        render();
      }, 0);
      host.addEventListener("focusout", leave);
    }
    return true;
  }
  /** Wraps an async action: disables the trigger, shows Arabic success/failure toasts. */
  async function act(trigger, fn, success) {
    if (trigger) { trigger.disabled = true; trigger.setAttribute("aria-busy", "true"); }
    try { const result = await fn(); if (success) toast(success, "ok"); return result; }
    catch (error) { toast(error.message || "تعذر تنفيذ العملية", "bad"); return undefined; }
    finally { if (trigger) { trigger.disabled = false; trigger.removeAttribute("aria-busy"); } }
  }

  // ------------------------------------------------------------------ workspaces, tabs and routing
  const views = [];
  const state = { view: null, tab: null, part: null, rest: [] };
  let booted = false;

  /**
   * def: { id, order, icon, ar, subtitle, tabs: [[id, ar, {hidden, parts:[[id, ar]]}]], defaultTab, resolve(rest), onShow(tab, rest), badge() }
   * Tabs are contextual sub-views; only one tab of one workspace is visible at a time.
   */
  function registerView(def) {
    views.push({ tabs: [], ...def });
    views.sort((a, b) => a.order - b.order);
    if (booted) { buildTabCss(); nav(); }
  }
  const viewById = (id) => views.find((v) => v.id === id);
  const tabDef = (view, tabId) => view?.tabs.find(([id]) => id === tabId);

  /** Creates a top-level content section owned by a workspace (and optionally specific tabs). */
  function section(id, view, tabs = "*") {
    const node = h("section", { class: "os-section", id, "data-os-view": view, "data-os-tab": Array.isArray(tabs) ? tabs.join(" ") : tabs });
    const content = document.querySelector(".content");
    content?.append(node);
    return node;
  }

  /** Legacy Universe / Milestone sections → their new home. Selectors are matched against `.content > *`. */
  const LEGACY_HOME = [
    ["#daily", "projects", "reports", "r-daily"],
    ["#worldConsole", "projects", "universe", "u-worlds"],
    ["#strategy", "projects", "universe", "u-strategy"],
    ["#map", "projects", "universe", "u-map"],
    ["#library", "projects", "universe", "u-library"],
    ["#relations", "projects", "universe", "u-relations"],
    ["#projectHub", "projects", "universe", "*"],
    ["#worlds", "projects", "local", "l-worlds"],
    ["#workboard", "projects", "reports", "r-journal"],
    ["#decisions", "projects", "reports", "r-decisions"],
    ["#agentSystem", "system", "integrations", null],
    [".hero, #metrics, .stats, .principles-section, .footer", null, null, null]
  ];
  /** Old hashes (V1 routes and in-page anchors) → V2 route. */
  const LEGACY_ROUTES = {
    overview: "hq", universe: "projects/universe", projects: "projects/all", workboard: "work", usage: "resources",
    infra: "system/overview", activity: "system/activity", settings: "system/settings"
  };
  const LEGACY_ANCHORS = {
    overview: "hq", daily: "projects/reports/r-daily", metrics: "hq", worldConsole: "projects/universe/u-worlds", strategy: "projects/universe/u-strategy",
    map: "projects/universe/u-map", library: "projects/universe/u-library", relations: "projects/universe/u-relations", worlds: "projects/local/l-worlds",
    workboard: "projects/reports/r-journal", workHistory: "projects/reports/r-journal", reports: "projects/reports/r-journal", decisions: "projects/reports/r-decisions",
    agentSystem: "system/integrations", projectIntelligence: "projects/universe"
  };

  function adoptLegacySections() {
    const content = document.querySelector(".content");
    if (!content) return;
    for (const [selector, view, tab, part] of LEGACY_HOME) {
      for (const node of content.querySelectorAll(`:scope > :is(${selector})`)) {
        node.dataset.osView = view || "none";
        node.dataset.osTab = tab || "*";
        if (part) node.dataset.osPart = part;
        // Public Universe sections keep their immersive deep-violet canvas; re-rendered internal ones use the light system.
        if (view === "projects") node.classList.add("os-legacy");
      }
    }
  }

  let tabStyle = null;
  /** Visibility is pure CSS keyed on body[data-os-view|tab|part]; modules may re-render freely without re-hiding. */
  function buildTabCss() {
    if (!tabStyle) { tabStyle = h("style", { id: "osTabCss" }); document.head.append(tabStyle); }
    const rules = ["body.ops-mode .content > :not([data-os-view]) { display: none !important; }"];
    const tabIds = new Set(), partIds = new Set();
    for (const view of views) {
      rules.push(`body[data-os-view="${view.id}"] .content > [data-os-view]:not([data-os-view~="${view.id}"]):not([data-os-view="*"]) { display: none !important; }`);
      for (const [tabId, , opts] of view.tabs) { tabIds.add(tabId); (opts?.parts || []).forEach(([p]) => partIds.add(p)); }
    }
    for (const tabId of tabIds) rules.push(`body[data-os-tab="${tabId}"] .content [data-os-tab]:not([data-os-tab~="${tabId}"]):not([data-os-tab="*"]) { display: none !important; }`);
    for (const partId of partIds) rules.push(`body[data-os-part="${partId}"] .content [data-os-part]:not([data-os-part~="${partId}"]):not([data-os-part="*"]) { display: none !important; }`);
    rules.push(`body:not([data-os-part]) .content [data-os-part]:not([data-os-part="*"]) { display: none !important; }`);
    tabStyle.textContent = rules.join("\n");
  }

  const PART_KEY = "abud-os-parts";
  function partFor(view, tabId, requested) {
    const parts = tabDef(view, tabId)?.[2]?.parts || [];
    if (!parts.length) return null;
    if (requested && parts.some(([p]) => p === requested)) return requested;
    const remembered = store.read(PART_KEY, {})[`${view.id}/${tabId}`];
    return parts.some(([p]) => p === remembered) ? remembered : parts[0][0];
  }

  function activate(viewId, tabId, rest = [], { focus = false } = {}) {
    const view = viewById(viewId) || views[0];
    if (!view) return;
    let tab = tabId && tabDef(view, tabId) ? tabId : view.defaultTab || view.tabs[0]?.[0] || null;
    let part = partFor(view, tab, rest[0]);
    if (part && rest[0] === part) rest = rest.slice(1);
    const changedView = state.view !== view.id;
    const changed = changedView || state.tab !== tab || JSON.stringify(rest) !== JSON.stringify(state.rest || []) || state.part !== part;
    Object.assign(state, { view: view.id, tab, part, rest });
    document.body.dataset.osView = view.id;
    if (tab) document.body.dataset.osTab = tab; else delete document.body.dataset.osTab;
    if (part) { document.body.dataset.osPart = part; const all = store.read(PART_KEY, {}); all[`${view.id}/${tab}`] = part; store.write(PART_KEY, all); }
    else delete document.body.dataset.osPart;
    nav();
    renderPageHead();
    if (changed) {
      view.onShow?.(tab, rest);
      window.dispatchEvent(new CustomEvent("abud:view", { detail: { id: view.id, tab, part, rest } }));
      // The Universe map measures itself with a ResizeObserver; nudge it after its section becomes visible.
      if (view.id === "projects") requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    }
    if (changedView) window.scrollTo({ top: 0 });
    if (focus) document.getElementById("osPageTitle")?.focus({ preventScroll: true });
    closeMenus();
  }

  /** Builds a V2 hash. */
  const href = (viewId, ...rest) => `#view/${[viewId, ...rest].filter((x) => x != null && x !== "").map(encodeURIComponent).join("/")}`;
  const go = (viewId, ...rest) => { location.hash = href(viewId, ...rest); };

  function route() {
    const hash = location.hash || "";
    if (hash.startsWith("#view/")) {
      let [viewId, ...rest] = hash.slice(6).split("/").map((x) => { try { return decodeURIComponent(x); } catch (_) { return x; } });
      if (!viewById(viewId) && LEGACY_ROUTES[viewId]) {
        const target = `#view/${LEGACY_ROUTES[viewId]}${rest.length && viewId !== "projects" ? `/${rest.join("/")}` : ""}`;
        history.replaceState(null, "", target);
        return route();
      }
      const view = viewById(viewId);
      if (!view) return activate(views[0]?.id, null, [], { focus: true });
      const resolved = view.resolve ? view.resolve(rest) : (tabDef(view, rest[0]) ? { tab: rest[0], rest: rest.slice(1) } : { tab: null, rest });
      return activate(view.id, resolved.tab, resolved.rest, { focus: true });
    }
    if (hash.startsWith("#project/")) return activate("projects", "universe", []);
    const anchor = hash.slice(1);
    if (anchor && LEGACY_ANCHORS[anchor]) {
      history.replaceState(null, "", `#view/${LEGACY_ANCHORS[anchor]}`);
      return route();
    }
    if (!state.view) activate(views[0]?.id, null, []);
  }

  // ------------------------------------------------------------------ shell: sidebar, top bar, page head
  const shell = { side: null, nav: null, top: null, head: null, health: null, bell: null, bellCount: null, conn: null, search: null, results: null, menus: [] };

  function nav() {
    if (!shell.nav) return;
    fill(shell.nav, views.map((view) => {
      const active = view.id === state.view;
      const b = view.badge?.();
      return h("a", { class: `os-nav-link${active ? " os-current" : ""}`, href: href(view.id), "data-view": view.id, "aria-current": active ? "page" : null, title: view.ar },
        h("span", { class: "os-nav-icon" }, icon(view.icon, 22)), h("span", { class: "os-nav-label" }, view.ar),
        b && b.n ? h("span", { class: `os-nav-badge os-nav-badge-${b.tone || "info"}`, "aria-label": b.title || `${b.n}` }, String(b.n)) : null);
    }));
    const current = viewById(state.view);
    if (current) document.title = `${current.ar}${state.tab && current.tabs.length > 1 ? ` · ${tabDef(current, state.tab)?.[1] || ""}` : ""} — ABUD FUN`;
  }

  const actionSlots = new Map();
  /** Lets a workspace place actions in the shared page header for a given tab ("*" = all tabs). */
  function setActions(viewId, nodes, tabId = "*") { actionSlots.set(`${viewId}/${tabId}`, nodes); if (state.view === viewId) renderPageHead(); }
  const headOverrides = new Map();
  /** Detail pages (project, agent) can override the header title/subtitle/back link. */
  function setHead(viewId, value) { if (value) headOverrides.set(viewId, value); else headOverrides.delete(viewId); if (state.view === viewId) renderPageHead(); }

  function renderPageHead() {
    const view = viewById(state.view);
    if (!shell.head || !view) return;
    const override = headOverrides.get(view.id);
    const useOverride = override && (!override.tab || override.tab === state.tab);
    const visibleTabs = view.tabs.filter(([, , opts]) => !opts?.hidden);
    const tab = tabDef(view, state.tab);
    const actions = actionSlots.get(`${view.id}/${state.tab}`) || actionSlots.get(`${view.id}/*`);
    const parts = tab?.[2]?.parts || [];
    fill(shell.head,
      h("div", { class: "os-head-row" },
        h("div", { class: "os-head-copy" },
          useOverride && override.back ? h("a", { class: "os-back", href: override.back[0] }, icon("chevronRight", 18), override.back[1]) : null,
          h("h1", { id: "osPageTitle", tabindex: "-1" }, useOverride ? h("bdi", null, override.title) : view.ar),
          (useOverride ? override.subtitle : view.subtitle) ? h("p", { class: "os-head-sub" }, useOverride ? override.subtitle : view.subtitle) : null),
        actions ? h("div", { class: "os-head-actions" }, typeof actions === "function" ? actions() : actions) : null),
      visibleTabs.length > 1 && !(useOverride && override.hideTabs) ? h("nav", { class: "os-tabs", "aria-label": `أقسام ${view.ar}` }, visibleTabs.map(([id, text]) =>
        h("a", { class: `os-tab${id === state.tab ? " os-tab-current" : ""}`, href: href(view.id, id), "aria-current": id === state.tab ? "page" : null }, text))) : null,
      parts.length > 1 ? h("div", { class: "os-parts", role: "group", "aria-label": "عرض فرعي" }, parts.map(([id, text]) =>
        h("a", { class: "os-part", href: href(view.id, state.tab, id), "aria-current": id === state.part ? "true" : null }, text))) : null);
  }

  function closeMenus(except) {
    for (const menu of shell.menus) if (menu !== except) { menu.hidden = true; menu.previousElementSibling?.setAttribute("aria-expanded", "false"); }
  }
  function popover(trigger, menu) {
    shell.menus.push(menu);
    trigger.setAttribute("aria-expanded", "false");
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = menu.hidden;
      closeMenus(menu);
      menu.hidden = !open;
      trigger.setAttribute("aria-expanded", String(open));
      if (open) { menu.dispatchEvent(new Event("os:open")); menu.querySelector("a,button")?.focus(); }
    });
    menu.addEventListener("click", (event) => event.stopPropagation());
    return h("div", { class: "os-pop-wrap" }, trigger, menu);
  }

  // ---------------- global search (projects, tasks, agents; local data, no new infrastructure)
  const SEARCH_LIMIT = 6;
  function searchResults(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const groups = [];
    const agents = (window.AbudCompany?.agentsDef() || []).filter((a) => `${a.name} ${a.titleAr} ${a.roleAr}`.toLowerCase().includes(q))
      .map((a) => ({ text: `${a.name} — ${a.titleAr}`, meta: a.active === false || a.active === 0 ? "وكيل غير نشط" : "وكيل", href: href("agents", a.id), color: a.color }));
    const projects = (peek("co:projects")?.data?.projects || []).filter((p) => `${p.name} ${p.github || ""}`.toLowerCase().includes(q))
      .slice(0, SEARCH_LIMIT).map((p) => ({ text: p.name, meta: p.github || "مشروع", href: href("projects", "p", p.id) }));
    const tasks = (peek("co:tasks")?.data?.tasks || []).filter((t) => t.title.toLowerCase().includes(q)).slice(0, SEARCH_LIMIT)
      .map((t) => ({ text: t.title, meta: L.taskStatus[t.status], task: t.id }));
    if (agents.length) groups.push(["الوكلاء", agents]);
    if (projects.length) groups.push(["المشاريع", projects]);
    if (tasks.length) groups.push(["المهام", tasks]);
    return groups;
  }
  function renderSearch() {
    const groups = searchResults(shell.search.value);
    const box = shell.results;
    if (!shell.search.value.trim()) { box.hidden = true; return; }
    box.hidden = false;
    let index = 0;
    fill(box, groups.length ? groups.map(([title, items]) => h("div", { class: "os-search-group" }, h("p", { class: "os-search-title" }, title),
      items.map((item) => {
        const attrs = { class: "os-search-item", role: "option", id: `osSearch${index++}` };
        const kids = [item.color ? h("span", { class: "os-dot", style: `--dot:${item.color}` }) : null, h("span", { class: "os-search-text" }, item.text), h("small", null, bdi(item.meta, "co-tech-soft"))];
        return item.href ? h("a", { ...attrs, href: item.href, onclick: clearSearch }, kids)
          : h("button", { ...attrs, type: "button", onclick: () => { clearSearch(); window.AbudCompany?.openTask(item.task); } }, kids);
      })))
      : h("p", { class: "os-search-empty" }, "لا نتائج مطابقة في المشاريع أو المهام أو الوكلاء."));
  }
  function clearSearch() { shell.search.value = ""; shell.results.hidden = true; }

  function buildShell() {
    const appShell = document.querySelector(".app-shell");
    const main = document.querySelector(".main");
    const content = document.querySelector(".content");
    if (!appShell || !main || !content) return false;

    // ---------------- sidebar
    shell.nav = h("nav", { class: "os-nav", "aria-label": "مساحات الشركة" });
    shell.health = h("div", { class: "os-health", role: "status", "aria-live": "polite" });
    const collapse = h("button", { type: "button", class: "os-collapse", "aria-label": "طي القائمة الجانبية", title: "طي القائمة", onclick: () => {
      const collapsed = document.body.classList.toggle("os-collapsed");
      store.write("abud-os-collapsed", collapsed);
      collapse.setAttribute("aria-pressed", String(collapsed));
    } }, icon("sidebar", 20));
    shell.side = h("aside", { class: "os-side", id: "osSide", "aria-label": "التنقل الرئيسي" },
      h("a", { class: "os-brand", href: href("hq"), "aria-label": "ABUD FUN — الرئيسية" },
        h("span", { class: "os-logo", "aria-hidden": "true" }, "A"),
        h("span", { class: "os-brand-copy" }, h("strong", null, "ABUD FUN"), h("small", null, "نظام تشغيل الشركة"))),
      h("div", { class: "os-workspace" }, h("span", { class: "os-dot os-dot-live", "aria-hidden": "true" }), h("span", null, "المقر الرئيسي · هذا الجهاز")),
      shell.nav,
      h("div", { class: "os-side-foot" }, shell.health, collapse));
    if (store.read("abud-os-collapsed", false)) document.body.classList.add("os-collapsed");
    const backdrop = h("div", { class: "os-side-backdrop", id: "osSideBackdrop", hidden: true, onclick: () => toggleSide(false) });
    appShell.prepend(shell.side, backdrop);

    // ---------------- top bar
    shell.search = h("input", { class: "os-search-input", type: "search", placeholder: "ابحث في المشاريع والمهام والوكلاء…", "aria-label": "بحث شامل", autocomplete: "off", role: "combobox", "aria-expanded": "false", "aria-controls": "osSearchResults",
      onfocus: () => { api.co("projects", "/projects", { ttl: 30_000 }); api.co("tasks", "/tasks", { ttl: 30_000 }); },
      oninput: () => { renderSearch(); shell.search.setAttribute("aria-expanded", String(!shell.results.hidden)); },
      onkeydown: (event) => {
        if (event.key === "Escape") { clearSearch(); shell.search.blur(); }
        if (event.key === "Enter") { event.preventDefault(); shell.results.querySelector(".os-search-item")?.click(); }
        if (event.key === "ArrowDown") { event.preventDefault(); shell.results.querySelector(".os-search-item")?.focus(); }
      } });
    shell.results = h("div", { class: "os-search-results", id: "osSearchResults", role: "listbox", hidden: true, onkeydown: (event) => {
      const items = [...shell.results.querySelectorAll(".os-search-item")];
      const i = items.indexOf(document.activeElement);
      if (event.key === "ArrowDown") { event.preventDefault(); items[Math.min(i + 1, items.length - 1)]?.focus(); }
      if (event.key === "ArrowUp") { event.preventDefault(); (i <= 0 ? shell.search : items[i - 1]).focus(); }
      if (event.key === "Escape") { clearSearch(); shell.search.focus(); }
    } });
    const searchBox = h("div", { class: "os-search" }, icon("search", 18), shell.search, h("kbd", { class: "os-kbd", "aria-hidden": "true" }, "/"), shell.results);

    const createMenu = h("div", { class: "os-menu", role: "menu", hidden: true },
      menuItem("work", "مهمة جديدة", "عنوان فقط، والباقي اختياري", () => window.AbudCompany?.openQuickTask()),
      menuItem("projects", "مشروع جديد", "بهوية GitHub ثابتة عند توفرها", () => window.AbudCompany?.openNewProject()),
      menuItem("agents", "طلب لوكيل", "إسناد عمل لأحد الوكلاء النشطين", () => go("agents", "request")));
    const createBtn = h("button", { type: "button", class: "btn btn-primary os-create", "aria-haspopup": "menu" }, icon("plus", 18), h("span", null, "إنشاء"));

    shell.bellCount = h("span", { class: "os-bell-count", hidden: true });
    const bellMenu = h("div", { class: "os-menu os-bell-menu", role: "dialog", "aria-label": "التنبيهات", hidden: true });
    bellMenu.addEventListener("os:open", () => { renderBell(bellMenu); api.co("notifications", "/notifications", { force: true }); });
    on("co:notifications", () => { updateBell(); if (!bellMenu.hidden) renderBell(bellMenu); });
    shell.bell = h("button", { type: "button", class: "os-icon-btn", "aria-label": "التنبيهات", "aria-haspopup": "dialog" }, icon("bell", 20), shell.bellCount);

    shell.conn = h("a", { class: "os-conn", href: href("resources"), title: "حالة OmniRoute" }, h("span", { class: "os-dot" }), h("span", { class: "os-conn-text" }, "OmniRoute…"));
    const ownerMenu = h("div", { class: "os-menu", role: "menu", hidden: true },
      h("div", { class: "os-menu-head" }, h("strong", null, "المالك"), h("small", null, "تشغيل محلي على 127.0.0.1")),
      menuLink("system", "الإعدادات", href("system", "settings")),
      menuLink("database", "البيانات والنسخ الاحتياطي", href("system", "data")),
      menuLink("shield", "الأمان", href("system", "security")),
      menuLink("globe", "الموقع العام على GitHub", "https://github.com/abudoxali", true));
    const ownerBtn = h("button", { type: "button", class: "os-avatar", "aria-label": "قائمة المالك", "aria-haspopup": "menu" }, "A");
    const menuBtn = h("button", { type: "button", class: "os-icon-btn os-menu-toggle", "aria-label": "فتح القائمة", "aria-controls": "osSide", "aria-expanded": "false", onclick: () => toggleSide() }, icon("menu", 22));

    shell.top = h("header", { class: "os-top" },
      menuBtn, searchBox,
      h("div", { class: "os-top-actions" }, shell.conn, popover(createBtn, createMenu), popover(shell.bell, bellMenu), popover(ownerBtn, ownerMenu)));
    main.prepend(shell.top);

    shell.head = h("div", { class: "os-page-head", id: "osPageHead", "data-os-view": "*", "data-os-tab": "*" });
    content.prepend(shell.head);

    // The Universe "refresh public GitHub metadata" control belongs to the Universe tab, not to every page.
    const sync = document.getElementById("syncButton");
    if (sync) {
      const holder = h("div", { class: "os-universe-tools", "data-os-view": "projects", "data-os-tab": "universe" },
        h("p", null, "عالم المشاريع العام: الخريطة والكتالوج والعلاقات من بيانات GitHub العامة فقط."), document.getElementById("syncLabel") || null, sync);
      shell.head.after(holder);
    }

    document.addEventListener("click", () => { closeMenus(); if (!shell.results.contains(document.activeElement)) shell.results.hidden = true; });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenus();
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
      if (!typing && (event.key === "/" || (event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey)))) { event.preventDefault(); shell.search.focus(); }
    });
    window.addEventListener("hashchange", () => toggleSide(false));
    return true;
  }
  function menuItem(ic, title, hint, onclick) {
    return h("button", { type: "button", class: "os-menu-item", role: "menuitem", onclick: () => { closeMenus(); onclick(); } }, icon(ic, 20), h("span", null, h("strong", null, title), h("small", null, hint)));
  }
  function menuLink(ic, title, url, external = false) {
    return h("a", { class: "os-menu-item", role: "menuitem", href: url, target: external ? "_blank" : null, rel: external ? "noopener noreferrer" : null, onclick: () => closeMenus() }, icon(ic, 20), h("span", null, h("strong", null, title)), external ? icon("external", 16) : null);
  }
  function toggleSide(open) {
    const next = open ?? !document.body.classList.contains("os-side-open");
    document.body.classList.toggle("os-side-open", next);
    const backdrop = document.getElementById("osSideBackdrop");
    if (backdrop) backdrop.hidden = !next;
    document.querySelector(".os-menu-toggle")?.setAttribute("aria-expanded", String(next));
    if (next) shell.nav.querySelector("a")?.focus();
  }

  function updateBell() {
    const list = peek("co:notifications")?.data?.notifications || [];
    const open = list.filter((n) => !n.acknowledged_at);
    shell.bellCount.hidden = !open.length;
    shell.bellCount.textContent = open.length > 9 ? "9+" : String(open.length);
    shell.bell.setAttribute("aria-label", open.length ? `التنبيهات: ${open.length} غير مُقرّة` : "التنبيهات");
  }
  function renderBell(menu) {
    const res = peek("co:notifications");
    const list = res?.data?.notifications;
    const rank = { critical: 0, warning: 1, info: 2 };
    fill(menu,
      h("div", { class: "os-menu-head" }, h("strong", null, "التنبيهات"), h("a", { class: "ops-link", href: href("system", "activity"), onclick: () => closeMenus() }, "كل السجل")),
      !list ? skeleton(3) : list.length ? h("ul", { class: "os-bell-list" }, [...list].sort((a, b) => rank[a.level] - rank[b.level]).slice(0, 8).map((n) =>
        h("li", { class: `os-bell-item os-level-${n.level}${n.acknowledged_at ? " os-acked" : ""}` },
          label("level", n.level), h("div", null, h("strong", null, rich(n.title)), h("small", null, `${fmt.relative(n.last_seen_at)}${n.count > 1 ? ` · تكرر ${n.count} مرات` : ""}`)))))
        : h("p", { class: "os-search-empty" }, "لا تنبيهات مفتوحة."));
  }

  /** Compact integration health (sidebar footer + top-bar pill). Values come only from bridge responses. */
  function renderHealth() {
    const summary = peek("co:summary")?.data;
    const routerState = summary?.router?.state ?? peek("overview")?.data?.connection?.state ?? null;
    const bridgeOk = Boolean(peek("co:summary")?.data || peek("co:catalog")?.data);
    const routerOk = routerState === "connected";
    const dot = (ok, unknown) => h("span", { class: `os-dot ${unknown ? "" : ok ? "os-dot-ok" : "os-dot-bad"}` });
    if (shell.health) fill(shell.health,
      h("p", { class: "os-health-title" }, "حالة الأنظمة"),
      h("a", { href: href("system", "overview") }, dot(bridgeOk, !summary), h("span", null, "Local Bridge"), h("small", null, bridgeOk ? "يعمل" : "…")),
      h("a", { href: href("resources") }, dot(routerOk, routerState == null), h("span", null, "OmniRoute"), h("small", null, routerState == null ? "…" : routerOk ? "متصل" : "غير متصل")),
      h("a", { href: href("system", "data") }, dot(bridgeOk, !summary), h("span", null, "قاعدة البيانات"), h("small", null, bridgeOk ? "SQLite" : "…")));
    if (shell.conn) {
      shell.conn.className = `os-conn ${routerState == null ? "" : routerOk ? "os-conn-ok" : "os-conn-bad"}`;
      fill(shell.conn, h("span", { class: "os-dot" }), h("span", { class: "os-conn-text" }, routerState == null ? "OmniRoute…" : routerOk ? "OmniRoute متصل" : "OmniRoute غير متصل"));
    }
  }

  function boot() {
    if (booted || !document.querySelector(".content")) return;
    // The Company OS is Arabic-first: switch the shared Universe scripts to Arabic once, then hide the toggle.
    if (document.documentElement.lang === "en") document.getElementById("languageButton")?.click();
    document.documentElement.lang = "ar";
    document.documentElement.dir = "rtl";
    if (!buildShell()) return;
    booted = true;
    document.body.classList.add("ops-mode");
    document.documentElement.classList.remove("os-booting");
    adoptLegacySections();
    buildTabCss();
    window.addEventListener("hashchange", route);
    ["co:summary", "co:catalog", "overview"].forEach((key) => on(key, () => { renderHealth(); nav(); }));
    on("co:agents", nav); on("co:tasks", nav);
    renderHealth();
    route();
    // Notifications are polled gently (60 s, paused when hidden) so the bell stays honest without busy polling.
    api.co("notifications", "/notifications", { ttl: 15_000 });
    setInterval(() => { if (!document.hidden) { api.co("notifications", "/notifications", { ttl: 50_000 }); api.co("summary", "/summary", { ttl: 50_000 }); } }, 60_000);
  }

  window.AbudOps = {
    tr, lang, h, fill, fmt, badge, source, meter, stateLabel, stateTone, notice, resourceStatus, sectionShell, skeleton,
    api, on, peek, store, registerView, activate, boot, views, state, mutate, invalidate, session, L, tones, label, bdi, rich, dateOnly, todayIso, toast, drawer, act, companyZone,
    confirmDialog, promptDialog, editing, icon, panel, panelX, empty, button, linkButton, field, select, formValues, dateInput, kpi, segmented, section, href, go, setActions, setHead,
    stateRank: { exhausted: 5, critical: 4, low: 3, ok: 2, unlimited: 1, unknown: 0 },
    refreshNav: () => nav(), refreshHead: () => renderPageHead()
  };
})();
