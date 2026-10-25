/* Bounded, SSRF-guarded HTTP(S) fetch for ZEN's approved-page extraction. Only exact owner-approved host names are
 * reachable, every resolved address must be public, the connection is pinned to the vetted address (no DNS rebinding
 * between check and connect), redirects are re-validated hop by hop, HTTPS never downgrades, and size, time and
 * decompression are bounded. Page content is returned as untrusted text; nothing in it is executed or obeyed. */
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { HttpError } from "./company.mjs";

// Separate lists: a BlockList IPv6 rule for ::ffff:0:0/96 would otherwise also match every IPv4 address.
const BLOCKED = new BlockList();
const BLOCKED6 = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4], ["255.255.255.255", 32]]) BLOCKED.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) BLOCKED6.addSubnet(net, prefix, "ipv6");
const TEXT_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|text\/markdown)\b/i;

const deny = (code, ar, status = 422) => { throw new HttpError(status, code, ar); };

/** True when the address may be contacted: public unicast only (IPv4-mapped IPv6 is judged as its IPv4 form). */
export function isPublicAddress(address) {
  const family = isIP(address);
  if (!family) return false;
  const mapped = family === 6 ? address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1] : null;
  if (mapped) return !BLOCKED.check(mapped, "ipv4");
  return family === 4 ? !BLOCKED.check(address, "ipv4") : !BLOCKED6.check(address, "ipv6");
}

/** Validates one hop's URL against the policy; returns the parsed URL. */
export function checkUrl(raw, allowHosts) {
  let url;
  try { url = new URL(raw); } catch (_) { deny("web-url-invalid", "الرابط غير صالح"); }
  if (!["http:", "https:"].includes(url.protocol)) deny("web-scheme", "يُسمح فقط بروابط http وhttps");
  if (url.username || url.password) deny("web-credentials", "لا يُسمح ببيانات دخول داخل الرابط");
  if (url.port && !((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80"))) deny("web-port", "يُسمح بالمنافذ الافتراضية فقط");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, ""))) deny("web-ip-literal", "استخدم اسم نطاق معتمدًا بدل عنوان IP");
  if (!allowHosts.includes(host)) deny("web-host-not-approved", `النطاق ${host} ليس ضمن المواقع المعتمدة من المالك`, 403);
  url.hash = "";
  return url;
}

/** Resolves the host and returns one vetted public address; fails closed if any answer is non-public. */
async function vet(host, lookupImpl) {
  let answers;
  try { answers = await lookupImpl(host, { all: true, verbatim: true }); } catch (_) { deny("web-dns", "تعذر حل اسم النطاق", 502); }
  if (!answers?.length) deny("web-dns", "تعذر حل اسم النطاق", 502);
  if (answers.some((a) => !isPublicAddress(a.address))) deny("web-private-address", "النطاق يشير إلى عنوان داخلي أو محجوز؛ رُفض الطلب", 403);
  return answers[0];
}

function decode(buffer, encoding, maxBytes) {
  const options = { maxOutputLength: maxBytes };
  if (!encoding || encoding === "identity") return buffer;
  if (encoding === "gzip" || encoding === "x-gzip") return zlib.gunzipSync(buffer, options);
  if (encoding === "deflate") return zlib.inflateSync(buffer, options);
  if (encoding === "br") return zlib.brotliDecompressSync(buffer, options);
  deny("web-encoding", "ترميز ضغط غير مدعوم", 502);
}

/** One request to a vetted address. Resolves to { status, headers, body (Buffer), truncated }. */
function requestOnce(url, address, { timeoutMs, maxBytes, signal, transport }) {
  return new Promise((resolve, reject) => {
    const lib = transport?.[url.protocol] ?? (url.protocol === "https:" ? https : http);
    const req = lib.request({
      protocol: url.protocol, hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: `${url.pathname}${url.search}`, method: "GET",
      headers: { "User-Agent": "ABUD-Company-OS/5 (ZEN; approved-source extraction)", Accept: "text/html,application/xhtml+xml,text/plain;q=0.9", "Accept-Encoding": "gzip, deflate, br", Connection: "close" },
      // The connection goes to the address that was vetted, never to a second DNS answer.
      lookup: (_host, options, callback) => (options?.all ? callback(null, [{ address: address.address, family: address.family }]) : callback(null, address.address, address.family)),
      timeout: timeoutMs, signal
    }, (res) => {
      const length = Number(res.headers["content-length"]);
      if (Number.isFinite(length) && length > maxBytes) { res.destroy(); reject(new HttpError(413, "web-too-large", "الصفحة أكبر من الحد المسموح")); return; }
      const chunks = [];
      let received = 0;
      let truncated = false;
      res.on("data", (chunk) => {
        if (truncated) return;
        received += chunk.length;
        if (received > maxBytes) { truncated = true; chunks.push(chunk.subarray(0, chunk.length - (received - maxBytes))); res.destroy(); return; }
        chunks.push(chunk);
      });
      const done = () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated });
      res.on("end", done);
      res.on("close", () => { if (truncated) done(); });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new HttpError(504, "web-timeout", "انتهت مهلة جلب الصفحة")));
    req.on("error", (error) => reject(error instanceof HttpError ? error : error?.name === "AbortError" ? new HttpError(499, "cancelled", "أُلغي الجلب") : new HttpError(502, "web-connect", "تعذر الاتصال بالموقع")));
    req.end();
  });
}

/**
 * Fetches one approved page. Returns { url (final), status, contentType, text, bytes, truncated, redirects, fetchedAt, etag }.
 * `lookupImpl` and `transport` are injectable for tests (no real network in the test suite).
 */
export async function safeFetch(raw, { allowHosts = [], maxBytes = 1_500_000, timeoutMs = 15_000, maxRedirects = 3, signal, lookupImpl = dnsLookup, transport } = {}) {
  let url = checkUrl(raw, allowHosts);
  const redirects = [];
  for (let hop = 0; ; hop++) {
    const address = await vet(url.hostname, lookupImpl);
    const res = await requestOnce(url, address, { timeoutMs, maxBytes, signal, transport });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop >= maxRedirects) deny("web-redirects", "عدد إعادات التوجيه تجاوز الحد", 502);
      const next = checkUrl(new URL(res.headers.location, url).href, allowHosts);
      if (url.protocol === "https:" && next.protocol !== "https:") deny("web-downgrade", "رُفضت إعادة توجيه من HTTPS إلى HTTP", 502);
      redirects.push(next.href);
      url = next;
      continue;
    }
    if (res.status < 200 || res.status >= 300) deny("web-status", `أعاد الموقع الحالة ${res.status}`, 502);
    const contentType = String(res.headers["content-type"] || "");
    if (!TEXT_TYPES.test(contentType)) deny("web-content-type", "نوع المحتوى ليس صفحة نصية أو HTML", 415);
    let body;
    try { body = decode(res.body, String(res.headers["content-encoding"] || "").toLowerCase().trim(), maxBytes); }
    catch (error) { if (error instanceof HttpError) throw error; deny("web-too-large", "المحتوى بعد فك الضغط أكبر من الحد المسموح", 413); }
    const truncated = res.truncated || body.length > maxBytes;
    if (body.length > maxBytes) body = body.subarray(0, maxBytes);
    const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1] || "utf-8";
    let text;
    try { text = new TextDecoder(charset, { fatal: false }).decode(body); } catch (_) { text = new TextDecoder("utf-8").decode(body); }
    return { url: url.href, status: res.status, contentType: contentType.split(";")[0].trim(), text, bytes: body.length, truncated, redirects, fetchedAt: new Date().toISOString(), etag: res.headers.etag ? String(res.headers.etag).slice(0, 200) : null };
  }
}
