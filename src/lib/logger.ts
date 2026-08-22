/**
 * Structured JSON logging.
 *
 * One line per event, machine-parseable, so a deployed instance can be diagnosed from log
 * search instead of guesswork. The redaction pass is the important part: this app holds
 * Alpaca keys and an Anthropic key, and a log line is the easiest place in a system to leak
 * one by accident.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const SECRET_KEY_PATTERN = /^(.*(key|secret|token|password|authorization|cookie).*)$/i;

/** Values that look like credentials regardless of the field they arrived in. */
const SECRET_VALUE_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bPK[A-Z0-9]{16,}\b/g,
  /\bAK[A-Z0-9]{16,}\b/g,
];

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") {
    return SECRET_VALUE_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[redacted]"), value);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...(redact(fields) as Record<string, unknown>),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * Wraps a route handler with a request id, duration and outcome logging. The request id is
 * echoed to the client so a user-reported problem can be found in the logs.
 */
export async function withRequestLog(
  event: string,
  request: Request,
  handler: (requestId: string) => Promise<Response>,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  try {
    const response = await handler(requestId);
    log(response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info", event, {
      requestId,
      method: request.method,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    response.headers.set("x-request-id", requestId);
    return response;
  } catch (error) {
    log("error", event, {
      requestId,
      method: request.method,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "unknown",
    });
    throw error;
  }
}
