# bunscript

`bunscript` is a tool to help simplify the use of TypeScript as a scripting language via Bun.

## Why is it necessary?

It's not&mdash;Bun is already good by itself. This exists just to suit my personal workflow and to
make the use of TypeScript as the scripting language easier by providing a package which already
has the tsconfig and appropriate type packages installed.

## Installation

1. Make sure you have [Bun installed](https://bun.com/docs/installation).
2. Add Bun's bin directory (`~/.bun/bin` by default) to `$PATH` if your installation method doesn't
  do it for you.
3. Clone this repo (you could probably use `bun install -g` to install it directly from git but
  I haven't tried)
4. Inside the repo, run `bun link`
5. Run `bunscript -h` to make sure it's working.
