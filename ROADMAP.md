# Roadmap

What's planned, in the order it's likely to ship. Each item links to its issue; open an
[issue](https://github.com/paureis/cloudpin/issues) to vote for an idea or suggest one.

## 1.0

The `.cloudpin.yml` format is stable from 1.0 on. Everything that changes it shipped in 0.2.0; what is left:

- **Verifiable releases** ([#19](https://github.com/paureis/cloudpin/issues/19),
  [#20](https://github.com/paureis/cloudpin/issues/20)): npm provenance from GitHub Actions and an OpenSSF Scorecard.
- **A week of real use** by the author, then 1.0.0.

## 1.x

- **`cloudpin switch`** ([#14](https://github.com/paureis/cloudpin/issues/14)): move every CLI to the pinned
  accounts in one go, after one confirmation.
- **Claude Code plugin and MCP server** ([#15](https://github.com/paureis/cloudpin/issues/15)): one-click install,
  and read-only tools agents can call to check the account before acting.
- **GitHub Action** ([#10](https://github.com/paureis/cloudpin/issues/10)): `cloudpin check` before deploy jobs.
- **Installers:** Homebrew ([#16](https://github.com/paureis/cloudpin/issues/16)), Scoop and winget
  ([#17](https://github.com/paureis/cloudpin/issues/17)).
- **VS Code / Cursor status bar** ([#18](https://github.com/paureis/cloudpin/issues/18)): a green or red pin
  showing whether the active accounts match the project.
- **Tested inside every agent** ([#2](https://github.com/paureis/cloudpin/issues/2),
  [#3](https://github.com/paureis/cloudpin/issues/3)): Cursor, Gemini CLI and Copilot CLI.

## Ideas

- **More CLIs** ([#11](https://github.com/paureis/cloudpin/issues/11)): `terraform` workspaces, `doctl`, `flyctl`,
  `wrangler` (Cloudflare), `supabase`, `firebase`, `heroku`, `stripe`, `netlify`.
- **Team policy:** a shared file that requires certain projects to be pinned.
- **Fish and Nushell** wrappers.

## Shipped

- **0.2.0** (2026-10-08): environments and protected environments ([#12](https://github.com/paureis/cloudpin/issues/12)),
  Kubernetes for `kubectl` and `helm` ([#13](https://github.com/paureis/cloudpin/issues/13); standalone `kustomize`
  never contacts a cluster, so it isn't guarded), Vercel monorepos and large teams
  ([#4](https://github.com/paureis/cloudpin/issues/4), [#5](https://github.com/paureis/cloudpin/issues/5)), command
  parser gaps ([#7](https://github.com/paureis/cloudpin/issues/7)), and safety-review fixes.
- **0.1.0** (2026-10-08): first public beta.

Details in [CHANGELOG.md](CHANGELOG.md).
