/**
 * Shell functions that route each guarded CLI through `cloudpin exec`.
 * cloudpin then starts the real executable directly (no shell), so the
 * functions never call themselves.
 */
export function shellInit(shell: string, bins: string[]): string {
  switch (shell) {
    case "bash":
    case "zsh":
      return [
        `# cloudpin: guard cloud CLIs. Install: add to your ~/.${shell}rc`,
        `#   eval "$(cloudpin shell-init ${shell})"`,
        "# Remove that line to uninstall.",
        ...bins.map((bin) => `${bin}() { command cloudpin exec -- ${bin} "$@"; }`),
        "",
      ].join("\n");
    case "pwsh":
    case "powershell":
      return [
        "# cloudpin: guard cloud CLIs. Install: add to your PowerShell profile ($PROFILE)",
        "#   cloudpin shell-init pwsh | Out-String | Invoke-Expression",
        "# Remove that line to uninstall.",
        ...bins.map(
          (bin) =>
            `function ${bin} { if ($MyInvocation.ExpectingInput) { $input | cloudpin exec -- ${bin} @args } else { cloudpin exec -- ${bin} @args } }`,
        ),
        "",
      ].join("\n");
    default:
      throw new Error(`unsupported shell "${shell}" (supported: bash, zsh, pwsh)`);
  }
}
