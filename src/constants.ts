// Default - most starred repositories, period
export const QUERY = 'stars:>1';
// Alt 1 - repositories with 1000+ stars, created in the last year
// const oneYearAgo = new Date();
// oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
// oneYearAgo.setHours(0, 0, 0, 0);
// export const QUERY = `stars:>1000 created:>${oneYearAgo.toISOString().slice(0, 10)}`;
// Alt 2 - repositories with 500+ stars, created in the last 6 months
// const sixMonthsAgo = new Date();
// sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
// sixMonthsAgo.setHours(0, 0, 0, 0);
// export const QUERY = `stars:>500 created:>${sixMonthsAgo.toISOString().slice(0, 10)}`;

export const CACHE_DIR = '.cache';

export const GITHUB_API_URL = 'https://api.github.com';

// Each GitHub search results page has 30 items, we can fetch 1000 results with 34 requests
export const MAX_PAGES = 34;
