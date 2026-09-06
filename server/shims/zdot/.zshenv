# sshx PTY 引导：转源用户真实 zdotdir（含 ~/.zshenv），行为对用户无感
if [[ -z "$SSHX_BOOTSTRAPPED" && -n "$SSHX_REAL_ZDOTDIR" && "$ZDOTDIR" != "$SSHX_REAL_ZDOTDIR" ]]; then
  [[ -f "$SSHX_REAL_ZDOTDIR/.zshenv" ]] && source "$SSHX_REAL_ZDOTDIR/.zshenv"
fi
