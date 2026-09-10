#!/usr/bin/env python3
import os
import sys
import json
import time
try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False
import socket
import platform
import argparse
import subprocess
import webbrowser
from http.server import HTTPServer, SimpleHTTPRequestHandler
from typing import Dict, Any, List

# Ensure VURA modules can be imported if needed
sys.path.insert(0, os.path.abspath("packages/vura-io-py"))

class VuraBenchmarkingTool:
    def __init__(self, tier: str = "quick", output_file: str = "benchmarks/results.jsonl"):
        self.tier = tier
        self.output_file = output_file
        self.git_sha = self._get_git_sha()
        self.vura_version = self._get_vura_version()
        self.machine_info = self._get_machine_info()
        self.checkpoints = [10_000, 50_000, 100_000, 500_000, 1_000_000] if tier == "quick" else [10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000, 10_000_000, 50_000_000, 100_000_000]

    def _get_git_sha(self) -> str:
        try:
            return subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
        except Exception:
            return "unknown"

    def _get_vura_version(self) -> str:
        try:
            with open("package.json", "r") as f:
                data = json.load(f)
                return data.get("version", "1.0.0")
        except Exception:
            return "1.0.0"

    def _get_machine_info(self) -> Dict[str, Any]:
        cores = psutil.cpu_count(logical=True) if HAS_PSUTIL else os.cpu_count() or 1
        ram_gb = round(psutil.virtual_memory().total / (1024 ** 3), 1) if HAS_PSUTIL else 8.0
        return {
            "cpu": platform.processor() or platform.machine(),
            "cores": cores,
            "ramGB": ram_gb,
            "os": f"{platform.system()} {platform.release()}"
        }

    def _get_process_rss_mb(self) -> float:
        if HAS_PSUTIL:
            process = psutil.Process(os.getpid())
            return round(process.memory_info().rss / (1024 * 1024), 2)
        try:
            out = subprocess.check_output(["ps", "-o", "rss=", "-p", str(os.getpid())], text=True)
            return round(float(out.strip()) / 1024.0, 2)
        except Exception:
            return 0.0

    def log_measurement(self, suite: str, op: str, table_rows: int, batch_size: int, language: str, duration_ms: float, extra: Dict[str, Any] = None):
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "suite": suite,
            "op": op,
            "tableRows": table_rows,
            "batchSize": batch_size,
            "language": language,
            "durationMs": round(duration_ms, 2),
            "rssMemMB": self._get_process_rss_mb(),
            "machine": self.machine_info,
            "gitSha": self.git_sha,
            "vuraVersion": self.vura_version
        }
        if extra:
            entry.update(extra)

        os.makedirs(os.path.dirname(os.path.abspath(self.output_file)), exist_ok=True)
        with open(self.output_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

    def run_suite(self):
        print(f"🚀 Running VURA Benchmarks [Tier: {self.tier.upper()}]...")
        os.makedirs(os.path.dirname(os.path.abspath(self.output_file)), exist_ok=True)
        # Clear or initialize output file
        with open(self.output_file, "w", encoding="utf-8") as f:
            pass

        # Suite 1: append_scaling
        print(" -> Suite 1: append() latency vs table size (Python & Node sidecar engines)")
        try:
            from vura.io.data import DataManager
            data_mgr = DataManager()
            table_name = "bench_append_test"
            current_rows = 0

            for target_rows in self.checkpoints:
                rows_to_add = target_rows - current_rows
                batch_size = 10_000 if rows_to_add >= 10_000 else rows_to_add
                batches = rows_to_add // batch_size

                for _ in range(batches):
                    # Synthetic data batch
                    batch_data = [{"id": i, "val": i * 1.5, "name": f"row_{i}"} for i in range(batch_size)]
                    start_t = time.time()
                    if current_rows == 0:
                        data_mgr.put(table_name, batch_data)
                    else:
                        data_mgr.append(table_name, batch_data)
                    dur_ms = (time.time() - start_t) * 1000.0
                    current_rows += batch_size
                    self.log_measurement("append_scaling", "append", current_rows, batch_size, "python", dur_ms)
                print(f"    [Python] Target {target_rows:,} rows reached. Current RSS: {self._get_process_rss_mb()} MB")

        except Exception as e:
            print(f"    [!] Error in Suite 1 Python: {e}")

        # Suite 2: read_scaling (stream) - object vs arrow
        print(" -> Suite 2: stream() latency and RSS memory (object vs arrow)")
        try:
            from vura.io.data import DataManager
            data_mgr = DataManager()
            for rows in [10_000, 50_000, 100_000]:
                if rows in self.checkpoints:
                    # Test format: dict (object)
                    start_t = time.time()
                    batches_obj = list(data_mgr.stream("bench_append_test", batch_size=rows, format="dict"))
                    dur_obj = (time.time() - start_t) * 1000.0
                    self.log_measurement("read_scaling", "stream", rows, rows, "python", dur_obj, {"format": "object"})

                    # Test format: arrow
                    start_t = time.time()
                    batches_arrow = list(data_mgr.stream("bench_append_test", batch_size=rows, format="arrow"))
                    dur_arrow = (time.time() - start_t) * 1000.0
                    self.log_measurement("read_scaling", "stream", rows, rows, "python", dur_arrow, {"format": "arrow"})
        except Exception as e:
            print(f"    [!] Error in Suite 2 Python: {e}")

        print(" ✓ Benchmark suite completed successfully.")


def serve_dashboard(port: int = 8080, open_browser: bool = True):
    dashboard_dir = os.path.abspath("benchmarks")
    os.chdir(dashboard_dir)
    server_address = ("", port)
    handler = SimpleHTTPRequestHandler
    httpd = HTTPServer(server_address, handler)
    url = f"http://localhost:{port}/index.html"
    print(f"🌐 Serving VURA Benchmark Dashboard at {url}")
    if open_browser:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping dashboard server.")


def main():
    parser = argparse.ArgumentParser(description="VURA Real-Engine Scale Benchmark Tool & Local Dashboard")
    parser.add_argument("command", choices=["run", "serve"], nargs="?", default="run", help="Command to execute (run or serve)")
    parser.add_argument("--tier", choices=["quick", "full"], default="quick", help="Benchmark tier (quick up to 1M, full up to 100M)")
    parser.add_argument("--headless", "--no-browser", action="store_true", dest="headless", help="Run benchmark in headless mode (no browser launch)")
    parser.add_argument("--port", type=int, default=8080, help="Local dashboard HTTP port (default: 8080)")
    parser.add_argument("--output", type=str, default="benchmarks/results.jsonl", help="JSONL output path")

    args = parser.parse_args()

    if args.command == "run":
        tool = VuraBenchmarkingTool(tier=args.tier, output_file=args.output)
        tool.run_suite()
        if not args.headless:
            serve_dashboard(port=args.port, open_browser=True)
    elif args.command == "serve":
        serve_dashboard(port=args.port, open_browser=not args.headless)


if __name__ == "__main__":
    main()
