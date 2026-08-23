#!/usr/bin/env python3
"""
Telemetry Monitor for VURA Benchmarking Suite
Captures CPU, RAM (RSS), and Disk storage metrics for the main VURA process
and all spawned child sidecar processes (Python, Node.js).
Uses psutil when available, with a robust fallback to native macOS/POSIX 'ps' commands.
"""

import os
import subprocess
import threading
import time
from typing import Dict, List, Any, Optional

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False


class TelemetryMonitor:
    def __init__(self, target_pid: Optional[int] = None, storage_dir: Optional[str] = None, sample_interval_sec: float = 0.25):
        self.target_pid = target_pid
        self.storage_dir = storage_dir or os.path.abspath(".vura/storage")
        self.sample_interval_sec = sample_interval_sec
        self.snapshots: List[Dict[str, Any]] = []
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.start_time: float = 0.0

    def start(self):
        self.snapshots = []
        self._stop_event.clear()
        self.start_time = time.time()
        self._thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self._thread.start()

    def stop(self):
        if self._thread and self._thread.is_alive():
            self._stop_event.set()
            self._thread.join(timeout=3.0)

    def _monitor_loop(self):
        while not self._stop_event.is_set():
            snapshot = self._take_snapshot()
            if snapshot:
                self.snapshots.append(snapshot)
            time.sleep(self.sample_interval_sec)

    def _get_storage_size_bytes(self) -> int:
        if not os.path.exists(self.storage_dir):
            return 0
        total_bytes = 0
        try:
            for root, _, files in os.walk(self.storage_dir):
                for f in files:
                    fp = os.path.join(root, f)
                    try:
                        total_bytes += os.path.getsize(fp)
                    except OSError:
                        pass
        except Exception:
            pass
        return total_bytes

    def _get_active_runs_count(self) -> int:
        runs_dir = os.path.join(self.storage_dir, "sessions")
        if not os.path.exists(runs_dir):
            return 0
        count = 0
        try:
            for root, dirs, _ in os.walk(runs_dir):
                if os.path.basename(root) == "runs":
                    count += len(dirs)
        except Exception:
            pass
        return count

    def _take_snapshot(self) -> Dict[str, Any]:
        rel_time = round(time.time() - self.start_time, 2)
        storage_bytes = self._get_storage_size_bytes()
        storage_mb = round(storage_bytes / (1024 * 1024), 2)
        active_runs = self._get_active_runs_count()

        if HAS_PSUTIL and self.target_pid:
            return self._sample_psutil(rel_time, storage_mb, active_runs)
        else:
            return self._sample_native(rel_time, storage_mb, active_runs)

    def _sample_psutil(self, rel_time: float, storage_mb: float, active_runs: int) -> Dict[str, Any]:
        main_mem_mb = 0.0
        main_cpu_pct = 0.0
        sidecar_mem_mb = 0.0
        sidecar_cpu_pct = 0.0
        sidecar_count = 0

        try:
            parent = psutil.Process(self.target_pid)
            main_mem_mb = round(parent.memory_info().rss / (1024 * 1024), 2)
            main_cpu_pct = round(parent.cpu_percent(interval=None), 1)

            for child in parent.children(recursive=True):
                try:
                    c_mem = child.memory_info().rss / (1024 * 1024)
                    c_cpu = child.cpu_percent(interval=None)
                    sidecar_mem_mb += c_mem
                    sidecar_cpu_pct += c_cpu
                    sidecar_count += 1
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

        return {
            "timestamp": rel_time,
            "main_rss_mb": main_mem_mb,
            "main_cpu_pct": main_cpu_pct,
            "sidecar_rss_mb": round(sidecar_mem_mb, 2),
            "sidecar_cpu_pct": round(sidecar_cpu_pct, 1),
            "sidecar_count": sidecar_count,
            "total_rss_mb": round(main_mem_mb + sidecar_mem_mb, 2),
            "storage_mb": storage_mb,
            "active_runs": active_runs
        }

    def _sample_native(self, rel_time: float, storage_mb: float, active_runs: int) -> Dict[str, Any]:
        main_mem_mb = 0.0
        main_cpu_pct = 0.0
        sidecar_mem_mb = 0.0
        sidecar_cpu_pct = 0.0
        sidecar_count = 0

        try:
            # Query all processes related to node / python sidecar or children of target_pid
            cmd = ["ps", "-ax", "-o", "pid,ppid,%cpu,rss,command"]
            out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL).decode("utf-8")
            lines = out.strip().split("\n")[1:]

            child_pids = set()
            for line in lines:
                parts = line.strip().split(None, 4)
                if len(parts) < 5:
                    continue
                pid_s, ppid_s, cpu_s, rss_s, cmd_s = parts[0], parts[1], parts[2], parts[3], parts[4]
                try:
                    p = int(pid_s)
                    pp = int(ppid_s)
                    cpu = float(cpu_s)
                    rss_mb = float(rss_s) / 1024.0
                except ValueError:
                    continue

                if self.target_pid and p == self.target_pid:
                    main_mem_mb = round(rss_mb, 2)
                    main_cpu_pct = round(cpu, 1)
                elif self.target_pid and (pp == self.target_pid or pp in child_pids):
                    child_pids.add(p)
                    sidecar_mem_mb += rss_mb
                    sidecar_cpu_pct += cpu
                    sidecar_count += 1
                elif not self.target_pid and ("sidecar.py" in cmd_s or "sidecar.js" in cmd_s or "vura-runner" in cmd_s):
                    sidecar_mem_mb += rss_mb
                    sidecar_cpu_pct += cpu
                    sidecar_count += 1
        except Exception:
            pass

        return {
            "timestamp": rel_time,
            "main_rss_mb": main_mem_mb,
            "main_cpu_pct": main_cpu_pct,
            "sidecar_rss_mb": round(sidecar_mem_mb, 2),
            "sidecar_cpu_pct": round(sidecar_cpu_pct, 1),
            "sidecar_count": sidecar_count,
            "total_rss_mb": round(main_mem_mb + sidecar_mem_mb, 2),
            "storage_mb": storage_mb,
            "active_runs": active_runs
        }

    def get_summary(self) -> Dict[str, Any]:
        if not self.snapshots:
            return {
                "peak_total_rss_mb": 0.0,
                "peak_sidecar_rss_mb": 0.0,
                "peak_cpu_pct": 0.0,
                "start_storage_mb": 0.0,
                "peak_storage_mb": 0.0,
                "end_storage_mb": 0.0,
                "storage_delta_mb": 0.0,
                "sample_count": 0
            }

        peak_total_rss = max(s["total_rss_mb"] for s in self.snapshots)
        peak_sidecar_rss = max(s["sidecar_rss_mb"] for s in self.snapshots)
        peak_cpu = max(s["main_cpu_pct"] + s["sidecar_cpu_pct"] for s in self.snapshots)
        start_storage = self.snapshots[0]["storage_mb"]
        end_storage = self.snapshots[-1]["storage_mb"]
        peak_storage = max(s["storage_mb"] for s in self.snapshots)

        return {
            "peak_total_rss_mb": peak_total_rss,
            "peak_sidecar_rss_mb": peak_sidecar_rss,
            "peak_cpu_pct": peak_cpu,
            "start_storage_mb": start_storage,
            "peak_storage_mb": peak_storage,
            "end_storage_mb": end_storage,
            "storage_delta_mb": round(end_storage - start_storage, 2),
            "sample_count": len(self.snapshots)
        }
