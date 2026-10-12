# Development workflow

- Read `TODO.md` before development work. It is the active backlog.
- Read `PROJECT_BRIEF.md` for project orientation. Maintain it when entry points, commands, architecture, dependencies, storage, or established decisions change; verify affected claims and update its last-verified date.
- Preserve task IDs. Move tasks between Now, Next, Later, Blocked, and Done.
- Keep at most one task in Now. Record context, Done when, and Verify before implementation.
- Record actual verification and its limits in Evidence before marking Done.
- Mention the task ID in implementation commits; add a Commit reference after committing when practical.
- Keep historical plans as supporting context. Add new work to TODO.md rather than a second backlog.
- App Manager edits the same TODO.md. Re-read it before writing to preserve other changes.
- Store priority in `Priority` (P0/P1/P2/P3), not the title. `Order` breaks ties within a priority.
- `Depends on` uses local IDs or `project:ID` references separated by commas. Resolve dependencies before starting or completing; record decisions in `Notes`.
