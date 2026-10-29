# Forward setup to the default WSL distribution; install no Windows tooling.
param([switch]$WithBrowser)
$ErrorActionPreference = 'Stop'
$RepositoryDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
	throw 'WSL is required. Install and initialize a default Linux distribution first.'
}
$LinuxRepositoryDirectory = (& wsl.exe --exec wslpath -a $RepositoryDirectory).Trim()
if ($LASTEXITCODE -ne 0 -or -not $LinuxRepositoryDirectory) {
	throw 'Cannot resolve the repository in the default WSL distribution.'
}
$SetupArguments = @('--cd', $LinuxRepositoryDirectory, '--exec', 'bash', './scripts/setup.sh')
if ($WithBrowser) { $SetupArguments += '--with-browser' }
& wsl.exe @SetupArguments
if ($LASTEXITCODE -ne 0) { throw "WSL setup failed (exit $LASTEXITCODE)." }
Write-Host 'Continue inside the default WSL distribution; follow the source command printed above.'
