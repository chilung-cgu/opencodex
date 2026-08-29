# 000 — `--restart-codex` misses `codex.opencodex-real` shim backup binaries

## The report

On remote hosts where Codex autostart shim is installed (`~/.local/bin/codex`), running `ocx sync --restart-codex`
reports zero app-server processes stopped, leaving long-lived app-servers holding stale in-memory model catalogs.

## What is actually running there

`ps -ef` on the affected host:

```
ubuntu  3600609  1  0 04:35 ?  /home/ubuntu/.local/bin/codex.opencodex-real -c features.code_mode_host=true app-server --listen unix://
```

## The defect

`isCodexExecutableToken` in `src/codex/app-server-processes.ts` checked only `codex`, `codex.exe`, `codex.cmd`,
and Rust target triples. When the autostart shim moves the original launcher to `codex.opencodex-real`,
the process command line starts with `codex.opencodex-real` and fails `isCodexExecutableToken`, so `--restart-codex`
ignores it entirely.

## The fix

Admit `codex.opencodex-real`, `codex.opencodex-real.exe`, and `codex.opencodex-real.cmd` in `isCodexExecutableToken`
and in `WINDOWS_CODEX_BASENAME_CANDIDATE_RE`.
