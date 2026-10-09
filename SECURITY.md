# Security policy

## Reporting a vulnerability

Please report security problems privately through
[GitHub's private vulnerability reporting](https://github.com/paureis/cloudpin/security/advisories/new) rather than
in a public issue. You'll get a reply within a few days, and credit in the release notes if you'd like it.

Examples of what counts as a security problem here:

- a way for a command to run on an account other than the pinned one without `CLOUDPIN_SKIP`;
- a way for an agent to bypass the hook;
- cloudpin printing, logging or storing a credential;
- command injection through arguments that cloudpin passes to a CLI.

## What cloudpin does with your accounts

- It runs each CLI's own identity command (`az account show`, `aws sts get-caller-identity`, `gcloud config list`,
  `vercel teams ls`, `gh api user`, `supabase projects list`, `wrangler whoami --json`) with the same flags and
  environment as your command, and reads the result. For Kubernetes, Supabase and Wrangler it also reads project
  files that name the target (the kubeconfig, `supabase/.temp/`, the Wrangler config and its account cache).
- It never logs in, logs out or switches accounts, and never uses or stores a token or key. Credential files are not
  read, with one exception: the kubeconfig, which can hold credentials next to the cluster list; cloudpin takes only
  the server and namespace from it. For Vercel it checks whether a login file exists, without reading it.
- It stores successful identity answers for up to five minutes in a cache file in your user cache folder. Keys are
  salted hashes, so tokens and command arguments are never written in clear.
- It has no telemetry and sends nothing of its own.

## Supported versions

Security fixes go into the latest release.
