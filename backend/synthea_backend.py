"""Entry point of the packaged compute-engine sidecar used by the desktop app.

The desktop shell starts this executable with ``--port`` and the environment
variables SYNTHEA_TOKEN (per-session API token) and SYNTHEA_DATA_DIR (per-user
data folder). The server only listens on 127.0.0.1.
"""
import argparse

import uvicorn

from app.main import app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
