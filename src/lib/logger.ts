import { getLogLevel } from "@/config/envConfig";

export type LogLevel = "debug" | "info" | "warn" | "error" | "none";

type ConsoleMethod = "debug" | "log" | "warn" | "error";
type WritableLevel = Exclude<LogLevel, "none">;

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
};

interface LevelController {
  level: LogLevel;
}

export interface Logger {
  level: LogLevel;
  readonly scope: string[];
  debug(...args: unknown[]): void;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  shouldLog(level: LogLevel): boolean;
  getLevel(): LogLevel;
  setLevel(level: LogLevel): void;
  forScope(scope: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  scope?: string | string[];
}

class LoggerImpl implements Logger {
  #controller: LevelController;
  readonly scope: string[];

  constructor(controller: LevelController, scope: string[]) {
    this.#controller = controller;
    this.scope = scope;
  }

  get level(): LogLevel {
    return this.#controller.level;
  }

  set level(level: LogLevel) {
    this.setLevel(level);
  }

  debug(...args: unknown[]): void {
    this.#write("debug", args);
  }

  log(...args: unknown[]): void {
    this.#write("info", args, "log");
  }

  warn(...args: unknown[]): void {
    this.#write("warn", args);
  }

  error(...args: unknown[]): void {
    this.#write("error", args);
  }

  shouldLog(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.level];
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setLevel(level: LogLevel): void {
    if (!(level in LEVEL_RANK)) {
      return;
    }
    this.#controller.level = level;
  }

  forScope(scope: string): Logger {
    const normalized = scope.trim();
    const nextScope = normalized ? [...this.scope, normalized] : this.scope;
    return new LoggerImpl(this.#controller, nextScope);
  }

  #write(
    level: WritableLevel,
    args: unknown[],
    methodOverride?: ConsoleMethod
  ): void {
    if (!this.shouldLog(level)) return;

    const method: ConsoleMethod =
      methodOverride ?? (level === "info" ? "log" : level);
    const prefix = this.scope.length ? `[${this.scope.join(":")}]` : undefined;
    const values = prefix ? [prefix, ...args] : args;
    console[method](...values);
  }
}

export function createLogger(options?: LoggerOptions): Logger {
  const controller: LevelController = {
    level: options?.level ?? getLogLevel(),
  };
  const scope = Array.isArray(options?.scope)
    ? options.scope.map((s) => String(s))
    : options?.scope
      ? [String(options.scope)]
      : [];
  return new LoggerImpl(controller, scope);
}

// -----------------------------------------------------------------------------
// App scoped logger - initializes from env config
// -----------------------------------------------------------------------------

const appLevelController: LevelController = {
  level: getLogLevel(),
};

const appRootLogger = new LoggerImpl(appLevelController, []);

export const appBaseLogger = appRootLogger.forScope("App");
