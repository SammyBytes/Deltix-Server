# Installation Guide

This guide covers installing Deltix-Server in production, on both Linux and
Windows, without Docker. If you are running Docker, see the "Deployment
(Docker)" section in [README.md](README.md) instead — this guide is for bare
metal / VM installs.

The companion client CLI, Deltix-Client, is covered briefly at the end.

## What the installer does

`scripts/install.sh` (Linux) and `scripts/install-windows.ps1` (Windows) are
the supported way to install Deltix-Server. Both scripts:

- Install Bun if it is not already present.
- Install Dolt at the exact version pinned in `DOLT_VERSION` — never
  "latest" — so an upstream Dolt release can never silently break a running
  Deltix install on its next reinstall or upgrade.
- Create a dedicated, restricted-permission service account and data
  directory hierarchy.
- Run an interactive configuration wizard for the HTTP port, gRPC port, and
  TLS mode, instead of requiring you to hand-edit `.env` or `config.json`.
- Generate `config.json` and the environment file for you.
- Register and (optionally) start a system service (systemd on Linux, a
  Windows Service on Windows).

You do not need to run `bun run <something>` yourself, edit any
configuration file by hand, or manually create directories. The only manual
step after installation is the one-time creation of your first
administrator account through the Admin Web UI on first visit.

## Linux installation

### Requirements

- A Linux server with `systemd` (Debian, Ubuntu, RHEL/Rocky, and
  derivatives are all supported).
- `curl`, `tar`, and `unzip` available (used to fetch Bun and Dolt).
- Root or `sudo` access, since the installer creates a system user, a
  systemd unit, and directories under `/opt` and `/var/lib`.

### Steps

The GitHub Release for a given tag only carries standalone tool binaries
(such as the TLS certificate generator), not a packaged server tarball.
To install a specific version, fetch the tagged **source** instead, using
either of these two options:

**Option A — clone with git (recommended):**

```bash
git clone --branch v0.5.0 --depth 1 https://github.com/SammyBytes/Deltix-Server.git
cd Deltix-Server
```

**Option B — download the tagged source archive (no git required):**

```bash
curl -L -o deltix-server-v0.5.0.tar.gz \
  https://github.com/SammyBytes/Deltix-Server/archive/refs/tags/v0.5.0.tar.gz
tar xzf deltix-server-v0.5.0.tar.gz
cd Deltix-Server-0.5.0
```

Replace `v0.5.0` with the release you want to install. Then, from the
repository root:

```bash
sudo ./scripts/install.sh
```

This runs interactively by default. You will be asked for:

1. **HTTP control plane port** (default `9090`) — serves the REST API and
   the Admin Web UI.
2. **gRPC transfer engine port** (default `50051`) — used by Deltix-Client
   for push/pull/heartbeat traffic.
3. **TLS mode** for the HTTP control plane and Admin Web UI:
   - `None` — plain HTTP. Reasonable if a reverse proxy in front of Deltix
     already terminates TLS.
   - `Self-signed` — the installer generates a certificate for a hostname
     or IP you provide, using the bundled `generate-server-tls-cert` tool.
   - `Existing certificate` — point the installer at a certificate and key
     you already have (for example, one issued by your organization's CA).
4. Whether to start the service immediately after installation.

For unattended installs (configuration management, provisioning scripts,
CI), pass `--unattended`. All prompts are skipped and defaults are used;
running with a non-interactive stdin (for example, piped input) is also
auto-detected as unattended.

```bash
sudo ./scripts/install.sh --unattended
```

### What gets created

| Path | Purpose |
|---|---|
| `/opt/deltix` | Application code |
| `/opt/deltix-tools/dolt-<version>/bin/dolt` | Pinned Dolt binary, symlinked from `/usr/local/bin/dolt` |
| `/var/lib/deltix` | Data directory: repositories, staging area, databases, logs, certificates |
| `/var/lib/deltix/config/config.json` | Generated configuration |
| `/var/lib/deltix/config/deltix.env` | Generated environment file |
| `deltix-server.service` | systemd unit |

### After installation

```bash
sudo systemctl status deltix-server
sudo journalctl -u deltix-server -f
```

Open the Admin Web UI at the address and port printed in the installation
summary (`http://` or `https://` depending on the TLS mode you chose). The
first visit prompts you to create the initial administrator account —
there is no default password to change.

### Upgrading

Re-run `scripts/install.sh` from the new release. It detects the existing
service, data directory, and configuration, and preserves them. Dolt is
only re-downloaded if the pinned version in `DOLT_VERSION` has changed.

## Windows installation

### Requirements

- Windows Server 2019+ or Windows 10/11.
- PowerShell 5.1+ (included) or PowerShell 7+.
- An elevated (Administrator) PowerShell session, since the installer
  registers a Windows Service and writes to `Program Files`.

### Steps

From an elevated PowerShell prompt, in the repository root:

```powershell
.\scripts\install-windows.ps1
```

The same interactive wizard as the Linux installer runs by default: HTTP
port, gRPC port, TLS mode, and whether to start the service immediately.

For unattended installs:

```powershell
.\scripts\install-windows.ps1 -Unattended
```

### What gets created

| Path | Purpose |
|---|---|
| `C:\Program Files\Deltix` | Application code |
| `C:\Program Files\Deltix-Tools\dolt-<version>\dolt.exe` | Pinned Dolt binary, added to the machine `PATH` |
| `C:\ProgramData\Deltix` | Data directory: repositories, staging area, databases, logs, certificates |
| `config.json` / `deltix.env` | Generated configuration |
| A Windows Service (`DeltixServer`) | Runs Deltix-Server under the Local System (or configured) account |

### After installation

```powershell
Get-Service -Name DeltixServer
Get-Content -Path C:\ProgramData\Deltix\logs\deltix.log -Tail 50 -Wait
```

Open the Admin Web UI at the address printed in the installation summary
and create the initial administrator account.

### Upgrading

Re-run `scripts\install-windows.ps1` from the new release. It stops the
existing service, replaces the application code, and restarts it,
preserving your data directory and configuration.

## TLS certificate generation (standalone)

If you need to generate or rotate a certificate after installation without
re-running the full installer, use the standalone `generate-server-tls-cert`
tool. It ships as a compiled binary in each GitHub Release, so it can be run
directly on the server with no source checkout and no `bun install`:

```bash
./deltix-gen-cert-linux-x64 my-server.example.com /var/lib/deltix/certs
```

See the "HTTPS for the HTTP control plane" section in
[README.md](README.md) for the full set of options, including the
Docker one-liner.

## Deltix-Client installation

Deltix-Client is a single dependency-free binary — no runtime, no native
modules, no installer required.

1. Download the `deltix` binary for your platform from the latest
   Deltix-Client release, or build it yourself with `bun run build`.
2. Place it on your `PATH`.
3. Run the interactive setup once:

```bash
deltix configure
```

This asks for the Deltix-Server REST URL, the gRPC host/IP and port, and,
if you are connecting to an IP address over TLS, the certificate's server
name and an optional CA certificate path. The answers are saved to
`~/.deltix/config.json` (created automatically) so you never need to pass
them again or edit a configuration file by hand.

4. Authenticate:

```bash
deltix login
```

From this point, `deltix push`, `deltix pull`, `deltix repo`, `deltix
branch`, and the rest of the command set work against the configured
server without further setup.

## Getting help

Run `scripts/install.sh -h` (Linux) or `Get-Help .\scripts\install-windows.ps1`
(Windows) for the full list of parameters (install directory, data
directory, ports, service account, and so on). Every parameter has a
sensible default; the wizard only asks about the choices that materially
affect how the server runs.
