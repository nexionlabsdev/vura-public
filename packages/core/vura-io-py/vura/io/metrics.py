import json
import sys
import time

class MetricsManager:
    def track(self, name, value, step=None):
        payload = {"type": "vura_metric", "name": name, "value": value, "step": step, "timestamp": time.time()}
        print(json.dumps(payload), file=sys.stderr)

    def log(self, message, level="INFO"):
        print(f"[{level.upper()}] {message}")

    def preview(self, name, sample):
        payload = {"type": "vura_preview", "name": name, "sample": sample, "timestamp": time.time()}
        print(json.dumps(payload), file=sys.stderr)

metrics = MetricsManager()
