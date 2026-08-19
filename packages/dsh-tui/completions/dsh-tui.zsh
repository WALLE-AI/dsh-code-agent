#compdef dsh dshcodecli
# zsh completion for `dshcodecli` and `dsh --profile tui`.
# Install: put this file on $fpath as _dsh and run `compinit`.

_dsh_tui() {
  _arguments -s \
    '--alternate-screen[use the alternate screen buffer]' \
    '(-i --interactive)'{-i,--interactive}'[keep the session open for follow-up input]' \
    '--no-color[disable semantic terminal colors]' \
    '--resume=[resume a session by id, id prefix, or latest]:session:(latest)' \
    '--permission=[session permission preset]:preset:(read-only workspace-write danger-full-access)' \
    '--model=[model override as provider/model:reasoning-effort]:route:' \
    '--diagnostic-log=[write a redacted diagnostic log to this file]:path:_files' \
    '--help[show this help]' \
    '*:task:'
}

_dsh_tui "$@"
