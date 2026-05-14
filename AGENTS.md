# Repository Guidelines

## Project Structure & Module Organization

- `SKILL.md` defines the agent-facing workflow and input/output contract.
- `scripts/` contains the Node.js implementation:
  - `extract.js` parses `MySQLHealthCheck_*.txt` files into `data.json`.
  - `render.js` renders `data.json` into a `.docx` report.
  - `lib/charts.js` builds embedded report charts.
  - `assets/` stores static assets such as `logo.png`.
- `README.md` and `USAGE.md` are user-facing installation and operation docs.
- `references/` contains design, parsing, rules, and interview guidance.
- `install.sh` installs the skill into a target skill directory.

## Build, Test, and Development Commands

```bash
cd scripts
npm install
npm run extract -- <data-dir> --project "Project Name"
npm run render -- <data-dir>/data.json
npm run build -- <data-dir> --project "Project Name"
```

- `npm install` installs runtime dependencies (`docx`, `@resvg/resvg-js`).
- `npm run extract` creates structured JSON from healthcheck text files.
- `npm run render` creates the Word report from JSON.
- `npm run build` runs extract and render in sequence.

```bash
# from the repository root
bash install.sh --target /tmp/workbuddy-skills
```

## Coding Style & Naming Conventions

The codebase uses CommonJS JavaScript and two-space indentation. Keep scripts dependency-light and compatible with Node.js 16 or newer. Prefer descriptive helper names such as `parseMysqlTable`, `formatBytesNum`, or `renderSection...`.

Main executables live directly in `scripts/`, shared helpers in `scripts/lib/`, and supporting documentation in `references/`. Keep generated report text consistent with the existing Chinese business-report style.

## Testing Guidelines

There is no formal test framework configured. Validate changes with realistic data containing `MySQLHealthCheck_*.txt` files:

```bash
cd scripts
node extract.js <data-dir> --project "Test Project"
node render.js <data-dir>/data.json
```

Check that extraction reports expected node and issue counts, rendering prints the placeholder validation success message, and the generated `.docx` opens in Word or WPS with all 17 chapters present. For parser changes, consult `references/parsing.md`.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commits, often with Chinese descriptions: `feat(install): ...`, `docs(readme): ...`, `chore: ...`, and `feat!: ...` for breaking changes. Keep commits scoped and mention user-visible report changes.

Pull requests should include a summary, affected files or report sections, verification commands, and before/after notes for generated output. Link related issues when available. Include screenshots or sample `.docx` observations when changing layout, charts, fonts, or visual styling.

## Security & Configuration Tips

Do not commit customer healthcheck exports, generated reports, passwords, or production `data.json` files. Treat all `MySQLHealthCheck_*.txt` inputs as sensitive operational data. Keep dependencies pinned through `scripts/package-lock.json`.
