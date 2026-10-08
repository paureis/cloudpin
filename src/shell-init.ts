/**
 * Shell functions that route each guarded CLI through `cloudpin exec`.
 * cloudpin then starts the real executable directly (no shell), so the
 * functions never call themselves. If cloudpin is not installed (or was
 * uninstalled), each function runs the real CLI unchanged, so a missing
 * cloudpin can never stop az, aws, gcloud, vercel or gh from working.
 */
export function shellInit(shell: string, bins: string[]): string {
  switch (shell) {
    case "bash":
    case "zsh":
      return [
        `# cloudpin: guard cloud CLIs. Install: add to your ~/.${shell}rc`,
        `#   eval "$(cloudpin shell-init ${shell})"`,
        "# Remove that line to uninstall.",
        ...bins.map(
          (bin) =>
            `${bin}() { if command -v cloudpin >/dev/null 2>&1; then command cloudpin exec -- ${bin} "$@"; else command ${bin} "$@"; fi; }`,
        ),
        "",
      ].join("\n");
    case "pwsh":
    case "powershell":
      return [
        "# cloudpin: guard cloud CLIs. Install: add to your PowerShell profile ($PROFILE)",
        "#   cloudpin shell-init pwsh | Out-String | Invoke-Expression",
        "# Remove that line to uninstall.",
        ...bins.map((bin) =>
          [
            `function ${bin} {`,
            `  if (Get-Command cloudpin -CommandType Application -ErrorAction SilentlyContinue) {`,
            `    if ($MyInvocation.ExpectingInput) { $input | cloudpin exec -- ${bin} @args } else { cloudpin exec -- ${bin} @args }`,
            `  } else {`,
            `    $real = (Get-Command ${bin} -CommandType Application | Select-Object -First 1).Source`,
            `    if ($MyInvocation.ExpectingInput) { $input | & $real @args } else { & $real @args }`,
            `  }`,
            `}`,
          ].join("\n"),
        ),
        "",
      ].join("\n");
    default:
      throw new Error(`unsupported shell "${shell}" (supported: bash, zsh, pwsh)`);
  }
}
