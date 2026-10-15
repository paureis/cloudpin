/**
 * Shell functions that route each guarded CLI through `cloudpin exec`.
 * cloudpin then starts the real executable directly (no shell), so the
 * functions never call themselves. If cloudpin is not installed (or was
 * uninstalled), each function runs the real CLI unchanged, so a missing
 * cloudpin can never stop a guarded CLI from working.
 *
 * Aliases (#69): `name() {` fails to parse when `name` is already an alias, and
 * in zsh that stops the whole eval, so the functions use `function name {`,
 * whose name is never alias-expanded. An alias that calls the CLI itself then
 * reaches the function; one that runs another program (kubectl=kubecolor,
 * `command gh`) bypasses it, so each shell start warns about those.
 */
export function shellInit(shell: string, bins: string[]): string {
  switch (shell) {
    case "bash":
    case "zsh": {
      // bash 4+ and zsh expose aliases as an associative array; bash 3.2 (macOS) has none and stays quiet.
      const aliasOf = shell === "bash" ? '${BASH_ALIASES[$__cloudpin_bin]-}' : '${aliases[$__cloudpin_bin]-}';
      return [
        `# cloudpin: guard cloud CLIs. Install: add to your ~/.${shell}rc`,
        `#   eval "$(cloudpin shell-init ${shell})"`,
        "# Remove that line to uninstall.",
        ...bins.map(
          (bin) =>
            `function ${bin} { if command -v cloudpin >/dev/null 2>&1; then command cloudpin exec -- ${bin} "$@"; else command ${bin} "$@"; fi; }`,
        ),
        `for __cloudpin_bin in ${bins.join(" ")}; do`,
        `  __cloudpin_alias="${aliasOf}"`,
        '  __cloudpin_first="${__cloudpin_alias%%[[:space:]]*}"',
        '  if [ -n "$__cloudpin_alias" ] && [ "$__cloudpin_first" != "$__cloudpin_bin" ] && [ "$__cloudpin_first" != "\\\\$__cloudpin_bin" ]; then',
        `    printf "cloudpin: alias %s='%s' runs another program, so %s is not guarded in this shell. Remove the alias to guard it.\\n" "$__cloudpin_bin" "$__cloudpin_alias" "$__cloudpin_bin" >&2`,
        "  fi",
        "done",
        "unset __cloudpin_bin __cloudpin_alias __cloudpin_first",
        "",
      ].join("\n");
    }
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
        // PowerShell runs an alias before a function of the same name, so any alias of a guarded CLI bypasses it (#69).
        `foreach ($__cloudpin_alias in @(Get-Alias -Name ${bins.map((b) => `'${b}'`).join(", ")} -ErrorAction SilentlyContinue)) {`,
        `  [Console]::Error.WriteLine("cloudpin: alias $($__cloudpin_alias.Name) -> $($__cloudpin_alias.Definition) runs instead of the cloudpin wrapper, so $($__cloudpin_alias.Name) is not guarded in this shell. Remove the alias to guard it.")`,
        "}",
        "Remove-Variable __cloudpin_alias -ErrorAction SilentlyContinue",
        "",
      ].join("\n");
    default:
      throw new Error(`unsupported shell "${shell}" (supported: bash, zsh, pwsh)`);
  }
}
