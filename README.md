# Systemstats

Selbst gehostetes Status-Dashboard für einen Linux-Host, als einzelner Docker-Container.

- **Übersicht** – CPU (je Kern, Last, Takt, Temperatur), RAM/Swap, AMD-GPU (Auslastung, VRAM/GTT, Temperatur, Leistung), Netz, Disk-I/O, Pressure Stall Information, Warnungen
- **Prozesse** – alle Host-Prozesse mit CPU, RAM, I/O, Benutzer und Container; Gruppierung, Baumansicht, Detailansicht (offene Dateien, Verbindungen, Eltern/Kinder)
- **Container** – CPU/RAM/I/O je Container aus der cgroup (wie `docker stats`), gruppiert nach Compose-Stack; Stacks starten, stoppen, neu starten und Neustart-Richtlinie setzen
- **Speicher** – Belegung und Inodes je Dateisystem mit Füllprognose, NVMe-Temperaturen, Verzeichnisanalyse (wie `du`, mit Drill-Down und größten Dateien), `docker system df`, Größe der Container-Logs
- **Netzwerk** – Schnittstellen, offene Ports mit Prozess/Container, TCP-Zustände
- **Analyse** – Verlauf von 15 Minuten bis 30 Tage (SQLite), Min/Ø/p95/Max, Top-Verbraucher, Plattenbelegung über die Zeit

Backend: Python (FastAPI + psutil), Frontend: Vanilla JS ohne externe Abhängigkeiten.

## Starten

```bash
docker compose up -d --build
```

Danach erreichbar unter `http://<host>:8097` (Port über `PORT` in `docker-compose.yml` änderbar).

Voraussetzungen: Linux mit cgroup v2, Docker mit Compose-Plugin. GPU-Werte werden für AMD-GPUs (amdgpu-Treiber) gelesen.

## ⚠️ Sicherheit

Das Dashboard ist für ein vertrauenswürdiges Heimnetz gedacht und hat **keine Anmeldung**.

- Der Container läuft mit `pid: host`, `network_mode: host`, `cgroup: host`, erweiterten Capabilities und hat das Host-Dateisystem read-only eingehängt – er sieht praktisch alles auf dem Host.
- Er hat Zugriff auf den Docker-Socket. Das entspricht Root-Rechten auf dem Host (`:ro` am Socket schränkt die API **nicht** ein).
- Über die Oberfläche lassen sich Compose-Stacks starten/stoppen und deren Neustart-Richtlinie ändern. Mit `CONTROL_ENABLED=0` ist das Dashboard rein lesend.

**Nicht ins Internet freigeben.** Für Zugriff von außen einen Reverse-Proxy mit Authentifizierung oder ein VPN davorschalten.

## Konfiguration

Umgebungsvariablen (siehe `app/config.py`), z. B.:

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | `8097` | HTTP-Port |
| `CONTROL_ENABLED` | `1` | Stack-Steuerung erlauben |
| `SAMPLE_INTERVAL` | `2` | Abtastintervall der Metriken (s) |
| `RETENTION_METRICS_DAYS` | `30` | Aufbewahrung der Minutenwerte |
| `WARN_DISK_PCT` / `CRIT_DISK_PCT` | `85` / `95` | Schwellwerte Plattenbelegung |

Daten (SQLite) liegen in `./data`.
