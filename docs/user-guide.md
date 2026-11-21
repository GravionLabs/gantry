# Gantry user guide

Gantry is a client only: it connects to a Docker engine you already run and never installs or starts one
([ADR 0001](adr/0001-scope-and-stack.md)). This guide covers installing Gantry, setting up an engine on each
platform, connecting to remote hosts over SSH, and fixing the usual problems.

- [Install Gantry](#install-gantry)
- [Set up an engine](#set-up-an-engine)
  - [Linux](#linux)
  - [macOS](#macos)
  - [Windows](#windows)
- [Remote hosts over SSH](#remote-hosts-over-ssh)
- [Troubleshooting](#troubleshooting)

## Install Gantry

Download the installer for your platform from the
[latest release](https://github.com/GravionLabs/gantry/releases/latest). Installed apps update themselves from
the latest release; the status bar tells you when an update is available.

| Platform | Installer                     | Notes                                                          |
| :------- | :---------------------------- | :------------------------------------------------------------- |
| Linux    | `.deb`, `.rpm` or `.AppImage` | Install with your package manager, or `chmod +x` the AppImage. |
| macOS    | `.dmg`                        | Drag Gantry to Applications.                                   |
| Windows  | `.msi` or `-setup.exe`        | Run the installer.                                             |

Gantry needs an engine, and for Compose actions and SSH endpoints it uses command line tools on the machine
where it runs:

- `docker` with the Compose plugin (`docker compose`) for Compose stack actions (up, down, restart, pull).
- `ssh` for [remote hosts](#remote-hosts-over-ssh). Windows 10 and later ship the OpenSSH client.

## Set up an engine

On start Gantry looks for engines in the usual places and lists each one as running, not running or not
permitted. It only looks and connects; it never starts or changes an engine. Select a running engine to use it.
If your engine is not listed, add it by hand (a socket, `tcp://host:port` or `ssh://user@host`). Docker CLI
contexts (`docker context ls`) are imported as read-only endpoints, and `DOCKER_HOST` is honored.

### Linux

**Docker CE.** Install it from [docs.docker.com/engine/install](https://docs.docker.com/engine/install/), which
includes the Compose plugin (`docker-compose-plugin`). Start it and enable it at boot:

```sh
sudo systemctl enable --now docker
```

Gantry reads `/var/run/docker.sock`. That socket belongs to `root:docker`, so your user must be in the `docker`
group:

```sh
sudo usermod -aG docker "$USER"
```

Sign out and in again (or reboot) so the new group applies, then check with `docker ps`. Members of the `docker`
group have root-equivalent access to the machine; if that is too much, use rootless Docker.

**Rootless Docker.** Follow [the rootless guide](https://docs.docker.com/engine/security/rootless/). The socket
is `$XDG_RUNTIME_DIR/docker.sock` (usually `/run/user/1000/docker.sock`) and Gantry finds it when the variable
is set. Make sure the service runs: `systemctl --user enable --now docker`. For it to run without an open
session, enable lingering: `sudo loginctl enable-linger "$USER"`.

**Docker Desktop for Linux** is found at `~/.docker/desktop/docker.sock`.

### macOS

macOS has no native Docker engine; install one of these. Gantry finds each of them by its socket.

- **Colima** (light, command line): `brew install colima docker docker-compose`, then `colima start`. Every
  profile is listed (`Colima (default)`, `Colima (work)`, …) from `~/.colima/<profile>/docker.sock`. Colima must
  be running; Gantry does not start it.
- **Docker Desktop**: install from [docker.com](https://www.docker.com/products/docker-desktop/) and start it.
  Gantry uses `~/.docker/run/docker.sock`.
- **OrbStack**: install and start it; Gantry uses `~/.orbstack/run/docker.sock`.

For Compose actions install the Docker CLI and the Compose plugin (Docker Desktop and OrbStack include them;
with Colima use `brew install docker docker-compose` and follow the Homebrew caveat that links the plugin).

### Windows

**Docker Desktop.** Install it with the WSL 2 backend and start it. Gantry connects through the named pipes
`docker_engine` and `dockerDesktopLinuxEngine`.

**Docker CE in WSL2.** Install Docker CE inside a WSL2 distribution (for example Ubuntu) by the Linux steps
above, with systemd enabled (`/etc/wsl.conf`: `[boot]` `systemd=true`, then `wsl --shutdown`). The Docker
socket lives inside the distribution, so Gantry, which runs on Windows, cannot open it as a file. Gantry has no
automatic detection for this setup. Reach the engine in one of two ways:

1. **SSH into the distribution (recommended, nothing is exposed without authentication).** Install and start
   `openssh-server` in the distribution, add your public key to its `~/.ssh/authorized_keys`, and add the
   endpoint `ssh://<user>@localhost:<port>` (set a free `Port` in `/etc/ssh/sshd_config`; WSL2 forwards
   `localhost` ports to Windows). Your user must be in the `docker` group inside the distribution. See
   [Remote hosts over SSH](#remote-hosts-over-ssh).
2. **TCP on localhost.** Let `dockerd` also listen on `127.0.0.1:2375` (a `hosts` entry in
   `/etc/docker/daemon.json`; with systemd also override `-H fd://` in the service unit) and add the endpoint
   `tcp://127.0.0.1:2375`. This port has **no authentication**: any program on the machine can control Docker.
   Never bind it to a non-loopback address without TLS.

Do not run Docker Desktop and an engine in WSL2 under the same name; they are separate engines with separate
containers.

## Remote hosts over SSH

Gantry runs your system `ssh` with `docker system dial-stdio` on the host, as the Docker CLI does
([ADR 0003](adr/0003-ssh-transport-through-docker-system-dial-stdio.md)). Gantry stores no keys or passwords.

Prerequisites:

1. **Key in the agent.** Authentication must work without a prompt (`BatchMode=yes`), so the key must be
   unlocked in your SSH agent:

   ```sh
   ssh-add ~/.ssh/id_ed25519   # then: ssh-add -l shows it
   ```

   Windows: start the `ssh-agent` service (`Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent`)
   and run `ssh-add`. The public key must be in `~/.ssh/authorized_keys` on the host.

2. **Host key known.** Connect once in a terminal (`ssh user@host`) and accept the host key. Gantry never asks.
3. **User in the `docker` group on the host:** `sudo usermod -aG docker <user>` there; the user signs in again.
4. **Docker CLI on the host** that supports `docker system dial-stdio` (Docker 18.09 or later).
5. **Test it:** `ssh user@host docker system dial-stdio` should wait silently (stop it with Ctrl+C), and
   `ssh user@host docker ps` should list containers.

The endpoint is `ssh://[user@]host[:port]`. Aliases, jump hosts (`ProxyJump`) and identity files from your
`~/.ssh/config` apply, so `ssh://prod` works when `Host prod` exists there.

## Troubleshooting

### Permission denied

The engine's socket exists but your user may not use it.

- **Linux, Docker CE:** add yourself to the `docker` group and sign in again (see [Linux](#linux)). Check with
  `id -nG` that `docker` is listed. Alternatively use rootless Docker.
- **macOS / Docker Desktop:** start Docker Desktop and accept its prompts; check that `~/.docker/run/docker.sock`
  belongs to you.
- **SSH endpoint, `authentication failed`:** the agent has no usable key for this host. Run `ssh-add -l`, then
  `ssh user@host` in a terminal. Check the key and `IdentityFile` in `~/.ssh/config`.
- **SSH endpoint, host key:** connect once with `ssh` in a terminal to verify and trust the host key. If the key
  changed legitimately, remove the old entry with `ssh-keygen -R host`.
- **SSH endpoint, `permission denied` from Docker:** the remote user is not in the `docker` group.

### Engine not running

Nothing listens at the socket or pipe: no engine, a stopped engine, or a different address.

- Linux: `systemctl status docker`; start with `sudo systemctl start docker` (rootless:
  `systemctl --user start docker`).
- macOS: `colima status` and `colima start`, or start Docker Desktop or OrbStack.
- Windows: start Docker Desktop, or start the WSL2 distribution (`wsl -d <name>`) so its engine runs.
- Check which one you expect: `docker context ls` and `echo $DOCKER_HOST` (`$env:DOCKER_HOST` in PowerShell). A
  stale `DOCKER_HOST` points Gantry, and the CLI, at an engine that is gone.
- Remote hosts: `the host cannot be reached over SSH` means DNS, firewall or network; try `ssh user@host`.

### Compose plugin missing

Compose actions use the `docker compose` command on the machine where Gantry runs, and Gantry says so when it
is missing. Check:

```sh
docker compose version
```

- **Linux:** install `docker-compose-plugin` from Docker's package repository (`apt install docker-compose-plugin`
  or `dnf install docker-compose-plugin`).
- **macOS:** Docker Desktop and OrbStack include it. With Colima: `brew install docker-compose` and add
  `"cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]` to `~/.docker/config.json`.
- **Windows:** Docker Desktop includes it. For Docker CE in WSL2 install the Docker CLI with the plugin on
  Windows too (Docker Desktop's CLI or the `docker` and `docker-compose` binaries on `PATH`).
- A stack started without the Compose files on this machine (labels only, files elsewhere) cannot be managed
  from Gantry; use it from the host where the files live.
