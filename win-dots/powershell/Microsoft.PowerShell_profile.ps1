$Env:KOMOREBI_CONFIG_HOME = 'C:\Users\sadik\.config\komorebi'
if ($PSVersionTable.PSVersion.Major -ge 7) {
    oh-my-posh init pwsh --config "1_shell" | Invoke-Expression
}