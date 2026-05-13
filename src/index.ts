import fs from 'node:fs';
import { styleText } from 'node:util';
import { asyncForEachStrict } from '@wojtekmaj/async-array-utils';
import { parseAllDocuments, parse as parseYaml } from 'yaml';

import { DEBUG, GITHUB_TOKEN } from './env.ts';
import { info, log } from './logger.ts';
import {
  checkIfFileExists,
  fetchLanguagePages,
  fetchWithCache,
  parsePartialJson,
} from './utils.ts';

import type {
  PackageManagerMonorepoStats,
  PackageManagerStats,
  PackageManagerVersionStats,
  RepositoryTree,
  SearchResultsPage,
} from './types.ts';

if (!GITHUB_TOKEN) {
  throw new Error('GITHUB_TOKEN environment variable must be set');
}

function fetchJavaScriptPages(): Promise<SearchResultsPage[]> {
  return fetchLanguagePages('JavaScript');
}

function fetchTypeScriptPages(): Promise<SearchResultsPage[]> {
  return fetchLanguagePages('TypeScript');
}

const [jsResults, tsResults] = await Promise.all([fetchJavaScriptPages(), fetchTypeScriptPages()]);

const results = [...jsResults, ...tsResults];

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
  is_monorepo: 0,
  is_not_monorepo: 0,
};

const packageManagerStats: PackageManagerStats = {
  npm: 0,
  yarn_classic: 0,
  yarn_modern: 0,
  pnpm: 0,
  bun: 0,
  unknown: 0,
};

const packageManagerWeightedStats: PackageManagerStats = {
  npm: 0,
  yarn_classic: 0,
  yarn_modern: 0,
  pnpm: 0,
  bun: 0,
  unknown: 0,
};

const packageManagerMonorepoStats: PackageManagerStats = {
  npm: 0,
  yarn_classic: 0,
  yarn_modern: 0,
  pnpm: 0,
  bun: 0,
  unknown: 0,
};

const packageManagerMonorepoBreakdownStats: PackageManagerMonorepoStats = {
  npm: {
    is_monorepo: 0,
    is_not_monorepo: 0,
  },
  yarn_classic: {
    is_monorepo: 0,
    is_not_monorepo: 0,
  },
  yarn_modern: {
    is_monorepo: 0,
    is_not_monorepo: 0,
  },
  pnpm: {
    is_monorepo: 0,
    is_not_monorepo: 0,
  },
  bun: {
    is_monorepo: 0,
    is_not_monorepo: 0,
  },
  unknown: {
    is_monorepo: 0,
    is_not_monorepo: 0,
  },
};

const packageManagerVersionStats: PackageManagerVersionStats = {
  npm: {},
  yarn_classic: {},
  yarn_modern: {},
  pnpm: {},
  bun: {},
};

const packageManagerWeightedVersionStats: PackageManagerVersionStats = {
  npm: {},
  yarn_classic: {},
  yarn_modern: {},
  pnpm: {},
  bun: {},
};

const regexes = {
  npm: /npm (ci|install|run|test)/i,
  // Yarn allows installing by executing "yarn" and running scripts by executing "yarn <script>"
  yarn: /yarn/i,
  pnpm: /pnpm (install|run|test)/i,
  bun: /bun (install|run|test)/i,
};

const CONCURRENT_REPOSITORY_SCANS = 10;

async function asyncForEachConcurrent<T, U>(
  arr: T[],
  fn: (item: T, index: number, arr: T[]) => Promise<U>,
  concurrency: number,
): Promise<void> {
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < arr.length) {
      const currentIndex = nextIndex++;
      const item = arr[currentIndex];

      if (!item) {
        continue;
      }

      await fn(item, currentIndex, arr);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, arr.length) }, () => worker()));
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function workspacePatternToRegex(pattern: string): RegExp {
  const normalizedPattern = pattern.replace(/^\.\//, '').replace(/\/$/, '');
  const parts = normalizedPattern.split('/');
  const regexParts = parts.map((part) => {
    if (part === '**') {
      return '(?:[^/]+/)*';
    }

    const partRegex = escapeRegex(part).replace(/\\\*/g, '[^/]*');
    return `${partRegex}/`;
  });

  return new RegExp(`^${regexParts.join('')}package\\.json$`);
}

function getPackageJsonWorkspacePatterns(
  // biome-ignore lint/suspicious/noExplicitAny: No capacity to type arbitrary package.json
  packageJson: Record<string, any> | undefined,
): string[] {
  if (!packageJson) {
    return [];
  }

  const { workspaces } = packageJson;

  if (Array.isArray(workspaces)) {
    return workspaces.filter((workspace): workspace is string => typeof workspace === 'string');
  }

  const packages = workspaces?.packages as unknown;

  if (Array.isArray(packages)) {
    return packages.filter((workspace): workspace is string => typeof workspace === 'string');
  }

  return [];
}

function getPnpmWorkspacePatterns(pnpmWorkspaceYaml: string): string[] {
  const parsedPnpmWorkspace = parseYaml(pnpmWorkspaceYaml) as { packages?: unknown };
  const packages = parsedPnpmWorkspace.packages;

  if (!Array.isArray(packages)) {
    return [];
  }

  return packages.filter((workspace): workspace is string => typeof workspace === 'string');
}

function getPnpmLockfilePackageCount(pnpmLockYaml: string): number | undefined {
  const parsedPnpmLockYamls = parseAllDocuments(pnpmLockYaml, { uniqueKeys: false })
    .map((document) => document.toJS({}) as { importers?: unknown })
    .sort((a, b) => {
      const aImporters =
        a.importers && typeof a.importers === 'object' && !Array.isArray(a.importers)
          ? Object.keys(a.importers).length
          : 0;
      const bImporters =
        b.importers && typeof b.importers === 'object' && !Array.isArray(b.importers)
          ? Object.keys(b.importers).length
          : 0;

      return bImporters - aImporters;
    });
  const { importers } = parsedPnpmLockYamls[0] ?? {};

  if (!importers || typeof importers !== 'object' || Array.isArray(importers)) {
    return undefined;
  }

  return Object.keys(importers).filter((importer) => importer !== '.').length;
}

function countWorkspacePackages(packageJsonPaths: string[], patterns: string[]): number {
  const packagePatterns = patterns.filter((pattern) => !pattern.startsWith('!'));
  const ignoredPatterns = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => pattern.slice(1));

  if (!packagePatterns.length) {
    return 0;
  }

  const packageRegexes = packagePatterns.map(workspacePatternToRegex);
  const ignoredRegexes = ignoredPatterns.map(workspacePatternToRegex);

  const packageCount = packageJsonPaths.filter((packageJsonPath) => {
    if (packageJsonPath === 'package.json') {
      return false;
    }

    return (
      packageRegexes.some((regex) => regex.test(packageJsonPath)) &&
      !ignoredRegexes.some((regex) => regex.test(packageJsonPath))
    );
  }).length;

  return packageCount;
}

function isPublishableRootPackage(
  // biome-ignore lint/suspicious/noExplicitAny: No capacity to type arbitrary package.json
  packageJson: Record<string, any> | undefined,
): boolean {
  return typeof packageJson?.name === 'string' && packageJson.private !== true;
}

const forEachRepository: typeof asyncForEachStrict = DEBUG
  ? asyncForEachStrict
  : (arr, fn) => asyncForEachConcurrent(arr, fn, CONCURRENT_REPOSITORY_SCANS);

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
await forEachRepository(flattenedResults, async (result, index) => {
  log(
    `${styleText('bold', result.name)} ${styleText('gray', `(${index + 1}/${flattenedResults.length})`)}`,
  );

  const branch = result.default_branch;

  function fetchWithCacheInRepo(path: string, init?: RequestInit) {
    return fetchWithCache(
      `https://raw.githubusercontent.com/${result.name}/${branch}/${path}`,
      init,
    );
  }

  function fetchGitHubApiWithCacheInRepo(path: string, init?: RequestInit) {
    return fetchWithCache(`https://api.github.com/repos/${result.name}/${path}`, {
      ...init,
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        ...init?.headers,
      },
    });
  }

  function checkIfFileExistsInRepo(path: string) {
    return checkIfFileExists(`https://raw.githubusercontent.com/${result.name}/${branch}/${path}`);
  }

  const packageJsonExists = await checkIfFileExistsInRepo('package.json');

  if (!packageJsonExists) {
    log(styleText('white', '  Non-Node.js project'));
    stats.non_nodejs++;
    return;
  }

  stats.nodejs++;

  const rawPackageJson = await fetchWithCacheInRepo('package.json');

  // biome-ignore lint/suspicious/noExplicitAny: No capacity to type packageJson
  let packageJson: Record<string, any> | undefined;
  try {
    packageJson = JSON.parse(rawPackageJson);
  } catch {
    log(styleText('red', '  Invalid package.json'));
  }

  let pnpmLockYamlExists: boolean | undefined;
  async function checkIfPnpmLockYamlExists(): Promise<boolean> {
    pnpmLockYamlExists ??= await checkIfFileExistsInRepo('pnpm-lock.yaml');
    return pnpmLockYamlExists;
  }

  let pnpmLockYaml: string | undefined;
  async function fetchPnpmLockYaml(): Promise<string | undefined> {
    try {
      pnpmLockYaml ??= await fetchWithCacheInRepo('pnpm-lock.yaml');
    } catch (error) {
      if (error instanceof Error && error.message.includes('Network error 404')) {
        pnpmLockYamlExists = false;
        return undefined;
      }

      throw error;
    }

    return pnpmLockYaml;
  }

  const packageJsonWorkspacePatterns = getPackageJsonWorkspacePatterns(packageJson);
  const rawPnpmLockYaml = (await checkIfPnpmLockYamlExists())
    ? await fetchPnpmLockYaml()
    : undefined;
  const pnpmLockfilePackageCount = rawPnpmLockYaml
    ? getPnpmLockfilePackageCount(rawPnpmLockYaml)
    : undefined;
  const pnpmWorkspaceYamlExists =
    pnpmLockfilePackageCount === undefined
      ? await checkIfFileExistsInRepo('pnpm-workspace.yaml')
      : false;
  const pnpmWorkspacePatterns = pnpmWorkspaceYamlExists
    ? getPnpmWorkspacePatterns(await fetchWithCacheInRepo('pnpm-workspace.yaml'))
    : [];
  const workspacePatterns = pnpmWorkspacePatterns.length
    ? pnpmWorkspacePatterns
    : packageJsonWorkspacePatterns;
  const rootPackageCount = isPublishableRootPackage(packageJson) ? 1 : 0;
  const packageCount =
    pnpmLockfilePackageCount !== undefined
      ? Math.max(pnpmLockfilePackageCount + rootPackageCount, 1)
      : workspacePatterns.length
        ? Math.max(
            countWorkspacePackages(
              await (async () => {
                const repositoryTreeRaw = await fetchGitHubApiWithCacheInRepo(
                  `git/trees/${encodeURIComponent(branch)}?recursive=1`,
                );
                const repositoryTree = JSON.parse(repositoryTreeRaw) as RepositoryTree;

                if (repositoryTree.truncated) {
                  log(
                    styleText(
                      'yellow',
                      '    Repository tree truncated; workspace count may be incomplete',
                    ),
                  );
                }

                return repositoryTree.tree
                  .filter((item) => item.type === 'blob' && item.path.endsWith('/package.json'))
                  .map((item) => item.path);
              })(),
              workspacePatterns,
            ) + rootPackageCount,
            1,
          )
        : 1;

  if (packageCount > 1) {
    log(styleText('gray', `    Found ${packageCount} workspace packages`));
    stats.is_monorepo++;
  } else {
    stats.is_not_monorepo++;
  }

  function recordPackageManager(
    packageManager: keyof PackageManagerStats,
    version?: string | number,
  ): void {
    packageManagerStats[packageManager]++;
    packageManagerWeightedStats[packageManager] += packageCount;

    if (packageCount > 1) {
      packageManagerMonorepoStats[packageManager]++;
      packageManagerMonorepoBreakdownStats[packageManager].is_monorepo++;
    } else {
      packageManagerMonorepoBreakdownStats[packageManager].is_not_monorepo++;
    }

    if (packageManager === 'unknown' || version === undefined) {
      return;
    }

    const versionKey = version.toString();
    const versionStats = packageManagerVersionStats[packageManager];
    const weightedVersionStats = packageManagerWeightedVersionStats[packageManager];

    versionStats[versionKey] = (versionStats[versionKey] ?? 0) + 1;
    weightedVersionStats[versionKey] = (weightedVersionStats[versionKey] ?? 0) + packageCount;
  }

  if (packageJson?.packageManager) {
    log(styleText('gray', '    Found packageManager'));
    stats.uses_corepack++;

    // Extract package manager name and major version, tolerating malformed prefixes.
    const packageManagerMatch = packageJson.packageManager.match(
      /(?:^|\W)(npm|yarn|pnpm|bun)@(?:v)?(\d+)/i,
    );

    if (!packageManagerMatch) {
      throw new Error(`packageManager not recognized: ${packageJson.packageManager}`);
    }

    const [, packageManager, packageManagerVersion] = packageManagerMatch;
    const version = Number(packageManagerVersion);

    if (packageManager?.toLowerCase() === 'npm') {
      log(styleText('green', '  npm detected'));
      recordPackageManager('npm', version);
      return;
    }

    if (packageManager?.toLowerCase() === 'yarn' && version === 1) {
      log(styleText('green', '  Yarn Classic detected'));
      recordPackageManager('yarn_classic', version);
      return;
    }

    if (packageManager?.toLowerCase() === 'yarn' && version >= 2) {
      log(styleText('green', '  Yarn Modern detected'));
      recordPackageManager('yarn_modern', version);
      return;
    }

    if (packageManager?.toLowerCase() === 'pnpm') {
      log(styleText('green', '  pnpm detected'));
      recordPackageManager('pnpm', version);
      return;
    }

    if (packageManager?.toLowerCase() === 'bun') {
      log(styleText('green', '  bun detected'));
      recordPackageManager('bun', version);
      return;
    }

    throw new Error(`packageManager not recognized: ${packageJson.packageManager}`);
  }

  if (packageJson) {
    log(styleText('gray', '    No packageManager found'));
    stats.does_not_use_corepack++;
  }

  const packageLockJsonExists = await checkIfFileExistsInRepo('package-lock.json');

  if (packageLockJsonExists) {
    log(styleText('green', '  npm detected'));
    stats.has_lockfile++;

    const parsedPackageLockJson = await (async () => {
      const packageLockJson = await fetchWithCacheInRepo('package-lock.json', {
        headers: { Range: 'bytes=0-127' },
      });

      let parsedPackageLockJson = parsePartialJson(packageLockJson);

      if (parsedPackageLockJson) {
        return parsedPackageLockJson;
      }

      const fullPackageLockJson = await fetchWithCacheInRepo('package-lock.json');

      parsedPackageLockJson = parsePartialJson(fullPackageLockJson);

      if (parsedPackageLockJson) {
        return parsedPackageLockJson;
      }

      throw new Error('Invalid package-lock.json');
    })();

    const packageLockJsonVersion = parsedPackageLockJson.lockfileVersion as string | undefined;

    if (!packageLockJsonVersion) {
      recordPackageManager('npm', 'unknown');
      return;
    }

    // https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json#lockfileversion
    const lockfileVersionToNpmVersionMap: Record<string, string> = {
      '1': '5_or_6', // ^5.0.0 || ^6.0.0
      '2': '7_or_8', // ^7.0.0 || ^8.0.0
      '3': '9_or_10_or_11', // ^9.0.0 || ^10.0.0 || ^11.0.0
    };

    const npmVersion = lockfileVersionToNpmVersionMap[packageLockJsonVersion] ?? 'unknown';

    recordPackageManager('npm', npmVersion);
    return;
  }

  const npmShrinkwrapJsonExists = await checkIfFileExistsInRepo('npm-shrinkwrap.json');

  if (npmShrinkwrapJsonExists) {
    log(styleText('green', '  npm detected'));
    stats.has_lockfile++;
    recordPackageManager('npm', 'unknown');
    return;
  }

  const yarnLockExists = await checkIfFileExistsInRepo('yarn.lock');

  if (yarnLockExists) {
    stats.has_lockfile++;

    const yarnLock = await fetchWithCacheInRepo('yarn.lock', {
      headers: { Range: 'bytes=0-151' },
    });

    if (yarnLock.match(/# yarn lockfile v1/i)) {
      log(styleText('green', '  Yarn Classic detected'));
      recordPackageManager('yarn_classic', '1');
      return;
    }

    if (yarnLock.match(/# This file is generated by running/i)) {
      log(styleText('green', '  Yarn Modern detected'));

      const firstTenLinesOfYarnLock = yarnLock.split('\n').slice(0, 10).join('\n');
      const lockfileVersion = parseYaml(firstTenLinesOfYarnLock).__metadata.version;

      if (!lockfileVersion) {
        recordPackageManager('yarn_modern', 'unknown');
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

      recordPackageManager('yarn_modern', yarnVersion);
      return;
    }

    const parsedYarnLock = await (async () => {
      let parsedYarnLock = parsePartialJson(yarnLock);

      if (parsedYarnLock) {
        return parsedYarnLock;
      }

      const fullYarnLock = await fetchWithCacheInRepo('yarn.lock');

      parsedYarnLock = parsePartialJson(fullYarnLock);

      if (parsedYarnLock) {
        return parsedYarnLock;
      }

      throw new Error('Invalid yarn.lock');
    })();

    const yarnLockVersion = (parsedYarnLock.__metadata as Record<string, unknown>).version as
      | string
      | undefined;

    if (!yarnLockVersion) {
      recordPackageManager('yarn_modern', 'unknown');
      return;
    }

    // https://github.com/yarnpkg/zpm/blob/main/packages/zpm/src/lockfile.rs
    const lockfileVersionToYarnVersionMap: Record<string, string> = {
      '9': '6',
    };

    const yarnVersion = lockfileVersionToYarnVersionMap[yarnLockVersion] ?? 'unknown';

    recordPackageManager('yarn_modern', yarnVersion);
    return;
  }

  const rawPnpmLockYamlForDetection = (await checkIfPnpmLockYamlExists())
    ? await fetchPnpmLockYaml()
    : undefined;

  if (rawPnpmLockYamlForDetection) {
    log(styleText('green', '  pnpm detected'));
    stats.has_lockfile++;

    const firstLineOfPnpmLockYaml = rawPnpmLockYamlForDetection.split('\n')[0] || '';
    const lockfileVersion = parseYaml(firstLineOfPnpmLockYaml).lockfileVersion;

    if (!lockfileVersion) {
      recordPackageManager('pnpm', 'unknown');
      return;
    }

    // https://github.com/pnpm/pnpm/blob/main/core/constants/src/index.ts
    const lockfileVersionToPnpmVersionMap: Record<string, string> = {
      '5': '3', // ^3.0.0
      '5.1': '3_or_4_or_5', // ^3.5.0 || ^4.0.0 || ^5.0.0
      '5.2': '5', // ^5.10.0
      '5.3': '6',
      '5.4': '7',
      '6.0': '8', // Opt-in in ^7.24.0, default in ^8.0.0 - assuming ^8.0.0
      '6.1': '9', // v9.0.0-alpha.5
      '7.0': '9', // v9.0.0-alpha.5
      '9.0': '9_or_10_or_11',
    };

    const pnpmVersion = lockfileVersionToPnpmVersionMap[lockfileVersion] ?? 'unknown';

    recordPackageManager('pnpm', pnpmVersion);
    return;
  }

  const bunLockbOrBunLockExists =
    (await checkIfFileExistsInRepo('bun.lockb')) || (await checkIfFileExistsInRepo('bun.lock'));

  if (bunLockbOrBunLockExists) {
    log(styleText('green', '  bun detected'));
    stats.has_lockfile++;
    // There's no v2 yet - it MUST be v1
    recordPackageManager('bun', '1');
    return;
  }

  stats.does_not_have_lockfile++;

  // Check for package manager in scripts
  if (rawPackageJson) {
    if (rawPackageJson.match(/npm run/i)) {
      log(styleText('green', '  npm detected'));
      recordPackageManager('npm');
      return;
    }

    if (rawPackageJson.match(/yarn run/i)) {
      log(styleText('red', '  Yarn detected, but not sure which version'));
      recordPackageManager('unknown');
      return;
    }

    if (rawPackageJson.match(/pnpm run/i)) {
      log(styleText('green', '  pnpm detected'));
      recordPackageManager('pnpm');
      return;
    }

    if (rawPackageJson.match(/bun run/i)) {
      log(styleText('green', '  bun detected'));
      recordPackageManager('bun');
      return;
    }

    /**
     * npx is a tool to execute binaries from npm packages. If a project uses npx *and* does not use
     * any other package manager, it's likely using npm.
     */
    if (rawPackageJson.match(/npx/i)) {
      log(styleText('green', '  npm detected'));
      recordPackageManager('npm');
      return;
    }
  }

  // README.md intentionally omitted because it may contain installation instructions for
  // multiple package managers

  // CONTRIBUTING.md is generally intended for contributors, not users, so it's a better
  // indicator of the package manager used by the project
  const contributingMdExists = await checkIfFileExistsInRepo('CONTRIBUTING.md');

  if (contributingMdExists) {
    const contributingMd = await fetchWithCacheInRepo('CONTRIBUTING.md');

    if (contributingMd.match(regexes.npm)) {
      log(styleText('green', '  npm detected'));
      recordPackageManager('npm');
      return;
    }

    if (contributingMd.match(regexes.yarn)) {
      log(styleText('red', '  Yarn detected, but not sure which version'));
      recordPackageManager('unknown');
      return;
    }

    if (contributingMd.match(regexes.pnpm)) {
      log(styleText('green', '  pnpm detected'));
      recordPackageManager('pnpm');
      return;
    }

    if (contributingMd.match(regexes.bun)) {
      log(styleText('green', '  bun detected'));
      recordPackageManager('bun');
      return;
    }
  }

  const githubWorkflowsCiYmlExists = await checkIfFileExistsInRepo('.github/workflows/ci.yml');

  if (githubWorkflowsCiYmlExists) {
    const githubWorkflowsCiYml = await fetchWithCacheInRepo('.github/workflows/ci.yml');

    if (githubWorkflowsCiYml.match(regexes.npm)) {
      log(styleText('green', '  npm detected'));
      recordPackageManager('npm');
      return;
    }

    if (githubWorkflowsCiYml.match(regexes.yarn)) {
      log(styleText('red', '  Yarn detected, but not sure which version'));
      recordPackageManager('unknown');
      return;
    }

    if (githubWorkflowsCiYml.match(regexes.pnpm)) {
      log(styleText('green', '  pnpm detected'));
      recordPackageManager('pnpm');
      return;
    }

    if (githubWorkflowsCiYml.match(regexes.bun)) {
      log(styleText('green', '  bun detected'));
      recordPackageManager('bun');
      return;
    }
  }

  log(styleText('red', '  No package manager detected'));
  recordPackageManager('unknown');
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

fs.writeFileSync(
  `results/${ymd}-package-manager-weighted-stats.json`,
  `${JSON.stringify(packageManagerWeightedStats, null, 2)}\n`,
);
info(packageManagerWeightedStats);

fs.writeFileSync(
  `results/${ymd}-package-manager-weighted-version-stats.json`,
  `${JSON.stringify(packageManagerWeightedVersionStats, null, 2)}\n`,
);
info(packageManagerWeightedVersionStats);

fs.writeFileSync(
  `results/${ymd}-package-manager-monorepo-stats.json`,
  `${JSON.stringify(packageManagerMonorepoStats, null, 2)}\n`,
);
info(packageManagerMonorepoStats);

fs.writeFileSync(
  `results/${ymd}-package-manager-monorepo-breakdown-stats.json`,
  `${JSON.stringify(packageManagerMonorepoBreakdownStats, null, 2)}\n`,
);
info(packageManagerMonorepoBreakdownStats);
