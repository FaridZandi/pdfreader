import json
import socket
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

from local_webui import ExportCancelled, handler_for


class StubApp:
    """Stands in for Kokoro so the test does not need the model."""

    def __init__(self) -> None:
        self.started = threading.Event()
        self.cancelled = threading.Event()
        self.finished = threading.Event()

    def synthesize_export(self, chunks, speed, should_stop=None):
        self.started.set()
        for _ in range(500):
            if should_stop is not None and should_stop():
                self.cancelled.set()
                raise ExportCancelled
            time.sleep(0.01)
        self.finished.set()
        return b"never reached in this test"


class ExportCancellationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.app = StubApp()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(self.app))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def _send_export_request(self) -> socket.socket:
        body = json.dumps({"chunks": ["a paragraph to speak"], "speed": 1.0}).encode()
        client = socket.create_connection(self.server.server_address, timeout=5)
        client.sendall(
            b"POST /api/export-audio HTTP/1.1\r\n"
            b"Host: 127.0.0.1\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
        )
        return client

    def test_generation_stops_when_the_browser_drops_the_connection(self):
        client = self._send_export_request()
        self.assertTrue(self.app.started.wait(5), "export never started")
        # An in-flight export must not be reported as cancelled on its own.
        time.sleep(0.2)
        self.assertFalse(self.app.cancelled.is_set())

        client.close()

        self.assertTrue(self.app.cancelled.wait(5), "export kept running after the client left")
        self.assertFalse(self.app.finished.is_set())


if __name__ == "__main__":
    unittest.main()
