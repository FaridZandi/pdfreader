import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from local_webui import fetch_url_as_pdf

PDF_BYTES = b"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF"
PAGE_HTML = b"<!doctype html><title>A Local Page</title><p>Readable body text.</p>"


class Origin(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/paper.pdf":
            body, content_type = PDF_BYTES, "application/pdf"
        elif self.path == "/mislabelled":
            # A PDF served as HTML: the sniff has to win over the header.
            body, content_type = PDF_BYTES, "text/html"
        elif self.path == "/article":
            body, content_type = PAGE_HTML, "text/html"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        pass


class FetchUrlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Origin)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        host, port = self.server.server_address
        self.origin = f"http://{host}:{port}"
        self.printed: list[str] = []

    def _printer(self, url: str) -> tuple[bytes, str]:
        self.printed.append(url)
        return PDF_BYTES, "A Local Page.pdf"

    def test_a_pdf_link_is_downloaded_without_printing(self):
        body, name = fetch_url_as_pdf(f"{self.origin}/paper.pdf", self._printer)

        self.assertEqual(body, PDF_BYTES)
        self.assertEqual(name, "paper.pdf")
        self.assertEqual(self.printed, [])

    def test_content_type_does_not_override_the_bytes(self):
        body, name = fetch_url_as_pdf(f"{self.origin}/mislabelled", self._printer)

        self.assertEqual(body, PDF_BYTES)
        self.assertEqual(name, "mislabelled.pdf")
        self.assertEqual(self.printed, [])

    def test_a_web_page_is_printed_to_pdf(self):
        url = f"{self.origin}/article"

        body, name = fetch_url_as_pdf(url, self._printer)

        self.assertEqual(body, PDF_BYTES)
        self.assertEqual(name, "A Local Page.pdf")
        self.assertEqual(self.printed, [url])

    def test_non_web_schemes_are_refused_before_any_request(self):
        for address in ("file:///etc/passwd", "ftp://example.com/x.pdf", "not a url"):
            with self.subTest(address=address):
                with self.assertRaises(ValueError):
                    fetch_url_as_pdf(address, self._printer)
        self.assertEqual(self.printed, [])

    def test_a_missing_page_reports_the_failure(self):
        with self.assertRaises(ValueError):
            fetch_url_as_pdf(f"{self.origin}/nothing-here", self._printer)


class DocumentNameTests(unittest.TestCase):
    def test_names_are_readable_and_safe(self):
        from local_webui import _document_name, _name_from_url

        self.assertEqual(_name_from_url("https://arxiv.org/pdf/1706.03762v7"), "1706.03762v7.pdf")
        self.assertEqual(_name_from_url("https://example.com/a%20paper.pdf"), "a paper.pdf")
        self.assertEqual(_document_name("Title: with / separators", "x.pdf"), "Title with separators.pdf")
        self.assertEqual(_document_name("   ", "fallback.pdf"), "fallback.pdf")


if __name__ == "__main__":
    unittest.main()
