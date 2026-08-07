import json
import socket
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

from local_webui import RequestCancelled, handler_for


class StubApp:
    """Stands in for Kokoro so the test does not need the model."""

    def __init__(self) -> None:
        self.started = threading.Event()
        self.cancelled = threading.Event()
        self.finished = threading.Event()

    def _generate(self, should_stop):
        self.started.set()
        for _ in range(500):
            if should_stop is not None and should_stop():
                self.cancelled.set()
                raise RequestCancelled
            time.sleep(0.01)
        self.finished.set()
        return b"never reached in this test"

    def synthesize_export(self, chunks, speed, voice=None, should_stop=None):
        return self._generate(should_stop)

    def synthesize(self, text, speed, voice=None, should_stop=None):
        return self._generate(should_stop)


class CancellationTests(unittest.TestCase):
    """Leaving has to stop generation: audio nobody will receive still costs
    the machine the same model time as audio somebody wants."""

    def setUp(self) -> None:
        self.app = StubApp()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(self.app))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def _post(self, path: str, payload: dict) -> socket.socket:
        body = json.dumps(payload).encode()
        client = socket.create_connection(self.server.server_address, timeout=5)
        client.sendall(
            f"POST {path} HTTP/1.1\r\n".encode()
            + b"Host: 127.0.0.1\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
        )
        return client

    def _assert_stops_when_the_client_leaves(self, client: socket.socket) -> None:
        self.assertTrue(self.app.started.wait(5), "generation never started")
        # Work in flight must not be reported as cancelled on its own.
        time.sleep(0.2)
        self.assertFalse(self.app.cancelled.is_set())

        client.close()

        self.assertTrue(self.app.cancelled.wait(5), "generation kept running after the client left")
        self.assertFalse(self.app.finished.is_set())

    def test_export_stops_when_the_browser_drops_the_connection(self):
        self._assert_stops_when_the_client_leaves(
            self._post("/api/export-audio", {"chunks": ["a paragraph to speak"], "speed": 1.0})
        )

    def test_playback_synthesis_stops_when_the_reader_jumps_away(self):
        # The reader aborts this request when you click another paragraph, so
        # the server has to stop rather than finish work the reader discarded.
        self._assert_stops_when_the_client_leaves(
            self._post("/api/synthesize", {"text": "a paragraph to speak", "speed": 1.0})
        )


if __name__ == "__main__":
    unittest.main()
