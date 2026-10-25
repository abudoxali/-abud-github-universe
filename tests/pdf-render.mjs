/* Renders PDF pages to PNG with pdf.js inside Chromium so generated reports can be inspected visually (Arabic shaping and
 * direction, clipping) and their extracted text checked. Fully offline: pdf.js is served from the bridge's dev
 * dependency on a loopback port.
 * Usage: node tests/pdf-render.mjs <file.pdf> <out-prefix> [maxPages]  → <out-prefix>-1.png …, prints JSON text summary. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium } from "playwright";

export async function renderPdf(pdfPath, outPrefix, maxPages = 3) {
  const pdfjsDir = resolve("apps/local-bridge/node_modules/pdfjs-dist/build");
  const pdfBytes = await readFile(pdfPath);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/doc.pdf") { res.writeHead(200, { "Content-Type": "application/pdf" }); return res.end(pdfBytes); }
    if (/^\/pdf(\.worker)?\.min\.mjs$/.test(url.pathname)) { res.writeHead(200, { "Content-Type": "text/javascript" }); return res.end(await readFile(join(pdfjsDir, url.pathname.slice(1)))); }
    if (url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<!doctype html><body style='margin:0;background:#888'></body>"); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1.5 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/`);
    const summary = await page.evaluate(async ({ base, maxPages }) => {
      const pdfjs = await import(`${base}/pdf.min.mjs`);
      pdfjs.GlobalWorkerOptions.workerSrc = `${base}/pdf.worker.min.mjs`;
      const doc = await pdfjs.getDocument({ url: `${base}/doc.pdf` }).promise;
      const pages = [];
      for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
        const p = await doc.getPage(n);
        const viewport = p.getViewport({ scale: 1.4 });
        const canvas = document.createElement("canvas");
        canvas.id = `page-${n}`; canvas.width = viewport.width; canvas.height = viewport.height;
        canvas.style.display = "block"; canvas.style.marginBottom = "8px";
        document.body.appendChild(canvas);
        await p.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const content = await p.getTextContent();
        pages.push({ n, chars: content.items.reduce((s, i) => s + i.str.length, 0), sample: content.items.slice(0, 6).map((i) => i.str) });
      }
      return { numPages: doc.numPages, pages };
    }, { base, maxPages });
    const shots = [];
    for (const p of summary.pages) {
      const file = `${outPrefix}-${p.n}.png`;
      await page.locator(`#page-${p.n}`).screenshot({ path: file });
      shots.push(file);
    }
    return { ...summary, shots, errors };
  } finally {
    await browser.close();
    server.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve("tests/pdf-render.mjs")) {
  const [pdf, out, max] = process.argv.slice(2);
  console.log(JSON.stringify(await renderPdf(pdf, out, Number(max) || 3), null, 1));
}
