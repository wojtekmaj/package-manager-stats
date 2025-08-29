import fs from 'node:fs';
import { styleText } from 'node:util';
import { asyncForEach, asyncForEachStrict } from '@wojtekmaj/async-array-utils';
import pRetry from 'p-retry';
import { parse as parseYaml } from 'yaml';

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
  // log(styleText('gray', `Getting ${input}…`));

  const cacheKey = input
    .toString()
    .replace(/[^a-z0-9]/gi, '_')
    .toLowerCase();
  const cachePath = `${CACHE_DIR}/fetch/${cacheKey}`;
  const cacheExists = fs.existsSync(cachePath);

  // If the cache exists, return it
  if (cacheExists) {
    // log(styleText('gray', `  Retrieving from cache`));
    const cachedFile = fs.readFileSync(cachePath, 'utf-8');

    return cachedFile;
  }

  // Otherwise, fetch the URL
  // log(styleText('gray', `  Fetching from network ${input}`));
  const response = await pRetry(() =>
    fetch(input, init).then((response) => {
      if (!response.ok) {
        throw new NetworkError(response.status, response.statusText);
      }

      return response;
    }),
  );

  const requestText = await response.text();

  // Ensure the cache directory exists
  fs.mkdirSync(`${CACHE_DIR}/fetch`, { recursive: true });

  // Write the response to the cache
  fs.writeFileSync(cachePath, requestText);

  return requestText;
}

const results: SearchResultsPage[] = [];

let totalJavaScriptPages: number | undefined;

for (let i = 0; i < MAX_PAGES; i++) {
  const currentPage = i + 1;

  if (totalJavaScriptPages) {
    if (currentPage > totalJavaScriptPages) {
      break;
    }

    log(styleText('gray', `Fetching JavaScript page ${currentPage}/${totalJavaScriptPages}…`));
  } else {
    log(styleText('gray', `Fetching JavaScript page ${currentPage}…`));
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

  totalJavaScriptPages = Math.min(Math.ceil(response.total_count / 30), MAX_PAGES);

  if (results.length === response.total_count) {
    break;
  }
}

let totalTypeScriptPages: number | undefined;

for (let i = 0; i < MAX_PAGES; i++) {
  const currentPage = i + 1;

  if (totalTypeScriptPages) {
    if (currentPage > totalTypeScriptPages) {
      break;
    }

    log(styleText('gray', `Fetching TypeScript page ${currentPage}/${totalTypeScriptPages}…`));
  } else {
    log(styleText('gray', `Fetching TypeScript page ${currentPage}…`));
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

  totalTypeScriptPages = Math.min(Math.ceil(response.total_count / 30), MAX_PAGES);

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
        log(styleText('gray', `  Found ${filename}`));
      } else {
        log(styleText('gray', `  No ${filename} found`));
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

  if (!response.ok) {
    if (response.status === 404) {
      log(styleText('gray', `  No ${filename} found`));
      fileExistsStats[url] = false;
      fs.writeFileSync(fileExistsStatsPath, JSON.stringify(fileExistsStats));
      return false;
    }

    throw new NetworkError(response.status, response.statusText);
  }

  log(styleText('gray', `  Found ${filename}`));
  fileExistsStats[url] = true;
  fs.writeFileSync(fileExistsStatsPath, JSON.stringify(fileExistsStats));
  return true;
}

/**
 * Check if packageManager is present in package.json. If present, count as whatever is specified.
 * Check for package-lock.json. If present, count as npm.
 * Check for npm-shrinkwrap.json. If present, count as npm.
 * Check for yarn.lock, and…
 *   Check for .yarnrc.yml. If present, count as Yarn Modern.
 *   Check for "# yarn lockfile v1". If present, count as Yarn Classic. If not, count as Yarn Modern.
 * Check for pnpm-lock.yaml. If present, count as pnpm.
 * Check for bun.lockb. If present, count as bun.
 * Check for bun.lock. If present, count as bun.
 */
await (DEBUG ? asyncForEachStrict : asyncForEach)(flattenedResults, async (result, index) => {
  log(
    `${styleText('bold', result.name)} ${styleText('gray', `(${index + 1}/${flattenedResults.length})`)}`,
  );

  const branch = result.default_branch;

  const packageJsonExists = await checkIfFileExists(result.name, branch, 'package.json');

  if (!packageJsonExists) {
    log(styleText('white', '  Non-Node.js project'));
    stats.non_nodejs++;
    return;
  }

  stats.nodejs++;

  let rawPackageJson: string;
  try {
    rawPackageJson = await fetchWithCache(
      `https://raw.githubusercontent.com/${result.name}/${branch}/package.json`,
    );
  } catch (error) {
    if (error instanceof NetworkError && error.status === 404) {
      log(styleText('gray', '  No package.json found'));
      return;
    }

    throw error;
  }

  // biome-ignore lint/suspicious/noExplicitAny: No capacity to type packageJson
  let packageJson: Record<string, any> | undefined;
  try {
    packageJson = JSON.parse(rawPackageJson);
  } catch {
    log(styleText('red', '  Invalid package.json'));
  }

  if (packageJson) {
    if ('packageManager' in packageJson) {
      log(styleText('gray', '    Found packageManager'));
      stats.uses_corepack++;

      // Extract major version from packageManager string (e.g. "npm@7.20.0")
      const versionMatch = packageJson.packageManager.match(/@v?(\d+)/);

      if (!versionMatch) {
        throw new Error(`packageManager version not recognized: ${packageJson.packageManager}`);
      }

      const version = Number(versionMatch[1]);

      if (packageJson.packageManager.match(/npm/i)) {
        log(styleText('green', '  npm detected'));
        packageManagerStats.npm++;
        const npmStats: Record<string, number> = packageManagerVersionStats.npm;
        npmStats[version] = (npmStats[version] ?? 0) + 1;
        return;
      }

      if (packageJson.packageManager.match(/yarn@1/i)) {
        log(styleText('green', '  Yarn Classic detected'));
        packageManagerStats.yarn_classic++;
        const yarnClassicStats: Record<string, number> = packageManagerVersionStats.yarn_classic;
        yarnClassicStats[version] = (yarnClassicStats[version] ?? 0) + 1;
        return;
      }

      if (packageJson.packageManager.match(/yarn@[2-9]/i)) {
        log(styleText('green', '  Yarn Modern detected'));
        packageManagerStats.yarn_modern++;
        const yarnModernStats: Record<string, number> = packageManagerVersionStats.yarn_modern;
        yarnModernStats[version] = (yarnModernStats[version] ?? 0) + 1;
        return;
      }

      if (packageJson.packageManager.match(/pnpm/i)) {
        log(styleText('green', '  pnpm detected'));
        packageManagerStats.pnpm++;
        const pnpmStats: Record<string, number> = packageManagerVersionStats.pnpm;
        pnpmStats[version] = (pnpmStats[version] ?? 0) + 1;
        return;
      }

      if (packageJson.packageManager.match(/bun/i)) {
        log(styleText('green', '  bun detected'));
        packageManagerStats.bun++;
        const bunStats: Record<string, number> = packageManagerVersionStats.bun;
        bunStats[version] = (bunStats[version] ?? 0) + 1;
        return;
      }

      throw new Error(`packageManager not recognized: ${packageJson.packageManager}`);
    }

    log(styleText('gray', '    No packageManager found'));
    stats.does_not_use_corepack++;
  }

  const packageLockJsonExists = await checkIfFileExists(result.name, branch, 'package-lock.json');

  if (packageLockJsonExists) {
    log(styleText('green', '  npm detected'));
    packageManagerStats.npm++;
    stats.has_lockfile++;

    let packageLockJson: string;
    try {
      packageLockJson = await fetchWithCache(
        `https://raw.githubusercontent.com/${result.name}/${branch}/package-lock.json`,
      );
    } catch (error) {
      if (error instanceof NetworkError && error.status === 404) {
        log(styleText('gray', '  No package-lock.json found'));
        return;
      }

      throw error;
    }

    let parsedPackageLockJson: Record<string, unknown>;
    try {
      parsedPackageLockJson = JSON.parse(packageLockJson);
    } catch {
      log(styleText('red', '  Invalid package-lock.json, attempting to partially parse'));

      // Attempt to partially read package-lock.json by taking its first 5 lines, removing the last comma and adding "}"
      const firstFiveLines = packageLockJson.split('\n').slice(0, 5).join('\n');
      const lastCommaIndex = firstFiveLines.lastIndexOf(',');
      const partialJson = `${firstFiveLines.slice(0, lastCommaIndex)}\n}`;

      try {
        parsedPackageLockJson = JSON.parse(partialJson);
      } catch {
        throw new Error(`Invalid package-lock.json: ${partialJson}`);
      }
    }

    const packageLockJsonVersion = parsedPackageLockJson.lockfileVersion as string | undefined;

    if (!packageLockJsonVersion) {
      const npmStats: Record<string, number> = packageManagerVersionStats.npm;
      npmStats.unknown = (npmStats.unknown ?? 0) + 1;
      return;
    }

    // https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json#lockfileversion
    const lockfileVersionToNpmVersionMap: Record<string, string> = {
      '1': '5_or_6', // ^5.0.0 || ^6.0.0
      '2': '7_or_8', // ^7.0.0 || ^8.0.0
      '3': '9_or_10_or_11', // ^9.0.0 || ^10.0.0
    };

    const npmVersion = lockfileVersionToNpmVersionMap[packageLockJsonVersion] ?? 'unknown';

    const npmStats: Record<string, number> = packageManagerVersionStats.npm;
    npmStats[npmVersion] = (npmStats[npmVersion] ?? 0) + 1;
    return;
  }

  const npmShrinkwrapJsonExists = await checkIfFileExists(
    result.name,
    branch,
    'npm-shrinkwrap.json',
  );

  if (npmShrinkwrapJsonExists) {
    log(styleText('green', '  npm detected'));
    packageManagerStats.npm++;
    const npmStats: Record<string, number> = packageManagerVersionStats.npm;
    npmStats.unknown = (npmStats.unknown ?? 0) + 1;
    stats.has_lockfile++;
    return;
  }

  const yarnLockExists = await checkIfFileExists(result.name, branch, 'yarn.lock');

  if (yarnLockExists) {
    stats.has_lockfile++;

    let yarnLock: string;
    try {
      yarnLock = await fetchWithCache(
        `https://raw.githubusercontent.com/${result.name}/${branch}/yarn.lock`,
      );
    } catch (error) {
      if (error instanceof NetworkError && error.status === 404) {
        log(styleText('gray', '  No yarn.lock found'));
        return;
      }

      throw error;
    }

    if (yarnLock.match(/# yarn lockfile v1/i)) {
      log(styleText('green', '  Yarn Classic detected'));
      packageManagerStats.yarn_classic++;
      const yarnClassicStats: Record<string, number> = packageManagerVersionStats.yarn_classic;
      yarnClassicStats['1'] = (yarnClassicStats['1'] ?? 0) + 1;
      return;
    }

    log(styleText('green', '  Yarn Modern detected'));
    packageManagerStats.yarn_modern++;

    const firstTenLinesOfYarnLock = yarnLock.split('\n').slice(0, 10).join('\n');
    const lockfileVersion = parseYaml(firstTenLinesOfYarnLock).__metadata.version;

    if (!lockfileVersion) {
      const yarnModernStats: Record<string, number> = packageManagerVersionStats.yarn_modern;
      yarnModernStats.unknown = (yarnModernStats.unknown ?? 0) + 1;
      return;
    }

    // https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/Project.ts
    const lockfileVersionToYarnVersionMap: Record<string, string> = {
      '4': '3', // ^3.0.0
      '5': '3', // ^3.1.0
      '6': '3', // ^3.2.0
      '8': '4',
    };

    const yarnVersion = lockfileVersionToYarnVersionMap[lockfileVersion] ?? 'unknown';

    const yarnModernStats: Record<string, number> = packageManagerVersionStats.yarn_modern;
    yarnModernStats[yarnVersion] = (yarnModernStats[yarnVersion] ?? 0) + 1;
    return;
  }

  const pnpmLockYamlExists = await checkIfFileExists(result.name, branch, 'pnpm-lock.yaml');

  if (pnpmLockYamlExists) {
    log(styleText('green', '  pnpm detected'));
    packageManagerStats.pnpm++;
    stats.has_lockfile++;

    let pnpmLockYaml: string;
    try {
      pnpmLockYaml = await fetchWithCache(
        `https://raw.githubusercontent.com/${result.name}/${branch}/pnpm-lock.yaml`,
      );
    } catch (error) {
      if (error instanceof NetworkError && error.status === 404) {
        log(styleText('gray', '  No pnpm-lock.yaml found'));
        return;
      }

      throw error;
    }

    const firstLineOfPnpmLockYaml = pnpmLockYaml.split('\n')[0] || '';
    const lockfileVersion = parseYaml(firstLineOfPnpmLockYaml).lockfileVersion;

    if (!lockfileVersion) {
      const pnpmStats: Record<string, number> = packageManagerVersionStats.pnpm;
      pnpmStats.unknown = (pnpmStats.unknown ?? 0) + 1;
      return;
    }

    // https://github.com/pnpm/pnpm/blob/main/packages/constants/src/index.ts
    const lockfileVersionToPnpmVersionMap: Record<string, string> = {
      '5': '3', // ^3.0.0
      '5.1': '3_or_4_or_5', // ^3.5.0 || ^4.0.0 || ^5.0.0
      '5.2': '5', // ^5.10.0
      '5.3': '6',
      '5.4': '7',
      '6.0': '8', // Opt-in in ^7.24.0, default in ^8.0.0 - assuming ^8.0.0
      '6.1': '9', // v9.0.0-alpha.5
      '7.0': '9', // v9.0.0-alpha.5
      '9.0': '9_or_10',
    };

    const pnpmVersion = lockfileVersionToPnpmVersionMap[lockfileVersion] ?? 'unknown';

    const pnpmStats: Record<string, number> = packageManagerVersionStats.pnpm;
    pnpmStats[pnpmVersion] = (pnpmStats[pnpmVersion] ?? 0) + 1;
    return;
  }

  const bunLockbOrBunLockExists =
    (await checkIfFileExists(result.name, branch, 'bun.lockb')) ||
    (await checkIfFileExists(result.name, branch, 'bun.lock'));

  if (bunLockbOrBunLockExists) {
    log(styleText('green', '  bun detected'));
    packageManagerStats.bun++;
    const bunStats: Record<string, number> = packageManagerVersionStats.bun;
    // There's no v2 yet - it MUST be v1
    // bunStats.unknown = (bunStats.unknown ?? 0) + 1;
    bunStats['1'] = (bunStats['1'] ?? 0) + 1;
    stats.has_lockfile++;
    return;
  }

  stats.does_not_have_lockfile++;

  // Check for package manager in scripts
  if (rawPackageJson) {
    if (rawPackageJson.match(/npm run/i)) {
      log(styleText('green', '  npm detected'));
      packageManagerStats.npm++;
      return;
    }

    if (rawPackageJson.match(/yarn run/i)) {
      log(styleText('red', '  Yarn detected, but not sure which version'));
      packageManagerStats.unknown++;
      return;
    }

    if (rawPackageJson.match(/pnpm run/i)) {
      log(styleText('green', '  pnpm detected'));
      packageManagerStats.pnpm++;
      return;
    }

    if (rawPackageJson.match(/bun run/i)) {
      log(styleText('green', '  bun detected'));
      packageManagerStats.bun++;
      return;
    }

    /**
     * npx is a tool to execute binaries from npm packages. If a project uses npx *and* does not use
     * any other package manager, it's likely using npm.
     */
    if (rawPackageJson.match(/npx/i)) {
      log(styleText('green', '  npm detected'));
      packageManagerStats.npm++;
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

    if (contributingMd.match(/npm (ci|install|run|test)/i)) {
      log(styleText('green', '  npm detected'));
      packageManagerStats.npm++;
      return;
    }

    if (contributingMd.match(/yarn/i)) {
      log(styleText('red', '  Yarn detected, but not sure which version'));
      packageManagerStats.unknown++;
      return;
    }

    if (contributingMd.match(/pnpm (ci|install|run|test)/i)) {
      log(styleText('green', '  pnpm detected'));
      packageManagerStats.pnpm++;
      return;
    }

    if (contributingMd.match(/bun i/i)) {
      log(styleText('green', '  bun detected'));
      packageManagerStats.bun++;
      return;
    }
  }

  const githubWorkflowsCiYmlExists = await checkIfFileExists(
    result.name,
    branch,
    '.github/workflows/ci.yml',
  );

  if (githubWorkflowsCiYmlExists) {
    const githubWorkflowsCiYml = await fetchWithCache(
      `https://raw.githubusercontent.com/${result.name}/${branch}/.github/workflows/ci.yml`,
    );

    if (githubWorkflowsCiYml.match(/npm (ci|install|run|test)/i)) {
      log(styleText('green', '  npm detected'));
      packageManagerStats.npm++;
      return;
    }

    if (githubWorkflowsCiYml.match(/yarn/i)) {
      log(styleText('red', '  Yarn detected, but not sure which version'));
      packageManagerStats.unknown++;
      return;
    }

    if (githubWorkflowsCiYml.match(/pnpm (ci|install|run|test)/i)) {
      log(styleText('green', '  pnpm detected'));
      packageManagerStats.pnpm++;
      return;
    }

    if (githubWorkflowsCiYml.match(/bun i/i)) {
      log(styleText('green', '  bun detected'));
      packageManagerStats.bun++;
      return;
    }
  }

  log(styleText('red', '  No package manager detected'));
  packageManagerStats.unknown++;
});

const ymd = new Date().toISOString().slice(0, 10);

fs.writeFileSync(`results/${ymd}-stats.json`, `${JSON.stringify(stats, null, 2)}\n`);
info(stats);

fs.writeFileSync(
  `results/${ymd}-package-manager-stats.json`,
  `${JSON.stringify(packageManagerStats, null, 2)}\n`,
);
info(packageManagerStats);

fs.writeFileSync(
  `results/${ymd}-package-manager-version-stats.json`,
  `${JSON.stringify(packageManagerVersionStats, null, 2)}\n`,
);
info(packageManagerVersionStats);
