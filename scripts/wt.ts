#!/usr/bin/env bun

import { $ } from "bun";
import util from "util";
import { exit } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";

function usage(): void {
  console.log(`\
Usage: wt <COMMAND> [OPTIONS] - Manage git worktrees.

A wt-based git repo will have the following structure:
- repo: The root directory. wt commands which deal with relative paths will consider them relative
        to this directory (e.g., cp).
  - .base/: The repo clone that is used as the base for the underlying \`git worktree\` commands.
            Always checked out to an empty tree (i.e., it contains no files).
  - .git/: A symlink to .base/.git. Allows the use of git commands in the root repo directory.
  - .wt: The wt config file.
  - (main/master)/: The default worktree which tracks the main branch of the repo. Detects the name
                    automatically.
  - <worktrees>/: Other worktrees, as they are created and removed.

Commands:
  clone GIT-URL [DEST] - Clone git repo and set it up for worktrees
      DEST: If provided, the repo will be cloned to that location; otherwise, it will be cloned
            into a directory as chosen by \`git clone <git-url>\`.

  cp [--once|-o] [--link|-l] [SRC DEST]... - Copy files into all worktrees
      --once|-o: Perform a one-off copy. Otherwise, a default copy action will be set up that will
                 be executed for every new worktree (allowing you to automatically add ignored files
                 or external files to every worktree).
      --link|-l: Symlink the file rather than making a copy. All worktrees will share the file rather
                 than having independent copies.
      SRC: The location to copy from. Can be either a simple path or wt:worktree_name. If a worktree
           name is provided, dest will be interpreted as both the path in that worktree to copy from
           and the destination in each other worktree. Otherwise, the path to a file or directory.
      DEST: The destination to copy to. MUST be a relative path, which is considered relative to
            each worktree.
`);
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
type SharedFileSettings = { link?: boolean, source: SourceType<string> };

interface WtConfig {
  baseBranch: string;
  sharedFiles?: Record<string, SharedFileSettings>;
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
      once: {
        type: "boolean",
        short: "o",
      },
    },
    strict: true,
    allowPositionals: true,
    args,
  });

  if (positionals.length !== 0) {
    if (positionals.length % 2 !== 0) {
      console.error("unexpected number of arguments: arguments must be provided as [SRC DEST] pairs");
      exit(2);
    }

    const files: Record<string, SharedFileSettings> = {};
    for (let i = 0; i < positionals.length; i += 2) {
      const src = positionals[i]!;
      const dest = positionals[i + 1]!;

      if (path.isAbsolute(dest)) {
        console.error(`dest paths must be relative: "${dest}" is absolute`);
        exit(2);
      }

      if (src.startsWith("wt:")) {
        const tree = src.slice(3);
        files[dest] = { link: values.link, source: `wt:${tree}` };
      }
    }

    if (values.once) {
      // just a simple copy
    }
  }
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
