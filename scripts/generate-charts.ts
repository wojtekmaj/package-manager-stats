import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  PackageManager,
  PackageManagerStats,
  PackageManagerVersionStats,
} from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const resultsDir = path.join(rootDir, 'results');
const chartsDir = path.join(rootDir, 'charts');

fs.mkdirSync(chartsDir, { recursive: true });

type ChartDatum = {
  label: string;
  value: number;
  color: `#${string}`;
  rawLabel?: string;
};

type LineSeries = {
  key: PackageManager;
  label: string;
  color: `#${string}`;
  values: number[];
};

type ChartOptions = {
  title: string;
  subtitle?: string;
  footer?: string;
  width?: number;
  barHeight?: number;
  barGap?: number;
  margin?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
};

type ThemeName = 'light' | 'dark';

type ChartTheme = {
  text: string;
  subtitle: string;
  footer: string;
  label: string;
  value: string;
  legend: string;
  tick: string;
  axis: string;
};

const THEMES: Record<ThemeName, ChartTheme> = {
  light: {
    text: '#0f172a',
    subtitle: '#475569',
    footer: '#94a3b8',
    label: '#0f172a',
    value: '#0f172a',
    legend: '#0f172a',
    tick: '#475569',
    axis: '#cbd5e1',
  },
  dark: {
    text: '#e2e8f0',
    subtitle: '#cbd5e1',
    footer: '#cbd5e1',
    label: '#e2e8f0',
    value: '#e2e8f0',
    legend: '#e2e8f0',
    tick: '#cbd5e1',
    axis: '#475569',
  },
};

const PACKAGE_MANAGER_LABELS: Record<PackageManager, string> = {
  npm: 'npm',
  yarn_classic: 'Yarn Classic',
  yarn_modern: 'Yarn (Berry)',
  pnpm: 'pnpm',
  bun: 'Bun',
  unknown: 'Unknown',
};

const PACKAGE_MANAGER_COLORS: Record<PackageManager, `#${string}`> = {
  npm: '#ea2039',
  yarn_classic: '#2c8ebb',
  yarn_modern: '#2f2a68',
  pnpm: '#f9ad00',
  bun: '#f472b6',
  unknown: '#6b7280',
};

const DARK_MODE_COLOR_OVERRIDES: Partial<Record<`#${string}`, `#${string}`>> = {
  [PACKAGE_MANAGER_COLORS.yarn_modern]: '#7c6ff6',
};

function resolveColor(color: `#${string}`, themeName: ThemeName): `#${string}` {
  if (themeName === 'dark') {
    const override = DARK_MODE_COLOR_OVERRIDES[color];

    if (override) {
      return override;
    }
  }

  return color;
}

function findLatestDate(): string {
  const statsDates = collectDates(/^(\d{4}-\d{2}-\d{2})-package-manager-stats\.json$/);
  const versionDates = collectDates(/^(\d{4}-\d{2}-\d{2})-package-manager-version-stats\.json$/);
  const overlappingDates = statsDates.filter((date) => versionDates.includes(date));

  if (!overlappingDates.length) {
    throw new Error('No results found in results directory');
  }

  return overlappingDates.sort().pop() as string;
}

function collectDates(regex: RegExp): string[] {
  return fs
    .readdirSync(resultsDir)
    .map((file) => {
      const match = file.match(regex);
      return match ? match[1] : undefined;
    })
    .filter((date): date is string => Boolean(date));
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function formatPercent(ratio: number): string {
  return Intl.NumberFormat('en', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(ratio);
}

function buildChartData(stats: PackageManagerStats): ChartDatum[] {
  const entries = Object.entries(stats) as [PackageManager, number][];

  return entries
    .filter(([pm, value]) => pm !== 'unknown' && value > 0)
    .map(([pm, value]) => ({
      label: PACKAGE_MANAGER_LABELS[pm],
      rawLabel: pm,
      value,
      color: PACKAGE_MANAGER_COLORS[pm],
    }))
    .sort((a, b) => b.value - a.value);
}

function buildVersionChartData(
  pm: Exclude<PackageManager, 'unknown'>,
  stats: Record<string, number>,
): ChartDatum[] {
  return Object.entries(stats)
    .filter(([version]) => version !== 'unknown')
    .map(([version, value]) => ({
      label: normalizeVersionLabel(version),
      rawLabel: version,
      value,
      color: PACKAGE_MANAGER_COLORS[pm],
      order: parseVersionOrder(version),
    }))
    .filter((datum) => datum.value > 0)
    .sort((a, b) => b.order - a.order)
    .map(({ order: _order, ...rest }) => rest);
}

function normalizeVersionLabel(version: string): string {
  return version.replace(/_/g, ' ');
}

function parseVersionOrder(version: string): number {
  // Prefer a predictable semver-ish ordering: major, minor, patch
  const tokens = version.match(/\d+/g)?.map((token) => Number.parseInt(token, 10)) ?? [];

  const [major = 0, minor = 0, patch = 0] = tokens;
  return major * 1_000_000 + minor * 1_000 + patch;
}

function extractMajor(version: string): string {
  const match = version.match(/\d+/);
  if (match) {
    return match[0];
  }

  return normalizeVersionLabel(version);
}

function countMajorVariants(stats: Record<string, number>): number {
  const majors = new Set<string>();

  Object.entries(stats).forEach(([version, value]) => {
    if (version === 'unknown' || value <= 0) {
      return;
    }

    majors.add(extractMajor(version));
  });

  return majors.size;
}

function resolveVersionGroup(version: string, tokenToGroup: Record<string, string>): string {
  const label = normalizeVersionLabel(version);

  if (label.includes(' or ')) {
    return label;
  }

  return tokenToGroup[label] ?? label;
}

function mergeVersionStats(stats: Record<string, number>): {
  merged: Record<string, number>;
  hadMerges: boolean;
} {
  const merged: Record<string, number> = {};
  const tokenToGroup: Record<string, string> = {};
  let hadMerges = false;

  // Build token lookup from ambiguous labels (those containing " or ")
  Object.keys(stats).forEach((version) => {
    const label = normalizeVersionLabel(version);

    if (!label.includes(' or ')) {
      return;
    }

    const tokens = label
      .split(' or ')
      .map((token) => token.trim())
      .filter(Boolean);

    tokens.forEach((token) => {
      if (!tokenToGroup[token]) {
        tokenToGroup[token] = label;
      }
    });
  });

  Object.entries(stats).forEach(([version, value]) => {
    if (version === 'unknown' || value <= 0) {
      return;
    }

    const normalizedVersion = normalizeVersionLabel(version);
    const group = resolveVersionGroup(version, tokenToGroup);
    hadMerges = hadMerges || group !== normalizedVersion || merged[group] !== undefined;
    merged[group] = (merged[group] ?? 0) + value;
  });

  return { merged, hadMerges };
}

function formatDateLabel(date: string): string {
  return new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(date));
}

function renderBarChart(
  data: ChartDatum[],
  options: ChartOptions,
  themeName: ThemeName = 'light',
): string {
  const theme = THEMES[themeName];
  const { title, subtitle, footer } = options;
  const width = options.width ?? 720;
  const barHeight = options.barHeight ?? 28;
  const barGap = options.barGap ?? 12;
  const margin = options.margin ?? { top: 64, right: 140, bottom: 48, left: 110 };
  const titleX = 16;
  const subtitleX = 16;
  const titleY = 24;
  const subtitleY = 42;
  const footerX = titleX;
  const footerSpace = footer ? 16 : 0;

  const total = data.reduce((sum, datum) => sum + datum.value, 0);
  const maxValue = data.reduce((max, datum) => Math.max(max, datum.value), 0);

  const innerWidth = width - margin.left - margin.right;
  const chartHeight =
    margin.top + margin.bottom + footerSpace + data.length * (barHeight + barGap) - barGap;

  const safeMaxValue = maxValue === 0 ? 1 : maxValue;

  const svgParts: string[] = [];

  svgParts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${chartHeight}" viewBox="0 0 ${width} ${chartHeight}" role="img" aria-label="${title}">`,
  );
  svgParts.push(
    `
  <style>
    text { font-family: "Helvetica Neue", Arial, sans-serif; fill: ${theme.text}; }
    .title { font-size: 20px; font-weight: 700; }
    .subtitle { font-size: 12px; fill: ${theme.subtitle}; }
    .footer { font-size: 12px; fill: ${theme.footer}; }
    .label { font-size: 12px; text-anchor: end; fill: ${theme.label}; }
    .value { font-size: 12px; fill: ${theme.value}; }
  </style>
`,
  );

  svgParts.push(`<text class="title" x="${titleX}" y="${titleY}">${title}</text>`);

  if (subtitle) {
    svgParts.push(`<text class="subtitle" x="${subtitleX}" y="${subtitleY}">${subtitle}</text>`);
  }

  const barsGroup: string[] = [];

  data.forEach((datum, index) => {
    const y = margin.top + index * (barHeight + barGap);
    const barWidth = Math.max((datum.value / safeMaxValue) * innerWidth, 0);
    const ratio = total ? datum.value / total : 0;
    const percentText = formatPercent(ratio);
    const valueLabel = `${datum.value} (${percentText})`;
    const barColor = resolveColor(datum.color, themeName);

    barsGroup.push(
      `<g class="bar" data-label="${datum.rawLabel ?? datum.label}"><text class="label" x="${margin.left - 10}" y="${y + barHeight / 2}" dominant-baseline="middle">${datum.label}</text><rect x="${margin.left}" y="${y}" width="${barWidth}" height="${barHeight}" rx="6" fill="${barColor}" /><text class="value" x="${margin.left + barWidth + 8}" y="${y + barHeight / 2}" dominant-baseline="middle">${valueLabel}</text></g>`,
    );
  });

  svgParts.push(`<g class="bars">${barsGroup.join('')}</g>`);

  if (footer) {
    const footerY = chartHeight - margin.bottom + (footerSpace ? footerSpace - 8 : 0);
    svgParts.push(`<text class="footer" x="${footerX}" y="${footerY}">${footer}</text>`);
  }

  svgParts.push('</svg>');

  return `${svgParts.join('')}`;
}

function writeChart(svg: string, filename: string): void {
  const targetPath = path.join(chartsDir, filename);
  fs.writeFileSync(targetPath, `${svg}\n`);
}

function collectStatsEntries(): Array<{ date: string; stats: PackageManagerStats }> {
  const files = fs
    .readdirSync(resultsDir)
    .filter((file) => file.match(/^\d{4}-\d{2}-\d{2}-package-manager-stats\.json$/))
    .sort();

  if (!files.length) {
    throw new Error('No package-manager-stats.json files found in results directory');
  }

  return files.map((file) => {
    const date = file.slice(0, 10);
    const statsPath = path.join(resultsDir, file);
    const stats = readJson<PackageManagerStats>(statsPath);
    return { date, stats };
  });
}

function totalStats(stats: PackageManagerStats): number {
  return Object.values(stats).reduce((sum, value) => sum + value, 0);
}

function buildPopularitySeries(): { dates: string[]; series: LineSeries[] } {
  const entries = collectStatsEntries();
  const dates = entries.map((entry) => entry.date);
  const totals = entries.map((entry) => totalStats(entry.stats) || 1);

  const keys: PackageManager[] = ['npm', 'yarn_modern', 'yarn_classic', 'pnpm', 'bun'];

  const series = keys
    .map((key) => {
      const values = entries.map((entry, index) => {
        const total = totals[index] ?? 1;
        const value = entry.stats[key] ?? 0;
        return (value / total) * 100;
      });

      return {
        key,
        label: PACKAGE_MANAGER_LABELS[key],
        color: PACKAGE_MANAGER_COLORS[key],
        values,
      } satisfies LineSeries;
    })
    .filter((series) => series.values.some((value) => value > 0));

  return { dates, series };
}

function renderLineChart(
  dates: string[],
  series: LineSeries[],
  options: { title: string; subtitle?: string; width?: number; height?: number },
  themeName: ThemeName = 'light',
): string {
  const theme = THEMES[themeName];
  const width = options.width ?? 720;
  const height = options.height ?? 420;
  const margin = { top: 72, right: 120, bottom: 64, left: 64 };
  const titleX = 16;
  const subtitleX = 16;
  const titleY = 24;
  const subtitleY = 42;
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const flatValues = series.flatMap((entry) => entry.values);
  const maxValue = flatValues.length ? Math.max(...flatValues) : 0;
  const yMax = Math.max(20, Math.ceil(maxValue / 20) * 20 || 20);

  const xStep = dates.length > 1 ? innerWidth / (dates.length - 1) : 0;

  const svgParts: string[] = [];
  svgParts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${options.title}">`,
  );
  svgParts.push(
    `
  <style>
    text { font-family: "Helvetica Neue", Arial, sans-serif; fill: ${theme.text}; }
    .title { font-size: 20px; font-weight: 700; }
    .subtitle { font-size: 12px; fill: ${theme.subtitle}; }
    .axis { stroke: ${theme.axis}; stroke-width: 1; }
    .legend { font-size: 12px; fill: ${theme.legend}; }
    .tick { font-size: 12px; fill: ${theme.tick}; }
  </style>
`,
  );

  svgParts.push(`<text class="title" x="${titleX}" y="${titleY}">${options.title}</text>`);
  if (options.subtitle) {
    svgParts.push(
      `<text class="subtitle" x="${subtitleX}" y="${subtitleY}">${options.subtitle}</text>`,
    );
  }

  const yTickStep = 20;
  const yTicksGroup: string[] = [];
  for (let value = 0; value <= yMax; value += yTickStep) {
    const y = margin.top + innerHeight - (value / yMax) * innerHeight;
    yTicksGroup.push(
      `<line class="axis" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" />`,
    );
    yTicksGroup.push(
      `<text class="tick" x="${margin.left - 12}" y="${y}" dominant-baseline="middle" text-anchor="end">${value.toFixed(0)}%</text>`,
    );
  }

  svgParts.push(`<g class="y-ticks">${yTicksGroup.join('')}</g>`);

  const xTicksGroup: string[] = [];
  dates.forEach((date, index) => {
    const x = margin.left + index * xStep;
    xTicksGroup.push(
      `<text class="tick" x="${x}" y="${height - margin.bottom + 18}" text-anchor="middle">${date}</text>`,
    );
  });

  svgParts.push(`<g class="x-ticks">${xTicksGroup.join('')}</g>`);

  const seriesGroup: string[] = [];
  series.forEach((entry) => {
    const seriesColor = resolveColor(entry.color, themeName);
    const points = entry.values
      .map((value, index) => {
        const x = margin.left + index * xStep;
        const y = margin.top + innerHeight - (value / yMax) * innerHeight;
        return `${x},${y}`;
      })
      .join(' ');

    const circles = entry.values
      .map((value, index) => {
        const x = margin.left + index * xStep;
        const y = margin.top + innerHeight - (value / yMax) * innerHeight;
        return `<circle cx="${x}" cy="${y}" r="4" fill="${seriesColor}" />`;
      })
      .join('');

    seriesGroup.push(
      `<g class="series" data-key="${entry.key}"><polyline fill="none" stroke="${seriesColor}" stroke-width="3" points="${points}" />${circles}</g>`,
    );
  });

  svgParts.push(`<g class="series-group">${seriesGroup.join('')}</g>`);

  const legendOffset = 32;
  const legendX = width - margin.right + legendOffset;
  const legendY = margin.top;
  const legendGroup: string[] = [];
  series.forEach((entry, index) => {
    const seriesColor = resolveColor(entry.color, themeName);
    const y = legendY + index * 20;
    legendGroup.push(
      `<g class="legend-item" data-key="${entry.key}"><rect x="${legendX}" y="${y - 10}" width="12" height="12" rx="2" fill="${seriesColor}" /><text class="legend" x="${legendX + 18}" y="${y}" dominant-baseline="middle">${entry.label}</text></g>`,
    );
  });

  svgParts.push(`<g class="legend-group">${legendGroup.join('')}</g>`);

  svgParts.push('</svg>');

  return svgParts.join('');
}

const latestDate = findLatestDate();

const statsPath = path.join(resultsDir, `${latestDate}-package-manager-stats.json`);
const versionStatsPath = path.join(resultsDir, `${latestDate}-package-manager-version-stats.json`);

const packageManagerStats = readJson<PackageManagerStats>(statsPath);
const packageManagerVersionStats = readJson<PackageManagerVersionStats>(versionStatsPath);

const pmChartData = buildChartData(packageManagerStats);
const pmChartLight = renderBarChart(pmChartData, {
  title: 'Package manager usage',
  subtitle: formatDateLabel(latestDate),
});
const pmChartDark = renderBarChart(
  pmChartData,
  {
    title: 'Package manager usage',
    subtitle: formatDateLabel(latestDate),
  },
  'dark',
);

writeChart(pmChartLight, 'package-manager-stats.svg');
writeChart(pmChartDark, 'package-manager-stats-dark.svg');

const versionEntries = Object.entries(packageManagerVersionStats) as Array<
  [Exclude<PackageManager, 'unknown'>, Record<string, number>]
>;

versionEntries.forEach(([pm, stats]) => {
  const { merged, hadMerges } = mergeVersionStats(stats);
  const chartData = buildVersionChartData(pm, merged);
  const total = chartData.reduce((sum, datum) => sum + datum.value, 0);
  const majorVariants = countMajorVariants(merged);

  if (!chartData.length || total === 0 || majorVariants <= 1) {
    return;
  }

  const title = `${PACKAGE_MANAGER_LABELS[pm]} versions`;
  const baseOptions = {
    title,
    subtitle: formatDateLabel(latestDate),
    footer: hadMerges
      ? `* ${PACKAGE_MANAGER_LABELS[pm]} version cannot always be accurately derived; may be guessed from lockfile`
      : undefined,
  } satisfies ChartOptions;

  const chartLight = renderBarChart(chartData, baseOptions, 'light');
  const chartDark = renderBarChart(chartData, baseOptions, 'dark');

  const safeKey = pm.replace(/[^a-z0-9_]+/gi, '_');
  writeChart(chartLight, `package-manager-version-stats-${safeKey}.svg`);
  writeChart(chartDark, `package-manager-version-stats-${safeKey}-dark.svg`);
});

const popularity = buildPopularitySeries();

if (popularity.series.length) {
  const firstDate = popularity.dates[0] ?? latestDate;
  const lastDate = popularity.dates[popularity.dates.length - 1] ?? latestDate;
  const trendOptions = {
    title: 'Package manager popularity over time',
    subtitle: `${formatDateLabel(firstDate)} – ${formatDateLabel(lastDate)}`,
  } as const;

  const trendChartLight = renderLineChart(
    popularity.dates,
    popularity.series,
    trendOptions,
    'light',
  );
  const trendChartDark = renderLineChart(popularity.dates, popularity.series, trendOptions, 'dark');

  writeChart(trendChartLight, 'package-manager-trend.svg');
  writeChart(trendChartDark, 'package-manager-trend-dark.svg');
}
