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
