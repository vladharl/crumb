// Structured, leveled logger. One JSON object per line on stdout/stderr so
// container log drivers (Docker, Loki, CloudWatch, Datadog) can parse it
// without a regex. Replaces the ad-hoc `console.*` + `[crumb/*]` tag calls.
//
// Level via CRUMB_LOG_LEVEL (debug | info | warn | error); defaults to
// "debug" in development and "info" otherwise.
//
// Error reporting is an optional seam: when SENTRY_DSN is set, log.error()
// also forwards the Error to Sentry. When it's unset (the self-host default)
// the reporter is a no-op and @sentry/node is never loaded — no dependency
// is forced on self-host.

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = process.env.CRUMB_LOG_LEVEL?.trim().toLowerCase() as Level | undefined;
  if (raw && raw in ORDER) return ORDER[raw];
  return process.env.NODE_ENV === "production" ? ORDER.info : ORDER.debug;
}

type Fields = Record<string, unknown> & { err?: unknown };

function serializeErr(err: unknown): Record<string, unknown> | undefined {
  if (err == null) return undefined;
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

function emit(level: Level, msg: string, fields?: Fields): void {
  if (ORDER[level] < threshold()) return;
  const { err, ...rest } = fields ?? {};
  const record: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    msg,
    ...rest,
  };
  const serialized = serializeErr(err);
  if (serialized) record.err = serialized;

  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") {
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }

  if (level === "error" && err != null) {
    void captureException(err, rest);
  }
}

export const log = {
  debug: (msg: string, fields?: Fields) => emit("debug", msg, fields),
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};

// ─── optional Sentry error reporting ─────────────────────────────────────

let sentryReady: Promise<{ captureException: (e: unknown, ctx?: unknown) => void } | null> | null = null;

function loadSentry() {
  if (sentryReady) return sentryReady;
  sentryReady = (async () => {
    const dsn = process.env.SENTRY_DSN?.trim();
    if (!dsn) return null;
    try {
      // String-typed specifier + webpackIgnore: neither tsc nor webpack
      // tries to resolve an optional peer that self-host installs may not
      // have. Cloud adds @sentry/node as a dependency.
      const specifier: string = "@sentry/node";
      const Sentry = (await import(/* webpackIgnore: true */ specifier)) as {
        init: (opts: Record<string, unknown>) => void;
        captureException: (e: unknown, hint?: { extra?: Record<string, unknown> }) => void;
      };
      Sentry.init({ dsn, environment: process.env.CRUMB_TIER ?? process.env.NODE_ENV });
      return {
        captureException: (e: unknown, ctx?: unknown) =>
          Sentry.captureException(e, ctx ? { extra: ctx as Record<string, unknown> } : undefined),
      };
    } catch {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        time: new Date().toISOString(),
        level: "warn",
        msg: "SENTRY_DSN set but @sentry/node not installed, so error reporting is disabled",
      }));
      return null;
    }
  })();
  return sentryReady;
}

export async function captureException(err: unknown, context?: Record<string, unknown>): Promise<void> {
  const sentry = await loadSentry();
  sentry?.captureException(err, context);
}
