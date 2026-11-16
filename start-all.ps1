# Starts the Stremio streaming server (headless, no Stremio window) and the
# prefetch helper in the background. Anything already running is left alone.

$ErrorActionPreference = 'Stop'

$stremioDir = Join-Path $env:LOCALAPPDATA 'Programs\LNV\Stremio-4'
$runtime = Join-Path $stremioDir 'stremio-runtime.exe'
$helperDir = Join-Path $PSScriptRoot 'helper'
$logDir = Join-Path $PSScriptRoot 'logs'

if (-not (Test-Path $runtime)) { throw "Stremio runtime not found at $runtime" }
New-Item -ItemType Directory -Force $logDir | Out-Null

function Test-Listening([int]$port) {
    [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

function Wait-Listening([int]$port, [int]$seconds = 30) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Listening $port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Start-Background([string]$name, [int]$port, [string]$script, [string]$workDir, [string]$log) {
    if (Test-Listening $port) {
        Write-Output "$name already running (port $port)"
        return
    }
    Start-Process -FilePath $runtime -ArgumentList "`"$script`"" -WorkingDirectory $workDir -WindowStyle Hidden `
        -RedirectStandardOutput "$log.log" -RedirectStandardError "$log.err.log" | Out-Null
    if (Wait-Listening $port) {
        Write-Output "$name started (port $port)"
    } else {
        Write-Output "$name did not start within 30s, see $log.err.log"
    }
}

Start-Background 'Stremio server' 11470 (Join-Path $stremioDir 'server.js') $stremioDir (Join-Path $logDir 'stremio-server')
Start-Background 'Prefetch helper' 11480 (Join-Path $helperDir 'server.js') $helperDir (Join-Path $logDir 'helper')

$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.PrefixOrigin -in 'Dhcp', 'Manual' -and $_.IPAddress -notlike '169.*' } |
    Select-Object -First 1).IPAddress
Write-Output ''
Write-Output "Helper URL for the extension: http://${ip}:11480"
Write-Output "Stop everything with: stop-all.ps1"
