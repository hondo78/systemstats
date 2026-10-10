# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Was das ist

**Systemstats** – Status-Dashboard für den Host (Merlin): Performance-Daten (CPU/Kerne, RAM/Swap, AMD-GPU, Temperaturen, Netz, Disk-I/O, PSI), Prozessmonitor, Container-Übersicht, Speicherplatzanalyse und Langzeitanalyse mit Warnungen. LAN-Tool, **ohne Auth**. Einzige schreibende Funktion: Compose-Stacks starten/stoppen/neu starten und deren Neustart-Richtlinie setzen (`control.py`, abschaltbar mit `CONTROL_ENABLED=0`). Keine Kill-/Prune-Aktionen – bewusst so.

UI: `http://<host>:8097` (Ansichten per Hash: `#overview`, `#processes`, `#containers`, `#storage`, `#network`, `#analysis`).

## Befehle

```bash
docker compose up -d --build      # bauen & starten (Frontend ist ins Image kopiert -> nach jeder Änderung neu bauen)
docker compose logs -f systemstats
curl -s localhost:8097/api/health | python3 -m json.tool   # schneller Funktionstest
node --check app/static/app.js    # JS-Syntaxcheck
```

Es gibt keine Tests/Linter. UI-Prüfung ohne Chrome-Extension: `google-chrome --headless=new --no-sandbox --window-size=1600,2200 --virtual-time-budget=9000 --screenshot=out.png "http://localhost:8097/#storage"`.

## Wie der Container den Host sieht (wichtig)

`docker-compose.yml` setzt `pid: host`, `network_mode: host`, `cgroup: host`, `SYS_PTRACE` + `DAC_READ_SEARCH`, `apparmor=unconfined`. Dadurch sind `/proc`, `/sys`, Netzwerk-Interfaces und Sockets die des Hosts, psutil funktioniert direkt. Port 8097 wird direkt auf dem Host gebunden (kein Port-Mapping; über `PORT` änderbar).

- Host-Root liegt read-only unter `/hostfs` (`rslave`). Host-Dateien immer über `hostinfo.host_path()` lesen – **nicht** die Container-Dateien (z. B. Benutzernamen: `hostinfo.users` liest `/hostfs/etc/passwd`, nicht psutil/pwd).
- Mounts kommen aus `/proc/1/mountinfo` (Host-init), dedupliziert pro Gerät; `statvfs` über `/hostfs/<mountpoint>`.
- Container-Werte (CPU/RAM/IO) aus der Host-cgroup v2 (`/hostfs/sys/fs/cgroup/system.slice/docker-<id>.scope`), RAM = `memory.current - inactive_file` wie `docker stats`. Prozess-RSS-Summen nicht für Container-RAM verwenden (Shared Memory wird mehrfach gezählt).
- Prozess → Container über Regex auf `/proc/<pid>/cgroup`; Namen via Docker-Socket (read-only gemountet, nur GET).
- NVMe-Temperaturen direkt aus `/sys/class/nvme/nvmeX/hwmon*/temp1_input` (psutil-Reihenfolge vertauscht nvme0/nvme1).

## Architektur

Backend `app/` (FastAPI + psutil, keine weiteren Abhängigkeiten):

- `collector.py` – drei Daemon-Threads: **metrics** (alle 2 s, flaches Sample-Dict), **procs** (alle 3 s, `processes.monitor.sample()`), **slow** (Docker-Liste, Mounts, Plattenbelegung alle 10 min, Retention-Cleanup). Samples: Ringpuffer im RAM (1 h) + Minutenaggregat (avg/max als JSON) in SQLite `data/systemstats.db`.
- **Sample-Schlüssel** sind flach, Zusammengesetztes mit Doppelpunkt: `core:3`, `net_rx:enp193s0`, `disk_util:nvme1n1`, `temp:nvme0`, `ct_cpu:<container>`, `ct_mem:<container>`. Neue Metrik = neuer Schlüssel im Sample; Aggregation, Historie und `/api/analysis/history?keys=` (inkl. Wildcard `*präfix:`) greifen automatisch.
- Tabellen: `metrics_1m` (30 Tage), `proc_1m` (Top-25-Prozessgruppen nach CPU und RAM je Minute, 14 Tage), `disk_usage` (Belegung je Mountpoint, 180 Tage → lineare Füllprognose in `storage.fill_forecast`).
- `processes.py` – Prozess-Snapshot (Process-Objekte werden für `cpu_percent` wiederverwendet; cmdline/Container pro (pid, create_time) gecacht) und `ContainerRegistry` (Docker-API + cgroup-Statistik).
- `storage.py` – Verzeichnis-Scan als Hintergrund-Job (iterativ, bleibt im Dateisystem, `st_blocks` wie `du`, Hardlinks dedupliziert, speichert alle Verzeichnisgrößen → Drill-Down ohne Neuscan; max. 5 Jobs im RAM, gehen beim Neustart verloren), `docker system df` asynchron gecacht (kann Minuten dauern), Container-json-Log-Größen.
- `analysis.py` – `health()` bewertet aktuelle Werte gegen `config.THRESHOLDS` (per Env überschreibbar), Zeitreihen ≤ 1 h aus RAM, darüber aus SQLite, Top-Verbraucher.
- `control.py` – Stack-Steuerung über die Docker-API auf den **bestehenden** Containern (wie `docker compose start/stop/restart`, Reihenfolge nach Label `com.docker.compose.depends_on`), Aufträge laufen als Thread, Status in `control.jobs`. Neustart-Richtlinie per `POST /containers/{id}/update` – gilt nur bis zum Neuerstellen durch `docker compose up`. Der eigene Stack ist gesperrt. Hinweis: `:ro` am Docker-Socket schränkt API-Aufrufe nicht ein.
- `main.py` – REST-API unter `/api/*`. `/api/processes/top` muss vor `/api/processes/{pid}` deklariert bleiben.

Frontend `app/static/` (Vanilla JS, keine CDN-Abhängigkeiten): `charts.js` (eigene Canvas-`LineChart`, Farben als CSS-Variablen `--c1..--c8`, müssen Hex sein), `app.js` (ein Modul je Ansicht in `views.*` mit `init/refresh/enter`; `every()` pollt nur die aktive Ansicht; Live-Samples werden inkrementell via `/api/live?since=` geholt), `style.css` (Dark/Light über `data-theme`).
