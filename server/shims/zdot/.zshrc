# 转源真实 .zshrc（starship/nvm/… 都先跑完），然后一锤定音：shim 目录顶到 PATH 最前
[[ -f "$SSHX_REAL_ZDOTDIR/.zshrc" ]] && source "$SSHX_REAL_ZDOTDIR/.zshrc"
if [[ -n "$SSHX_SHIM_DIR" ]]; then
  typeset -U path PATH
  path=("$SSHX_SHIM_DIR" $path)
  export SSHX_BOOTSTRAPPED=1
fi
