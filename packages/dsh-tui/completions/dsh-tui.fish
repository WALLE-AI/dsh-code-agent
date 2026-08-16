# fish completion for `dsh --profile tui`.
# Install: copy into ~/.config/fish/completions/dsh.fish

complete -c dsh -l alternate-screen -d 'use the alternate screen buffer'
complete -c dsh -l interactive -d 'keep the session open for follow-up input'
complete -c dsh -l no-color -d 'disable semantic terminal colors'
complete -c dsh -l resume -r -d 'resume a session by id, id prefix, or latest' -a 'latest'
complete -c dsh -l permission -r -d 'session permission preset' \
  -a 'read-only workspace-write danger-full-access'
complete -c dsh -l model -r -d 'model override as provider/model:reasoning-effort'
complete -c dsh -l diagnostic-log -r -F -d 'write a redacted diagnostic log to this file'
complete -c dsh -l help -d 'show this help'
