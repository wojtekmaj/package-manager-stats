import fs from 'node:fs';
import { asyncForEach, asyncForEachStrict } from '@wojtekmaj/async-array-utils';
import chalk from 'chalk';

const CACHE_DIR = '.cache';
const GITHUB_API_URL = 'https://api.github.com';
// Each GitHub search results page has 30 items, we can fetch 1000 results with 34 requests
const MAX_PAGES = 34;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DEBUG = process.env.DEBUG === 'true';

if (!GITHUB_TOKEN) {
  throw new Error('GITHUB_TOKEN environment variable must be set');
}

function log(...args: unknown[]) {
  if (DEBUG) {
    console.log(...args);
  }
}

function info(...args: unknown[]) {
  console.info(...args);
}

type SearchResult = {
  full_name: string;
  url: string;
  html_url: string;
  stargazers_count: number;
};

type SearchResultsPage = {
  items: SearchResult[];
};

class NetworkError extends Error {
  status: number;

  constructor(status: number, statusText: string) {
    super(statusText);
    this.name = 'NetworkError';
    this.status = status;
  }
}

/**
 * Fetches a URL and caches it in the .cache directory. On subsequent calls, it
 * will return the cached version if it exists.
 */
async function fetchWithCache(input: string | URL, init?: RequestInit): Promise<string> {
  // log(chalk.gray`Getting %s…`, input);

  const cacheKey = input
    .toString()
    .replace(/[^a-z0-9]/gi, '_')
    .toLowerCase();
  const cachePath = `${CACHE_DIR}/fetch/${cacheKey}`;
  const cacheExists = fs.existsSync(cachePath);

  // If the cache exists, return it
  if (cacheExists) {
    // log(chalk.gray`  Retrieving from cache`);
    const cachedFile = fs.readFileSync(cachePath, 'utf-8');

    return cachedFile;
  }

  // Otherwise, fetch the URL
  // log(chalk.gray`  Fetching from network`, input);
  const response = await fetch(input, init);

  if (!response.ok) {
    throw new NetworkError(response.status, response.statusText);
  }

  const requestText = await response.text();

  // Ensure the cache directory exists
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Write the response to the cache
  fs.writeFileSync(cachePath, requestText);

  return requestText;
}

const results: SearchResultsPage[] = [];

await (DEBUG ? asyncForEachStrict : asyncForEach)(
  Array.from({ length: MAX_PAGES }),
  async (_, i) => {
    const currentPage = i + 1;
    log(chalk.gray`Fetching JavaScript page %s…`, currentPage);

    const url = new URL(`${GITHUB_API_URL}/search/repositories`);
    url.searchParams.set('q', 'stars:>1 language:JavaScript');
    url.searchParams.set('sort', 'stars');
    url.searchParams.set('page', currentPage.toString());

    const rawResponse = await fetchWithCache(url, {
      headers: {
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
      },
    });

    const response = JSON.parse(rawResponse) as SearchResultsPage;

    results.push(response);
  },
);

await (DEBUG ? asyncForEachStrict : asyncForEach)(
  Array.from({ length: MAX_PAGES }),
  async (_, i) => {
    const currentPage = i + 1;
    log(chalk.gray`Fetching TypeScript page %s…`, currentPage);

    const url = new URL(`${GITHUB_API_URL}/search/repositories`);
    url.searchParams.set('q', 'stars:>1 language:TypeScript');
    url.searchParams.set('sort', 'stars');
    url.searchParams.set('page', currentPage.toString());

    const rawResponse = await fetchWithCache(url, {
      headers: {
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
      },
    });

    const response = JSON.parse(rawResponse) as SearchResultsPage;

    results.push(response);
  },
);

const flattenedResults = results
  .flatMap((page) => page.items)
  .map((item) => ({
    name: item.full_name,
    url: item.html_url,
  }));

const stats = {
  total: flattenedResults.length,
  nodejs: 0,
  non_nodejs: 0,
  uses_corepack: 0,
  does_not_use_corepack: 0,
  has_lockfile: 0,
  does_not_have_lockfile: 0,
};

const packageManagerStats = {
  npm: 0,
  yarn_classic: 0,
  yarn_modern: 0,
  pnpm: 0,
  bun: 0,
  unknown: 0,
};

const fileExistsStatsPath = `${CACHE_DIR}/file-exists-stats.json`;
const fileExistsStats: Record<string, boolean> = fs.existsSync(fileExistsStatsPath)
  ? (JSON.parse(fs.readFileSync(fileExistsStatsPath, 'utf-8')) as Record<string, boolean>)
  : {};

async function checkIfFileExists(resultName: string, filename: string): Promise<boolean> {
  const url = `https://raw.githubusercontent.com/${resultName}/master/${filename}`;

  if (url in fileExistsStats) {
    const result = fileExistsStats[url];

    if (typeof result === 'boolean') {
      if (result) {
        log(chalk.gray`  Found %s`, filename);
      } else {
        log(chalk.gray`  No %s found`, filename);
      }

      return result;
    }
  }

  const response = await fetch(
    `https://raw.githubusercontent.com/${resultName}/master/${filename}`,
    {
      method: 'HEAD',
    },
  );

  if (response.ok) {
    log(chalk.gray`  Found %s`, filename);
    fileExistsStats[url] = true;
    fs.writeFileSync(fileExistsStatsPath, JSON.stringify(fileExistsStats));
    return true;
  } else {
    if (response.status === 404) {
      log(chalk.gray`  No %s found`, filename);
      fileExistsStats[url] = false;
      fs.writeFileSync(fileExistsStatsPath, JSON.stringify(fileExistsStats));
      return false;
    }

    throw new NetworkError(response.status, response.statusText);
  }
}

/**
 * Check if packageManager is present in package.json. If present, count as whatever is specified.
 * Check for package-lock.json. If present, count as npm.
 * Check for yarn.lock, and…
 *   Check for .yarnrc.yml. If present, count as Yarn Modern.
 *   If not, count as Yarn Classic.
 * Check for pnpm-lock.yaml. If present, count as pnpm.
 * Check for bun.lockb. If present, count as bun.
 */
await (DEBUG ? asyncForEachStrict : asyncForEach)(flattenedResults, async (result) => {
  log(chalk.bold(result.name));

  const packageJsonExists = await checkIfFileExists(result.name, 'package.json');

  if (!packageJsonExists) {
    log(chalk.white`  Non-Node.js project`);
    stats.non_nodejs++;
    return;
  }

  stats.nodejs++;

  let rawPackageJson;
  try {
    // https://raw.githubusercontent.com/aanand/git-up/master/LICENSE
    rawPackageJson = await fetchWithCache(
      `https://raw.githubusercontent.com/${result.name}/master/package.json`,
    );
  } catch (error) {
    if (error instanceof NetworkError && error.status === 404) {
      log(chalk.gray`  No package.json found`);
      return;
    }

    throw error;
  }

  let packageJson;
  try {
    packageJson = JSON.parse(rawPackageJson);
  } catch (error) {
    log(chalk.red`  Invalid package.json`);
  }

  if (packageJson) {
    if ('packageManager' in packageJson) {
      log(chalk.gray`    Found packageManager`);
      stats.uses_corepack++;

      if (packageJson.packageManager.match(/npm/i)) {
        log(chalk.green`  npm detected`);
        packageManagerStats.npm++;
        return;
      }

      if (packageJson.packageManager.match(/yarn@1/i)) {
        log(chalk.green`  Yarn Classic detected`);
        packageManagerStats.yarn_classic++;
        return;
      }

      if (packageJson.packageManager.match(/yarn@[2-9]/i)) {
        log(chalk.green`  Yarn Modern detected`);
        packageManagerStats.yarn_modern++;
        return;
      }

      if (packageJson.packageManager.match(/pnpm/i)) {
        log(chalk.green`  pnpm detected`);
        packageManagerStats.pnpm++;
        return;
      }

      throw new Error('packageManager not recognized');
    } else {
      log(chalk.gray`    No packageManager found`);
      stats.does_not_use_corepack++;
    }
  }

  const packageLockJsonExists = await checkIfFileExists(result.name, 'package-lock.json');

  if (packageLockJsonExists) {
    log(chalk.green`  npm detected`);
    packageManagerStats.npm++;
    stats.has_lockfile++;
    return;
  }

  const npmShrinkwrapJsonExists = await checkIfFileExists(result.name, 'npm-shrinkwrap.json');

  if (npmShrinkwrapJsonExists) {
    log(chalk.green`  npm detected`);
    packageManagerStats.npm++;
    stats.has_lockfile++;
    return;
  }

  const yarnLockExists = await checkIfFileExists(result.name, 'yarn.lock');

  if (yarnLockExists) {
    stats.has_lockfile++;

    const yarnrcYmlExists = await checkIfFileExists(result.name, '.yarnrc.yml');

    if (yarnrcYmlExists) {
      log(chalk.green`  Yarn Modern detected`);
      packageManagerStats.yarn_modern++;
      return;
    } else {
      log(chalk.green`  Yarn Classic detected`);
      packageManagerStats.yarn_classic++;
      return;
    }
  }

  const pnpmLockYamlExists = await checkIfFileExists(result.name, 'pnpm-lock.yaml');

  if (pnpmLockYamlExists) {
    log(chalk.green`  pnpm detected`);
    packageManagerStats.pnpm++;
    stats.has_lockfile++;
    return;
  }

  const bunLockbExists = await checkIfFileExists(result.name, 'bun.lockb');

  if (bunLockbExists) {
    log(chalk.green`  bun detected`);
    packageManagerStats.bun++;
    stats.has_lockfile++;
    return;
  }

  log(chalk.red`  No package manager detected`);
  packageManagerStats.unknown++;
  stats.does_not_have_lockfile++;
});

info(stats);
info(packageManagerStats);
