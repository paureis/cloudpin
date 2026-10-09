# Roadmap

What's planned, in the order it's likely to ship. Each item links to its issue; open an
[issue](https://github.com/paureis/cloudpin/issues) to vote for an idea or suggest one.

## 1.0

The `.cloudpin.yml` format is stable from 1.0 on. Everything planned for 1.0 shipped in 0.2.0 to 0.3.0; what is
left:

- **Wrangler against a real Cloudflare login:** the Cloudflare support is built to Wrangler's source and docs.
- **A week of real use** by the author and early testers, then 1.0.0 and the launch
  ([#9](https://github.com/paureis/cloudpin/issues/9)).

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
  `firebase`, `heroku`, `stripe`, `netlify`.
- **Team policy:** a shared file that requires certain projects to be pinned.
- **Fish and Nushell** wrappers.
- **OpenSSF Best Practices silver, then gold** (passing since 2026-10-08,
  [project 15321](https://www.bestpractices.dev/projects/15321)). Silver is mostly writing: governance, a code of
  conduct, a threat model, signed releases and 80% test coverage, plus a second person who could keep the project
  going. Gold needs other contributors: two-person review of most changes and a bus factor of two.

## Shipped

- **0.3.1** (2026-10-09): the update notice and `cloudpin version` ([#50](https://github.com/paureis/cloudpin/issues/50)),
  and no false Supabase warning outside a project ([#48](https://github.com/paureis/cloudpin/issues/48)).
- **0.3.0** (2026-10-09): Supabase and Cloudflare Wrangler ([#37](https://github.com/paureis/cloudpin/issues/37)),
  `cloudpin doctor` ([#35](https://github.com/paureis/cloudpin/issues/35)), `cloudpin explain`
  ([#36](https://github.com/paureis/cloudpin/issues/36)), and the Cursor hook fix
  ([#42](https://github.com/paureis/cloudpin/issues/42)).
- **0.2.1** (2026-10-08): releases published from GitHub Actions with provenance
  ([#19](https://github.com/paureis/cloudpin/issues/19)), OpenSSF Scorecard
  ([#20](https://github.com/paureis/cloudpin/issues/20)) and CodeQL.
- **0.2.0** (2026-10-08): environments and protected environments ([#12](https://github.com/paureis/cloudpin/issues/12)),
  Kubernetes for `kubectl` and `helm` ([#13](https://github.com/paureis/cloudpin/issues/13); standalone `kustomize`
  never contacts a cluster, so it isn't guarded), Vercel monorepos and large teams
  ([#4](https://github.com/paureis/cloudpin/issues/4), [#5](https://github.com/paureis/cloudpin/issues/5)), command
  parser gaps ([#7](https://github.com/paureis/cloudpin/issues/7)), and safety-review fixes.
- **0.1.0** (2026-10-08): first public beta.

Details in [CHANGELOG.md](CHANGELOG.md).
