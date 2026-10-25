/* Arabic-first PDF writer for LUNA's reports. pdf-lib draws glyphs left to right and fontkit shapes Arabic (joining
 * forms, RTL glyph order) but neither reorders mixed-direction text, so lines are split into bidirectional runs here
 * (a reduced Unicode Bidi Algorithm: strong types, W7 numbers after Latin, neutral resolution, L2 reordering). The
 * bundled fonts are complementary subsets: Alexandria carries Arabic, Manrope carries Latin, digits and punctuation,
 * so every character is drawn with whichever font has its glyph. Both are OFL-licensed and embedded as subsets. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const FONT_DIR = fileURLToPath(new URL("../../../internal/assets/fonts/", import.meta.url));
const A4 = [595.28, 841.89];
const MARGIN = 48;
const MIRROR = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<", "«": "»", "»": "«" };
const ARABIC = /[؀-ٟ٪-ۯۺ-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-ﻼ]/u;
const DIGIT = /[0-9٠-٩۰-۹]/u;
const LETTER = /\p{L}/u;
const NUMBER_JOINER = /[.,:/\-]/;
const NUMBER_AFFIX = /[%$€£+]/;

/** fontkit's simple-glyph encoder never writes the repeat count of a flag run that reaches the last point, which
 * corrupts glyphs such as "X" and "w". A zero-length final segment (same coordinates, so an invisible change) gives
 * the last point a distinct flag, so every run is closed before the outline ends. */
function terminatedPath(path) {
  const commands = [...path.commands];
  const closeAt = commands.at(-1)?.command === "closePath" ? commands.length - 1 : commands.length;
  const last = commands[closeAt - 1];
  if (last?.args?.length >= 2) commands.splice(closeAt, 0, { command: "lineTo", args: last.args.slice(-2) });
  return { commands, bbox: path.bbox };
}

/** WOFF2 fonts keep a transformed glyf table, which @pdf-lib/fontkit's TrueType subsetter copies byte for byte and
 * corrupts. For WOFF2 sources each glyph is re-encoded from its decoded outline instead (hinting is dropped, which a
 * PDF does not need). Applied once to the shared prototype; other font types keep the original code path. */
function patchWoff2Subsetter(font) {
  const proto = Object.getPrototypeOf(font.createSubset());
  if (proto.__woff2Safe) return;
  const original = proto._addGlyph;
  proto._addGlyph = function addGlyph(gid) {
    if (this.font.directory?.tag !== "wOF2") return original.call(this, gid);
    const glyph = this.font.getGlyph(gid);
    // An empty glyph (e.g. space) has no outline or components, so the original byte copy is safe for it.
    if (!glyph.path.commands.length) return original.call(this, gid);
    const buffer = this.glyphEncoder.encodeSimple(terminatedPath(glyph.path), []);
    this.glyf.push(buffer);
    this.loca.offsets.push(this.offset);
    this.hmtx.metrics.push({ advance: glyph.advanceWidth, bearing: glyph._getMetrics().leftBearing });
    this.offset += buffer.length;
    return this.glyf.length - 1;
  };
  proto.__woff2Safe = true;
}

let fontBytes = null;
async function loadFontBytes() {
  fontBytes ??= Promise.all([readFile(`${FONT_DIR}alexandria-arabic.woff2`), readFile(`${FONT_DIR}manrope-latin.woff2`)]);
  return fontBytes;
}

/** Bidi class used here: R (Arabic letters), L (other letters), EN (digits), WS, ON (other neutrals). */
function bidiClass(ch) {
  if (ARABIC.test(ch)) return "R";
  if (DIGIT.test(ch)) return "EN";
  if (LETTER.test(ch)) return "L";
  if (/\s/.test(ch)) return "WS";
  return "ON";
}

/** Logical runs `{ text, level }` for one line. Paragraph level follows the first strong character (default RTL). */
export function bidiRuns(line, baseRtl = null) {
  const chars = [...line];
  if (!chars.length) return { rtl: baseRtl ?? true, runs: [] };
  const types = chars.map(bidiClass);
  const firstStrong = types.find((t) => t === "R" || t === "L");
  const rtl = baseRtl ?? (firstStrong ? firstStrong === "R" : true);
  // Number separators and affixes joined to digits behave as part of the number (12:30, 3.5, 42%, 2026-10-25).
  for (let i = 0; i < types.length; i++) {
    if (types[i] !== "ON" && types[i] !== "WS") continue;
    const ch = chars[i];
    if (NUMBER_JOINER.test(ch) && types[i - 1] === "EN" && types[i + 1] === "EN") types[i] = "EN";
    else if (NUMBER_AFFIX.test(ch) && (types[i - 1] === "EN" || types[i + 1] === "EN")) types[i] = "EN";
  }
  // W7: a number whose preceding strong character is Latin is treated as Latin; after Arabic it stays a number that
  // is embedded in the Arabic run (W2/I1: level 2), also inside a left-to-right paragraph.
  let lastStrong = rtl ? "R" : "L";
  const afterArabic = new Array(types.length).fill(false);
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "R" || types[i] === "L") lastStrong = types[i];
    else if (types[i] === "EN") { if (lastStrong === "L") types[i] = "L"; else afterArabic[i] = true; }
  }
  // Strong direction for neutral resolution: numbers count as R.
  const strongAt = (i) => (types[i] === "L" ? "L" : types[i] === "R" || types[i] === "EN" ? "R" : null);
  const levels = new Array(types.length);
  const base = rtl ? 1 : 0;
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    if (t === "R") levels[i] = 1;
    else if (t === "L") levels[i] = rtl ? 2 : 0;
    else if (t === "EN") levels[i] = rtl || afterArabic[i] ? 2 : 0;
    else {
      let before = null, after = null;
      for (let j = i - 1; j >= 0 && !before; j--) before = strongAt(j);
      for (let j = i + 1; j < types.length && !after; j++) after = strongAt(j);
      before ??= rtl ? "R" : "L"; after ??= rtl ? "R" : "L";
      levels[i] = before === after ? (before === "L" ? (rtl ? 2 : 0) : 1) : base;
    }
  }
  const runs = [];
  for (let i = 0; i < chars.length; i++) {
    const last = runs.at(-1);
    if (last && last.level === levels[i]) last.text += chars[i];
    else runs.push({ text: chars[i], level: levels[i] });
  }
  return { rtl, runs };
}

/** L2 reordering at run granularity: returns runs in visual (left-to-right) order. */
export function visualOrder(runs) {
  const order = runs.map((run) => ({ ...run }));
  const max = Math.max(0, ...order.map((r) => r.level));
  const lowestOdd = order.reduce((min, r) => (r.level % 2 && r.level < min ? r.level : min), Infinity);
  for (let level = max; level >= Math.min(lowestOdd, max) && level >= 1; level--) {
    for (let i = 0; i < order.length;) {
      if (order[i].level < level) { i++; continue; }
      let j = i;
      while (j < order.length && order[j].level >= level) j++;
      const reversed = order.slice(i, j).reverse();
      order.splice(i, j - i, ...reversed);
      i = j;
    }
  }
  return order;
}

export async function createPdfWriter() {
  const [arabicBytes, latinBytes] = await loadFontBytes();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  patchWoff2Subsetter(fontkit.create(latinBytes));
  const arabic = await doc.embedFont(arabicBytes, { subset: true });
  const latin = await doc.embedFont(latinBytes, { subset: true });
  const arabicFace = arabic.embedder.font;
  const latinFace = latin.embedder.font;
  const fontFor = (ch) => (arabicFace.hasGlyphForCodePoint(ch.codePointAt(0)) && (ARABIC.test(ch) || !latinFace.hasGlyphForCodePoint(ch.codePointAt(0))) ? arabic : latin);

  /** Visual pieces of one run: same-font sub-runs; RTL runs reverse sub-run order and mirror/reverse Latin neutrals
   * (fontkit itself reverses Arabic glyphs). Characters missing from both fonts become "?" rather than blank boxes. */
  function pieces(run) {
    const rtl = run.level % 2 === 1;
    const parts = [];
    for (const raw of run.text) {
      const ch = arabicFace.hasGlyphForCodePoint(raw.codePointAt(0)) || latinFace.hasGlyphForCodePoint(raw.codePointAt(0)) ? raw : "?";
      const font = fontFor(ch);
      const last = parts.at(-1);
      if (last && last.font === font) last.text += ch;
      else parts.push({ font, text: ch });
    }
    if (!rtl) return parts;
    return parts.reverse().map((p) => (p.font === latin ? { ...p, text: [...p.text].reverse().map((c) => MIRROR[c] ?? c).join("") } : p));
  }

  function layoutLine(line, size, baseRtl = null) {
    const { rtl, runs } = bidiRuns(line, baseRtl);
    const visual = visualOrder(runs).flatMap(pieces).map((p) => ({ ...p, width: p.font.widthOfTextAtSize(p.text, size) }));
    return { rtl, visual, width: visual.reduce((sum, p) => sum + p.width, 0) };
  }

  function wrap(text, size, maxWidth) {
    const lines = [];
    for (const paragraph of String(text ?? "").replace(/\r/g, "").split("\n")) {
      const words = paragraph.split(/ +/).filter(Boolean);
      if (!words.length) { lines.push(""); continue; }
      let current = "";
      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (current && layoutLine(candidate, size).width > maxWidth) { lines.push(current); current = word; }
        else current = candidate;
      }
      lines.push(current);
    }
    return lines;
  }

  let page = null;
  let y = 0;
  const pages = [];
  const width = A4[0] - MARGIN * 2;
  const newPage = () => { page = doc.addPage(A4); pages.push(page); y = A4[1] - MARGIN; };
  const ensure = (height) => { if (!page || y - height < MARGIN + 18) newPage(); };

  /** Draws one line; `align` "auto" follows the paragraph direction (right for Arabic). */
  function drawLine(line, { size = 11, color = rgb(0.12, 0.1, 0.2), align = "auto", x0 = MARGIN, boxWidth = width, baseRtl = null } = {}) {
    const laid = layoutLine(line, size, baseRtl);
    const right = align === "right" || (align === "auto" && laid.rtl);
    let x = align === "center" ? x0 + (boxWidth - laid.width) / 2 : right ? x0 + boxWidth - laid.width : x0;
    for (const piece of laid.visual) { page.drawText(piece.text, { x, y, size, font: piece.font, color }); x += piece.width; }
    return laid.width;
  }

  function paragraph(text, { size = 11, color, gap = 4, indent = 0 } = {}) {
    for (const line of wrap(text, size, width - indent)) {
      ensure(size + gap);
      y -= size + gap;
      drawLine(line, { size, color, boxWidth: width - indent });
    }
  }

  function heading(text, { size = 15 } = {}) {
    ensure(size + 26);
    y -= 14;
    paragraph(text, { size, color: rgb(0.36, 0.16, 0.82), gap: 6 });
    page.drawLine({ start: { x: MARGIN, y: y - 6 }, end: { x: A4[0] - MARGIN, y: y - 6 }, thickness: 0.6, color: rgb(0.85, 0.82, 0.95) });
    y -= 10;
  }

  /** Right-to-left table: the first column is drawn at the right edge. Cells are single-line and clipped by width. */
  function table(columns, rows, { size = 9.5 } = {}) {
    const total = columns.reduce((s, c) => s + c.weight, 0);
    const widths = columns.map((c) => (c.weight / total) * width);
    const rowHeight = size + 9;
    const fit = (value, w) => {
      let textValue = String(value ?? "—");
      while (textValue.length > 1 && layoutLine(textValue, size).width > w - 8) textValue = `${[...textValue].slice(0, -2).join("")}…`;
      return textValue;
    };
    const drawRow = (cells, header) => {
      ensure(rowHeight);
      y -= rowHeight;
      if (header) page.drawRectangle({ x: MARGIN, y: y - 4, width, height: rowHeight, color: rgb(0.95, 0.93, 1) });
      let right = A4[0] - MARGIN;
      cells.forEach((cell, i) => {
        const w = widths[i];
        drawLine(fit(cell, w), { size, x0: right - w + 4, boxWidth: w - 8, align: "right", color: header ? rgb(0.3, 0.15, 0.7) : undefined });
        right -= w;
      });
    };
    drawRow(columns.map((c) => c.label), true);
    for (const r of rows) drawRow(r, false);
    y -= 6;
  }

  function spacer(height = 8) { y -= height; }

  async function finish({ title = "", footer = "" } = {}) {
    doc.setTitle(title);
    doc.setCreator("ABUD FUN Company OS");
    doc.setProducer("ABUD FUN Company OS (pdf-lib)");
    doc.setLanguage("ar");
    pages.forEach((p, index) => {
      page = p; y = MARGIN - 20;
      drawLine(`${footer} · صفحة ${index + 1} من ${pages.length}`, { size: 8, color: rgb(0.45, 0.42, 0.55), align: "center" });
    });
    return doc.save();
  }

  newPage();
  return { heading, paragraph, table, spacer, drawLine, finish, layoutLine };
}
