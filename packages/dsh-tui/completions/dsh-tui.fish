# fish completion for `dshcodecli` and `dsh --profile tui`.
# Install: copy into ~/.config/fish/completions/dsh.fish

for cmd in dsh dshcodecli
  complete -c $cmd -l alternate-screen -d 'use the alternate screen buffer'
  complete -c $cmd -s i -l interactive -d 'keep the session open for follow-up input'
  complete -c $cmd -l no-color -d 'disable semantic terminal colors'
  complete -c $cmd -s r -l resume -r -d 'resume a session by id, id prefix, or latest' -a 'latest'
  complete -c $cmd -l resume-select -d 'open the session browser at startup'
  complete -c $cmd -l permission -r -d 'session permission preset' \
    -a 'read-only workspace-write danger-full-access'
  complete -c $cmd -l model -r -d 'model override as provider/model:reasoning-effort'
  complete -c $cmd -l diagnostic-log -r -F -d 'write a redacted diagnostic log to this file'
  complete -c $cmd -l help -d 'show this help'
end
