# ==============================================================================
# Deltix-Server one-line bootstrap installer (Windows).
#
# Downloads the source tarball for a Deltix-Server release (the latest one
# by default) and runs scripts/install-windows.ps1 against it, so a brand-new
# Windows Server machine with nothing installed can go from zero to a running
# service with a single command (elevated PowerShell):
#
#   iwr -useb https://raw.githubusercontent.com/SammyBytes/Deltix-Server/main/scripts/get-deltix.ps1 | iex
#
# To pin a specific version instead of the latest release:
#
#   $env:DELTIX_VERSION = "0.5.2"
#   iwr -useb https://raw.githubusercontent.com/SammyBytes/Deltix-Server/main/scripts/get-deltix.ps1 | iex
#
# This script only downloads and extracts; scripts/install-windows.ps1 (run
# afterwards) is the one that installs Bun, the pinned Dolt version, creates
# the Windows Service, and generates the required secrets. Pass -Unattended
# through via $env:DELTIX_UNATTENDED = "true" for a fully non-interactive run.
# ==============================================================================

param(
    [string]$Version = $env:DELTIX_VERSION,
    [switch]$Unattended = ($env:DELTIX_UNATTENDED -eq "true")
)

$ErrorActionPreference = "Stop"
$Repo = "SammyBytes/Deltix-Server"

function Log-Info  { param([string]$Message) Write-Host "[INFO]  $Message" -ForegroundColor Gray }
function Log-Error { param([string]$Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Log-Error "This script must be run from an elevated (Administrator) PowerShell session -- it installs a Windows Service."
    exit 1
}

if (-not $Version) {
    Log-Info "No version pinned, resolving latest release tag..."
    try {
        $latest = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$Repo/releases/latest"
        $Version = $latest.tag_name.TrimStart("v")
    } catch {
        Log-Error "Could not resolve the latest release tag. Set `$env:DELTIX_VERSION and retry. ($($_.Exception.Message))"
        exit 1
    }
}

$Tag = "v$Version"
$Asset = "deltix-server-$Version.tar.gz"
$Url = "https://github.com/$Repo/releases/download/$Tag/$Asset"

$WorkDir = Join-Path $env:TEMP ("deltix-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

try {
    $archivePath = Join-Path $WorkDir $Asset
    Log-Info "Downloading $Asset ($Tag)..."
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $archivePath
    } catch {
        Log-Error "Failed to download $Url"
        Log-Error "Check available releases at https://github.com/$Repo/releases"
        exit 1
    }

    Log-Info "Extracting..."
    # tar.exe ships built in on Windows 10 1803+ / Windows Server 2019+ and
    # understands .tar.gz directly -- no extra dependency required.
    tar -xzf $archivePath -C $WorkDir
    if ($LASTEXITCODE -ne 0) {
        Log-Error "Failed to extract $archivePath (tar exited with $LASTEXITCODE)."
        exit 1
    }

    $sourceDir = Join-Path $WorkDir "deltix-server-$Version"
    $installerPath = Join-Path $sourceDir "scripts\install-windows.ps1"
    if (-not (Test-Path $installerPath)) {
        Log-Error "Extracted archive is missing scripts\install-windows.ps1 -- unexpected tarball layout."
        exit 1
    }

    Log-Info "Running the installer from $sourceDir..."
    if ($Unattended) {
        & $installerPath -Unattended -StartService
    } else {
        & $installerPath
    }
} finally {
    Remove-Item -Path $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
}
