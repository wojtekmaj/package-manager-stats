# package-manager-stats

Script to get stats about package managers used in most popular projects on GitHub.

## Prerequisites

- [Bun](https://bun.sh)

## Usage

Add `.env` file with GitHub token:

```sh
GITHUB_TOKEN=…
```

Install:

```sh
bun install
```

Run:

```sh
bun start
```

Optionally, you can run script in debug mode to see more logs. Bear in mind that it will take much more time to run.

```sh
DEBUG=true bun start
```
