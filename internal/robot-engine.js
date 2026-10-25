/* ABUD FUN Company OS V3 — RobotCharacter engine: code-built 2.5D robots (layered SVG, no bitmaps, no dependencies).
 *
 * Every character is assembled from geometry defined here and the per-agent specification in robot-specs.js:
 *   anatomy   head shell, crown/stripe cap, two mechanical ears (outer shell + glowing inner panel + base joint), side
 *             audio modules, glossy visor, LED eyes, speaking LED bar, neck, chest armor with hexagonal ▽ core, abdomen
 *             segments, hip assembly, shoulder balls + pauldrons, upper arms, elbow joints, forearms with LED cuffs,
 *             articulated hands (open / wave / fist / point / peace / hold), hip joints, thighs, knee joints, shins,
 *             ankle joints and boots with ankle LEDs.
 *   rig       nested transform groups (stage → torso → head → face/ears; shoulder → elbow → wrist; hip → knee → ankle);
 *             left limbs are the right-side geometry under a mirror transform.
 *   materials per-instance gradients (glossy armor, satin white, dark frame, visor) + one glow filter, or flat fills for
 *             portraits and low quality.
 *   motion    one shared requestAnimationFrame scheduler for all instances; per-instance clock, smoothed pose targets,
 *             breathing, blinking, saccades, ear sway/twitch, state overlays (idle, listening, thinking, working,
 *             speaking, unavailable) and transient reactions (greeting, success, error). Paused offscreen
 *             (IntersectionObserver), in hidden tabs and for reduced motion (still frames); instances detached from the
 *             document are disposed automatically.
 * Public API: window.AbudRobots = { create, mount, portrait, forms, stats, STATES, EXPRESSIONS }. */
(() => {
  "use strict";
  if (window.AbudRobots) return;
  const SPEC = window.AbudRobotSpecs;
  if (!SPEC) return;
  const NS = "http://www.w3.org/2000/svg";
  const TAU = Math.PI * 2;
  const VIEWBOX = "-125 -309 250 325";
  const STATES = ["idle", "listening", "thinking", "working", "speaking", "unavailable", "greeting", "success", "error"];
  const TRANSIENT = { greeting: 2.4, success: 2.8, error: 2.4 };
  const STATE_AR = { idle: "في وضع الاستعداد", listening: "يستمع", thinking: "يفكر", working: "يعمل الآن", speaking: "يتحدث", unavailable: "غير متاح", greeting: "يرحّب", success: "أنجز بنجاح", error: "واجه خطأ" };

  // ---------------------------------------------------------------- DOM helpers
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, String(v));
    for (const kid of kids.flat(4)) if (kid) el.append(kid);
    return el;
  }
  const g = (attrs, ...kids) => s("g", attrs, ...kids);
  const P = (d, attrs) => s("path", { d, ...attrs });
  const OUT = { stroke: "#0b0910", "stroke-opacity": 0.5, "stroke-width": 1.2, "stroke-linejoin": "round" };
  const lerp = (a, b, k) => a + (b - a) * k;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  const reducedQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false, addEventListener() {} };

  // ---------------------------------------------------------------- materials
  function materials(idp, pal, flat) {
    const tones = { primary: [pal.light, pal.primary, pal.deep], white: ["#ffffff", pal.white, pal.whiteShade], dark: [pal.darkLight, pal.dark, pal.darkDeep], darkDeep: [pal.dark, pal.darkDeep, "#000000"] };
    const fill = {};
    const defs = [];
    for (const [key, [a, b, c]] of Object.entries(tones)) {
      if (flat) { fill[key] = b; continue; }
      defs.push(s("linearGradient", { id: `${idp}-${key}`, x1: 0.08, y1: 0.02, x2: 0.94, y2: 0.96 },
        s("stop", { offset: 0, "stop-color": a }), s("stop", { offset: 0.18, "stop-color": a }),
        s("stop", { offset: 0.43, "stop-color": b }), s("stop", { offset: 0.76, "stop-color": c }),
        s("stop", { offset: 1, "stop-color": b })));
      fill[key] = `url(#${idp}-${key})`;
    }
    if (flat) { fill.visor = "#0d0b12"; fill.specular = "none"; }
    else {
      defs.push(s("linearGradient", { id: `${idp}-visor`, x1: 0.16, y1: 0.02, x2: 0.85, y2: 1 },
        s("stop", { offset: 0, "stop-color": "#555160" }), s("stop", { offset: 0.13, "stop-color": "#272631" }),
        s("stop", { offset: 0.38, "stop-color": "#0d0e14" }), s("stop", { offset: 0.8, "stop-color": "#05060a" }),
        s("stop", { offset: 1, "stop-color": "#24202b" })));
      defs.push(s("linearGradient", { id: `${idp}-specular`, x1: 0.08, y1: 0.03, x2: 0.84, y2: 0.95 },
        s("stop", { offset: 0, "stop-color": "#fff", "stop-opacity": 0.52 }),
        s("stop", { offset: 0.31, "stop-color": "#fff", "stop-opacity": 0.14 }),
        s("stop", { offset: 0.56, "stop-color": "#fff", "stop-opacity": 0 }),
        s("stop", { offset: 1, "stop-color": "#000", "stop-opacity": 0.29 })));
      defs.push(s("radialGradient", { id: `${idp}-shadow` }, s("stop", { offset: 0, "stop-color": "#1b1030", "stop-opacity": 0.32 }), s("stop", { offset: 1, "stop-color": "#1b1030", "stop-opacity": 0 })));
      defs.push(s("filter", { id: `${idp}-glow`, x: "-60%", y: "-60%", width: "220%", height: "220%", "color-interpolation-filters": "sRGB" },
        s("feGaussianBlur", { stdDeviation: 1.6, result: "b1" }),
        s("feGaussianBlur", { stdDeviation: 3.8, result: "b2" }),
        s("feMerge", null, s("feMergeNode", { in: "b2" }), s("feMergeNode", { in: "b1" }), s("feMergeNode", { in: "SourceGraphic" }))));
      fill.visor = `url(#${idp}-visor)`;
      fill.specular = `url(#${idp}-specular)`;
    }
    const light = { primary: 0.42, white: 0.62, dark: 0.16, darkDeep: 0.1 };
    return { defs, fill, hl: (key) => light[key] ?? 0.3 };
  }

  // ---------------------------------------------------------------- eye expressions (right-eye local space; the left eye is mirrored)
  const EYE = {
    neutral: { d: "M -6.4,0 A 6.4,8 0 1 0 6.4,0 A 6.4,8 0 1 0 -6.4,0 Z", fill: true, blink: true },
    happy: { d: "M -8,3.6 Q 0,-9.5 8,3.6", w: 4.4 },
    closed: { d: "M -8,0.4 Q 0,4.6 8,0.4", w: 3.6 },
    focus: { d: "M -8,-2.4 L 8,-4 L 8,3.6 Q 8,5.4 6.2,5.4 L -6.2,5.4 Q -8,5.4 -8,3.6 Z", fill: true, blink: true },
    determined: { d: "M -8.6,-0.6 L 8.6,-6.4 L 8.6,3.8 Q 8.6,6 6.4,6 L -6.4,6 Q -8.6,6 -8.6,3.8 Z", fill: true, blink: true },
    alarm: { d: "M -8,1.6 L 8.4,-7.2 L 8.4,3 Q 8.4,5 6.4,5 L -6,5 Q -8,5 -8,3.4 Z", fill: true, blink: true },
    surprised: { d: "M -6.2,0 A 6.2,6.6 0 1 0 6.2,0 A 6.2,6.6 0 1 0 -6.2,0 Z", w: 3.2, blink: true },
    love: { d: "M 0,6.4 C -9.6,0 -9.4,-7.6 -4.6,-7.6 C -2.2,-7.6 -0.6,-5.6 0,-3.8 C 0.6,-5.6 2.2,-7.6 4.6,-7.6 C 9.4,-7.6 9.6,0 0,6.4 Z", fill: true },
    analyze: { d: "M 0,-8.6 L 7.4,0 L 0,8.6 L -7.4,0 Z M 0,-3.4 L -2.9,0 L 0,3.4 L 2.9,0 Z", fill: true, blink: true },
    sparkle: { d: "M 0,-9.4 Q 1.7,-1.7 9.4,0 Q 1.7,1.7 0,9.4 Q -1.7,1.7 -9.4,0 Q -1.7,-1.7 0,-9.4 Z", fill: true },
    concern: { d: "M -8,4 Q -1,-6 7,-1", w: 3.7, blink: true },
    ponder: { d: "M -8,-1 Q 0,-4 8,-1 L 7,3 Q 0,1 -7,3 Z", fill: true, blink: true },
    sleepy: { d: "M -7.6,1.6 Q 0,3.6 7.6,1.6", w: 3.2 },
    error: { d: "M 6,-6.4 L -5,0 L 6,6.4", w: 3.8 }
  };
  /** Faces: an eye shape per side (+ optional scale and vertical offset). */
  const EXPRESSIONS = {
    neutral: { l: "neutral", r: "neutral" }, happy: { l: "happy", r: "happy" }, focus: { l: "focus", r: "focus" },
    determined: { l: "determined", r: "determined" }, alarm: { l: "alarm", r: "alarm" }, surprised: { l: "surprised", r: "surprised" },
    love: { l: "love", r: "love" }, analyze: { l: "analyze", r: "analyze" }, sparkle: { l: "sparkle", r: "sparkle" },
    sleepy: { l: "sleepy", r: "sleepy" }, error: { l: "error", r: "error" },
    wink: { l: "neutral", r: "happy" }, curious: { l: ["neutral", 1.14, -0.6], r: ["neutral", 0.8, 1.2] },
    thinking: { l: "ponder", r: "neutral" }, concerned: { l: "concern", r: "concern" },
    celebrating: { l: "sparkle", r: "sparkle" }, focused: { l: "focus", r: "focus" }
  };
  const eyeOf = (spec) => (Array.isArray(spec) ? { shape: spec[0], k: spec[1], y: spec[2] } : { shape: spec, k: 1, y: 0 });

  // ---------------------------------------------------------------- anatomy builders (absolute rig coordinates, ground at y = 0)
  const HEAD_SHELL = "M -56,-178 C -56,-212 -32,-226 0,-226 C 32,-226 56,-212 56,-178 C 56,-149 40,-134 0,-134 C -40,-134 -56,-149 -56,-178 Z";
  const VISOR = "M -45,-173 C -45,-191 -30,-198 0,-198 C 30,-198 45,-191 45,-173 C 45,-155 33,-146 0,-146 C -33,-146 -45,-155 -45,-173 Z";

  function earPath(style, L, W) {
    const tx = L * 0.17;
    if (style === "blade") return `M ${-W},6 L ${tx - 3},${-L + 5} Q ${tx},${-L - 2} ${tx + 3},${-L + 5} L ${W},6 Z`;
    if (style === "tech") return `M ${-W},6 L ${tx - 3},${-L + 5} Q ${tx},${-L - 2} ${tx + 3},${-L + 5} L ${W + 3},${-L * 0.44} L ${W - 1},${-L * 0.38} L ${W},6 Z`;
    if (style === "notched") return `M ${-W},6 L ${tx - 7},${-L * 0.6} L ${tx - 2},${-L * 0.58} L ${tx - 3},${-L + 5} Q ${tx + 1},${-L - 3} ${tx + 4},${-L + 6} L ${W + 2},${-L * 0.3} L ${W},6 Z`;
    if (style === "leaf") return `M ${-W},6 C ${-W - 4},${-L * 0.42} ${tx - 7},${-L * 0.86} ${tx},${-L} C ${tx + 9},${-L * 0.74} ${W + 6},${-L * 0.36} ${W},6 Z`;
    return `M ${-W},6 C ${-W},${-L * 0.46} ${tx - 8},${-L * 0.9} ${tx},${-L} C ${tx + 6},${-L * 0.8} ${W + 3},${-L * 0.42} ${W},6 Z`; // soft
  }
  function buildEar(spec, M, glow, scale = 1) {
    const m = spec.morph;
    const L = m.earLen * scale, W = m.earWidth, tx = L * 0.17;
    const d = earPath(m.ear, L, W);
    const cx = tx * 0.45, cy = -L * 0.4;
    return [
      P(d, { fill: M.fill.darkDeep, stroke: spec.palette.deep, "stroke-width": 4.8, "stroke-linejoin": "round" }),
      P(d, { fill: M.fill[spec.parts.earOuter], ...OUT }),
      P(`M ${-W + 4},2 L ${tx - 1},${-L + 14} L ${tx + 2},${-L * 0.56} L ${W - 4},1 Z`, { fill: spec.palette.deep, "fill-opacity": 0.62, stroke: M.fill.dark, "stroke-width": 1.2, "stroke-linejoin": "round" }),
      P(d, { fill: M.fill[spec.parts.earInner], stroke: spec.palette.glow, "stroke-width": 2.3, "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round",
        transform: `translate(${cx} ${cy}) scale(0.58 0.74) translate(${-cx} ${-cy})` }),
      P(`M ${-W + 5},${-L * 0.24} L ${W - 3},${-L * 0.29} M ${-W + 7},${-L * 0.44} L ${W - 6},${-L * 0.49}`, { fill: "none", stroke: M.fill[spec.parts.earOuter], "stroke-opacity": 0.48, "stroke-width": 1.7, "stroke-linecap": "round" }),
      P(`M ${tx - 2},${-L + 15} L ${tx + 1},${-L * 0.38}`, { fill: "none", stroke: spec.palette.glow, "stroke-width": 1.4, "stroke-opacity": 0.8, ...glow }),
      P(`M ${-W + 3},2 C ${-W + 5},${-L * 0.3} ${-2},${-L * 0.62} ${tx - 2},${-L * 0.86}`, { fill: "none", stroke: "#ffffff", "stroke-opacity": M.hl(spec.parts.earOuter) * 0.7, "stroke-width": 1.6, "stroke-linecap": "round" }),
      P(`M ${W - 4},-1 L ${W - 7},${-L * 0.18} L ${W - 1},${-L * 0.26}`, { fill: "none", stroke: spec.palette.light, "stroke-opacity": 0.7, "stroke-width": 1.3 }),
      s("rect", { x: -W * 0.72, y: -1, width: W * 1.44, height: 12, rx: 4, fill: M.fill.dark, ...OUT }),
      s("rect", { x: -W * 0.62, y: 1, width: W * 1.24, height: 4, rx: 2, fill: M.fill.primary, opacity: 0.7 }),
      s("circle", { cx: 0, cy: 5, r: 2.2, fill: spec.palette.glow, ...glow })
    ];
  }
  function buildPod(spec, M, glow) {
    return [
      s("circle", { cx: 0, cy: 0, r: 17.5, fill: M.fill.darkDeep, stroke: M.fill.primary, "stroke-width": 1.4 }),
      s("circle", { cx: 0, cy: 0, r: 14.8, fill: M.fill.dark, ...OUT }),
      s("circle", { cx: 0, cy: 0, r: 12.6, fill: "none", stroke: "#fff", "stroke-opacity": 0.22, "stroke-width": 1.3 }),
      s("circle", { cx: 0, cy: 0, r: 10.4, fill: "none", stroke: spec.palette.glow, "stroke-width": 2.6, ...glow }),
      s("circle", { cx: 0, cy: 0, r: 6.6, fill: M.fill.darkDeep }),
      s("circle", { cx: 0, cy: 0, r: 3.2, fill: M.fill[spec.parts.headCap], stroke: "#fff", "stroke-opacity": 0.32, "stroke-width": 0.8 }),
      P("M -9,-8 A 12,12 0 0 1 4,-12", { fill: "none", stroke: "#ffffff", "stroke-opacity": 0.35, "stroke-width": 1.6, "stroke-linecap": "round" })
    ];
  }
  function buildCap(spec, M) {
    const cap = M.fill[spec.parts.headCap];
    const out = [];
    if (spec.parts.capStyle === "crown") {
      out.push(P("M -55,-190 C -53,-215 -31,-226 0,-226 C 31,-226 53,-215 55,-190 C 34,-198 -34,-198 -55,-190 Z", { fill: cap, ...OUT }));
      out.push(P("M -8,-225.6 L 8,-225.6 L 6.5,-197 L -6.5,-197 Z", { fill: M.fill[spec.parts.headShell] }));
    } else if (spec.parts.capStyle === "band") {
      out.push(P("M -21,-224.4 C -7,-226.4 7,-226.4 21,-224.4 L 15.5,-197 L -15.5,-197 Z", { fill: cap, ...OUT }));
      out.push(P("M -30,-220 L -24,-198 M 30,-220 L 24,-198", { stroke: cap, "stroke-width": 2.2, "stroke-linecap": "round", opacity: 0.8 }));
    } else {
      out.push(P("M -14,-225.2 C -5,-226.2 5,-226.2 14,-225.2 L 11,-197 L -11,-197 Z", { fill: cap, ...OUT }));
    }
    return out;
  }
  function buildAccessory(name, spec, M, glow, idx) {
    const pal = spec.palette;
    if (name === "crest") return [P("M -7,-225.4 L 0,-234 L 7,-225.4 Z", { fill: M.fill.primary, ...OUT }), P("M -3.6,-215 L 3.6,-215 L 0,-209 Z", { fill: pal.glow, ...glow })];
    if (name === "bow") return g({ "data-part": "bow" },
      P("M -35,-216 C -46,-232 -60,-216 -47,-206 C -42,-203 -37,-209 -35,-216 Z", { fill: M.fill.primary, ...OUT }),
      P("M -35,-216 C -22,-232 -9,-216 -22,-207 C -27,-204 -33,-209 -35,-216 Z", { fill: M.fill.primary, ...OUT }),
      P("M -37,-213 L -44,-199 L -39.5,-200.5 Z M -33,-213 L -28,-199 L -32,-200.4 Z", { fill: pal.deep }),
      s("circle", { cx: -35, cy: -215, r: 4.4, fill: pal.light, ...OUT }),
      P("M -50,-218 C -48,-222 -44,-223 -41,-221", { fill: "none", stroke: "#fff", "stroke-opacity": 0.6, "stroke-width": 1.5, "stroke-linecap": "round" }));
    if (name === "butterfly") return g({ "data-part": "butterfly", transform: "translate(38 -219) rotate(-14)" },
      P("M 0,0 C -6,-14 -20,-14 -16,-3 C -14,2 -6,2 0,0 Z M 0,0 C 6,-14 20,-14 16,-3 C 14,2 6,2 0,0 Z", { fill: pal.light, "fill-opacity": 0.82, stroke: pal.glow, "stroke-width": 1.4, ...glow }),
      P("M 0,0 C -5,8 -13,9 -11,3 Z M 0,0 C 5,8 13,9 11,3 Z", { fill: pal.primary, "fill-opacity": 0.85, stroke: pal.glow, "stroke-width": 1.1 }),
      s("rect", { x: -1.4, y: -6, width: 2.8, height: 11, rx: 1.4, fill: M.fill.dark }));
    if (name === "sprout") return g({ "data-part": "sprout" },
      P("M 0,-226 C 0,-233 1,-237 2,-241", { fill: "none", stroke: pal.deep, "stroke-width": 2.6, "stroke-linecap": "round" }),
      P("M 2,-240 C -8,-249 -16,-241 -11,-236 C -7,-233 -1,-236 2,-240 Z", { fill: M.fill.primary, ...OUT }),
      P("M 2,-240 C 10,-251 20,-244 15,-237 C 11,-234 5,-236 2,-240 Z", { fill: M.fill.primary, ...OUT }),
      P("M -8,-239 L 0,-238 M 12,-241 L 4,-239", { stroke: pal.light, "stroke-width": 1, opacity: 0.8 }));
    if (name === "hud") return g({ "data-part": "hud" },
      P("M 63,-185 L 71,-202", { stroke: M.fill.dark, "stroke-width": 2.6, "stroke-linecap": "round" }),
      s("circle", { cx: 71.5, cy: -203, r: 2.8, fill: pal.glow, ...glow }),
      P("M -34,-192 L -26,-192 M -34,-188 L -29,-188 M 26,-192 L 34,-192", { stroke: pal.glow, "stroke-width": 1.2, opacity: 0.75 }));
    if (name === "brow") return g({ "data-part": "brow" },
      P("M -47,-192 L -9,-185 L 0,-189.5 L 9,-185 L 47,-192 L 45,-199.5 L 0,-195.5 L -45,-199.5 Z", { fill: M.fill.dark, ...OUT }),
      P("M -57,-196 L -66,-206 L -58,-188 Z M 57,-196 L 66,-206 L 58,-188 Z", { fill: M.fill.primary, ...OUT }));
    void idx;
    return null;
  }

  function buildHand(type, spec, M) {
    const H = M.fill[spec.parts.hand], tip = M.fill[spec.parts.fingertip];
    const palm = s("rect", { x: 27.5, y: -72.5, width: 13, height: 11.5, rx: 4, fill: H, ...OUT });
    if (type === "open" || type === "wave") {
      const fingers = [29.2, 32.6, 36, 39.4].map((x, i) => g({ transform: type === "wave" ? `rotate(${(i - 1.5) * 11} ${x} -62)` : null },
        s("rect", { x: x - 1.45, y: -63, width: 2.9, height: 9, rx: 1.45, fill: H, ...OUT }), s("circle", { cx: x, cy: -54.6, r: 1.55, fill: tip })));
      return [s("rect", { x: 24.4, y: -70, width: 3.2, height: 8.5, rx: 1.6, fill: H, transform: "rotate(34 26 -70)", ...OUT }), palm, fingers];
    }
    const knuckles = [s("rect", { x: 27, y: -64, width: 14, height: 7.4, rx: 3.6, fill: H, ...OUT }), s("rect", { x: 28.5, y: -59.6, width: 11, height: 2, rx: 1, fill: tip, opacity: 0.9 })];
    if (type === "point") return [palm, knuckles, s("rect", { x: 37.4, y: -63, width: 3, height: 13.5, rx: 1.5, fill: H, ...OUT }), s("circle", { cx: 38.9, cy: -50.4, r: 1.6, fill: tip })];
    if (type === "peace") return [palm, knuckles,
      g({ transform: "rotate(-11 32.5 -62)" }, s("rect", { x: 31, y: -63, width: 3, height: 12.5, rx: 1.5, fill: H, ...OUT }), s("circle", { cx: 32.5, cy: -51.4, r: 1.6, fill: tip })),
      g({ transform: "rotate(11 37 -62)" }, s("rect", { x: 35.5, y: -63, width: 3, height: 12.5, rx: 1.5, fill: H, ...OUT }), s("circle", { cx: 37, cy: -51.4, r: 1.6, fill: tip }))];
    return [palm, knuckles, s("rect", { x: 27, y: -67, width: 8, height: 3.2, rx: 1.6, fill: H, ...OUT })]; // fist / hold
  }

  const PAULDRON = {
    round: "M 22,-131 C 24,-143 43,-146 48,-133 C 50,-125 46,-118 41,-115 L 28,-117 C 23,-121 21,-126 22,-131 Z",
    angular: "M 20.5,-129 L 29,-141 L 47,-138 L 51,-123 L 41,-112.5 L 25.5,-116.5 Z",
    tech: "M 22,-131 C 24,-143 43,-146 48,-133 C 50,-125 46,-118 41,-115 L 28,-117 C 23,-121 21,-126 22,-131 Z",
    heavy: "M 18.5,-128 L 28,-144 L 51,-141 L 57,-121 L 45,-109 L 24.5,-113.5 Z"
  };
  function buildArm(spec, M, glow) {
    const pal = spec.palette, m = spec.morph;
    const hand = g({ "data-part": "hand" });
    const handProp = g({ "data-part": "hand-prop" });
    const handGroup = g(null, hand, handProp);
    const fore = g(null,
      P("M 29,-97 L 39,-97 L 40,-93 L 28,-93 Z", { fill: M.fill.darkDeep, stroke: pal.deep, "stroke-width": 1 }),
      P("M 27.5,-95 L 40.5,-95 C 43.6,-86 43.6,-78 42,-72 L 26,-72 C 24.4,-78 24.4,-86 27.5,-95 Z", { fill: M.fill[spec.parts.forearm], ...OUT }),
      P("M 27.4,-92 L 33,-94 L 31.5,-78 L 27.4,-75 C 25.5,-81 25.9,-87 27.4,-92 Z", { fill: M.fill.specular, opacity: 0.8 }),
      P("M 37.2,-94 L 41,-93 C 44,-86 43.3,-79 42,-75 L 38,-77 C 40,-82 40,-89 37.2,-94 Z", { fill: M.fill.darkDeep, opacity: 0.4 }),
      P("M 29,-82 L 39,-82 M 29.5,-79 L 38.5,-79", { stroke: pal.deep, "stroke-opacity": 0.7, "stroke-width": 0.9 }),
      P("M 29.5,-93 C 28.5,-86 28.5,-80 29.4,-75", { fill: "none", stroke: "#fff", "stroke-opacity": M.hl(spec.parts.forearm), "stroke-width": 1.8, "stroke-linecap": "round" }),
      s("rect", { x: 26.2, y: -74, width: 16, height: 4, rx: 1.8, fill: M.fill.darkDeep, stroke: M.fill.primary, "stroke-width": 1 }),
      P("M 26.6,-75.4 L 41.4,-75.4", { stroke: pal.glow, "stroke-width": 1.7, "stroke-linecap": "round", ...glow }),
      handGroup);
    const pad = g({ transform: `translate(34 -125) scale(${m.shoulderScale}) translate(-34 125)` },
      P(PAULDRON[m.shoulder] || PAULDRON.round, { fill: M.fill[spec.parts.shoulder], ...OUT }),
      P("M 25,-129 C 29,-140 42,-143 47,-133 L 44,-125 C 37,-132 29,-131 25,-125 Z", { fill: M.fill.specular, opacity: 0.64 }),
      P("M 27,-118 L 41,-115 L 46,-122", { fill: "none", stroke: M.fill.darkDeep, "stroke-opacity": 0.7, "stroke-width": 1.6 }),
      s("circle", { cx: 44, cy: -125, r: 2.2, fill: M.fill.darkDeep, stroke: pal.glow, "stroke-width": 1 }),
      m.shoulder === "heavy" ? P("M 37,-142 L 47,-156 L 50.5,-140 Z", { fill: M.fill.dark, ...OUT }) : null,
      m.shoulder === "tech" ? P("M 30,-140 L 45,-122", { stroke: pal.glow, "stroke-width": 1.6, ...glow }) : null,
      m.shoulder === "angular" ? P("M 31,-137 L 45,-134.5", { stroke: pal.glow, "stroke-width": 1.5, ...glow }) : null,
      P("M 26,-129 C 28,-137 36,-140 42,-138", { fill: "none", stroke: "#fff", "stroke-opacity": M.hl(spec.parts.shoulder), "stroke-width": 2, "stroke-linecap": "round" }));
    const upper = g(null,
      s("circle", { cx: 34, cy: -125, r: 8.6, fill: M.fill.dark, ...OUT }),
      s("rect", { x: 28.2, y: -124, width: 11.6, height: 27, rx: 5.8, fill: M.fill[spec.parts.upperArm], ...OUT }),
      P("M 29,-122 L 34,-124 L 33,-103 L 29,-101 Z", { fill: M.fill.specular, opacity: 0.6 }),
      P("M 37,-121 L 40,-119 L 40,-103 L 37,-101 Z", { fill: M.fill.darkDeep, opacity: 0.45 }),
      P("M 28.6,-111 L 39.4,-111", { stroke: "#000", "stroke-opacity": 0.35, "stroke-width": 1 }),
      s("circle", { cx: 34, cy: -97, r: 6.4, fill: M.fill.dark, ...OUT }),
      s("circle", { cx: 34, cy: -97, r: 3.6, fill: "none", stroke: pal.glow, "stroke-width": 1.3, opacity: 0.9 }),
      fore, pad);
    return { root: upper, fore, handGroup, hand, handProp };
  }
  const THIGH = {
    plated: "M 3.5,-81 L 22,-81 C 25,-69 24.5,-57 21.5,-50 L 5,-50 C 2.5,-57 1.5,-70 3.5,-81 Z",
    curved: "M 2.5,-82 L 21.5,-82 C 28,-72 27,-58 22,-50 L 5,-50 C 2,-57 0.5,-71 2.5,-82 Z"
  };
  const BOOT = {
    block: "M 1.5,-17 C 2,-23.5 28.5,-23.5 29.5,-17 L 33,-3 C 33.3,0.6 31.5,2 28.5,2 L 0.5,2 C -2.6,2 -4,0.6 -3.6,-3 Z",
    round: "M 2,-17 C 3,-24.5 28,-24.5 29,-17 C 33,-12 35,-6 34,-1 C 33.5,1.6 32,2.5 29,2.5 L 1,2.5 C -2,2.5 -3.6,1 -3,-2 C -2.6,-7 -1,-12 2,-17 Z",
    heavy: "M 0,-19 C 0.5,-26 30,-26 31,-19 L 35,-3 C 35.3,0.8 33.5,2.2 30.5,2.2 L -1,2.2 C -4.2,2.2 -5.8,0.8 -5.4,-3 Z"
  };
  function buildLeg(spec, M, glow) {
    const pal = spec.palette, m = spec.morph;
    const boot = g({ transform: `translate(15 2) scale(${m.bootScale}) translate(-15 -2)` },
      P(BOOT[m.boot] || BOOT.block, { fill: M.fill[spec.parts.boot], ...OUT }),
      P("M 1,-16 C 5,-21 13,-22 20,-21 L 15,-11 L 2,-10 Z", { fill: M.fill.specular, opacity: 0.5 }),
      P("M 3,-15 L 26,-15 M 6,-12 L 22,-12", { stroke: M.fill.darkDeep, "stroke-opacity": 0.6, "stroke-width": 1 }),
      P(m.boot === "round" ? "M 2,-6 C 9,-10.5 21,-10.5 30.5,-6 L 31.5,0.5 L 0,0.5 Z" : "M 4,-8.5 L 27,-8.5 L 29.5,0 L 1.5,0 Z", { fill: M.fill[spec.parts.bootToe], ...OUT }),
      P("M 6,-5 L 14,-5 L 12,-1 L 4,-1 Z M 18,-5 L 26,-5 L 27,-1 L 17,-1 Z", { fill: M.fill.specular, opacity: 0.46 }),
      s("rect", { x: -3.6, y: -0.6, width: 37, height: 3.4, rx: 1.6, fill: M.fill.darkDeep }),
      s("circle", { cx: 27.5, cy: -13, r: 3, fill: M.fill.darkDeep, stroke: pal.glow, "stroke-width": 1.4, ...glow }),
      P("M 5,-19.5 C 10,-21.5 20,-21.5 24,-20", { fill: "none", stroke: "#fff", "stroke-opacity": M.hl(spec.parts.boot), "stroke-width": 1.8, "stroke-linecap": "round" }),
      m.boot === "heavy" ? P("M 6,-22 L 25,-22", { stroke: pal.glow, "stroke-width": 1.4, ...glow }) : null);
    const foot = g(null, s("circle", { cx: 14, cy: -16, r: 5, fill: M.fill.dark, ...OUT }), boot);
    const shin = g(null,
      P("M 5,-45 L 22,-45 C 24.5,-35 23.5,-25 21.5,-18 L 6,-18 C 4,-25 3,-35 5,-45 Z", { fill: M.fill[spec.parts.shin], ...OUT }),
      P("M 6,-44 L 15,-44 L 12,-21 L 7,-20 C 5,-28 4.5,-37 6,-44 Z", { fill: M.fill.specular, opacity: 0.68 }),
      P("M 8,-31 L 18,-31 M 9,-27 L 17,-27", { stroke: M.fill.darkDeep, "stroke-opacity": 0.45, "stroke-width": 1 }),
      P("M 18,-44 C 22,-36 22,-26 20,-19 L 21.5,-18.4 C 23.5,-25 24.5,-35 22,-45 Z", { fill: M.fill[spec.parts.shinSide] }),
      P("M 5,-21 L 21,-21", { stroke: pal.glow, "stroke-opacity": 0.7, "stroke-width": 1.1 }),
      P("M 8,-41 C 7,-34 7,-27 8,-22", { fill: "none", stroke: "#fff", "stroke-opacity": M.hl(spec.parts.shin), "stroke-width": 1.8, "stroke-linecap": "round" }),
      foot);
    const knee = g(null, s("circle", { cx: 13.5, cy: -47.5, r: 7, fill: M.fill.dark, ...OUT }),
      s("circle", { cx: 13.5, cy: -47.5, r: 4.7, fill: M.fill.darkDeep, stroke: pal.glow, "stroke-width": 1.2 }),
      s("circle", { cx: 13.5, cy: -47.5, r: 2, fill: M.fill[spec.parts.shin], stroke: "#fff", "stroke-opacity": 0.4, "stroke-width": 0.7 }));
    const thigh = g(null,
      s("circle", { cx: 13, cy: -79, r: 7.4, fill: M.fill.dark, ...OUT }),
      P(THIGH[m.thighStyle] || THIGH.plated, { fill: M.fill[spec.parts.thigh], ...OUT }),
      P("M 4,-79 L 12,-81 L 11,-54 L 6,-53 C 3,-62 2.8,-72 4,-79 Z", { fill: M.fill.specular, opacity: 0.64 }),
      P("M 6,-55 L 21,-55", { stroke: M.fill.darkDeep, "stroke-opacity": 0.5, "stroke-width": 1.1 }),
      spec.parts.thighAccent ? P("M 17.5,-78 C 22.5,-70 22.5,-60 19.5,-53 L 22,-52 C 25.5,-60 25.5,-71 21,-80 Z", { fill: M.fill[spec.parts.thighAccent] }) : P("M 4,-66 L 22.5,-66", { stroke: "#000", "stroke-opacity": 0.28, "stroke-width": 1 }),
      P("M 7,-78 C 6,-70 6,-62 7,-55", { fill: "none", stroke: "#fff", "stroke-opacity": M.hl(spec.parts.thigh), "stroke-width": 2, "stroke-linecap": "round" }),
      shin, knee);
    return { root: thigh, shin, foot };
  }

  // ---------------------------------------------------------------- props (hand-held follow a wrist; floating ones hover in stage space)
  function buildProp(type, spec, M, glow) {
    const pal = spec.palette;
    const holo = { fill: pal.primary, "fill-opacity": 0.16, stroke: pal.glow, "stroke-width": 1.5, ...glow };
    if (type === "tablet") return g(null, s("rect", { x: 12, y: -84, width: 44, height: 30, rx: 4, ...holo }),
      [0, 1, 2, 3].map((i) => s("rect", { x: 18 + i * 8.5, y: -59 - [7, 13, 9, 18][i], width: 5, height: [7, 13, 9, 18][i], rx: 1, fill: pal.glow, opacity: 0.88 })),
      P("M 17,-79 L 51,-79", { stroke: pal.light, "stroke-width": 1.2, opacity: 0.75 }));
    if (type === "stylus") return g(null, s("rect", { x: 33, y: -66, width: 3.2, height: 22, rx: 1.6, fill: M.fill.white, ...OUT, transform: "rotate(-24 34.6 -62)" }), s("circle", { cx: 39.5, cy: -44, r: 2.6, fill: pal.glow, ...glow }));
    if (type === "magnifier") return g(null, s("rect", { x: 32.5, y: -64, width: 3.6, height: 14, rx: 1.8, fill: M.fill.dark, ...OUT }),
      s("circle", { cx: 34.3, cy: -41, r: 10.5, fill: pal.light, "fill-opacity": 0.28, stroke: M.fill.dark, "stroke-width": 3.4 }),
      s("circle", { cx: 34.3, cy: -41, r: 10.5, fill: "none", stroke: pal.glow, "stroke-width": 1.2, ...glow }),
      P("M 28,-45 A 7,7 0 0 1 33,-49", { fill: "none", stroke: "#fff", "stroke-width": 1.6, opacity: 0.8, "stroke-linecap": "round" }));
    if (type === "shield") return g({ transform: "translate(30 -60)" },
      P("M 0,-31 L 27,-17 L 27,11 L 0,29 L -27,11 L -27,-17 Z", { fill: M.fill.primary, ...OUT, "stroke-width": 1.6 }),
      P("M 0,-23 L 19.5,-12.5 L 19.5,7.5 L 0,21 L -19.5,7.5 L -19.5,-12.5 Z", { fill: M.fill.dark, stroke: pal.glow, "stroke-width": 1.8, ...glow }),
      P("M -8,-6 L 8,-6 L 0,8 Z", { fill: "none", stroke: pal.glow, "stroke-width": 2.4, "stroke-linejoin": "round", ...glow }),
      P("M -20,-17 L -4,-26", { stroke: "#fff", "stroke-opacity": 0.55, "stroke-width": 2, "stroke-linecap": "round" }));
    if (type === "canvas") return g({ "data-float": "1", transform: "translate(78 -196)" },
      s("rect", { x: -20, y: -16, width: 40, height: 30, rx: 4, ...holo }),
      P("M 0,7 C -9,1 -9,-6 -4.5,-6 C -2,-6 -0.6,-4.2 0,-2.6 C 0.6,-4.2 2,-6 4.5,-6 C 9,-6 9,1 0,7 Z", { fill: pal.glow, opacity: 0.9, ...glow }),
      P("M -15,-10 C -10,-13 -6,-7 -1,-10", { fill: "none", stroke: pal.light, "stroke-width": 1.3, "stroke-linecap": "round" }));
    if (type === "chart") return g({ "data-float": "1", transform: "translate(-98 -146)" },
      s("rect", { x: -22, y: -18, width: 44, height: 34, rx: 4, ...holo }),
      [0, 1, 2, 3].map((i) => s("rect", { x: -15 + i * 8.5, y: 10 - [8, 14, 11, 21][i], width: 5, height: [8, 14, 11, 21][i], rx: 1, fill: pal.glow, opacity: 0.88 })),
      P("M -16,-1 L -7,-6 L 1,-3 L 14,-13", { fill: "none", stroke: pal.light, "stroke-width": 1.4, "stroke-linejoin": "round" }));
    if (type === "codepanel") return g({ "data-float": "1", transform: "translate(98 -146)" },
      s("rect", { x: -22, y: -18, width: 44, height: 34, rx: 4, ...holo }),
      [0, 1, 2, 3].map((i) => s("rect", { x: -16 + (i % 2) * 4, y: -11 + i * 6, width: [22, 16, 24, 12][i], height: 2.2, rx: 1.1, fill: pal.light, opacity: 0.85 })),
      s("circle", { cx: 13, cy: 8, r: 4.4, fill: "none", stroke: pal.glow, "stroke-width": 1.6, "stroke-dasharray": "2.4 1.6" }));
    if (type === "heart") return g({ "data-float": "1", transform: "translate(82 -210)" },
      P("M 0,9 C -13,1 -13,-9 -6.4,-9 C -3,-9 -0.8,-6.4 0,-4.2 C 0.8,-6.4 3,-9 6.4,-9 C 13,-9 13,1 0,9 Z", { fill: pal.primary, stroke: pal.glow, "stroke-width": 1.4, ...glow }),
      P("M -7,-5 C -6,-7 -4,-7.4 -2.6,-6.6", { fill: "none", stroke: "#fff", "stroke-width": 1.3, opacity: 0.8, "stroke-linecap": "round" }));
    if (type === "leaves") return g({ "data-float": "1" }, [[-86, -150, -20], [84, -196, 30], [-74, -226, 60]].map(([x, y, r]) =>
      g({ transform: `translate(${x} ${y}) rotate(${r})` }, P("M 0,-9 C 7,-6 7,5 0,9 C -7,5 -7,-6 0,-9 Z", { fill: pal.primary, "fill-opacity": 0.85, stroke: pal.glow, "stroke-width": 1.1, ...glow }), P("M 0,-7 L 0,7", { stroke: pal.light, "stroke-width": 0.9 }))));
    return null;
  }

  // ---------------------------------------------------------------- state effects (built lazily, animated per frame)
  function buildFx(kind, spec, glow) {
    const pal = spec.palette;
    if (kind === "dots") return g({ transform: "translate(64 -246)" }, [0, 1, 2].map((i) => s("circle", { cx: i * 9, cy: -i * 7, r: 2.6 + i * 1.1, fill: pal.glow, ...glow })));
    if (kind === "keys") return g({ transform: "translate(0 -78)" },
      P("M -40,-6 L 40,-6 L 48,10 L -48,10 Z", { fill: pal.primary, "fill-opacity": 0.18, stroke: pal.glow, "stroke-width": 1.4, ...glow }),
      [0, 1, 2].map((r) => [0, 1, 2, 3, 4, 5, 6].map((c) => s("rect", { x: -36 + c * 10.4 - r * 2.2, y: -3 + r * 4.4, width: 7, height: 2.6, rx: 1, fill: pal.light, opacity: 0.4, "data-key": `${r}-${c}` }))));
    if (kind === "ring") return s("circle", { cx: 0, cy: -113, r: 18.5, fill: "none", stroke: pal.glow, "stroke-width": 2, "stroke-dasharray": "30 86.2", "stroke-linecap": "round", ...glow });
    if (kind === "sparkles") return g(null, [[-70, -226, 1], [72, -238, 0.8], [-84, -170, 0.7], [86, -150, 0.9], [0, -258, 0.75]].map(([x, y, k]) =>
      g({ transform: `translate(${x} ${y}) scale(${k})` }, P("M 0,-9 Q 1.6,-1.6 9,0 Q 1.6,1.6 0,9 Q -1.6,1.6 -9,0 Q -1.6,-1.6 0,-9 Z", { fill: "#fff", stroke: pal.glow, "stroke-width": 1.6, ...glow }))));
    if (kind === "warn") return g({ transform: "translate(66 -244)" },
      P("M 0,-13 L 12,9 L -12,9 Z", { fill: "#ffb020", stroke: "#7a3d00", "stroke-width": 1.4, "stroke-linejoin": "round" }),
      P("M 0,-5 L 0,2", { stroke: "#2a1400", "stroke-width": 2.6, "stroke-linecap": "round" }), s("circle", { cx: 0, cy: 5.6, r: 1.5, fill: "#2a1400" }));
    if (kind === "zzz") return g({ transform: "translate(58 -236)" }, [0, 1, 2].map((i) => P("M -3.5,-3.5 L 3.5,-3.5 L -3.5,3.5 L 3.5,3.5", { fill: "none", stroke: pal.light, "stroke-width": 1.8, "stroke-linejoin": "round", "stroke-linecap": "round", transform: `translate(${i * 9} ${-i * 11}) scale(${0.8 + i * 0.25})` })));
    if (kind === "waves") return g({ transform: "translate(78 -173)" }, [0, 1].map((i) => P(`M 0,${-6 - i * 5} A ${8 + i * 5},${8 + i * 5} 0 0 1 0,${6 + i * 5}`, { fill: "none", stroke: pal.glow, "stroke-width": 2, "stroke-linecap": "round", ...glow })));
    return null;
  }

  // ---------------------------------------------------------------- the rig
  let SEQ = 0;
  function buildRig(agentId, { flat = false, glowOn = true, portrait = false } = {}) {
    const spec = SPEC.AGENTS[agentId];
    const idp = `rb${++SEQ}`;
    const M = materials(idp, spec.palette, flat);
    const glow = glowOn && !flat ? { filter: `url(#${idp}-glow)` } : {};
    const m = spec.morph, pal = spec.palette;
    const r = { spec, idp };

    // head
    r.earR = g(null, buildEar(spec, M, glow, portrait ? 0.6 : 1));
    r.earL = g(null, buildEar(spec, M, glow, portrait ? 0.6 : 1));
    r.podR = g(null, buildPod(spec, M, glow));
    r.podL = g(null, buildPod(spec, M, glow));
    r.eyeR = P("", {}); r.eyeL = P("", {});
    r.eyeGR = g(null, r.eyeR); r.eyeGL = g(null, r.eyeL);
    r.eyes = g({ fill: pal.eye, stroke: pal.eye, "stroke-linecap": "round", "stroke-linejoin": "round", ...glow }, r.eyeGR, g({ transform: "scale(-1 1)" }, r.eyeGL));
    r.eyeSoft = flat ? g({ opacity: 0.3 }) : null; // portraits: a soft halo stands in for the glow filter
    r.mouth = g({ transform: "translate(0 -154)", opacity: 0 }, [-2, -1, 0, 1, 2].map((i) => s("rect", { x: i * 4.2 - 1.2, y: -2, width: 2.4, height: 4, rx: 1.2, fill: pal.eye })));
    r.mouthBars = [...r.mouth.children];
    r.face = g(null,
      P("M -48,-175 C -48,-196 -30,-202 0,-202 C 30,-202 48,-196 48,-175 C 48,-151 32,-142 0,-142 C -32,-142 -48,-151 -48,-175 Z", { fill: M.fill.darkDeep, stroke: M.fill.primary, "stroke-width": 1.7 }),
      P(VISOR, { fill: M.fill.visor, stroke: pal.darkLight, "stroke-width": 2.2 }),
      P("M -43,-181 C -38,-194 -25,-197 0,-197 C 25,-197 38,-194 43,-181 C 32,-189 -31,-189 -43,-181 Z", { fill: M.fill.specular, opacity: 0.62 }),
      P("M -37,-187 C -29,-194 -12,-196 3,-195.6", { fill: "none", stroke: "#ffffff", "stroke-opacity": 0.24, "stroke-width": 3, "stroke-linecap": "round" }),
      P("M -39,-157 C -22,-145 21,-145 39,-157", { fill: "none", stroke: "#bcb4c7", "stroke-opacity": 0.25, "stroke-width": 1.8, "stroke-linecap": "round" }),
      s("circle", { cx: 33, cy: -186, r: 1.8, fill: "#fff", opacity: 0.22 }),
      g({ transform: "translate(0 -171)" }, r.eyeSoft, r.eyes),
      s("circle", { cx: -22, cy: -178, r: 1.5, fill: "#fff", opacity: 0.75 }),
      s("circle", { cx: 16, cy: -177, r: 1, fill: "#fff", opacity: 0.55 }), r.mouth);
    const shellKey = spec.parts.headShell;
    r.head = g(null,
      g({ transform: "scale(-1 1)" }, r.earL), r.earR,
      P(HEAD_SHELL, { fill: M.fill[shellKey], ...OUT, "stroke-width": 1.4 }),
      P("M -54,-185 C -55,-213 -34,-226 -7,-227 L -16,-217 C -33,-215 -47,-200 -46,-178 L -43,-153 C -53,-158 -55,-170 -54,-185 Z", { fill: M.fill.darkDeep, opacity: 0.48 }),
      P("M 54,-185 C 55,-213 34,-226 7,-227 L 16,-217 C 33,-215 47,-200 46,-178 L 43,-153 C 53,-158 55,-170 54,-185 Z", { fill: M.fill.darkDeep, opacity: 0.52 }),
      buildCap(spec, M),
      P("M -44,-201 C -34,-218 -17,-225 0,-225 C 17,-225 34,-218 44,-201 L 38,-198 C 29,-211 15,-217 0,-217 C -15,-217 -29,-211 -38,-198 Z", { fill: M.fill.specular, stroke: "#fff", "stroke-opacity": 0.18, "stroke-width": 0.7 }),
      P("M -47,-194 L -53,-179 L -47,-163 L -42,-169 L -43,-187 Z M 47,-194 L 53,-179 L 47,-163 L 42,-169 L 43,-187 Z", { fill: M.fill[spec.parts.headCap], stroke: M.fill.darkDeep, "stroke-width": 1.2 }),
      P("M -54,-169 L -46,-163 M 54,-169 L 46,-163", { stroke: pal.glow, "stroke-opacity": 0.6, "stroke-width": 1.2 }),
      P("M -42,-207 C -34,-219 -18,-224 -4,-224 C -16,-219 -30,-212 -38,-200 Z", { fill: "#fff", opacity: M.hl(shellKey) }),
      P("M -51,-160 C -42,-140 42,-140 51,-160 C 40,-147 -40,-147 -51,-160 Z", { fill: "#000", opacity: 0.16 }),
      ["crest", "brow"].some((a) => spec.accessories.includes(a)) ? null : P("M -3.6,-214 L 3.6,-214 L 0,-208 Z", { fill: pal.glow, ...glow }),
      r.face,
      P("M -39,-148 C -22,-136 22,-136 39,-148 L 34,-142 C 17,-132 -17,-132 -34,-142 Z", { fill: M.fill[spec.parts.headCap], stroke: M.fill.darkDeep, "stroke-width": 1.1 }),
      P("M -23,-141 L 23,-141", { stroke: "#fff", "stroke-opacity": 0.24, "stroke-width": 0.9 }),
      g({ transform: "translate(-57 -173) scale(-1 1)" }, r.podL), g({ transform: "translate(57 -173)" }, r.podR),
      spec.accessories.map((a, i) => buildAccessory(a, spec, M, glow, i)));
    if (portrait) {
      r.svg = s("svg", { viewBox: "-82 -268 164 164", class: "rb-portrait", "aria-hidden": "true", focusable: "false" }, M.defs.length ? s("defs", null, M.defs) : null,
        s("rect", { x: -11, y: -142, width: 22, height: 18, rx: 5, fill: M.fill.darkDeep }), r.head);
      r.earR.setAttribute("transform", `translate(26 -211) rotate(${m.earSplay})`);
      r.earL.setAttribute("transform", `translate(26 -211) rotate(${m.earSplay})`);
      return r;
    }

    // torso, arms, legs
    r.arms = { R: buildArm(spec, M, glow), L: buildArm(spec, M, glow) };
    r.legs = { R: buildLeg(spec, M, glow), L: buildLeg(spec, M, glow) };
    const shoulderShift = (m.torsoW - 1) * 30;
    const armWrap = (side) => g({ transform: `${side === "L" ? "scale(-1 1) " : ""}translate(${shoulderShift} 0) translate(34 -125) scale(${m.limb}) translate(-34 125)`, "data-arm": side }, r.arms[side].root);
    r.armWrapR = armWrap("R"); r.armWrapL = armWrap("L");
    r.core = P("M -7.4,-117.5 L 7.4,-117.5 L 0,-105 Z", { fill: pal.glow, "fill-opacity": 0.3, stroke: pal.glow, "stroke-width": 2.4, "stroke-linejoin": "round", ...glow });
    r.headPivot = g(null, r.head);
    r.armsBack = g(null, r.armWrapL, r.armWrapR);
    r.armsFront = g(null);
    r.torso = g(null,
      s("rect", { x: -10, y: -144, width: 20, height: 15, rx: 4, fill: M.fill.darkDeep }),
      P("M -9,-139 L 9,-139 M -9,-135 L 9,-135", { stroke: pal.darkLight, "stroke-width": 1 }),
      g({ transform: `scale(${m.torsoW} 1)` },
        P("M -30,-128 C -35,-116 -29,-100 -18,-91 L 18,-91 C 29,-100 35,-116 30,-128 C 18,-135.5 -18,-135.5 -30,-128 Z", { fill: M.fill[spec.parts.torso], ...OUT, "stroke-width": 1.4 }),
        P("M -30,-128 C -35,-116 -29,-100 -18,-91 L -13,-91 C -21,-103 -23,-117 -21,-130.5 Z M 30,-128 C 35,-116 29,-100 18,-91 L 13,-91 C 21,-103 23,-117 21,-130.5 Z", { fill: M.fill[spec.parts.torsoSide] }),
        P("M -28,-126 L -13,-130 L -9,-116 L -19,-108 L -29,-112 Z M 28,-126 L 13,-130 L 9,-116 L 19,-108 L 29,-112 Z", { fill: M.fill[spec.parts.torso], stroke: M.fill.darkDeep, "stroke-width": 1.5, "stroke-linejoin": "round" }),
        P("M -27,-125 L -16,-128 L -13,-119 L -24,-117 Z M 27,-125 L 16,-128 L 13,-119 L 24,-117 Z", { fill: M.fill.specular, opacity: 0.62 }),
        P("M -29,-112 L -22,-109 L -17,-94 L -22,-95 Z M 29,-112 L 22,-109 L 17,-94 L 22,-95 Z", { fill: M.fill.darkDeep, opacity: 0.45 }),
        P("M -24,-105 L -17,-104 M -23,-101 L -16,-100 M 24,-105 L 17,-104 M 23,-101 L 16,-100", { stroke: pal.glow, "stroke-opacity": 0.55, "stroke-width": 1.1, "stroke-linecap": "round" }),
        P("M -20,-131.5 C -10,-136.5 10,-136.5 20,-131.5 L 18,-127 C 8,-131 -8,-131 -18,-127 Z", { fill: M.fill.dark }),
        P("M -24,-126 C -17,-130 -6,-131.5 2,-131.5 C -9,-127.5 -18,-121 -23,-112 Z", { fill: "#fff", opacity: M.hl(spec.parts.torso) })),
      P("M -15,-114 L -7,-127 L 7,-127 L 15,-114 L 8,-99 L -8,-99 Z", { fill: M.fill.darkDeep, stroke: M.fill[spec.parts.torsoSide], "stroke-width": 2, "stroke-linejoin": "round" }),
      P("M -13,-113 L -6.5,-124.3 L 6.5,-124.3 L 13,-113 L 6.5,-101.7 L -6.5,-101.7 Z", { fill: M.fill.darkDeep, stroke: pal.darkLight, "stroke-width": 1.4 }),
      P("M -8,-118 L 8,-118 L 0,-103 Z", { fill: pal.deep, "fill-opacity": 0.5, stroke: pal.glow, "stroke-opacity": 0.75, "stroke-width": 1.1 }),
      r.core,
      P("M -4,-115.5 L 4,-115.5 L 0,-108.5 Z", { fill: "#fff", opacity: 0.65 }),
      agentId === "ori" ? P("M -25,-128 L -20,-128 L -19,-123 L -22.5,-121 L -26,-123 Z", { fill: pal.glow, stroke: M.fill.darkDeep, "stroke-width": 0.8 }) : null,
      agentId === "mia" ? P("M -23,-129 Q -20,-124 -17,-129 Q -20,-126 -23,-129 Z", { fill: pal.glow }) : null,
      agentId === "nex" ? P("M -25,-127 L -20,-127 M -25,-124 L -18,-124 M -25,-121 L -21,-121", { stroke: pal.glow, "stroke-width": 1.1 }) : null,
      agentId === "luna" ? P("M -23,-125 C -27,-129 -29,-122 -23,-119 C -17,-122 -19,-129 -23,-125 Z", { fill: pal.glow }) : null,
      agentId === "zen" ? P("M -26,-121 Q -25,-129 -18,-129 Q -18,-122 -26,-121 Z", { fill: pal.glow }) : null,
      agentId === "rex" ? P("M -25,-128 L -19,-128 L -18,-123 L -22,-119 L -26,-123 Z", { fill: pal.glow, stroke: M.fill.darkDeep, "stroke-width": 1 }) : null,
      s("rect", { x: -15.5, y: -96, width: 31, height: 11, rx: 3.4, fill: M.fill.dark, ...OUT }),
      P("M -14,-92.5 L 14,-92.5 M -14,-89 L 14,-89", { stroke: "#000", "stroke-opacity": 0.45, "stroke-width": 0.9 }),
      P("M -10,-96 L 10,-96 L 8,-93 L -8,-93 Z", { fill: M.fill[spec.parts.torso], stroke: M.fill.darkDeep, "stroke-width": 0.9 }),
      P("M -11,-87 L 11,-87 L 9,-84 L -9,-84 Z", { fill: M.fill[spec.parts.torsoSide], stroke: M.fill.darkDeep, "stroke-width": 0.8 }),
      r.armsBack, r.headPivot, r.armsFront);
    const legWrap = (side) => g({ transform: `${side === "L" ? "scale(-1 1) " : ""}translate(13 -79) scale(${m.limb} 1) translate(-13 79)` }, r.legs[side].root);
    r.pelvis = g(null,
      P("M -22.5,-89 L 22.5,-89 L 19.5,-74 C 11,-67 -11,-67 -19.5,-74 Z", { fill: M.fill[spec.parts.pelvis], ...OUT }),
      P("M -19,-87 L -9,-84 L -10,-71 L -18,-74 Z M 19,-87 L 9,-84 L 10,-71 L 18,-74 Z", { fill: M.fill[spec.parts.torso], stroke: M.fill.darkDeep, "stroke-width": 1 }),
      P("M -18,-84 L -12,-82 M 18,-84 L 12,-82", { stroke: "#fff", "stroke-opacity": 0.35, "stroke-width": 1.4 }),
      P("M -7.5,-87.5 L 7.5,-87.5 L 5.6,-75.5 L -5.6,-75.5 Z", { fill: M.fill[spec.parts.torsoSide === "white" ? "dark" : spec.parts.torsoSide], opacity: 0.9 }));
    r.floats = g({ "data-part": "floats" });
    r.fx = g({ "data-part": "fx" });
    r.fxNodes = {};
    r.stage = g(null, legWrap("L"), legWrap("R"), r.pelvis, r.torso, r.floats, r.fx);
    r.ring = s("ellipse", { cx: 0, cy: 3, rx: 56, ry: 9.5, fill: "none", stroke: pal.glow, "stroke-width": 1.6, opacity: 0.32, ...glow });
    r.shadow = s("ellipse", { cx: 0, cy: 3, rx: 60, ry: 10, fill: flat ? "rgba(27,16,48,.18)" : `url(#${idp}-shadow)` });
    r.svg = s("svg", { viewBox: VIEWBOX, class: "rb-robot", role: "img", focusable: "false", "data-agent": agentId, preserveAspectRatio: "xMidYMax meet" },
      M.defs.length ? s("defs", null, M.defs) : null, r.shadow, r.ring, r.stage);
    r.M = M; r.glow = glow;
    return r;
  }

  function setExpression(r, name) {
    const ex = EXPRESSIONS[name] || EXPRESSIONS.neutral;
    const out = {};
    for (const side of ["l", "r"]) {
      const e = eyeOf(ex[side]);
      const shape = EYE[e.shape] || EYE.neutral;
      const node = side === "l" ? r.eyeL : r.eyeR;
      node.setAttribute("d", shape.d);
      node.setAttribute("stroke-width", shape.fill ? 0.6 : shape.w);
      node.setAttribute("fill", shape.fill ? r.spec.palette.eye : "none");
      node.setAttribute("fill-rule", "evenodd");
      out[side] = { k: e.k, y: e.y, blink: Boolean(shape.blink) };
    }
    if (r.eyeSoft) {
      r.eyeSoft.replaceChildren(...[r.eyeGR, r.eyeGL].map((gr, i) => {
        const c = gr.cloneNode(true);
        c.querySelectorAll("path").forEach((p) => { p.setAttribute("stroke", r.spec.palette.glow); p.setAttribute("stroke-width", 5); p.setAttribute("fill", r.spec.palette.glow); });
        return i ? g({ transform: "scale(-1 1)" }, c) : c;
      }));
    }
    return out;
  }

  // ---------------------------------------------------------------- poses
  const ZERO = () => ({ armR: { sh: 8, el: -6, hand: "open" }, armL: { sh: 8, el: -6, hand: "open" }, legR: { hip: 3, knee: 0, lift: 0 }, legL: { hip: 3, knee: 0, lift: 0 },
    head: { tilt: 0, turn: 0, nod: 0 }, body: { lean: 0, lift: 0 }, ears: { l: 0, r: 0 } });
  function basePose(spec, variant) {
    const p = ZERO();
    const src = spec.forms[variant]?.pose || spec.forms.standard.pose;
    for (const k of ["armR", "armL", "legR", "legL", "head", "body", "ears"]) if (src[k]) Object.assign(p[k], src[k]);
    return p;
  }
  /** State overlays: arm overrides and offsets per operational state (oscillations are added in the frame loop). */
  const OVERLAY = {
    idle: {},
    listening: { head: { tilt: 7, nod: -1 }, ears: { l: -9, r: -9 }, body: { lean: 1.2 } },
    thinking: { armR: { sh: 10, el: -150, hand: "fist" }, armL: { sh: -10, el: -95, hand: "fist" }, head: { tilt: -8, turn: -0.15 }, ears: { l: 4, r: -6 } },
    working: { armR: { sh: 22, el: -78, hand: "open" }, armL: { sh: 22, el: -78, hand: "open" }, head: { tilt: 0, nod: 2.5, turn: 0 }, ears: { l: -3, r: -3 }, legR: { hip: 5, knee: 0, lift: 0 }, legL: { hip: 5, knee: 0, lift: 0 } },
    speaking: { armR: { sh: 40, el: 50, hand: "open" }, head: { tilt: 3 } },
    unavailable: { armR: { sh: 6, el: -6, hand: "open" }, armL: { sh: 6, el: -6, hand: "open" }, head: { tilt: 9, nod: 3, turn: 0 }, ears: { l: 24, r: 24 }, body: { lean: 0, lift: 0 }, legR: { hip: 3, knee: 0, lift: 0 }, legL: { hip: 3, knee: 0, lift: 0 } },
    greeting: { armR: { sh: 100, el: 40, hand: "wave" }, ears: { l: -6, r: -6 }, head: { tilt: -6 } },
    success: { armR: { sh: 120, el: 8, hand: "open" }, armL: { sh: 120, el: 8, hand: "open" }, ears: { l: -10, r: -10 }, head: { tilt: 0, nod: -2 } },
    error: { armR: { sh: 55, el: 95, hand: "open" }, armL: { sh: 55, el: 95, hand: "open" }, ears: { l: 20, r: 20 }, head: { nod: 2 } }
  };
  const STATE_FX = { thinking: ["dots"], working: ["keys", "ring"], success: ["sparkles"], error: ["warn"], unavailable: ["zzz"], listening: ["waves"] };
  function stateExpression(spec, agentId, state, variantExpr) {
    if (state === "listening") return "neutral";
    if (state === "thinking") return "thinking";
    if (state === "working") return SPEC.STATE_EXPRESSION.working[agentId] || "focus";
    if (state === "speaking" || state === "greeting") return "happy";
    if (state === "success") return SPEC.STATE_EXPRESSION.success[agentId] || "celebrating";
    if (state === "error") return "concerned";
    if (state === "unavailable") return "sleepy";
    return variantExpr;
  }

  // ---------------------------------------------------------------- shared scheduler
  const live = new Set();
  const perf = { frames: 0, total: 0, max: 0, last: [] };
  let raf = 0;
  const io = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    for (const e of entries) { const inst = e.target.__robot; if (inst) { inst.visible = e.isIntersecting; if (inst.visible) wake(); } }
  }, { rootMargin: "120px" }) : null;
  function wake() { if (!raf && !document.hidden) raf = requestAnimationFrame(tick); }
  function tick(now) {
    raf = 0;
    const t0 = performance.now();
    let active = 0;
    for (const inst of live) {
      if (!inst.r.svg.isConnected) { if (++inst.detached > 90) inst.dispose(); continue; }
      inst.detached = 0;
      if (!inst.visible || inst.still) continue;
      inst.frame(now / 1000);
      active++;
    }
    const dt = performance.now() - t0;
    if (active) { perf.frames++; perf.total += dt; perf.max = Math.max(perf.max, dt); }
    if (active && !document.hidden) raf = requestAnimationFrame(tick);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
  setInterval(() => { for (const inst of live) if (!inst.r.svg.isConnected && ++inst.detached > 3) inst.dispose(); }, 4000);

  // ---------------------------------------------------------------- RobotCharacter
  /**
   * create({ agentId, variant = "standard", animationState = "idle", expression = null, accentColor = null,
   *          interactive = true, quality = "auto", reducedMotion = null, size = null, label = null })
   * → { el, set(props), react(kind), dispose(), props }
   */
  function create(options) {
    const props = { variant: "standard", animationState: "idle", expression: null, accentColor: null, interactive: true, quality: "auto", reducedMotion: null, size: null, label: null, ...options };
    const spec = SPEC.AGENTS[props.agentId];
    if (!spec) throw new Error(`unknown robot agent: ${props.agentId}`);
    const quality = props.quality === "auto" ? ((typeof props.size === "number" ? props.size : 240) >= 170 ? "high" : "medium") : props.quality;
    const r = buildRig(props.agentId, { flat: quality === "low", glowOn: quality !== "low" });
    const svg = r.svg;
    if (typeof props.size === "number") svg.style.setProperty("--rb-size", `${props.size}px`);
    if (props.accentColor) svg.style.setProperty("--agent", props.accentColor);
    const inst = { r, props, visible: !io, detached: 0, still: false, quality };
    let reactionTimer = null;
    svg.__robot = inst;
    const rnd = (a, b) => a + Math.random() * (b - a);
    const clock = { start: performance.now() / 1000 - rnd(0, 20), last: 0 };
    const st = {
      cur: null, handR: null, handL: null, expr: null, eyeInfo: null, reaction: null, fxOn: new Set(), props: new Map(),
      blinkAt: rnd(1, 4), blinkT: -1, lookAt: 0, look: { x: 0, y: 0 }, lookT: { x: 0, y: 0 }, twitchAt: rnd(3, 8), twitch: { side: "r", t: -1 },
      hover: false, pointer: { x: 0, y: 0 }
    };
    const motion = spec.motion;

    // props (hand-held props attach to the wrist and are counter-rotated to stay upright)
    const form = () => spec.forms[props.variant] || spec.forms.standard;
    function mountProps() {
      r.floats.replaceChildren(); r.arms.R.handProp.replaceChildren(); r.arms.L.handProp.replaceChildren(); st.props.clear();
      for (const p of form().props || []) {
        const node = buildProp(p.type, spec, r.M, r.glow);
        if (!node) continue;
        if (p.hand) r.arms[p.hand].handProp.append(node); else r.floats.append(node);
        st.props.set(p.type, { node, hand: p.hand || null });
      }
    }
    function ensureFx(kinds) {
      const want = new Set(kinds);
      for (const k of [...st.fxOn]) if (!want.has(k)) { r.fxNodes[k]?.remove(); delete r.fxNodes[k]; st.fxOn.delete(k); }
      for (const k of want) if (!st.fxOn.has(k)) {
        const node = buildFx(k, spec, r.glow);
        if (!node) continue;
        (k === "ring" ? r.torso : r.fx).append(node);
        r.fxNodes[k] = node; st.fxOn.add(k);
      }
    }
    function setHand(side, type) {
      const key = side === "R" ? "handR" : "handL";
      if (st[key] === type) return;
      st[key] = type;
      r.arms[side].hand.replaceChildren(...buildHand(type, spec, r.M).flat(2));
    }
    function applyExpression(name) {
      if (st.expr === name) return;
      st.expr = name;
      st.eyeInfo = setExpression(r, name);
    }
    function label() {
      const f = form();
      svg.setAttribute("aria-label", props.label || `${spec.name} — ${f.ar} — ${STATE_AR[effectiveState()] || ""}`);
    }
    const reduced = () => (props.reducedMotion == null ? reducedQuery.matches : Boolean(props.reducedMotion));
    const effectiveState = () => st.reaction?.kind || props.animationState;

    function targetPose(state) {
      const base = basePose(spec, props.variant);
      const ov = OVERLAY[state] || {};
      for (const k of ["armR", "armL", "legR", "legL"]) if (ov[k]) base[k] = { ...base[k], ...ov[k], overridden: true };
      for (const k of ["head", "body", "ears"]) if (ov[k]) for (const [kk, v] of Object.entries(ov[k])) base[k][kk] = (k === "ears" ? base[k][kk] + v : state === "unavailable" || kk === "turn" ? v : base[k][kk] + v);
      return base;
    }
    const NUM = [["armR", "sh"], ["armR", "el"], ["armL", "sh"], ["armL", "el"], ["legR", "hip"], ["legR", "knee"], ["legR", "lift"], ["legL", "hip"], ["legL", "knee"], ["legL", "lift"],
      ["head", "tilt"], ["head", "turn"], ["head", "nod"], ["body", "lean"], ["body", "lift"], ["ears", "l"], ["ears", "r"]];
    function smoothToward(target, k) {
      if (!st.cur) st.cur = JSON.parse(JSON.stringify(target));
      for (const [a, b] of NUM) st.cur[a][b] = lerp(st.cur[a][b], target[a][b], k);
      st.cur.armR.hand = target.armR.hand; st.cur.armL.hand = target.armL.hand;
      st.cur.armR.overridden = target.armR.overridden; st.cur.armL.overridden = target.armL.overridden;
    }

    function write(p, t, still) {
      const m = spec.morph;
      const e = still ? 0 : 1;
      const speed = motion.speed * (props.animationState === "unavailable" ? 0.45 : 1);
      const breath = Math.sin(t * TAU * 0.27 * speed);
      const sway = motion.sway;
      let lift = p.body.lift, lean = p.body.lean, tilt = p.head.tilt, turn = p.head.turn, nod = p.head.nod;
      const arms = { R: { ...p.armR }, L: { ...p.armL } };
      const legs = { R: { ...p.legR }, L: { ...p.legL } };
      let earL = p.ears.l, earR = p.ears.r;
      const state = effectiveState();
      if (e) {
        arms.R.sh += Math.sin(t * 1.6 * speed + 0.4) * 2.2 * sway; arms.L.sh += Math.sin(t * 1.6 * speed + 2.1) * 2.2 * sway;
        arms.R.el += Math.sin(t * 1.3 * speed + 1) * 1.6 * sway; arms.L.el += Math.sin(t * 1.3 * speed + 2.6) * 1.6 * sway;
        tilt += Math.sin(t * 0.55 * speed) * 1.6 * sway * (motion.curious ? 1.8 : 1);
        turn += Math.sin(t * 0.37 * speed) * 0.05;
        earL += Math.sin(t * 1.1 * speed + 1.3) * 1.4; earR += Math.sin(t * 1.1 * speed + 0.2) * 1.4;
        if (state === "working") { arms.R.el += Math.sin(t * 15) * 9; arms.L.el += Math.sin(t * 15 + Math.PI) * 9; nod += Math.sin(t * 3) * 0.8; }
        if (state === "speaking") { arms.R.sh += Math.sin(t * 3.4) * 9; arms.R.el += Math.sin(t * 3.4 + 1) * 8; nod += Math.sin(t * 5.2) * 1.4; }
        if (state === "thinking") { tilt += Math.sin(t * 0.9) * 3; earL += Math.sin(t * 2.2) * 5; }
        if (state === "listening") { tilt += Math.sin(t * 0.7) * 1.4; }
        const hoverLift = st.hover && props.interactive ? 5.5 + Math.sin(t * 3.2 * speed) * 2.2 : Math.sin(t * 1.8 * speed) * 1.4;
        lift += hoverLift;
        lean += Math.sin(t * 0.9 * speed) * 0.7;
        if (st.hover && props.interactive) {
          const px = st.pointer.x || 0, py = st.pointer.y || 0;
          earL -= 7 + px * 3; earR -= 7 - px * 3;
          tilt += px * 6.2; nod += py * 4.2;
          lean += px * 2.4;
          turn = lerp(turn, px * 0.48, 0.75);
        }
        // reactions
        const rx = st.reaction;
        if (rx) {
          const u = clamp((t - rx.t0) / rx.dur, 0, 1);
          const env = ease(Math.min(u * 5, 1)) * ease(Math.min((1 - u) * 4, 1));
          if (rx.kind === "greeting" || state === "greeting") {
            const w = Math.sin(t * 13) * 24 * env;
            arms.R.sh = lerp(arms.R.sh, 105, env);
            arms.R.el = lerp(arms.R.el, 38 + w, env);
            arms.R.hand = "wave";
            lift += Math.sin(u * TAU * 2) * 4 * env;
            tilt += Math.sin(t * 6) * 3 * env;
            earR -= 8 * env; earL -= 4 * env;
          }
          if (rx.kind === "success") { lift += Math.max(0, Math.sin(u * TAU * 2)) * 15 * env; arms.R.el += Math.sin(t * 12) * 8 * env; arms.L.el += Math.sin(t * 12 + 1.4) * 8 * env; }
          if (rx.kind === "error") { turn += Math.sin(t * 17) * 0.4 * env; tilt += Math.sin(t * 17) * 4 * env; }
        } else if (state === "greeting") {
          arms.R.el += Math.sin(t * 11) * 20;
        }
        // twitch
        if (st.twitch.t >= 0) { const u = (t - st.twitch.t) / 0.32; if (u > 1) st.twitch.t = -1; else { const k = Math.sin(u * Math.PI) * 10; if (st.twitch.side === "r") earR -= k; else earL -= k; } }
      }
      const bob = e ? breath * 1.25 * motion.bob : 0;
      r.stage.setAttribute("transform", `translate(0 ${(-lift).toFixed(2)}) rotate(${lean.toFixed(2)} 0 0)`);
      r.shadow.setAttribute("transform", `translate(0 3) scale(${(1 - lift * 0.012).toFixed(3)} 1) translate(0 -3)`);
      r.torso.setAttribute("transform", `translate(0 ${bob.toFixed(2)}) translate(0 -88) scale(1 ${(1 + breath * 0.011 * e).toFixed(4)}) translate(0 88)`);
      r.headPivot.setAttribute("transform", `translate(0 ${(nod - bob * 0.3).toFixed(2)}) rotate(${tilt.toFixed(2)} 0 -138)`);
      const tx = clamp(turn, -1, 1);
      r.face.setAttribute("transform", `translate(${(tx * 7).toFixed(2)} 0)`);
      r.podR.setAttribute("transform", `translate(${(tx * 3).toFixed(2)} 0) scale(${(1 + tx * 0.16).toFixed(3)} 1)`);
      r.podL.setAttribute("transform", `translate(${(-tx * 3).toFixed(2)} 0) scale(${(1 - tx * 0.16).toFixed(3)} 1)`);
      r.earR.setAttribute("transform", `translate(${(26 + tx * 3).toFixed(2)} -211) rotate(${(m.earSplay + earR).toFixed(2)})`);
      r.earL.setAttribute("transform", `translate(${(26 - tx * 3).toFixed(2)} -211) rotate(${(m.earSplay + earL).toFixed(2)})`);
      for (const side of ["R", "L"]) {
        const a = arms[side], A = r.arms[side];
        A.root.setAttribute("transform", `rotate(${(-a.sh).toFixed(2)} 34 -125)`);
        A.fore.setAttribute("transform", `rotate(${(-a.el).toFixed(2)} 34 -97)`);
        A.handProp.setAttribute("transform", `rotate(${(a.sh + a.el).toFixed(2)} 34 -66)`);
        setHand(side, a.hand);
        A.handProp.style.display = a.overridden ? "none" : "";
        const L = legs[side], G = r.legs[side];
        G.root.setAttribute("transform", `rotate(${(-L.hip).toFixed(2)} 13 -79) translate(13 -79) scale(1 ${(1 - 0.42 * L.lift).toFixed(3)}) translate(-13 79)`);
        G.shin.setAttribute("transform", `rotate(${L.knee.toFixed(2)} 13.5 -47.5)`);
        G.foot.setAttribute("transform", `rotate(${(-L.knee * 0.5 + L.hip).toFixed(2)} 14 -16)`);
      }
      // the raised arm goes in front of the head when its hand rises above the shoulder line
      const front = arms.R.sh > 95 && arms.R.el > 60 ? r.armWrapR : null;
      if (front && front.parentNode !== r.armsFront) r.armsFront.append(front);
      if (!front && r.armWrapR.parentNode !== r.armsBack) r.armsBack.append(r.armWrapR);
      // eyes: saccades, pointer look, blink
      const lk = st.look;
      r.eyes.setAttribute("transform", `translate(${(lk.x * 5.5 + tx * 2).toFixed(2)} ${(lk.y * 3.8).toFixed(2)})`);
      let blink = 0;
      if (e && st.blinkT >= 0) { const u = (t - st.blinkT) / 0.15; if (u >= 1) st.blinkT = -1; else blink = Math.sin(u * Math.PI); }
      for (const [side, node] of [["r", r.eyeGR], ["l", r.eyeGL]]) {
        const info = st.eyeInfo?.[side] || { k: 1, y: 0, blink: true };
        const sy = info.k * (info.blink ? 1 - 0.9 * blink : 1);
        node.setAttribute("transform", `translate(19 ${info.y}) scale(${info.k} ${sy.toFixed(3)})`);
      }
      // core, ring, mouth, fx
      const corePulse = state === "working" ? 0.55 + 0.45 * Math.sin(t * 7) : st.hover ? 0.88 + 0.12 * Math.sin(t * 4.5) : 0.72 + 0.22 * Math.sin(t * 2.2);
      r.core.setAttribute("fill-opacity", (0.22 + corePulse * 0.42 * (e || 0.6)).toFixed(3));
      r.ring.setAttribute("opacity", (state === "working" ? 0.35 + 0.25 * Math.sin(t * 5) * e : state === "unavailable" ? 0.08 : st.hover ? 0.52 + 0.18 * Math.sin(t * 4) : 0.28).toFixed(3));
      r.mouth.setAttribute("opacity", state === "speaking" ? 1 : 0);
      if (state === "speaking") r.mouthBars.forEach((b, i) => { const hgt = 2 + Math.abs(Math.sin(t * 11 + i * 1.3)) * 7 * e; b.setAttribute("height", hgt.toFixed(2)); b.setAttribute("y", (-hgt / 2).toFixed(2)); });
      const fx = r.fxNodes;
      if (fx.dots) [...fx.dots.children].forEach((c, i) => c.setAttribute("opacity", e ? (0.25 + 0.75 * Math.max(0, Math.sin(t * 4 - i * 0.9))).toFixed(3) : 0.9));
      if (fx.ring) fx.ring.setAttribute("transform", `rotate(${((t * 260) % 360).toFixed(1)} 0 -113)`);
      if (fx.keys) fx.keys.querySelectorAll("[data-key]").forEach((k, i) => k.setAttribute("opacity", e && Math.sin(t * 9 + i * 2.7) > 0.7 ? 0.95 : 0.35));
      if (fx.sparkles) [...fx.sparkles.children].forEach((c, i) => { const k = e ? Math.max(0, Math.sin(t * 5 + i * 1.7)) : 0.9; c.setAttribute("opacity", k.toFixed(3)); });
      if (fx.warn) fx.warn.setAttribute("opacity", e ? (0.55 + 0.45 * Math.sign(Math.sin(t * 9))).toFixed(2) : 1);
      if (fx.zzz) [...fx.zzz.children].forEach((c, i) => c.setAttribute("opacity", e ? (0.15 + 0.85 * ((t * 0.5 + i / 3) % 1)).toFixed(3) : 0.7));
      if (fx.waves) [...fx.waves.children].forEach((c, i) => c.setAttribute("opacity", e ? (0.2 + 0.8 * Math.max(0, Math.sin(t * 3.5 - i))).toFixed(3) : 0.8));
      if (e) r.floats.setAttribute("transform", `translate(0 ${(Math.sin(t * 1.4) * 3).toFixed(2)})`);
    }

    function syncState() {
      const state = effectiveState();
      applyExpression(props.expression || stateExpression(spec, props.agentId, state, form().expression));
      ensureFx(STATE_FX[state] || []);
      svg.classList.toggle("rb-dim", props.animationState === "unavailable");
      svg.dataset.state = state;
      svg.dataset.variant = props.variant;
      label();
    }
    inst.frame = (now) => {
      const t = now - clock.start;
      const dt = clamp(t - clock.last, 0, 0.1);
      clock.last = t;
      if (st.reaction && t - st.reaction.t0 > st.reaction.dur) { st.reaction = null; syncState(); }
      if (t > st.blinkAt) { st.blinkT = t; st.blinkAt = t + (Math.random() < 0.18 ? 0.35 : rnd(2.2, 5.6)); }
      if (t > st.twitchAt) { st.twitch = { side: Math.random() < 0.5 ? "l" : "r", t }; st.twitchAt = t + rnd(props.animationState === "working" ? 1.5 : 4, 9); }
      const state = effectiveState();
      if (st.hover && props.interactive) st.lookT = { x: st.pointer.x, y: st.pointer.y };
      else if (state === "thinking") st.lookT = { x: -0.55, y: -0.7 };
      else if (state === "working") st.lookT = { x: Math.sin(t * 2.4) * 0.35, y: 0.55 };
      else if (state === "listening") st.lookT = { x: 0, y: -0.05 };
      else if (t > st.lookAt) { st.lookT = { x: rnd(-0.6, 0.6), y: rnd(-0.35, 0.35) }; st.lookAt = t + rnd(1.4, 3.8); }
      const lk = 1 - Math.exp(-dt * (motion.quantize ? 22 : 9));
      st.look.x = lerp(st.look.x, st.lookT.x, lk); st.look.y = lerp(st.look.y, st.lookT.y, lk);
      smoothToward(targetPose(state), 1 - Math.exp(-dt * 7));
      write(st.cur, t, false);
    };
    function still() {
      st.cur = null;
      st.look = { x: 0, y: 0 };
      smoothToward(targetPose(effectiveState()), 1);
      write(st.cur, 0, true);
    }
    function refreshMode() {
      inst.still = reduced();
      if (inst.still) still(); else wake();
    }
    const onReducedChange = () => { if (live.has(inst)) refreshMode(); };
    inst.set = (patch = {}) => {
      const prev = { ...props };
      Object.assign(props, patch);
      if (TRANSIENT[props.animationState]) { const kind = props.animationState; props.animationState = prev.animationState in TRANSIENT ? "idle" : prev.animationState; inst.react(kind); }
      if (props.variant !== prev.variant) { st.handR = st.handL = null; mountProps(); }
      syncState();
      if (inst.still || reduced()) refreshMode();
      return inst;
    };
    inst.react = (kind) => {
      if (!TRANSIENT[kind]) return inst;
      st.reaction = { kind, t0: performance.now() / 1000 - clock.start, dur: TRANSIENT[kind] };
      syncState();
      if (inst.still) { still(); clearTimeout(reactionTimer); reactionTimer = setTimeout(() => { if (live.has(inst) && st.reaction?.kind === kind) { st.reaction = null; syncState(); still(); } }, TRANSIENT[kind] * 1000); }
      else wake();
      return inst;
    };
    inst.dispose = () => {
      live.delete(inst);
      io?.unobserve(svg);
      reducedQuery.removeEventListener?.("change", onReducedChange);
      clearTimeout(reactionTimer);
      if (inst.key && registry.get(inst.key) === inst) registry.delete(inst.key);
      svg.__robot = null;
    };
    if (props.interactive) {
      svg.addEventListener("pointerenter", () => {
        st.hover = true;
        st.twitch = { side: Math.random() < 0.5 ? "l" : "r", t: performance.now() / 1000 - clock.start };
      });
      svg.addEventListener("pointerleave", () => {
        st.hover = false;
        st.pointer = { x: 0, y: 0 };
      });
      svg.addEventListener("pointermove", (ev) => {
        const b = svg.getBoundingClientRect();
        if (!b.width) return;
        st.pointer = { x: clamp(((ev.clientX - b.left) / b.width - 0.5) * 2, -1, 1), y: clamp(((ev.clientY - b.top) / b.height - 0.35) * 2, -1, 1) };
      });
      svg.addEventListener("click", () => {
        inst.react("greeting");
      });
      svg.classList.add("rb-interactive");
    }
    reducedQuery.addEventListener?.("change", onReducedChange);
    mountProps();
    if (TRANSIENT[props.animationState]) { const kind = props.animationState; props.animationState = "idle"; syncState(); inst.react(kind); } else syncState();
    live.add(inst);
    if (io) io.observe(svg);
    refreshMode();
    if (inst.still) still(); else { inst.frame(performance.now() / 1000); wake(); }
    inst.el = svg;
    return inst;
  }

  /** Keyed reuse: a view that re-renders every few seconds keeps the same live robot (and its animation) instead of
   * rebuilding it. Returns the SVG element; the instance is reachable as el.__robot. */
  const registry = new Map();
  function mount(key, options) {
    let inst = registry.get(key);
    if (inst && (inst.props.agentId !== options.agentId || inst.quality !== (options.quality && options.quality !== "auto" ? options.quality : inst.quality))) { inst.dispose(); inst = null; }
    if (inst) { inst.set(options); return inst.el; }
    inst = create(options);
    inst.key = key;
    registry.set(key, inst);
    return inst.el;
  }

  /** Lightweight head portrait for small UI (lists, chips, avatars): the same head geometry with flat materials and no
   * filters or animation; cached per agent and expression and cloned. */
  const portraitCache = new Map();
  function portrait(agentId, { expression = null } = {}) {
    const spec = SPEC.AGENTS[agentId];
    if (!spec) return null;
    const expr = expression || (spec.forms.standard.expression === "curious" ? "happy" : spec.forms.standard.expression);
    const key = `${agentId}:${expr}`;
    if (!portraitCache.has(key)) {
      const r = buildRig(agentId, { flat: true, glowOn: false, portrait: true });
      const info = setExpression(r, expr);
      for (const [side, node] of [["r", r.eyeGR], ["l", r.eyeGL]]) node.setAttribute("transform", `translate(19 ${info[side].y}) scale(${info[side].k})`);
      setExpression(r, expr); // refresh the halo clone with the positioned eyes
      r.svg.setAttribute("data-agent", agentId);
      portraitCache.set(key, r.svg);
    }
    return portraitCache.get(key).cloneNode(true);
  }

  const forms = () => SPEC.ORDER.flatMap((id) => SPEC.VARIANTS.map((v) => ({ agentId: id, variant: v, key: SPEC.AGENTS[id].forms[v].key, ar: SPEC.AGENTS[id].forms[v].ar })));
  const stats = () => ({ instances: live.size, visible: [...live].filter((i) => i.visible && !i.still && i.r.svg.isConnected).length, frames: perf.frames, avgScriptMs: perf.frames ? +(perf.total / perf.frames).toFixed(3) : 0, maxScriptMs: +perf.max.toFixed(3), registry: registry.size });
  const resetStats = () => { perf.frames = 0; perf.total = 0; perf.max = 0; };

  window.AbudRobots = { create, mount, portrait, forms, stats, resetStats, STATES, STATE_AR, EXPRESSIONS: Object.keys(EXPRESSIONS), AGENTS: SPEC.AGENTS, ORDER: SPEC.ORDER };
})();
