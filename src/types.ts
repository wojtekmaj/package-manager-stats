export type PackageManager = 'npm' | 'yarn_classic' | 'yarn_modern' | 'pnpm' | 'bun' | 'unknown';

export type PackageManagerStats = Record<PackageManager, number>;

export type PackageManagerVersionStats = Record<
  Exclude<PackageManager, 'unknown'>,
  Record<string, number>
>;

export type PackageManagerMonorepoStats = Record<
  PackageManager,
  {
    is_monorepo: number;
    is_not_monorepo: number;
  }
>;

export type RepositoryTree = {
  truncated: boolean;
  tree: Array<{
    path: string;
    type: 'blob' | 'tree' | 'commit';
  }>;
};

export type SearchResult = {
  full_name: string;
  url: string;
  html_url: string;
  default_branch: string;
  stargazers_count: number;
};

export type SearchResultsPage = {
  total_count: number;
  items: SearchResult[];
};
