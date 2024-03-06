import fs from 'node:fs';
import { asyncForEach, asyncForEachStrict } from '@wojtekmaj/async-array-utils';
import chalk from 'chalk';
import semver from 'semver';

const CACHE_DIR = '.cache';
const GITHUB_API_URL = 'https://api.github.com';
// Default - most starred repositories, period
const QUERY = 'stars:>1';
// Alt 1 - repositories with 1000+ stars, created in the last year
// const oneYearAgo = new Date();
// oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
// oneYearAgo.setHours(0, 0, 0, 0);
// const QUERY = `stars:>1000 created:>${oneYearAgo.toISOString().slice(0, 10)}`;
// Alt 2 - repositories with 500+ stars, created in the last 6 months
// const sixMonthsAgo = new Date();
// sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
// sixMonthsAgo.setHours(0, 0, 0, 0);
// const QUERY = `stars:>500 created:>${sixMonthsAgo.toISOString().slice(0, 10)}`;
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
  default_branch: string;
  stargazers_count: number;
};

type SearchResultsPage = {
  total_count: number;
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
  fs.mkdirSync(`${CACHE_DIR}/fetch`, { recursive: true });

  // Write the response to the cache
  fs.writeFileSync(cachePath, requestText);

  return requestText;
}

const results: SearchResultsPage[] = [];

let totalJavaScriptPages: number | undefined = undefined;

for (let i = 0; i < MAX_PAGES; i++) {
  const currentPage = i + 1;

  if (totalJavaScriptPages) {
    if (currentPage > totalJavaScriptPages) {
      break;
    }

    log(chalk.gray`Fetching JavaScript page %s/%s…`, currentPage, totalJavaScriptPages);
  } else {
    log(chalk.gray`Fetching JavaScript page %s…`, currentPage);
  }

  const url = new URL(`${GITHUB_API_URL}/search/repositories`);
  url.searchParams.set('q', `${QUERY} language:JavaScript`);
  url.searchParams.set('sort', 'stars');
  url.searchParams.set('page', currentPage.toString());

  const rawResponse = await fetchWithCache(url, {
    headers: {
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
    },
  });

  const response = JSON.parse(rawResponse) as SearchResultsPage;

  results.push(response);

  totalJavaScriptPages = Math.ceil(response.total_count / 30);

  if (results.length === response.total_count) {
    break;
  }
}

let totalTypeScriptPages: number | undefined = undefined;

for (let i = 0; i < MAX_PAGES; i++) {
  const currentPage = i + 1;

  if (totalTypeScriptPages) {
    if (currentPage > totalTypeScriptPages) {
      break;
    }

    log(chalk.gray`Fetching TypeScript page %s/%s…`, currentPage, totalTypeScriptPages);
  } else {
    log(chalk.gray`Fetching TypeScript page %s…`, currentPage);
  }

  const url = new URL(`${GITHUB_API_URL}/search/repositories`);
  url.searchParams.set('q', `${QUERY} language:TypeScript`);
  url.searchParams.set('sort', 'stars');
  url.searchParams.set('page', currentPage.toString());

  const rawResponse = await fetchWithCache(url, {
    headers: {
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
    },
  });

  const response = JSON.parse(rawResponse) as SearchResultsPage;

  results.push(response);

  totalTypeScriptPages = Math.ceil(response.total_count / 30);

  if (results.length === response.total_count) {
    break;
  }
}

const flattenedResults = results
  .flatMap((page) => page.items)
  .map((item) => ({
    name: item.full_name,
    url: item.html_url,
    default_branch: item.default_branch,
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

const packageManagerVersionStats = {
  npm: {},
  yarn_classic: {},
  yarn_modern: {},
  pnpm: {},
  bun: {},
};

const fileExistsStatsPath = `${CACHE_DIR}/file-exists-stats.json`;
const fileExistsStats: Record<string, boolean> = fs.existsSync(fileExistsStatsPath)
  ? (JSON.parse(fs.readFileSync(fileExistsStatsPath, 'utf-8')) as Record<string, boolean>)
  : {};

async function checkIfFileExists(
  resultName: string,
  branch: string,
  filename: string,
): Promise<boolean> {
  const url = `https://raw.githubusercontent.com/${resultName}/${branch}/${filename}`;

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
    `https://raw.githubusercontent.com/${resultName}/${branch}/${filename}`,
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
 *   Check for "# yarn lockfile v1". If present, count as Yarn Classic. If not, count as Yarn Modern.
 * Check for pnpm-lock.yaml. If present, count as pnpm.
 * Check for bun.lockb. If present, count as bun.
 */
await (DEBUG ? asyncForEachStrict : asyncForEach)(flattenedResults, async (result, index) => {
  log(chalk.bold(result.name) + ' ' + chalk.gray`(%s/%s)`, index + 1, flattenedResults.length);

  const branch = result.default_branch;

  const packageJsonExists = await checkIfFileExists(result.name, branch, 'package.json');

  if (!packageJsonExists) {
    log(chalk.white`  Non-Node.js project`);
    stats.non_nodejs++;
    return;
  }

  stats.nodejs++;

  let rawPackageJson;
  try {
    rawPackageJson = await fetchWithCache(
      `https://raw.githubusercontent.com/${result.name}/${branch}/package.json`,
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

      const version = semver.major(packageJson.packageManager.match(/@(([0-9]\.?){1,})/)?.[1]);

      if (packageJson.packageManager.match(/npm/i)) {
        log(chalk.green`  npm detected`);
        packageManagerStats.npm++;
        const npmStats: Record<string, number> = packageManagerVersionStats.npm;
        npmStats[version] = (npmStats[version] ?? 0) + 1;
        return;
      }

      if (packageJson.packageManager.match(/yarn@1/i)) {
        log(chalk.green`  Yarn Classic detected`);
        packageManagerStats.yarn_classic++;
        const yarnClassicStats: Record<string, number> = packageManagerVersionStats.yarn_classic;
        yarnClassicStats[version] = (yarnClassicStats[version] ?? 0) + 1;
        return;
      }

      if (packageJson.packageManager.match(/yarn@[2-9]/i)) {
        log(chalk.green`  Yarn Modern detected`);
        packageManagerStats.yarn_modern++;
        const yarnModernStats: Record<string, number> = packageManagerVersionStats.yarn_modern;
        yarnModernStats[version] = (yarnModernStats[version] ?? 0) + 1;
        return;
      }

      if (packageJson.packageManager.match(/pnpm/i)) {
        log(chalk.green`  pnpm detected`);
        packageManagerStats.pnpm++;
        const pnpmStats: Record<string, number> = packageManagerVersionStats.pnpm;
        pnpmStats[version] = (pnpmStats[version] ?? 0) + 1;
        return;
      }

      throw new Error(`packageManager not recognized: ${packageJson.packageManager}`);
    } else {
      log(chalk.gray`    No packageManager found`);
      stats.does_not_use_corepack++;
    }
  }

  const packageLockJsonExists = await checkIfFileExists(result.name, branch, 'package-lock.json');

  if (packageLockJsonExists) {
    log(chalk.green`  npm detected`);
    packageManagerStats.npm++;
    stats.has_lockfile++;
    return;
  }

  const npmShrinkwrapJsonExists = await checkIfFileExists(
    result.name,
    branch,
    'npm-shrinkwrap.json',
  );

  if (npmShrinkwrapJsonExists) {
    log(chalk.green`  npm detected`);
    packageManagerStats.npm++;
    stats.has_lockfile++;
    return;
  }

  const yarnLockExists = await checkIfFileExists(result.name, branch, 'yarn.lock');

  if (yarnLockExists) {
    stats.has_lockfile++;

    const yarnrcYmlExists = await checkIfFileExists(result.name, branch, '.yarnrc.yml');

    if (yarnrcYmlExists) {
      log(chalk.green`  Yarn Modern detected`);
      packageManagerStats.yarn_modern++;
      return;
    } else {
      let yarnLock;
      try {
        yarnLock = await fetchWithCache(
          `https://raw.githubusercontent.com/${result.name}/${branch}/yarn.lock`,
        );
      } catch (error) {
        if (error instanceof NetworkError && error.status === 404) {
          log(chalk.gray`  No yarn.lock found`);
          return;
        }

        throw error;
      }

      if (yarnLock.match(/# yarn lockfile v1/i)) {
        log(chalk.green`  Yarn Classic detected`);
        packageManagerStats.yarn_classic++;
        return;
      } else {
        log(chalk.green`  Yarn Modern detected`);
        packageManagerStats.yarn_modern++;
        return;
      }
    }
  }

  const pnpmLockYamlExists = await checkIfFileExists(result.name, branch, 'pnpm-lock.yaml');

  if (pnpmLockYamlExists) {
    log(chalk.green`  pnpm detected`);
    packageManagerStats.pnpm++;
    stats.has_lockfile++;
    return;
  }

  const bunLockbExists = await checkIfFileExists(result.name, branch, 'bun.lockb');

  if (bunLockbExists) {
    log(chalk.green`  bun detected`);
    packageManagerStats.bun++;
    stats.has_lockfile++;
    return;
  }

  stats.does_not_have_lockfile++;

  // Check for package manager in scripts
  if (rawPackageJson) {
    if (rawPackageJson.match(/npm run/i)) {
      log(chalk.green`  npm detected`);
      packageManagerStats.npm++;
      return;
    }

    if (rawPackageJson.match(/yarn run/i)) {
      log(chalk.red`  Yarn detected, but not sure which version`);
      packageManagerStats.unknown++;
      return;
    }

    if (rawPackageJson.match(/pnpm run/i)) {
      log(chalk.green`  pnpm detected`);
      packageManagerStats.pnpm++;
      return;
    }

    if (rawPackageJson.match(/bun run/i)) {
      log(chalk.green`  bun detected`);
      packageManagerStats.bun++;
      return;
    }
  }

  // README.md intentionally omitted because it may contain installation instructions for
  // multiple package managers

  // CONTRIBUTING.md is generally intended for contributors, not users, so it's a better
  // indicator of the package manager used by the project
  const contributingMdExists = await checkIfFileExists(result.name, branch, 'CONTRIBUTING.md');

  if (contributingMdExists) {
    const contributingMd = await fetchWithCache(
      `https://raw.githubusercontent.com/${result.name}/${branch}/CONTRIBUTING.md`,
    );

    if (contributingMd.match(/npm i/i)) {
      log(chalk.green`  npm detected`);
      packageManagerStats.npm++;
      return;
    }

    if (contributingMd.match(/yarn add/i)) {
      log(chalk.red`  Yarn detected, but not sure which version`);
      packageManagerStats.unknown++;
      return;
    }

    if (contributingMd.match(/pnpm i/i)) {
      log(chalk.green`  pnpm detected`);
      packageManagerStats.pnpm++;
      return;
    }

    if (contributingMd.match(/bun i/i)) {
      log(chalk.green`  bun detected`);
      packageManagerStats.bun++;
      return;
    }
  }

  log(chalk.red`  No package manager detected`);
  packageManagerStats.unknown++;
});

const ymd = new Date().toISOString().slice(0, 10);

fs.writeFileSync(`results/${ymd}-stats.json`, JSON.stringify(stats, null, 2) + '\n');
info(stats);

fs.writeFileSync(
  `results/${ymd}-package-manager-stats.json`,
  JSON.stringify(packageManagerStats, null, 2) + '\n',
);
info(packageManagerStats);

fs.writeFileSync(
  `results/${ymd}-package-manager-version-stats.json`,
  JSON.stringify(packageManagerVersionStats, null, 2) + '\n',
);
info(packageManagerVersionStats);
