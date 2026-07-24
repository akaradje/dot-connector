# Removes the Dot-Connector AI from Windows startup.
$startup = [Environment]::GetFolderPath('Startup')
$target = Join-Path $startup 'DotConnectorAI.vbs'
if (Test-Path $target) {
    Remove-Item $target -Force
    Write-Output "Removed from startup: $target"
} else {
    Write-Output "Not installed in startup."
}
