import json
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from threading import Thread

from local_webui import DEFAULT_VOICE, VOICE_IDS, handler_for


class StubApp:
    """Stands in for Kokoro so the test does not need the model."""

    def __init__(self) -> None:
        self.calls = []

    def synthesize(self, text, speed, voice=None, should_stop=None):
        self.calls.append({"text": text, "speed": speed, "voice": voice})
        return b"RIFF"


class ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.app = StubApp()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(self.app))
        Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        host, port = self.server.server_address
        self.base = f"http://{host}:{port}"

    def _post(self, path: str, payload: dict):
        request = urllib.request.Request(
            f"{self.base}{path}",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        return urllib.request.urlopen(request, timeout=5)  # noqa: S310 - local test server

    def test_the_voice_list_is_served_so_the_page_cannot_offer_an_unknown_one(self):
        with urllib.request.urlopen(f"{self.base}/api/voices", timeout=5) as response:  # noqa: S310
            payload = json.loads(response.read())
        self.assertEqual(payload["default"], DEFAULT_VOICE)
        self.assertEqual({item["id"] for item in payload["voices"]}, VOICE_IDS)
        self.assertTrue(all(item["label"] for item in payload["voices"]))

    def test_a_request_without_a_voice_uses_the_default(self):
        self._post("/api/synthesize", {"text": "Read this aloud.", "speed": 1.0}).read()
        self.assertEqual(self.app.calls[-1]["voice"], DEFAULT_VOICE)

    def test_the_chosen_voice_reaches_the_model(self):
        self._post("/api/synthesize", {"text": "Read this aloud.", "speed": 1.0, "voice": "am_michael"}).read()
        self.assertEqual(self.app.calls[-1]["voice"], "am_michael")

    def test_an_unknown_voice_is_refused_rather_than_passed_through(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self._post("/api/synthesize", {"text": "Read this aloud.", "speed": 1.0, "voice": "../etc/passwd"})
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(json.loads(caught.exception.read())["error"], "Unknown voice.")
        self.assertEqual(self.app.calls, [])


if __name__ == "__main__":
    unittest.main()
