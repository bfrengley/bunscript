#!/usr/bin/env bun

import { $ } from "bun";
import util from "util";
import { exit } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";

function usage(): void {
  console.log(`\
Usage: wt clone <git-url> [dest] - Clone git repo and set it up for worktrees`);
}

function usageError(): void {
  usage();
  exit(2);
}

try {
  switch (Bun.argv[2]) {
    case "clone": {
      await clone(Bun.argv.slice(3));
      break;
    }
    case "cp": {
      await cp(Bun.argv.slice(3));
      break;
    }
    default: {
      usageError();
    }
  }
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
  exit(1);
}

type SourceType<T extends string> = `wt:${T}` | `file:${T}`;

interface WtConfig {
  baseBranch: string;
  sharedFiles?: Record<string, { link?: boolean, source: SourceType<string> }>;
}

async function clone(args: string[]): Promise<void> {
  const { values, positionals } = util.parseArgs({
    options: {
      // why did I want this?
      "no-default": { type: "boolean" },
    },
    strict: true,
    allowPositionals: true,
    args,
  });

  if (positionals.length < 1 || positionals.length > 2) {
    usageError();
  }

  const repo = positionals[0]!;

  if (positionals.length === 1) {
    const repoName = repo
      .replace(/\.git$/, "")
      .slice(repo.lastIndexOf("/") + 1);
    console.log(`cloning ${repo} to ./${repoName}`);
    await fs.mkdir(repoName);
    process.chdir(await fs.realpath("./" + repoName));
  } else {
    const repoDir = positionals[1]!;
    console.log(`cloning ${repo} to ${repoDir}`);
    await fs.mkdir(repoDir, { recursive: true });
    process.chdir(await fs.realpath(repoDir));
  }

  await $`git clone ${repo} .base`;
  // a little bit of cursed magic - checkout out the blank tree for a detached HEAD with no files
  // @ref https://stackoverflow.com/questions/54367011/git-bare-repositories-worktrees-and-tracking-branches
  await $`git checkout $(git commit-tree $(git hash-object -t tree /dev/null) < /dev/null)`.cwd(
    ".base"
  );

  await fs.symlink(path.join(".base", ".git"), ".git");
  let branch = "";
  if (await branchExists("main")) {
    branch = "main";
  } else if (await branchExists("master")) {
    branch = "master";
  } else {
    console.error("no default branch could be found");
    exit(1);
  }

  await $`git worktree add ${branch} ${branch}`;

  await saveConfig(".", { baseBranch: branch });
}

async function cp(args: string[]): Promise<void> {
  const { values, positionals } = util.parseArgs({
    options: {
      link: {
        type: "boolean",
        short: "l",
      },
    },
    strict: true,
    allowPositionals: true,
    args,
  });


}

async function branchExists(branch: string): Promise<boolean> {
  return (
    (await $`git rev-parse --verify --quiet ${branch}`.nothrow().quiet())
      .exitCode === 0
  );
}

const CFG_FILE = ".wt";

async function loadConfig(wtRoot: string): Promise<WtConfig> {
  return await Bun.file(path.join(wtRoot, CFG_FILE)).json();
}

async function saveConfig(wtRoot: string, cfg: WtConfig): Promise<void> {
  await Bun.write(Bun.file(path.join(wtRoot, CFG_FILE)), JSON.stringify(cfg, null, 2));
}
