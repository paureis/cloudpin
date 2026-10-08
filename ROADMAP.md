# Roadmap

What's planned and what's being considered. Nothing here is promised; open an
[issue](https://github.com/paureis/cloudpin/issues) to vote for an idea or suggest one.

## Next

- **Tested inside every agent.** Cursor, Gemini CLI and Copilot CLI hooks are built to each agent's documented
  format; they still need to be exercised inside the real agent, the way Claude Code and Codex were.
- **Vercel monorepo links.** Read repo-level links (`.vercel/repo.json`) as well as project links.

## Ideas

- **More CLIs:** `kubectl` contexts, `terraform` workspaces, `doctl`, `flyctl`, `wrangler` (Cloudflare),
  `supabase`, `firebase`, `heroku`, `stripe`, `netlify`. The provider interface makes each one a small, separate
  addition with its own tests.
- **A GitHub Action** that runs `cloudpin check` before a deploy job.
- **Pinning environments, not just projects:** different accounts for `staging` and `production` in one file,
  chosen by a flag or a branch.
- **Allow lists for safe commands:** let read-only commands (`list`, `show`) through on a mismatch, per CLI, for
  people who prefer fewer stops over stricter checks.
- **Editor integration:** a status bar item in VS Code and Cursor showing whether the active accounts match the
  project.
- **`cloudpin switch`:** switch every CLI to the pinned accounts in one go, using each CLI's own switch command.
- **Team policy:** a shared file that requires certain projects to be pinned.
- **Fish and Nushell** wrappers.

## Done

See [CHANGELOG.md](CHANGELOG.md).
