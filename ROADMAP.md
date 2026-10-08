# Roadmap

What's planned, in the order it's likely to ship. Each item links to its issue; open an
[issue](https://github.com/paureis/cloudpin/issues) to vote for an idea or suggest one.

## 1.0

The `.cloudpin.yml` format is stable from 1.0 on, so everything that changes it lands first.

- **Environments** ([#12](https://github.com/paureis/cloudpin/issues/12)): `staging` and `production` pins in one
  file, chosen with `cloudpin use <env>`, `CLOUDPIN_ENV` or a branch mapping. Environments marked `protected` ask
  before any command that changes something: a one-line confirmation in your terminal, the agent's own approval
  prompt for AI agents, and `CLOUDPIN_CONFIRM` in CI. Read-only commands (list, get, describe, logs) pass.
- **Kubernetes** ([#13](https://github.com/paureis/cloudpin/issues/13)): pin the cluster (by API server URL) and
  namespace for `kubectl`, `helm` and `kustomize`.
- **Vercel monorepos and large teams** ([#4](https://github.com/paureis/cloudpin/issues/4),
  [#5](https://github.com/paureis/cloudpin/issues/5)).
- **Command parser gaps** ([#7](https://github.com/paureis/cloudpin/issues/7)): heredocs and commands held in
  variables.

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

## Done

See [CHANGELOG.md](CHANGELOG.md).
