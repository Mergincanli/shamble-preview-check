# shamble-preview-check

A throwaway test repository for SHAMBLE FRONTLINES' preview hosting check (ADR 0006, spike 1): it tests Cloudflare
Pages as the host of the game and of every pull request's preview link. The plan, the results and the report live in
the game's repository. This repository is archived when the check ends.

- `site/`: the one-page test site (a page, a module worker, a tiny WebAssembly file, a stand-in content file).
- `tools/`: the build script (seven modes) and the check scripts (headers, sizes, deletion, the login wall, browsers).
- `.github/workflows/`: the throwaway workflows. Every deploy waits for the owner's approval in the `preview`
  environment.
