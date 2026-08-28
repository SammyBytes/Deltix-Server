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
    # Some transitive dependencies (e.g. protobufjs, pulled in by
    # @grpc/proto-loader) run a "postinstall" script that shells out to a
    # literal "node" executable, not "bun". On a machine where only Bun was
    # ever installed (the whole point of this installer), node.exe does not
    # exist and "bun install" fails. Bun is a drop-in node replacement for
    # this purpose, so if no real Node.js is on PATH, point a throwaway
    # node.exe shim at Bun for the duration of this install only.
    $nodeShimDir = $null
    $existingNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $existingNode) {
        $nodeShimDir = Join-Path $env:TEMP ("deltix-node-shim-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $nodeShimDir -Force | Out-Null
        Copy-Item -Path $BunPath -Destination (Join-Path $nodeShimDir "node.exe") -Force
        Log-Info "No system Node.js found; using Bun as a temporary 'node' shim for postinstall scripts (e.g. protobufjs)."
    }

    Log-Info "Installing production dependencies with Bun..."
    $originalPath = $env:Path
    try {
        if ($nodeShimDir) {
            $env:Path = "$nodeShimDir;$env:Path"
        }
        Push-Location $InstallDir
        try {
            & $BunPath install --production
        } finally {
            Pop-Location
        }
    } finally {
        $env:Path = $originalPath
        if ($nodeShimDir) {
            Remove-Item -Path $nodeShimDir -Recurse -Force -ErrorAction SilentlyContinue
        }
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
$doltLicenseLogPath = "$DataDir\dolt-license-log"
$grpcCertsDir = "$DataDir\certs\grpc"

# ------------------------------------------------------------------------------
# Cryptographic material & anti-tamper log (generated once; never
# regenerated on an upgrade re-run). Mirrors scripts/install.sh: the
# server refuses to boot without a real DELTIX_LICENSE_KEY,
# DELTIX_JWT_PRIVATE_KEY/PUBLIC_KEY, DELTIX_DOLT_REPO_PATH, and a mandatory
# gRPC TLS cert (see src/shared/env.ts) -- none of this can be deferred to
# "edit deltix.env by hand later".
# ------------------------------------------------------------------------------
if (-not (Test-Path $envFile)) {
    Log-Info "Generating JWT signing keypair (Ed25519)..."
    Push-Location $InstallDir
    try {
        $jwtSnippet = & $BunPath run scripts/generate-jwt-keypair.ts
    } finally {
        Pop-Location
    }

    Log-Info "Generating a self-signed Community license..."
    Push-Location $InstallDir
    try {
        $licenseSnippet = & $BunPath run scripts/generate-community-license.ts "$env:COMPUTERNAME"
    } finally {
        Pop-Location
    }

    $grpcTlsHostname = if ($tlsHostname) { $tlsHostname } else { $env:COMPUTERNAME }
    Log-Info "Generating the mandatory gRPC transfer engine TLS certificate..."
    Push-Location $InstallDir
    try {
        & $BunPath run scripts/generate-server-tls-cert.ts $grpcTlsHostname $grpcCertsDir
    } finally {
        Pop-Location
    }

    Log-Info "Initializing the Dolt anti-tamper commit log at $doltLicenseLogPath..."
    New-Item -ItemType Directory -Path $doltLicenseLogPath -Force | Out-Null
    dolt config --global --add user.name deltix-server 2>$null | Out-Null
    dolt config --global --add user.email deltix-server@localhost 2>$null | Out-Null
    Push-Location $doltLicenseLogPath
    try {
        dolt init | Out-Null
    } finally {
        Pop-Location
    }
}


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
    $doltRepoPathForward = $doltLicenseLogPath.Replace('\', '/')
    $grpcCertsDirForward = $grpcCertsDir.Replace('\', '/')
    $envLines = New-Object System.Collections.Generic.List[string]
    $envLines.Add("# Deltix Environment Configuration -- generated once by scripts/install-windows.ps1.")
    $envLines.Add("# Do not regenerate by hand; re-running the installer preserves this file.")
    $envLines.Add("NODE_ENV=production")
    $envLines.Add("APP_CONFIG_PATH=$configFile")
    $envLines.Add("APP_PORT=$HttpPort")
    $envLines.Add("")
    $envLines.Add("# --- Licensing (self-signed Community tier; no internet dependency) ---")
    $envLines.Add($licenseSnippet.Trim())
    $envLines.Add("DELTIX_DOLT_REPO_PATH=$doltRepoPathForward")
    $envLines.Add("")
    $envLines.Add("# --- Session/access token signing ---")
    $envLines.Add($jwtSnippet.Trim())
    $envLines.Add("")
    $envLines.Add("# --- Data storage (all under $DataDir, kept separate from $InstallDir) ---")
    $envLines.Add("DELTIX_USER_DB_PATH=$escapedDataDir/db/users.db")
    $envLines.Add("DELTIX_SESSION_DB_PATH=$escapedDataDir/db/sessions.db")
    $envLines.Add("DELTIX_TICKET_DB_PATH=$escapedDataDir/db/transfer-tickets.db")
    $envLines.Add("DELTIX_TRANSFER_JOB_DB_PATH=$escapedDataDir/db/transfer-jobs.db")
    $envLines.Add("DELTIX_ADDON_TRUST_DB_PATH=$escapedDataDir/db/addon-trust.db")
    $envLines.Add("DELTIX_REPO_DB_PATH=$escapedDataDir/db/repos.db")
    $envLines.Add("DELTIX_STAGING_ROOT_PATH=$escapedDataDir/staging")
    $envLines.Add("DELTIX_DOLT_REPOS_ROOT_PATH=$escapedDataDir/repos")
    $envLines.Add("DELTIX_NAS_SIM_PATH=$escapedDataDir/nas-sim")
    $envLines.Add("")
    $envLines.Add("# --- gRPC transfer engine (mandatory TLS, self-signed cert generated above) ---")
    $envLines.Add("DELTIX_GRPC_PORT=$GrpcPort")
    $envLines.Add("DELTIX_GRPC_TLS_CERT_PATH=$grpcCertsDirForward/server.crt")
    $envLines.Add("DELTIX_GRPC_TLS_KEY_PATH=$grpcCertsDirForward/server.key")
    $envLines.Add("")
    $envLines.Add("# --- Admin Web UI / HTTP control plane ---")
    $envLines.Add("DELTIX_ADMIN_UI_ENABLED=true")
    $envLines.Add("DELTIX_CORS_ALLOWED_ORIGINS=")
    if ($tlsMode -ne "none") {
        $envLines.Add("DELTIX_HTTP_TLS_CERT_PATH=$resolvedTlsCertPath")
        $envLines.Add("DELTIX_HTTP_TLS_KEY_PATH=$resolvedTlsKeyPath")
    }
    Set-Content -Path $envFile -Value ($envLines -join "`r`n") -Encoding UTF8
}

# ------------------------------------------------------------------------------
# Create Windows Service Launcher Script
# ------------------------------------------------------------------------------
# sc.exe-registered services do NOT read an EnvironmentFile the way systemd
# does -- nothing on Windows loads deltix.env into the process automatically.
# The launcher must parse it itself (KEY=value, and KEY="multi-line PEM")
# and set each variable in-process before starting the server, otherwise the
# service starts with none of the required DELTIX_* variables and crashes
# on boot exactly like the pre-fix Linux installer did.
$launcherScript = "$InstallDir\start-service.ps1"
$launcherContent = @'
$ErrorActionPreference = "Stop"
Set-Location -Path "__INSTALL_DIR__"
$env:NODE_ENV = "production"
$env:APP_DATA_DIR = "__DATA_DIR__"

$envFilePath = "__ENV_FILE__"
$raw = Get-Content -Path $envFilePath -Raw
$pattern = '(?ms)^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|([^\r\n]*))$'
foreach ($match in [System.Text.RegularExpressions.Regex]::Matches($raw, $pattern)) {
    $name = $match.Groups[1].Value
    $value = if ($match.Groups[2].Success) { $match.Groups[2].Value } else { $match.Groups[3].Value }
    [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
}

& "__BUN_PATH__" run src/index.ts
'@
$launcherContent = $launcherContent.Replace('__INSTALL_DIR__', $InstallDir).Replace('__DATA_DIR__', $DataDir).Replace('__ENV_FILE__', $envFile).Replace('__BUN_PATH__', $BunPath)
Set-Content -Path $launcherScript -Value $launcherContent -Encoding UTF8
$launcherCmd = "$InstallDir\start-service.cmd"
Set-Content -Path $launcherCmd -Value "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$launcherScript`"" -Encoding ASCII
$launcherScript = $launcherCmd
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
