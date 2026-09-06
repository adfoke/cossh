# 转源真实 .zprofile（macOS 的 path_helper 在这里重排 PATH，所以最后一步由 .zshrc 扳回）
[[ -f "$SSHX_REAL_ZDOTDIR/.zprofile" ]] && source "$SSHX_REAL_ZDOTDIR/.zprofile"
