import fs from 'node:fs';
import { styleText } from 'node:util';
import pRetry from 'p-retry';

import { CACHE_DIR, GITHUB_API_URL, MAX_PAGES, QUERY } from './constants.ts';
import { log } from './logger.ts';

import type { SearchResultsPage } from './types.ts';

function getHeaderValue(headersInit: HeadersInit | undefined, headerName: string) {
  if (!headersInit) {
    return undefined;
  }

  return new Headers(headersInit).get(headerName);
}

export function parsePartialJson(raw: string): Record<string, unknown> | undefined {
  // Try our luck and see if it's valid JSON first
  try {
    return JSON.parse(raw);
  } catch {
    // If it's not, we'll try to parse it as a partial JSON
    const lastCommaIndex = raw.lastIndexOf(',');

    if (lastCommaIndex === -1) {
      return undefined;
    }

    const slicedJson = raw.slice(0, lastCommaIndex);

    const numberOfOpenBraces = slicedJson.match(/{/g)?.length ?? 0;
    const numberOfCloseBraces = slicedJson.match(/}/g)?.length ?? 0;

    const partialJson = slicedJson + '}'.repeat(numberOfOpenBraces - numberOfCloseBraces);

    try {
      return JSON.parse(partialJson);
    } catch {
      return undefined;
    }
  }
}

/**
 * Fetches a URL and caches it in the .cache directory. On subsequent calls, it
 * will return the cached version if it exists.
 */
export async function fetchWithCache(input: string | URL, init?: RequestInit): Promise<string> {
  // log(styleText('gray', `Getting ${input}…`));

  const rangeHeaderValue = getHeaderValue(init?.headers, 'range');
  const rangeSuffix = rangeHeaderValue ? `__range_${rangeHeaderValue}` : '';
  const cacheKey = `${input}${rangeSuffix}`.replace(/[^a-z0-9]/gi, '_').toLowerCase();
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
        throw new Error(`Network error ${response.status}: ${response.statusText}`);
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

export async function fetchLanguagePages(
  language: 'JavaScript' | 'TypeScript',
): Promise<SearchResultsPage[]> {
  const results: SearchResultsPage[] = [];

  let totalPages: number | undefined;

  for (let i = 0; i < MAX_PAGES; i++) {
    const currentPage = i + 1;

    if (totalPages) {
      if (currentPage > totalPages) {
        break;
      }

      log(styleText('gray', `Fetching ${language} page ${currentPage}/${totalPages}…`));
    } else {
      log(styleText('gray', `Fetching ${language} page ${currentPage}…`));
    }

    const url = new URL(`${GITHUB_API_URL}/search/repositories`);
    url.searchParams.set('q', `${QUERY} language:${language}`);
    url.searchParams.set('sort', 'stars');
    url.searchParams.set('page', currentPage.toString());

    const rawResponse = await fetchWithCache(url, {
      headers: {
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
      },
    });

    const response = JSON.parse(rawResponse) as SearchResultsPage;

    results.push(response);

    totalPages = Math.min(Math.ceil(response.total_count / 30), MAX_PAGES);

    if (results.length === response.total_count) {
      break;
    }
  }

  return results;
}

const fileExistsStatsPath = `${CACHE_DIR}/file-exists-stats.json`;
const fileExistsStats: Record<string, boolean> = fs.existsSync(fileExistsStatsPath)
  ? (JSON.parse(fs.readFileSync(fileExistsStatsPath, 'utf-8')) as Record<string, boolean>)
  : {};

export async function checkIfFileExists(url: string): Promise<boolean> {
  const filename = url.split('/').pop() ?? url;

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

  const response = await fetch(url, { method: 'HEAD' });

  if (!response.ok) {
    if (response.status === 404) {
      log(styleText('gray', `  No ${filename} found`));
      fileExistsStats[url] = false;
      fs.writeFileSync(fileExistsStatsPath, JSON.stringify(fileExistsStats));
      return false;
    }

    throw new Error(`Network error ${response.status}: ${response.statusText}`);
  }

  log(styleText('gray', `  Found ${filename}`));
  fileExistsStats[url] = true;
  fs.writeFileSync(fileExistsStatsPath, JSON.stringify(fileExistsStats));
  return true;
}
