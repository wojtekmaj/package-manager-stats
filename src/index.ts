import fs from 'node:fs';
import { styleText } from 'node:util';
import { asyncForEach, asyncForEachStrict } from '@wojtekmaj/async-array-utils';
import { parse as parseYaml } from 'yaml';

import { DEBUG, GITHUB_TOKEN } from './env.ts';
import { info, log } from './logger.ts';
import { checkIfFileExists, fetchLanguagePages, fetchWithCache } from './utils.ts';

import type {
  PackageManagerStats,
  PackageManagerVersionStats,
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
};

const packageManagerStats: PackageManagerStats = {
  npm: 0,
  yarn_classic: 0,
  yarn_modern: 0,
  pnpm: 0,
  bun: 0,
  unknown: 0,
};

const packageManagerVersionStats: PackageManagerVersionStats = {
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

  function fetchWithCacheInRepo(path: string) {
    return fetchWithCache(`https://raw.githubusercontent.com/${result.name}/${branch}/${path}`);
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

  if (packageJson) {
    if (packageJson.packageManager) {
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

  const packageLockJsonExists = await checkIfFileExistsInRepo('package-lock.json');

  if (packageLockJsonExists) {
    log(styleText('green', '  npm detected'));
    packageManagerStats.npm++;
    stats.has_lockfile++;

    const packageLockJson = await fetchWithCacheInRepo('package-lock.json');

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

  const npmShrinkwrapJsonExists = await checkIfFileExistsInRepo('npm-shrinkwrap.json');

  if (npmShrinkwrapJsonExists) {
    log(styleText('green', '  npm detected'));
    packageManagerStats.npm++;
    const npmStats: Record<string, number> = packageManagerVersionStats.npm;
    npmStats.unknown = (npmStats.unknown ?? 0) + 1;
    stats.has_lockfile++;
    return;
  }

  const yarnLockExists = await checkIfFileExistsInRepo('yarn.lock');

  if (yarnLockExists) {
    stats.has_lockfile++;

    const yarnLock = await fetchWithCacheInRepo('yarn.lock');

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

  const pnpmLockYamlExists = await checkIfFileExistsInRepo('pnpm-lock.yaml');

  if (pnpmLockYamlExists) {
    log(styleText('green', '  pnpm detected'));
    packageManagerStats.pnpm++;
    stats.has_lockfile++;

    const pnpmLockYaml = await fetchWithCacheInRepo('pnpm-lock.yaml');

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
    (await checkIfFileExistsInRepo('bun.lockb')) || (await checkIfFileExistsInRepo('bun.lock'));

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
  const contributingMdExists = await checkIfFileExistsInRepo('CONTRIBUTING.md');

  if (contributingMdExists) {
    const contributingMd = await fetchWithCacheInRepo('CONTRIBUTING.md');

    if (contributingMd.match(regexes.npm)) {
      log(styleText('green', '  npm detected'));
      packageManagerStats.npm++;
      return;
    }

    if (contributingMd.match(regexes.yarn)) {
      log(styleText('red', '  Yarn detected, but not sure which version'));
      packageManagerStats.unknown++;
      return;
    }

    if (contributingMd.match(regexes.pnpm)) {
      log(styleText('green', '  pnpm detected'));
      packageManagerStats.pnpm++;
      return;
    }

    if (contributingMd.match(regexes.bun)) {
      log(styleText('green', '  bun detected'));
      packageManagerStats.bun++;
      return;
    }
  }

  const githubWorkflowsCiYmlExists = await checkIfFileExistsInRepo('.github/workflows/ci.yml');

  if (githubWorkflowsCiYmlExists) {
    const githubWorkflowsCiYml = await fetchWithCacheInRepo('.github/workflows/ci.yml');

    if (githubWorkflowsCiYml.match(regexes.npm)) {
      log(styleText('green', '  npm detected'));
      packageManagerStats.npm++;
      return;
    }

    if (githubWorkflowsCiYml.match(regexes.yarn)) {
      log(styleText('red', '  Yarn detected, but not sure which version'));
      packageManagerStats.unknown++;
      return;
    }

    if (githubWorkflowsCiYml.match(regexes.pnpm)) {
      log(styleText('green', '  pnpm detected'));
      packageManagerStats.pnpm++;
      return;
    }

    if (githubWorkflowsCiYml.match(regexes.bun)) {
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
