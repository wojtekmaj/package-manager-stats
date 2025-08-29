# package-manager-stats

Script to get stats about package managers used in most popular projects on GitHub.

## Prerequisites

- [Node.js](https://nodejs.org) 22.6 or later with [Corepack](https://nodejs.org/api/corepack.html) enabled

## Usage

Add `.env` file with GitHub token:

```sh
GITHUB_TOKEN=…
```

Install:

```sh
yarn
```

Run:

```sh
yarn start
```

Optionally, you can run script in debug mode to see more logs. Bear in mind that it will take much more time to run.

```sh
DEBUG=true yarn start
```
