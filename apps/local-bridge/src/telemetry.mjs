/* Local OpenTelemetry for NEX. Runs and tool calls become spans recorded by the OpenTelemetry SDK and exported only to
 * the company SQLite store (no network exporter is configured, so traces never leave this machine). Parent links are
 * passed explicitly, so no async context manager is installed. Attributes are allowlisted and redacted. */
import { context, trace, SpanStatusCode, SpanKind } from "@opentelemetry/api";
import { ExportResultCode, hrTimeToMilliseconds } from "@opentelemetry/core";
import { SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { redact } from "./util.mjs";

const ATTRIBUTE_KEYS = new Set(["abud.agent", "abud.tool", "abud.run", "abud.workflow", "abud.capability", "abud.outcome", "abud.error", "abud.model", "abud.provider", "abud.actor"]);

class SqliteSpanExporter {
  constructor(db) { this.db = db; this.stopped = false; }
  export(spans, done) {
    if (this.stopped) { done({ code: ExportResultCode.FAILED }); return; }
    try {
      for (const span of spans) {
        const attrs = {};
        for (const [key, value] of Object.entries(span.attributes || {})) if (ATTRIBUTE_KEYS.has(key)) attrs[key] = typeof value === "string" ? redact(value, 160) : value;
        const ctx = span.spanContext();
        this.db.run(`INSERT OR IGNORE INTO telemetry_spans (span_id, trace_id, parent_span_id, name, kind, start_at, duration_ms, status, agent_id, tool_id, run_id, attributes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          ctx.spanId, ctx.traceId, span.parentSpanContext?.spanId ?? null, span.name.slice(0, 120), SpanKind[span.kind] ?? null,
          new Date(hrTimeToMilliseconds(span.startTime)).toISOString(), Math.round(hrTimeToMilliseconds(span.duration) * 100) / 100,
          span.status?.code === SpanStatusCode.ERROR ? "error" : "ok", attrs["abud.agent"] ?? null, attrs["abud.tool"] ?? null, attrs["abud.run"] ?? null, JSON.stringify(attrs));
      }
      done({ code: ExportResultCode.SUCCESS });
    } catch (_) {
      // Telemetry must never break a run; a failed write is dropped.
      done({ code: ExportResultCode.FAILED });
    }
  }
  shutdown() { this.stopped = true; return Promise.resolve(); }
  forceFlush() { return Promise.resolve(); }
}

export function createTelemetry({ db, now = Date.now }) {
  const exporter = new SqliteSpanExporter(db);
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const tracer = provider.getTracer("abud-company-os", "5.0");

  /** Starts a span, optionally as a child of `parent` (a span returned earlier). */
  function start(name, attributes = {}, parent = null) {
    const ctx = parent ? trace.setSpan(context.active(), parent) : context.active();
    return tracer.startSpan(name, { attributes: Object.fromEntries(Object.entries(attributes).filter(([, v]) => v != null)) }, ctx);
  }
  function end(span, { ok = true, error = null, attributes = {} } = {}) {
    if (!span) return;
    for (const [key, value] of Object.entries(attributes)) if (value != null) span.setAttribute(key, value);
    if (!ok) { span.setStatus({ code: SpanStatusCode.ERROR, message: error ? String(error).slice(0, 120) : undefined }); if (error) span.setAttribute("abud.error", String(error).slice(0, 80)); }
    else span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  }
  function recent({ runId = null, limit = 50 } = {}) {
    const rows = runId
      ? db.all("SELECT * FROM telemetry_spans WHERE trace_id IN (SELECT trace_id FROM telemetry_spans WHERE run_id = ?) ORDER BY start_at LIMIT ?", runId, limit)
      : db.all("SELECT * FROM telemetry_spans ORDER BY start_at DESC LIMIT ?", limit);
    return rows.map((r) => ({ spanId: r.span_id, traceId: r.trace_id, parentSpanId: r.parent_span_id, name: r.name, startAt: r.start_at, durationMs: r.duration_ms, status: r.status, agentId: r.agent_id, toolId: r.tool_id, runId: r.run_id, attributes: JSON.parse(r.attributes) }));
  }
  function prune(days) {
    return db.run("DELETE FROM telemetry_spans WHERE start_at < ?", new Date(now() - days * 86_400_000).toISOString()).changes;
  }
  return { start, end, recent, prune, shutdown: () => provider.shutdown() };
}
