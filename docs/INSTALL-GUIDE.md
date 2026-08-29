# Deltix — Installation and Configuration Guide

> A step-by-step guide so that **anyone** — a developer, a system administrator,
> or a support engineer — can get Deltix running without breaking anything.
> Read the simple path first, in order. At the end there is an **advanced
> section** with options for custom setups.

---

## 1. What Deltix is, in one paragraph

**Deltix** is version control, in the style of Git, but for **relational
databases** (their schemas and their data). Just like Git, there is a
**central server** that stores the history, and a **client** (a command-line
tool) that you use to upload (`push`) and download (`pull`) changes.

Deltix has **two parts**, installed separately:

| Part | What it is | Where it is installed |
|---|---|---|
| **Deltix-Server** | The "central repository" plus administration panels | On your company's server or virtual machine |
| **Deltix-Client** (the `deltix` command) | The command-line tool used by developers and support staff | On each person's computer |

```
 Developer's laptop or PC                     Your company's server
┌─────────────────────┐                ┌──────────────────────────┐
│  deltix push x.tbl  │ ──── gRPC ───► │  Deltix-Server            │
│  deltix pull        │ ◄── HTTPS ──── │   • REST API (login, etc.)│
│  deltix branch ...  │                │   • Data transfer         │
│  deltix log ...     │                │   • Admin Web UI (browser)│
└─────────────────────┘                └──────────────────────────┘
```

**Difficulty level: low.** The installer does almost everything for you. You
only answer a few simple questions.

---

## 2. Requirements (read this before you start)

**For the server (Deltix-Server):**
- Linux (Debian, Ubuntu, **RHEL/Rocky**, or similar) **with systemd**, or
  Windows Server 2019+ / Windows 10/11.
- `curl`, `tar`, and `unzip` available (used to download Bun and Dolt).
- **Root or sudo access** (the installer creates a system user, a service, and
  folders under `/opt` and `/var/lib`).
- **IP vs. hostname note:** if your server is only reachable by **IP**
  (for example `10.1.10.129`), that is fine. The installer and the client
  handle it automatically (explained below).

**For the client (Deltix-Client):**
- **Nothing is required.** It is a standalone binary, with no installer and
  no runtime. You download it and you are done.

---

## 3. Install Deltix-Server (the server)

### Step 3.1 — Download and start the installer

Open a terminal on the server **with sudo** and run:

```bash
curl -fsSL -o get-deltix.sh https://raw.githubusercontent.com/SammyBytes/Deltix-Server/main/scripts/get-deltix.sh
sudo bash get-deltix.sh
```

> **Important:** download the script **first** and run it (as shown above).
> If instead you pipe it directly (`curl ... | sudo bash`), the interactive
> menu will not appear and Deltix will be installed with the default settings.
> For a normal setup, use the form above.

### Step 3.2 — Answer the interactive menu (the simplest path)

The menu will ask you a few questions. **Press Enter to accept the default
value** for almost everything:

```
HTTP control plane port [9090]:          <Enter>
gRPC transfer engine port [50051]:       <Enter>

TLS ... Choose [2]:  2                     <- choose "Self-signed" (option 2)
Hostname or IP this server will be reached at [10.1.10.129]:  <Enter>  (or type your IP/hostname)

Start the deltix.service now after installation? [y/N]: y
```

That is all. The installer will:
- install Bun and Dolt automatically,
- generate a **self-signed TLS certificate** on its own,
- create the **`deltix.service`** service,
- and **start** it.

### Step 3.3 — Check that it started

```bash
sudo systemctl status deltix.service
```

You should see `active (running)`. To watch the logs live:

```bash
sudo journalctl -u deltix.service -f
```

### Step 3.4 — Open the Admin Web UI for the first time

Open the address shown in the installation summary in your browser
(`https://<server-IP>:9090/admin`). On the **first visit you will be asked to
create the administrator account** — there is no default password; you create
it.

> **Keep the certificate fingerprint** that the summary shows you. You will
> use it later when you set up the client — this is the same trust model as an
> SSH host key.

---

## 4. Install Deltix-Client (the `deltix` command)

### Step 4.1 — Download the binary

Go to the **Deltix-Client releases** page and download the binary for your
platform:

| System | File to download |
|---|---|
| Windows | `deltix-windows-x64.exe` |
| Linux x64 | `deltix-linux-x64` |
| macOS (Intel) | `deltix-darwin-x64` |
| macOS (Apple Silicon) | `deltix-darwin-arm64` |

### Step 4.2 — Put it on your PATH

> Simplified so it works right away. The more permanent method is in the
> advanced section.

**Windows** (in PowerShell):
```powershell
New-Item -ItemType Directory -Force $HOME\bin | Out-Null
Move-Item $HOME\Downloads\deltix-windows-x64.exe $HOME\bin\deltix.exe
$env:Path += ";$HOME\bin"
```
> Note: the `$env:Path` above only lasts for that window. To keep it
> permanently (recommended), see **Advanced section → Client → Permanent alias**.

**Linux / macOS:**
```bash
mkdir -p ~/bin
mv ~/Downloads/deltix-linux-x64 ~/bin/deltix
chmod +x ~/bin/deltix
export PATH="$HOME/bin:$PATH"
```

Check that it works:
```bash
deltix version
```

---

## 5. Configure the client (`deltix configure`) — the key step

Now we connect the client to your server. Run:

```bash
deltix configure
```

And answer like this:

```
Deltix-Server REST URL (http://127.0.0.1:9090):  https://10.1.10.129:9090
Deltix-Server gRPC host (hostname or IP) (127.0.0.1):  10.1.10.129
Deltix-Server gRPC port (50051):               <Enter>
Server uses HTTPS... (Y/n):                     y
```

If you connect to an **IP** (rather than a hostname), the client does
something very useful: it connects by itself, shows you the **certificate
fingerprint**, and **automatically suggests the DNS name** that the server
uses. It detects it itself, so you do not have to guess it:

```
Info: "10.1.10.129" is an IP address... suggested hbs-svr-pulse from the certificate.
TLS server name override (hbs-svr-pulse):   <Enter>
```

> **Key point:** when it asks `Trust this certificate? (y/N)`, answer `y` only
> if the fingerprint matches the one given to you by the server installer
> (step 3.4). This is the same trust model as SSH.

At the end you will see a summary like this (your settings are saved):

```
  serverUrl: https://10.1.10.129:9090
  grpcHost: 10.1.10.129
  grpcPort: 50051
  grpcTlsCaPath: C:\Users\YOUR_USER\.deltix\trusted-server.crt
  grpcTlsServerNameOverride: hbs-svr-pulse
```

**That is it.** You will not need to configure this machine again.

---

## 6. Verify that everything works (first login + push)

### 6.1 — Log in

```bash
deltix login <username> <password>
# example:
deltix login hemiblade Hemi.blade1
```
You should see `Logged in as hemiblade`.

> If you see a warning like `Setting the NODE_TLS_REJECT_UNAUTHORIZED...`,
> it means there is an **old environment variable left over** in your
> terminal. It should not be there. In PowerShell:
> `Remove-Item Env:DELTIX_* -ErrorAction SilentlyContinue` and try again.

### 6.2 — Push a schema

```bash
deltix push <my-repo> <path/to/file.sql>
# example:
deltix push hmc-pilot ./schema.sql
```
You should see:
```
Push completed for hmc-pilot
  jobId: ...
  checksum: ...
  bytesSent: 164
```

### 6.3 — Other useful daily commands

```bash
deltix whoami                      # who am I logged in as?
deltix pull <repo> <file.sql>      # download a schema
deltix branch list <repo>          # view branches
deltix branch create <repo> <name> # create a branch
deltix log <repo>                  # history
deltix diff <repo> <from> <to>     # differences
```

---

## 7. Quick troubleshooting (the 3 things that usually go wrong)

> These are exactly the three failures that happen in real use, with how to
> fix each one. Read this before you open a support ticket.

### A) `deltix login` fails with `self signed certificate`
**Cause:** the server certificate is not trusted by the client, or an old
environment variable is left over.
**Fix:**
```powershell
Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED -ErrorAction SilentlyContinue
Remove-Item Env:DELTIX_* -ErrorAction SilentlyContinue   # PowerShell only
deltix configure      # re-do the trust step (section 5)
deltix login ...
```
> Never "fix" this by setting `NODE_TLS_REJECT_UNAUTHORIZED=0` — that
> **turns off all TLS verification** and is insecure. Trust the certificate
> properly with `deltix configure`.

### B) `deltix login` fails but `configure` can connect
**Cause:** the **HTTP** certificate (login) does not match the **gRPC**
certificate (transfer). In server versions **>= 0.6.16**, both already use the
same certificate, so this rarely happens. If it does, **reinstall/update the
server** to the latest version:
```bash
sudo bash get-deltix.sh    # run again (updates the server)
```

### C) `deltix push` fails with `Could not parse target name "...\n:50051"`
**Cause:** a `DELTIX_GRPC_HOST` environment variable or a config value added
a line break to the host.
**Fix:** clear the old variables and reconfigure (requires client **>= 0.4.3**):
```powershell
Remove-Item Env:DELTIX_* -ErrorAction SilentlyContinue
deltix configure
```

### D) The server does not start (`deltix.service` in a restart loop)
**Cause:** the internal gRPC certificate is missing (for example, someone
deleted `/var/lib/deltix/certs`).
**Fix:** run the installer again (version **>= 0.6.15** regenerates it
automatically):
```bash
sudo bash get-deltix.sh
```

---

## ADVANCED SECTION (for people who want to customize)

> Everything below is optional. If the simple path works for you, you do not
> need to touch any of this.

### Advanced A — Server: install a specific version / unattended mode

You can **pin a version** (instead of the latest) and/or install **without
interaction** (for scripts, automation, and CI):

```bash
# Pin a version:
sudo VERSION=0.6.16 bash get-deltix.sh

# No interaction (uses default settings: ports 9090/50051, no TLS):
curl -fsSL -o get-deltix.sh https://raw.githubusercontent.com/SammyBytes/Deltix-Server/main/scripts/get-deltix.sh
sudo bash get-deltix.sh --unattended
```

### Advanced B — Server: choose the TLS mode

In the menu, at `TLS ... Choose [2]`:

| Option | What it means | When to use it |
|---|---|---|
| `1) None` | Plain HTTP | You already have a reverse proxy that handles TLS |
| `2) Self-signed` (recommended) | The installer generates the certificate | Most internal cases |
| `3) Existing certificate` | You provide a cert/key (for example from your company CA) | When your organization already manages certificates |

> A detail that saves you trouble: in `self-signed` mode, the server uses
> **the same certificate** for the HTTP login and for the gRPC transfer. That
> is why you only trust it once in the client.

### Advanced C — Server: what the installer creates (folder map)

| Path | What it is for |
|---|---|
| `/opt/deltix` | The application code |
| `/var/lib/deltix` | **Data**: repositories, staging, databases, logs, certificates, license, JWT keys |
| `/etc/deltix/config.json` | Generated configuration |
| `/etc/deltix/deltix.env` | Variables the server needs at startup |
| `deltix.service` | The service (systemd) |

Do not edit these folders by hand while the service is running. If you need
to rotate a certificate, **run the installer again** instead of deleting files
manually.

### Advanced D — Server: Windows

Same flow, in PowerShell **as Administrator**:
```powershell
iwr -useb -Uri https://raw.githubusercontent.com/SammyBytes/Deltix-Server/main/scripts/get-deltix.ps1 -OutFile get-deltix.ps1
.\get-deltix.ps1
```
It installs as a Windows service (`DeltixServer`) under
`C:\Program Files\Deltix` (code) and `C:\ProgramData\Deltix` (data).

### Advanced E — Client: make the binary permanent

**Windows** — create the directory and add it to the PATH permanently:
```powershell
New-Item -ItemType Directory -Force $HOME\bin | Out-Null
Move-Item $HOME\Downloads\deltix-windows-x64.exe $HOME\bin\deltix.exe
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";$HOME\bin", "User")
```
Close and reopen a terminal. After that, `deltix` always works.

**Linux/macOS** — add `~/.local/bin` to your `.bashrc`/`.zshrc`:
```bash
mkdir -p ~/.local/bin
mv ~/Downloads/deltix-linux-x64 ~/.local/bin/deltix
chmod +x ~/.local/bin/deltix
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

### Advanced F — Client: environment variables (they override the config)

Everything you set with `deltix configure` is only the **default value**. If
a `DELTIX_*` **environment variable** exists, **it wins**:

| Variable | Overrides |
|---|---|
| `DELTIX_SERVER_URL` | REST URL of the server |
| `DELTIX_GRPC_HOST` | gRPC host |
| `DELTIX_GRPC_PORT` | gRPC port |
| `DELTIX_GRPC_TLS_CA_PATH` | CA certificate to trust (gRPC) |
| `DELTIX_GRPC_TLS_SERVER_NAME_OVERRIDE` | DNS name override |
| `DELTIX_HTTP_TLS_CA_PATH` / `DELTIX_HTTP_TLS_SERVER_NAME_OVERRIDE` | The same, for the HTTP login |

> Since the variables **override** the config, an old variable left in your
> terminal can break the connection even if you touched nothing. If something
> fails in a strange way, **clear the `DELTIX_*` variables** (section 7) and
> reconfigure.

### Advanced G — Client: build from source (for developers)

```bash
git clone https://github.com/SammyBytes/Deltix-Client.git
cd Deltix-Client
bun install
bun run build          # produces ./dist/deltix (or .exe depending on platform)
```

### Advanced H — Default ports

| Port | What it is for |
|---|---|
| `9090` | HTTP control plane + Admin Web UI |
| `50051` | gRPC transfer (push/pull/heartbeat) |

---

*Found a problem? Report it. This guide covers the tested flow; if something
did not work for you, it is very useful for the team to know which step you
reached.*
