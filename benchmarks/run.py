import threading
#!/usr/bin/env python3
import os
import sys
import json
import time
import tempfile
import shutil
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

class SidecarClient:
    def __init__(self, command: List[str], cwd: str, storage_path: str, env_extra: Dict[str, str] = None):
        env = dict(os.environ)
        env["VURA_STORAGE_PATH"] = storage_path
        if env_extra:
            env.update(env_extra)
        self.proc = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1
        )
        self.storage_path = storage_path
        self._req_id = 0
        self.stderr_lines = []
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _drain_stderr(self):
        try:
            for line in self.proc.stderr:
                self.stderr_lines.append(line)
        except Exception:
            pass

    def execute_code(self, code: str) -> Dict[str, Any]:
        self._req_id += 1
        req_id = f"bench_{self._req_id}"
        payload = {
            "id": req_id,
            "code": code,
            "ctx": {"storagePath": self.storage_path}
        }
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()

        line = self.proc.stdout.readline()
        if not line:
            stderr_out = "".join(self.stderr_lines)
            raise RuntimeError(f"Sidecar process closed unexpectedly. Stderr: {stderr_out}")
        return json.loads(line.strip())

    def close(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()


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
        with open(self.output_file, "w", encoding="utf-8") as f:
            pass

        repo_root = os.path.abspath(".")
        py_sidecar_script = os.path.join(repo_root, "packages/vura-runner/src/assets/sidecar.py")
        node_sidecar_script = os.path.join(repo_root, "packages/vura-runner/src/assets/sidecar.js")

        node_bin = shutil.which("node") or "node"
        python_bin = sys.executable or "python3"

        extra_node_paths = [
            os.path.join(repo_root, "node_modules"),
            os.path.join(repo_root, "packages/vura-runner/node_modules")
        ]
        node_path_str = os.path.pathsep.join(extra_node_paths)

        # Suite 1: append_scaling (Python & Node sidecar engines)
        print(" -> Suite 1: append() latency vs table size (Python & Node sidecar engines)")

        # 1a. Python sidecar worker
        temp_dir_py = tempfile.mkdtemp(prefix="vura_bench_py_")
        py_client = SidecarClient([python_bin, "-u", py_sidecar_script, "--serve"], repo_root, temp_dir_py)
        current_rows_py = 0
        try:
            for target_rows in self.checkpoints:
                rows_to_add = target_rows - current_rows_py
                batch_size = 10_000 if rows_to_add >= 10_000 else rows_to_add
                batches = rows_to_add // batch_size

                for _ in range(batches):
                    code = f"""
batch_data = [{{"id": i, "val": i * 1.5, "name": f"row_{{i}}"}} for i in range({batch_size})]
if {current_rows_py} == 0 and data._find_existing_table_path('bench_append_test')[0] is None:
    data.put('bench_append_test', batch_data)
else:
    data.append('bench_append_test', batch_data)
"""
                    start_t = time.time()
                    res = py_client.execute_code(code)
                    dur_ms = (time.time() - start_t) * 1000.0
                    if res.get("status") != "ok":
                        raise RuntimeError(f"Python sidecar error: {res.get('error')}")

                    current_rows_py += batch_size
                    self.log_measurement("append_scaling", "append", current_rows_py, batch_size, "python", dur_ms)
                print(f"    [Python] Target {target_rows:,} rows reached. Current RSS: {self._get_process_rss_mb()} MB")
        except Exception as e:
            print(f"    [!] Error in Suite 1 Python: {e}")
        finally:
            py_client.close()
            shutil.rmtree(temp_dir_py, ignore_errors=True)

        # 1b. Node sidecar worker
        temp_dir_node = tempfile.mkdtemp(prefix="vura_bench_node_")
        node_client = SidecarClient([node_bin, node_sidecar_script, "--serve"], repo_root, temp_dir_node, {"NODE_PATH": node_path_str})
        current_rows_node = 0
        try:
            for target_rows in self.checkpoints:
                rows_to_add = target_rows - current_rows_node
                batch_size = 10_000 if rows_to_add >= 10_000 else rows_to_add
                batches = rows_to_add // batch_size

                for _ in range(batches):
                    code = f"""
const batchData = Array.from({{ length: {batch_size} }}, (_, i) => ({{ id: i, val: i * 1.5, name: 'row_' + i }}));
const info = data.findExistingTablePath('bench_append_test');
if (!info) {{
    await data.put('bench_append_test', batchData);
}} else {{
    await data.append('bench_append_test', batchData);
}}
"""
                    start_t = time.time()
                    res = node_client.execute_code(code)
                    dur_ms = (time.time() - start_t) * 1000.0
                    if res.get("status") != "ok":
                        raise RuntimeError(f"Node sidecar error: {res.get('error')}")

                    current_rows_node += batch_size
                    self.log_measurement("append_scaling", "append", current_rows_node, batch_size, "javascript", dur_ms)
                print(f"    [Node] Target {target_rows:,} rows reached. Current RSS: {self._get_process_rss_mb()} MB")
        except Exception as e:
            print(f"    [!] Error in Suite 1 Node: {e}")
        finally:
            node_client.close()
            shutil.rmtree(temp_dir_node, ignore_errors=True)

        # Suite 2: read_scaling (stream) - object vs arrow (Python & Node)
        print(" -> Suite 2: stream() latency and RSS memory (object vs arrow - Python & Node)")
        s2_checkpoints = [r for r in self.checkpoints if r <= 1_000_000]

        # 2a. Python sidecar worker for Suite 2
        temp_dir_s2_py = tempfile.mkdtemp(prefix="vura_bench_s2_py_")
        py_client_s2 = SidecarClient([python_bin, "-u", py_sidecar_script, "--serve"], repo_root, temp_dir_s2_py)
        try:
            for rows in s2_checkpoints:
                # Seed dataset
                seed_code = f"data.put('bench_stream_test', [{{\"id\": i, \"val\": i * 1.5}} for i in range({rows})])"
                py_client_s2.execute_code(seed_code)

                # Test format: dict (object)
                stream_obj_code = f"batches = list(data.stream('bench_stream_test', batch_size={rows}, format='dict'))"
                start_t = time.time()
                res_obj = py_client_s2.execute_code(stream_obj_code)
                dur_obj = (time.time() - start_t) * 1000.0
                if res_obj.get("status") == "ok":
                    self.log_measurement("read_scaling", "stream", rows, rows, "python", dur_obj, {"format": "object"})

                # Test format: arrow
                stream_arrow_code = f"""import pyarrow as pa
batches = list(data.stream('bench_stream_test', batch_size={rows}, format='arrow'))
verified = len(batches) > 0 and all(isinstance(b, (pa.RecordBatch, pa.Table)) for b in batches)
print(f"VERIFIED_ARROW:{{verified}}")
"""
                start_t = time.time()
                res_arrow = py_client_s2.execute_code(stream_arrow_code)
                dur_arrow = (time.time() - start_t) * 1000.0
                if res_arrow.get("status") == "ok":
                    arrow_verified = "VERIFIED_ARROW:True" in res_arrow.get("stdout", "")
                    if not arrow_verified:
                        sys.stderr.write(f"Warning: Python Arrow batch verification failed for {rows} rows\n")
                    self.log_measurement("read_scaling", "stream", rows, rows, "python", dur_arrow, {"format": "arrow", "arrowVerified": arrow_verified})
                print(f"    [Python Stream] Target {rows:,} rows reached. Current RSS: {self._get_process_rss_mb()} MB")
        except Exception as e:
            print(f"    [!] Error in Suite 2 Python: {e}")
        finally:
            py_client_s2.close()
            shutil.rmtree(temp_dir_s2_py, ignore_errors=True)

        # 2b. Node sidecar worker for Suite 2
        temp_dir_s2_node = tempfile.mkdtemp(prefix="vura_bench_s2_node_")
        node_client_s2 = SidecarClient([node_bin, node_sidecar_script, "--serve"], repo_root, temp_dir_s2_node, {"NODE_PATH": node_path_str})
        try:
            for rows in s2_checkpoints:
                # Seed dataset using vura put
                seed_code = f"const {{ put }} = require('vura'); await put('bench_stream_test', Array.from({{length: {rows}}}, (_, i) => ({{id: i, val: i * 1.5}})));"
                node_client_s2.execute_code(seed_code)

                # Test format: object
                stream_obj_code = f"const {{ stream }} = require('vura'); const batches = []; for await (const b of stream('bench_stream_test', {{batchSize: {rows}, format: 'object'}})) batches.push(b);"
                start_t = time.time()
                res_obj = node_client_s2.execute_code(stream_obj_code)
                dur_obj = (time.time() - start_t) * 1000.0
                if res_obj.get("status") == "ok":
                    self.log_measurement("read_scaling", "stream", rows, rows, "javascript", dur_obj, {"format": "object"})

                # Test format: arrow
                stream_arrow_code = f"""const {{ stream }} = require('vura');
const batches = [];
for await (const b of stream('bench_stream_test', {{batchSize: {rows}, format: 'arrow'}})) batches.push(b);
const looksArrow = (b) => b && typeof b === 'object' && (typeof b.numRows === 'number' || (b.schema && typeof b.schema === 'object'));
const verified = batches.length > 0 && batches.every(looksArrow);
console.log('VERIFIED_ARROW:' + verified);
"""
                start_t = time.time()
                res_arrow = node_client_s2.execute_code(stream_arrow_code)
                dur_arrow = (time.time() - start_t) * 1000.0
                if res_arrow.get("status") == "ok":
                    arrow_verified = "VERIFIED_ARROW:true" in res_arrow.get("stdout", "")
                    if not arrow_verified:
                        sys.stderr.write(f"Warning: Node Arrow batch verification failed for {rows} rows\n")
                    self.log_measurement("read_scaling", "stream", rows, rows, "javascript", dur_arrow, {"format": "arrow", "arrowVerified": arrow_verified})
                print(f"    [Node Stream] Target {rows:,} rows reached. Current RSS: {self._get_process_rss_mb()} MB")
        except Exception as e:
            print(f"    [!] Error in Suite 2 Node: {e}")
        finally:
            node_client_s2.close()
            shutil.rmtree(temp_dir_s2_node, ignore_errors=True)

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
