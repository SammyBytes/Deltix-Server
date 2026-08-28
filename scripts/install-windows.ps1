# ==============================================================================
# Deltix Enterprise Control Plane - Windows Production Installer
#
# PowerShell installer and Windows Service configuration for Bun v1.4.
# Strictly English, zero emojis, hardened security defaults.
# ==============================================================================

[CmdletBinding()]
param (
    [string]$InstallDir = "C:\Program Files\Deltix",
    [string]$DataDir = "C:\ProgramData\Deltix",
    [string]$ServiceName = "DeltixServer",
    [int]$HttpPort = 9090,
    [int]$GrpcPort = 50051,
    [string]$BunPath = "",
    [switch]$Unattended,
    [switch]$StartService
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ------------------------------------------------------------------------------
# Logging Functions
# ------------------------------------------------------------------------------
function Log-Info {
    param([string]$Message)
    Write-Host "[INFO]  $Message" -ForegroundColor Gray
}

function Log-Success {
    param([string]$Message)
    Write-Host "[SUCCESS] $Message" -ForegroundColor Green
}

function Log-Warn {
    param([string]$Message)
    Write-Host "[WARN]  $Message" -ForegroundColor Yellow
}

function Log-Error {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
}

# ------------------------------------------------------------------------------
# Administrator Privilege Verification
# ------------------------------------------------------------------------------
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Log-Error "This installation script requires elevated Administrator privileges."
    Log-Error "Please right-click PowerShell and select 'Run as Administrator', then execute this script again."
    exit 1
}

Log-Info "Starting Deltix installation on Windows..."

# ------------------------------------------------------------------------------
# Bun Executable Detection
# ------------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($BunPath)) {
    $bunCmd = Get-Command "bun" -ErrorAction SilentlyContinue
    if ($bunCmd) {
        $BunPath = $bunCmd.Source
    } elseif (Test-Path "$env:USERPROFILE\.bun\bin\bun.exe") {
        $BunPath = "$env:USERPROFILE\.bun\bin\bun.exe"
    } elseif (Test-Path "C:\Program Files\Bun\bun.exe") {
        $BunPath = "C:\Program Files\Bun\bun.exe"
    }
}

if ([string]::IsNullOrWhiteSpace($BunPath) -or -not (Test-Path $BunPath)) {
    Log-Info "Bun runtime not found in system PATH. Attempting automatic installation..."
    try {
        Invoke-Expression "& {$(Invoke-RestMethod -Uri 'https://bun.sh/install.ps1')}"
        if (Test-Path "$env:USERPROFILE\.bun\bin\bun.exe") {
            $BunPath = "$env:USERPROFILE\.bun\bin\bun.exe"
        }
    } catch {
        Log-Error "Failed to install Bun automatically: $_"
        Log-Error "Please install Bun manually from https://bun.sh and re-run this script with -BunPath <path>."
        exit 1
    }
}

if (-not (Test-Path $BunPath)) {
    Log-Error "Bun executable could not be verified at: $BunPath"
    exit 1
}

$bunVersion = & $BunPath --version
Log-Info "Verified Bun runtime: $BunPath (v$bunVersion)"

# ------------------------------------------------------------------------------
# Dolt Binary — Version-Pinned Installation
#
# Deltix pins an exact Dolt release (never "latest") so an upstream Dolt
# change can never silently break a running Deltix instance on its next
# reinstall/upgrade. The pinned version lives in a single file (DOLT_VERSION)
# shipped alongside this script.
# ------------------------------------------------------------------------------
$scriptDir = Split-Path -Parent $PSScriptRoot
$doltVersionFile = Join-Path $scriptDir "DOLT_VERSION"
if (Test-Path $doltVersionFile) {
    $pinnedDoltVersion = (Get-Content $doltVersionFile -Raw).Trim()
} else {
    $pinnedDoltVersion = "2.3.1"
    Log-Warn "DOLT_VERSION file not found next to install-windows.ps1; falling back to $pinnedDoltVersion."
}

$installedDoltVersion = $null
$doltCmd = Get-Command "dolt" -ErrorAction SilentlyContinue
if ($doltCmd) {
    $versionOutput = & $doltCmd.Source version 2>$null | Select-Object -First 1
    if ($versionOutput -match '(\d+\.\d+\.\d+)') { $installedDoltVersion = $Matches[1] }
}

$doltInstallDir = "C:\Program Files\Deltix-Tools\dolt-$pinnedDoltVersion"
if ($installedDoltVersion -eq $pinnedDoltVersion) {
    Log-Info "Dolt $pinnedDoltVersion already installed at $($doltCmd.Source) — skipping download."
} else {
    if ($installedDoltVersion) {
        Log-Warn "Found Dolt $installedDoltVersion in PATH, but Deltix pins $pinnedDoltVersion. Installing the pinned version alongside it."
    } else {
        Log-Info "Dolt binary not found. Installing pinned version $pinnedDoltVersion..."
    }
    $doltZipUrl = "https://github.com/dolthub/dolt/releases/download/v$pinnedDoltVersion/dolt-windows-amd64.zip"
    $doltTmpZip = Join-Path $env:TEMP "dolt-$pinnedDoltVersion.zip"
    $doltTmpExtract = Join-Path $env:TEMP "dolt-$pinnedDoltVersion-extract"
    try {
        Log-Info "Downloading $doltZipUrl..."
        Invoke-WebRequest -Uri $doltZipUrl -OutFile $doltTmpZip -UseBasicParsing
        if (Test-Path $doltTmpExtract) { Remove-Item $doltTmpExtract -Recurse -Force }
        Expand-Archive -Path $doltTmpZip -DestinationPath $doltTmpExtract -Force
        New-Item -ItemType Directory -Path $doltInstallDir -Force | Out-Null
        $extractedBin = Get-ChildItem -Path $doltTmpExtract -Filter "dolt.exe" -Recurse | Select-Object -First 1
        Copy-Item -Path $extractedBin.FullName -Destination "$doltInstallDir\dolt.exe" -Force
        $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
        if ($machinePath -notlike "*$doltInstallDir*") {
            [Environment]::SetEnvironmentVariable("Path", "$machinePath;$doltInstallDir", "Machine")
            $env:Path = "$env:Path;$doltInstallDir"
        }
        Log-Success "Installed Dolt $pinnedDoltVersion at $doltInstallDir\dolt.exe (added to system PATH)."
    } catch {
        Log-Error "Failed to download/install Dolt $pinnedDoltVersion for windows-amd64: $_"
        Log-Error "Install Dolt manually from https://github.com/dolthub/dolt/releases/tag/v$pinnedDoltVersion and re-run."
        exit 1
    } finally {
        Remove-Item $doltTmpZip -Force -ErrorAction SilentlyContinue
        Remove-Item $doltTmpExtract -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ------------------------------------------------------------------------------
# Interactive Configuration Wizard
#
# Everything below has a parameter default, so `-Unattended` (or running
# from a non-interactive host, e.g. CI) reproduces today's zero-prompt
# behavior exactly. Interactively, we ask for the choices that matter most —
# ports and whether this process terminates TLS itself — instead of leaving
# the operator to hand-edit deltix.env or config.json afterward.
# ------------------------------------------------------------------------------
$tlsMode = "none"
$tlsHostname = $null
$tlsCertPath = $null
$tlsKeyPath = $null
$isInteractive = (-not $Unattended) -and [Environment]::UserInteractive -and (-not [Console]::IsInputRedirected)

if ($isInteractive) {
    Write-Host ""
    Write-Host "=================================================================="
    Write-Host " Deltix Server - Interactive Setup"
    Write-Host "=================================================================="
    $answer = Read-Host "HTTP control plane port [$HttpPort]"
    if ($answer) { $HttpPort = [int]$answer }

    $answer = Read-Host "gRPC transfer engine port [$GrpcPort]"
    if ($answer) { $GrpcPort = [int]$answer }

    Write-Host ""
    Write-Host "TLS for the HTTP control plane and Admin Web UI:"
    Write-Host "  1) None - plain HTTP (fine behind a reverse proxy that already terminates TLS)"
    Write-Host "  2) Self-signed certificate - generated now for a hostname or IP you provide"
    Write-Host "  3) Existing certificate - point at a cert/key you already have"
    $answer = Read-Host "Choose [1]"
    switch ($answer) {
        "2" {
            $tlsMode = "self-signed"
            $tlsHostname = Read-Host "Hostname or IP this server will be reached at"
        }
        "3" {
            $tlsMode = "existing"
            $tlsCertPath = Read-Host "Path to certificate file (.crt/.pem)"
            $tlsKeyPath = Read-Host "Path to private key file (.key/.pem)"
        }
        default { $tlsMode = "none" }
    }

    Write-Host ""
    $answer = Read-Host "Start the Windows service now after installation? [y/N]"
    if ($answer -match '^(y|yes)$') { $StartService = $true }
    Write-Host "=================================================================="
    Write-Host ""
}

if ($tlsMode -eq "self-signed" -and -not $tlsHostname) {
    Log-Error "Self-signed TLS requires a hostname or IP."
    exit 1
}
if ($tlsMode -eq "existing" -and (-not $tlsCertPath -or -not $tlsKeyPath)) {
    Log-Error "Existing TLS mode requires both a certificate path and a key path."
    exit 1
}

# ------------------------------------------------------------------------------
# Directory Setup & Access Control Lists
# ------------------------------------------------------------------------------
Log-Info "Creating installation and data directory hierarchy..."

$directories = @(
    $InstallDir,
    $DataDir,
    "$DataDir\keys",
    "$DataDir\db",
    "$DataDir\staging",
    "$DataDir\repos",
    "$DataDir\certs",
    "$DataDir\config",
    "$DataDir\logs"
)

foreach ($dir in $directories) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}

# Harden permissions on ProgramData\Deltix: SYSTEM and Administrators full control
try {
    icacls "$DataDir" /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" /T /Q | Out-Null
    Log-Info "Applied secure filesystem ACLs on: $DataDir"
} catch {
    Log-Warn "Failed to apply restrictive ACLs with icacls: $_"
}

# ------------------------------------------------------------------------------
# Copy Application Files
# ------------------------------------------------------------------------------
Log-Info "Deploying application code to $InstallDir..."

if (Test-Path "$scriptDir\src") {
    Copy-Item -Path "$scriptDir\src" -Destination "$InstallDir\" -Recurse -Force
    if (Test-Path "$scriptDir\package.json") { Copy-Item -Path "$scriptDir\package.json" -Destination "$InstallDir\" -Force }
    if (Test-Path "$scriptDir\tsconfig.json") { Copy-Item -Path "$scriptDir\tsconfig.json" -Destination "$InstallDir\" -Force }
    if (Test-Path "$scriptDir\scripts") { Copy-Item -Path "$scriptDir\scripts" -Destination "$InstallDir\" -Recurse -Force }
    if (Test-Path "$scriptDir\DOLT_VERSION") { Copy-Item -Path "$scriptDir\DOLT_VERSION" -Destination "$InstallDir\" -Force }
    if (Test-Path "$scriptDir\bun.lock") { Copy-Item -Path "$scriptDir\bun.lock" -Destination "$InstallDir\" -Force }
    if (Test-Path "$scriptDir\packages") { Copy-Item -Path "$scriptDir\packages" -Destination "$InstallDir\" -Recurse -Force }
    if (Test-Path "$scriptDir\proto") { Copy-Item -Path "$scriptDir\proto" -Destination "$InstallDir\" -Recurse -Force }
}

# Install dependencies if node_modules missing
if (-not (Test-Path "$InstallDir\node_modules")) {
    Log-Info "Installing production dependencies with Bun..."
    Push-Location $InstallDir
    try {
        & $BunPath install --production
    } finally {
        Pop-Location
    }
}

# ------------------------------------------------------------------------------
# TLS Certificate (only if the wizard/parameters selected self-signed or existing)
# ------------------------------------------------------------------------------
$resolvedTlsCertPath = $null
$resolvedTlsKeyPath = $null
if ($tlsMode -eq "self-signed") {
    Log-Info "Generating a self-signed TLS certificate for '$tlsHostname'..."
    Push-Location $InstallDir
    try {
        & $BunPath run scripts/generate-server-tls-cert.ts $tlsHostname "$DataDir\certs"
    } finally {
        Pop-Location
    }
    $resolvedTlsCertPath = "$DataDir\certs\server.crt".Replace('\', '/')
    $resolvedTlsKeyPath = "$DataDir\certs\server.key".Replace('\', '/')
} elseif ($tlsMode -eq "existing") {
    $resolvedTlsCertPath = $tlsCertPath.Replace('\', '/')
    $resolvedTlsKeyPath = $tlsKeyPath.Replace('\', '/')
}

# ------------------------------------------------------------------------------
# Generate Configuration Files
# ------------------------------------------------------------------------------
$configFile = "$DataDir\config\config.json"
$envFile = "$DataDir\config\deltix.env"

if (-not (Test-Path $configFile)) {
    Log-Info "Generating production configuration: $configFile"
    $escapedDataDir = $DataDir.Replace('\', '/')
    if ($tlsMode -ne "none") {
        $tlsJsonBlock = @"
{
      "enabled": true,
      "certPath": "$resolvedTlsCertPath",
      "keyPath": "$resolvedTlsKeyPath",
      "autoGenerate": false
    }
"@
    } else {
        $tlsJsonBlock = @"
{
      "enabled": false,
      "autoGenerate": false
    }
"@
    }
    $configContent = @"
{
  "environment": "production",
  "server": {
    "host": "0.0.0.0",
    "port": $HttpPort,
    "grpcPort": $GrpcPort,
    "dynamicPort": false,
    "tls": $tlsJsonBlock
  },
  "storage": {
    "dataDir": "$escapedDataDir",
    "stagingRootPath": "$escapedDataDir/staging",
    "doltReposRootPath": "$escapedDataDir/repos",
    "nasSimPath": "$escapedDataDir/nas-sim"
  },
  "database": {
    "userDbPath": "$escapedDataDir/db/users.db",
    "repoDbPath": "$escapedDataDir/db/repos.db",
    "ticketDbPath": "$escapedDataDir/db/transfer-tickets.db",
    "transferJobDbPath": "$escapedDataDir/db/transfer-jobs.db",
    "addonTrustDbPath": "$escapedDataDir/db/addon-trust.db",
    "sessionDbPath": "$escapedDataDir/db/sessions.db"
  },
  "auth": {
    "sessionTtlSeconds": 120,
    "accessTokenTtlSeconds": 900,
    "corsAllowedOrigins": [],
    "adminUiEnabled": true
  },
  "logging": {
    "level": "info",
    "pretty": false
  }
}
"@
    Set-Content -Path $configFile -Value $configContent -Encoding UTF8
}

if (-not (Test-Path $envFile)) {
    Log-Info "Generating environment configuration: $envFile"
    $envContent = @"
# Deltix Windows Environment Configuration
NODE_ENV=production
APP_ENV=production
APP_CONFIG_PATH=$configFile
APP_DATA_DIR=$DataDir
APP_PORT=$HttpPort
APP_GRPC_PORT=$GrpcPort
APP_ADMIN_UI_ENABLED=true
APP_LOG_LEVEL=info
APP_LOG_PRETTY=false
"@
    Set-Content -Path $envFile -Value $envContent -Encoding UTF8
}

# ------------------------------------------------------------------------------
# Create Windows Service Launcher Script
# ------------------------------------------------------------------------------
$launcherScript = "$InstallDir\start-service.cmd"
$launcherContent = @"
@echo off
setlocal
cd /d "$InstallDir"
set "NODE_ENV=production"
set "APP_CONFIG_PATH=$configFile"
set "APP_DATA_DIR=$DataDir"
"$BunPath" run src/index.ts
"@
Set-Content -Path $launcherScript -Value $launcherContent -Encoding ASCII
Log-Info "Created service launcher script: $launcherScript"

# ------------------------------------------------------------------------------
# Register Windows Service
# ------------------------------------------------------------------------------
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

if ($existingService) {
    Log-Info "Stopping existing Windows Service '$ServiceName'..."
    try {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    } catch {}
    
    Log-Info "Updating service configuration for '$ServiceName'..."
    sc.exe config $ServiceName binPath= "$launcherScript" start= auto | Out-Null
} else {
    Log-Info "Creating Windows Service '$ServiceName'..."
    sc.exe create $ServiceName binPath= "$launcherScript" start= auto DisplayName= "Deltix Control Plane" | Out-Null
    sc.exe description $ServiceName "Deltix Enterprise Control Plane Server (Bun v1.4)" | Out-Null
}

# Configure service auto-restart on failure
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null

# ------------------------------------------------------------------------------
# Firewall Configuration
# ------------------------------------------------------------------------------
try {
    $existingHttpRule = Get-NetFirewallRule -DisplayName "Deltix Control Plane HTTP ($HttpPort)" -ErrorAction SilentlyContinue
    if (-not $existingHttpRule) {
        New-NetFirewallRule -DisplayName "Deltix Control Plane HTTP ($HttpPort)" -Direction Inbound -LocalPort $HttpPort -Protocol TCP -Action Allow | Out-Null
        Log-Info "Created Windows Firewall inbound rule for HTTP port $HttpPort"
    }

    $existingGrpcRule = Get-NetFirewallRule -DisplayName "Deltix Control Plane gRPC ($GrpcPort)" -ErrorAction SilentlyContinue
    if (-not $existingGrpcRule) {
        New-NetFirewallRule -DisplayName "Deltix Control Plane gRPC ($GrpcPort)" -Direction Inbound -LocalPort $GrpcPort -Protocol TCP -Action Allow | Out-Null
        Log-Info "Created Windows Firewall inbound rule for gRPC port $GrpcPort"
    }
} catch {
    Log-Warn "Could not automatically configure Windows Firewall rules: $_"
}

if ($StartService) {
    Log-Info "Starting service '$ServiceName'..."
    Start-Service -Name $ServiceName
}

# ------------------------------------------------------------------------------
# Installation Summary
# ------------------------------------------------------------------------------
Log-Success "Deltix installation completed successfully."
Write-Host "=================================================================="
Write-Host " Deltix Enterprise Control Plane - Windows Installation Summary"
Write-Host "=================================================================="
Write-Host " Service Name:        $ServiceName"
Write-Host " Bun Executable:      $BunPath"
Write-Host " Install Directory:   $InstallDir"
Write-Host " Data Directory:      $DataDir"
Write-Host " Configuration File:  $configFile"
Write-Host " Environment File:    $envFile"
Write-Host " HTTP Port:           $HttpPort"
Write-Host " gRPC Port:           $GrpcPort"
Write-Host " Dolt Version:        $pinnedDoltVersion (pinned)"
Write-Host " TLS:                 $tlsMode"
Write-Host "=================================================================="
Write-Host "Next Steps:"
Write-Host " 1. Start the service:          Start-Service -Name $ServiceName"
Write-Host " 2. Check service status:       Get-Service -Name $ServiceName"
Write-Host " 3. View service logs:          Get-Content -Path $DataDir\logs\deltix.log -Tail 50"
Write-Host " 4. Run system diagnostics:     & '$BunPath' run '$InstallDir\src\cli\commands.ts' doctor"
Write-Host " 5. Open the Admin Web UI:      http$( if ($tlsMode -ne 'none') { 's' } )://<this-host>:$HttpPort/admin"
Write-Host "    (first visit creates the initial administrator account)"
Write-Host "=================================================================="
