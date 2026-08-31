import { execFile } from "node:child_process";
import { promisify } from "node:util";

export async function run(command, args, options = {}) {
  try {
    return await promisify(execFile)(command, args, {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const details = String(error.stderr || error.stdout || error.message).slice(
      -8_000,
    );
    throw new Error(
      `${command} failed (${error.code ?? error.signal ?? "unknown"}):\n${details}`,
    );
  }
}

export function toolEnvironment(cacheDirectory) {
  // Public dependency tooling does not need the caller's registry credentials.
  return {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    CI: "true",
    NPM_CONFIG_USERCONFIG: `${cacheDirectory}/empty-user.npmrc`,
    NPM_CONFIG_GLOBALCONFIG: `${cacheDirectory}/empty-global.npmrc`,
    NPM_CONFIG_CACHE: cacheDirectory,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  };
}
