# bash completion for `dshcodecli` and `dsh --profile tui`.
# Install: source this file, or copy it into /etc/bash_completion.d/.

_dsh_tui_complete() {
  local current previous options presets
  current="${COMP_WORDS[COMP_CWORD]}"
  previous="${COMP_WORDS[COMP_CWORD - 1]}"
  options="-i -r --alternate-screen --interactive --no-color --resume --resume-select --permission --model --diagnostic-log --help"
  presets="read-only workspace-write danger-full-access"

  case "${previous}" in
    --permission)
      COMPREPLY=($(compgen -W "${presets}" -- "${current}"))
      return 0
      ;;
    --diagnostic-log)
      COMPREPLY=($(compgen -f -- "${current}"))
      return 0
      ;;
    -r|--resume)
      COMPREPLY=($(compgen -W "latest" -- "${current}"))
      return 0
      ;;
    --model)
      COMPREPLY=()
      return 0
      ;;
  esac

  if [[ "${current}" == -* ]]; then
    COMPREPLY=($(compgen -W "${options}" -- "${current}"))
    return 0
  fi
  COMPREPLY=()
  return 0
}

complete -F _dsh_tui_complete dsh dshcodecli
