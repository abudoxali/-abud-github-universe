/* ABUD FUN Company OS V3 — robot character specification (data only; rendered by robot-engine.js).
 * Derived from the owner's reference sheets in internal/assets/agents/ (team lineup, turnarounds, expression rows, action
 * poses, exploded views). Shared family anatomy: chibi proportions (head ≈ 30 % of height, ears ≈ 25 %), tall triangular
 * mechanical ears with glowing edges, round headphone-style side modules, a glossy black face visor with LED eyes, a
 * hexagonal chest plate holding a glowing ▽ core, segmented ball joints, articulated four-finger hands and block boots
 * with an ankle LED. Each agent varies palette, material split, ear/shoulder/boot morphology, accessories, default
 * expressions, motion temperament and two poses ("standard" + "expressive") — twelve visual forms of six identities.
 *
 * Pose conventions (front view, "R" = screen-right limb, "L" = screen-left limb; both authored as the right side and
 * mirrored by the engine):
 *   arm.sh   upper-arm raise away from the body in degrees (0 = hanging, 90 = horizontal, 170 = straight up, <0 = across)
 *   arm.el   forearm rotation relative to the upper arm, same sense (positive keeps rotating outward/upward,
 *            negative folds the forearm toward the chest)
 *   arm.hand open | fist | point | peace | wave | hold
 *   leg.hip  sideways spread in degrees; leg.knee bend in degrees; leg.lift 0..1 foreshortened raised leg
 *   head     { tilt (deg), turn (-1..1 yaw parallax), nod (px) }; body { lean (deg), lift (px) }; ears { l, r } extra splay */
(() => {
  "use strict";
  if (window.AbudRobotSpecs) return;

  const P = (sh, el, hand = "open") => ({ sh, el, hand });
  const LEG = (hip = 3, knee = 0, lift = 0) => ({ hip, knee, lift });

  const AGENTS = {
    ori: {
      name: "ORI", titleAr: "القائد", color: "#ff8a1f",
      palette: { primary: "#ff8a1f", light: "#ffbe73", deep: "#b8520b", white: "#ffe2bf", whiteShade: "#e7b98a", dark: "#2a2730", darkLight: "#4a4552", darkDeep: "#0d0c11", glow: "#ffa53a", eye: "#ffb347" },
      // Black helmet with orange crown plates, orange angular armor over a black frame (ref: 01 ORI sheet).
      parts: { headShell: "dark", headCap: "primary", capStyle: "crown", earOuter: "dark", earInner: "darkDeep", torso: "primary", torsoSide: "dark", shoulder: "primary", upperArm: "dark", forearm: "primary", hand: "dark", fingertip: "primary", pelvis: "dark", thigh: "primary", shin: "primary", shinSide: "dark", boot: "primary", bootToe: "dark" },
      morph: { ear: "blade", earLen: 82, earSplay: 13, earWidth: 21, shoulder: "angular", shoulderScale: 1.05, torsoW: 1.04, limb: 1.04, boot: "block", bootScale: 1.08, thighStyle: "plated" },
      accessories: ["crest"],
      motion: { energy: 1, bob: 1.1, speed: 1, sway: 1 },
      forms: {
        standard: { key: "ori-wave", ar: "تحية القائد", expression: "happy",
          pose: { armR: P(100, 40, "wave"), armL: P(40, -100, "fist"), legR: LEG(5), legL: LEG(5), head: { tilt: -4, turn: 0.12 }, body: { lean: -1 } } },
        expressive: { key: "ori-direct", ar: "توجيه الاستراتيجية", expression: "determined",
          pose: { armR: P(78, 8, "point"), armL: P(35, -60, "hold"), legR: LEG(8), legL: LEG(4, 6), head: { tilt: 3, turn: 0.28 }, body: { lean: 2 } },
          props: [{ type: "tablet", hand: "L" }] }
      }
    },
    mia: {
      name: "MIA", titleAr: "المبدعة", color: "#ff4fa3",
      palette: { primary: "#ff4fa3", light: "#ffa3cf", deep: "#c01d6e", white: "#fff6fa", whiteShade: "#ead3df", dark: "#2d2329", darkLight: "#4d3c46", darkDeep: "#100b0e", glow: "#ff5fb4", eye: "#ff7cc4" },
      // White shell with pink centre stripe, pink inner ears and a pink bow on the left ear; softer, rounder plates.
      parts: { headShell: "white", headCap: "primary", capStyle: "stripe", earOuter: "white", earInner: "primary", torso: "white", torsoSide: "primary", shoulder: "primary", upperArm: "dark", forearm: "white", hand: "dark", fingertip: "primary", pelvis: "white", thigh: "white", thighAccent: "primary", shin: "white", shinSide: "primary", boot: "white", bootToe: "primary" },
      morph: { ear: "soft", earLen: 78, earSplay: 15, earWidth: 21, shoulder: "round", shoulderScale: 1, torsoW: 0.96, limb: 0.98, boot: "round", bootScale: 1, thighStyle: "curved" },
      accessories: ["bow"],
      motion: { energy: 1.25, bob: 1.35, speed: 1.15, sway: 1.3 },
      forms: {
        standard: { key: "mia-cheeks", ar: "ابتسامة مبدعة", expression: "happy",
          pose: { armR: P(18, -150, "open"), armL: P(18, -150, "open"), legR: LEG(-2, 4), legL: LEG(-2, 4), head: { tilt: 6, turn: -0.08 }, body: { lean: 0 } } },
        expressive: { key: "mia-create", ar: "لحظة إبداع", expression: "love",
          pose: { armR: P(104, 48, "hold"), armL: P(36, -24, "open"), legR: LEG(4), legL: LEG(-6, 40, 0.55), head: { tilt: -7, turn: 0.22 }, body: { lean: -3, lift: 4 } },
          props: [{ type: "stylus", hand: "R" }, { type: "canvas" }] }
      }
    },
    nex: {
      name: "NEX", titleAr: "المحلل", color: "#2f8bff",
      palette: { primary: "#2f8bff", light: "#8cc4ff", deep: "#1450b4", white: "#f2f6fd", whiteShade: "#cdd6e6", dark: "#1d212b", darkLight: "#3b4250", darkDeep: "#080a0f", glow: "#45a6ff", eye: "#5ab4ff" },
      // White helmet with a black centre band, black chest, white limb plates; precise technical seams and HUD accents.
      parts: { headShell: "white", headCap: "dark", capStyle: "band", earOuter: "dark", earInner: "darkDeep", torso: "dark", torsoSide: "white", shoulder: "white", upperArm: "dark", forearm: "white", hand: "dark", fingertip: "primary", pelvis: "white", thigh: "white", thighAccent: "dark", shin: "dark", shinSide: "white", boot: "white", bootToe: "dark" },
      morph: { ear: "tech", earLen: 82, earSplay: 11, earWidth: 20, shoulder: "tech", shoulderScale: 1, torsoW: 1, limb: 1, boot: "block", bootScale: 1.02, thighStyle: "plated" },
      accessories: ["hud"],
      motion: { energy: 0.75, bob: 0.7, speed: 0.85, sway: 0.6, quantize: true },
      forms: {
        standard: { key: "nex-ready", ar: "جاهز للتحليل", expression: "focus",
          pose: { armR: P(20, -58, "fist"), armL: P(20, -58, "fist"), legR: LEG(6), legL: LEG(6), head: { tilt: 0, turn: 0 }, body: { lean: 0 } } },
        expressive: { key: "nex-analyze", ar: "تحليل البيانات", expression: "analyze",
          pose: { armR: P(64, 34, "open"), armL: P(58, 40, "point"), legR: LEG(5), legL: LEG(5), head: { tilt: -3, turn: -0.18 }, body: { lean: 0 } },
          props: [{ type: "chart", side: "L" }, { type: "codepanel", side: "R" }] }
      }
    },
    luna: {
      name: "LUNA", titleAr: "الداعمة", color: "#a35bff",
      palette: { primary: "#a35bff", light: "#d0afff", deep: "#6a2bc4", white: "#faf6ff", whiteShade: "#dcd0ee", dark: "#262031", darkLight: "#463d56", darkDeep: "#0d0a12", glow: "#b97cff", eye: "#c590ff" },
      // White shell, black centre band, purple ears and joints, a glowing butterfly clip on the right ear.
      parts: { headShell: "white", headCap: "dark", capStyle: "stripe", earOuter: "dark", earInner: "primary", torso: "white", torsoSide: "primary", shoulder: "white", upperArm: "dark", forearm: "white", hand: "dark", fingertip: "primary", pelvis: "white", thigh: "white", thighAccent: "primary", shin: "white", shinSide: "primary", boot: "white", bootToe: "primary" },
      morph: { ear: "soft", earLen: 80, earSplay: 14, earWidth: 21, shoulder: "round", shoulderScale: 0.98, torsoW: 0.97, limb: 0.98, boot: "round", bootScale: 1, thighStyle: "curved" },
      accessories: ["butterfly"],
      motion: { energy: 0.85, bob: 1, speed: 0.8, sway: 1.1 },
      forms: {
        standard: { key: "luna-welcome", ar: "ترحيب دافئ", expression: "happy",
          pose: { armR: P(46, 14, "open"), armL: P(46, 14, "open"), legR: LEG(3), legL: LEG(3), head: { tilt: -5, turn: 0 }, body: { lean: 0 } } },
        expressive: { key: "luna-cheer", ar: "تشجيع وسلام", expression: "wink",
          pose: { armR: P(105, 35, "peace"), armL: P(40, -22, "open"), legR: LEG(-4, 36, 0.45), legL: LEG(4), head: { tilt: 8, turn: 0.18 }, body: { lean: 2, lift: 2 } },
          props: [{ type: "heart", side: "R" }] }
      }
    },
    zen: {
      name: "ZEN", titleAr: "المستكشف", color: "#39d353",
      palette: { primary: "#39d353", light: "#97eda4", deep: "#1c8a30", white: "#f3f8f2", whiteShade: "#d0dccd", dark: "#1d231e", darkLight: "#3a463b", darkDeep: "#090c09", glow: "#55f070", eye: "#6dff86" },
      // White shell with green crown stripe, black ears with green glowing edges, a two-leaf sprout on the helmet.
      parts: { headShell: "white", headCap: "primary", capStyle: "stripe", earOuter: "dark", earInner: "darkDeep", torso: "white", torsoSide: "dark", shoulder: "primary", upperArm: "dark", forearm: "white", hand: "dark", fingertip: "primary", pelvis: "white", thigh: "white", thighAccent: "primary", shin: "primary", shinSide: "dark", boot: "white", bootToe: "dark" },
      morph: { ear: "leaf", earLen: 78, earSplay: 16, earWidth: 22, shoulder: "round", shoulderScale: 0.98, torsoW: 0.98, limb: 1, boot: "round", bootScale: 1.02, thighStyle: "plated" },
      accessories: ["sprout"],
      motion: { energy: 1.1, bob: 1.15, speed: 1.05, sway: 1.15, curious: true },
      forms: {
        standard: { key: "zen-scout", ar: "استطلاع", expression: "curious",
          pose: { armR: P(98, 42, "hold"), armL: P(40, -100, "fist"), legR: LEG(6), legL: LEG(2, 8), head: { tilt: -6, turn: 0.32 }, body: { lean: -2 } },
          props: [{ type: "magnifier", hand: "R" }] }
        ,
        expressive: { key: "zen-discover", ar: "فرحة الاكتشاف", expression: "sparkle",
          pose: { armR: P(105, 35, "peace"), armL: P(105, 35, "peace"), legR: LEG(4, 10), legL: LEG(-6, 44, 0.7), head: { tilt: 5, turn: -0.1 }, body: { lean: 1, lift: 8 } },
          props: [{ type: "leaves" }] }
      }
    },
    rex: {
      name: "REX", titleAr: "الحارس", color: "#ff3b3b",
      palette: { primary: "#ff3b3b", light: "#ff8c86", deep: "#a8121a", white: "#ffd4d0", whiteShade: "#e2a4a0", dark: "#271c1f", darkLight: "#47363a", darkDeep: "#0e090a", glow: "#ff4d4d", eye: "#ff5a52" },
      // Red helmet and heavy red armor over black, notched ears, broad spiked pauldrons, brow guard over the visor.
      parts: { headShell: "primary", headCap: "dark", capStyle: "band", earOuter: "primary", earInner: "darkDeep", torso: "primary", torsoSide: "dark", shoulder: "primary", upperArm: "dark", forearm: "primary", hand: "dark", fingertip: "primary", pelvis: "dark", thigh: "primary", shin: "primary", shinSide: "dark", boot: "primary", bootToe: "dark" },
      morph: { ear: "notched", earLen: 80, earSplay: 18, earWidth: 22, shoulder: "heavy", shoulderScale: 1.12, torsoW: 1.1, limb: 1.1, boot: "heavy", bootScale: 1.14, thighStyle: "plated" },
      accessories: ["brow"],
      motion: { energy: 0.7, bob: 0.65, speed: 0.75, sway: 0.5 },
      forms: {
        standard: { key: "rex-guard", ar: "وقفة الحراسة", expression: "determined",
          pose: { armR: P(-20, -80, "fist"), armL: P(-20, -80, "fist"), legR: LEG(8), legL: LEG(8), head: { tilt: 0, turn: 0 }, body: { lean: 0 } } },
        expressive: { key: "rex-shield", ar: "رفع الدرع", expression: "alarm",
          pose: { armR: P(62, 74, "fist"), armL: P(34, -96, "hold"), legR: LEG(12, 8), legL: LEG(10, 4), head: { tilt: -3, turn: -0.2 }, body: { lean: -2 } },
          props: [{ type: "shield", hand: "L" }] }
      }
    }
  };

  /** Default expression set per agent for operational states (eye shapes keyed by robot-engine EXPRESSIONS). */
  const STATE_EXPRESSION = {
    working: { ori: "focus", mia: "focus", nex: "analyze", luna: "focus", zen: "focus", rex: "determined" },
    success: { ori: "happy", mia: "love", nex: "sparkle", luna: "love", zen: "sparkle", rex: "happy" }
  };

  window.AbudRobotSpecs = { AGENTS, STATE_EXPRESSION, ORDER: ["ori", "mia", "nex", "luna", "zen", "rex"], VARIANTS: ["standard", "expressive"] };
})();
