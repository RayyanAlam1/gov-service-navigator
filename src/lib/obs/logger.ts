/**
 * Structured logging.
 *
 * pino, with a redaction list that is not optional. This system handles CNIC
 * numbers, passport numbers and phone numbers by design; a log line is the
 * easiest place in a codebase to accidentally persist one forever.
 */
import pino from 'pino';
import { getConfig } from '@/lib/config/env';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'apiKey',
  'api_key',
  'key',
  '*.cnic',
  '*.cnic_number',
  '*.passport_number',
  '*.phone',
  'extracted_fields',
  'extractedFields',
  'answers.cnic_number',
  'rawText',
  'raw_text',
];

function create(): pino.Logger {
  const cfg = getConfig();
  const pretty = !cfg.isProduction && process.env.NO_PRETTY_LOGS !== '1';

  return pino({
    level: cfg.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { app: 'gov-service-navigator', env: cfg.APP_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,app,env' },
          },
        }
      : {}),
  });
}

let root: pino.Logger | null = null;

export function logger(): pino.Logger {
  if (!root) {
    try {
      root = create();
    } catch {
      // pino-pretty is a devDependency; in a slimmed production image the
      // transport may be absent. Logging must never be the thing that breaks.
      root = pino({ level: getConfig().LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: '[redacted]' } });
    }
  }
  return root;
}

/** Child logger bound to a request/turn identifier. */
export function loggerFor(bindings: Record<string, unknown>): pino.Logger {
  return logger().child(bindings);
}

export type Logger = pino.Logger;
