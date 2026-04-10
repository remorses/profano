# Changelog

## 0.0.2

1. **Added `--sort` option** — sort results by self-time (default) or total/inclusive time:

   ```bash
   # sort by total/inclusive time to find expensive callers
   profano profile.cpuprofile --sort total

   # sort by self-time to find hot inner functions (default)
   profano profile.cpuprofile --sort self
   ```

2. **New Total and %Total columns** — the output table now shows both self-time and total (inclusive) time per function, with percentages calculated against non-idle active samples:

   ```
      Self  %Self    Total  %Total  Function                        Location
   ───────  ──────  ───────  ──────  ──────────────────────────────  ────────────────────
      3402   29.5%    6804   58.9%  parseAsync                      src/parser.ts:142
   ```

3. **AI agent skill** — profano now ships a `skills/profano/SKILL.md` that teaches AI coding agents (Claude Code, Cursor, Windsurf) when and how to CPU profile JS/TS programs. Install it with:

   ```bash
   npx -y skills add remorses/profano
   ```

## 0.0.1

Initial release. Self-time table from V8 `.cpuprofile` files in the terminal.
