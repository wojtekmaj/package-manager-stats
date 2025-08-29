const DEBUG = process.env.DEBUG === 'true';

export function log(...args: unknown[]): void {
  if (DEBUG) {
    console.log(...args);
  }
}

export function info(...args: unknown[]): void {
  console.info(...args);
}
