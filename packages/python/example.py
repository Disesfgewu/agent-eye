"""End-to-end example: drive a running web app with Agent Eye from Python.

Assumes something is served at http://127.0.0.1:5500 (e.g. the Flutter demo).
Run:  python example.py
"""
from agent_eye import AgentEye


def main() -> None:
    # channel="chrome" reuses the system Chrome (no separate browser download).
    with AgentEye(workspace=".", channel="chrome", show_cursor=True, slow_mo=300) as eye:
        info = eye.navigate("http://127.0.0.1:5500")
        print("navigated:", info)

        eye.screenshot(save_path="agent_eye_example.png")
        print("saved screenshot -> agent_eye_example.png")

        print("--- snapshot (first 400 chars) ---")
        print(eye.snapshot()[:400])

        print("--- network (API calls to the backend) ---")
        for req in eye.get_network_requests(limit=40):
            if "/api/" in req["url"]:
                print(req["method"], req["url"], req["status"])

        print("--- console ---")
        for line in eye.get_console_logs(limit=10):
            print(f"[{line['type']}] {line['text'][:120]}")


if __name__ == "__main__":
    main()
