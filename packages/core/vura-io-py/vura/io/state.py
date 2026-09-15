import os

class StateManager:
    def __init__(self):
        self._store = {}

    def set(self, key, value):
        self._store[key] = value

    def get(self, key, default=None):
        return self._store.get(key, default)

    @property
    def context(self):
        return {
            "storage_path": os.environ.get("VURA_STORAGE_PATH", ""),
            "notebook_id": os.environ.get("VURA_NOTEBOOK_ID", "default"),
            "depth_limit": int(os.environ.get("VURA_DEPTH_LIMIT", "5")),
            "env": dict(os.environ)
        }

state = StateManager()
