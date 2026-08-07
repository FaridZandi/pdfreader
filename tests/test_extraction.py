"""Extraction against a real PDF rather than hand-built dictionaries.

`tests/fixtures/two-column-paper.pdf` is a two-column paper printed by the same
headless Chromium the **From URL** feature uses, from the HTML kept beside it.
The other two fixtures are what the real tools produce from that PDF:
`.bbox.html` is `pdftotext -bbox` output and `.docling.json` is a Docling
conversion.  Both can be regenerated with the commands in `README.md`.
"""

import json
import unittest
from pathlib import Path

from local_webui import (
    BBoxParser,
    _column_gutter,
    _page_reading_order,
    annotate_filter_reasons,
    content_for_preset,
    paragraphs_from_docling_document,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def flattened(value: str) -> str:
    """Reading order without line breaks, which are a rendering artefact."""
    return " ".join(value.split())


class BBoxReadingOrderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        parser = BBoxParser()
        parser.feed((FIXTURES / "two-column-paper.bbox.html").read_text(encoding="utf-8"))
        cls.pages = parser.pages

    def test_word_positions_are_read_from_poppler_output(self):
        self.assertEqual(len(self.pages), 2)
        first = self.pages[0]
        self.assertEqual((first["width"], first["height"]), (612.0, 792.0))
        self.assertGreater(len(first["words"]), 400)
        left, right, baseline, text = first["words"][0]
        self.assertEqual(text, "Column-Aware")
        self.assertLess(left, right)
        self.assertLess(baseline, first["height"])

    def test_the_gutter_is_measured_from_the_page(self):
        # The column gap in this paper is about 22pt, well under the five
        # percent of page width the previous fixed threshold demanded, and the
        # full-width title crosses it - neither may stop it being found.
        gutter = _column_gutter(self._rows(self.pages[0]), self.pages[0]["width"])
        self.assertIsNotNone(gutter)
        start, end = gutter
        self.assertGreater(end - start, 8)
        self.assertTrue(280 < (start + end) / 2 < 330)

    def test_a_single_column_page_has_no_gutter(self):
        rows = [[(72.0, 540.0, float(top), "a full width line of ordinary prose")] for top in range(100, 400, 12)]
        self.assertIsNone(_column_gutter(rows, 612.0))

    def test_each_column_is_read_through_before_the_next(self):
        text = flattened(_page_reading_order(self.pages[0]))
        # Every sentence survives whole: interleaving the columns would splice
        # words from the other side into the middle of these.
        self.assertIn(
            "For the two-column format used by most conference proceedings it is "
            "catastrophic: a naive top-to-bottom sweep produces a sentence from the "
            "left column followed by an unrelated sentence from the right, and the "
            "listener loses the thread within a paragraph.",
            text,
        )
        self.assertIn(
            "A line that ends in a hyphen is joined to the following line without an "
            "intervening space, which restores words broken across a line end.",
            text,
        )
        # And the left column is finished before the right one starts.
        self.assertLess(text.index("2 Method"), text.index("Figure 1."))
        self.assertLess(text.index("gutter threshold set to five percent"), text.index("3 Results"))

    def test_a_word_broken_across_a_line_end_is_rejoined(self):
        text = flattened(_page_reading_order(self.pages[0]))
        self.assertIn("a naive top-to-bottom sweep", text)
        self.assertNotIn("top-to- bottom", text)

    def test_an_isolated_page_number_at_the_foot_is_dropped(self):
        page = {
            "width": 612.0,
            "height": 792.0,
            "words": [
                (72.0, 540.0, 100.0, "The"),
                (72.0, 540.0, 100.0, "opening line."),
                (300.0, 312.0, 730.0, "7"),
            ],
        }
        self.assertNotIn("7", _page_reading_order(page))

    @staticmethod
    def _rows(page):
        rows = []
        for word in sorted(page["words"], key=lambda item: (item[2], item[0])):
            if not rows or abs(word[2] - rows[-1][0][2]) > 3:
                rows.append([word])
            else:
                rows[-1].append(word)
        return rows


class DoclingDocumentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        document = json.loads((FIXTURES / "two-column-paper.docling.json").read_text(encoding="utf-8"))
        cls.paragraphs, cls.figure_boxes = paragraphs_from_docling_document(document)
        cls.annotated = annotate_filter_reasons(cls.paragraphs, cls.figure_boxes)

    def test_text_blocks_become_paragraphs_with_stable_ids_and_geometry(self):
        self.assertEqual([item["id"] for item in self.paragraphs][:3], ["0", "1", "2"])
        title = self.paragraphs[0]
        self.assertEqual(title["label"], "section_header")
        self.assertEqual(title["text"], "Column-Aware Reading Order for Local Document Speech")
        self.assertEqual(title["page"], 1)
        box = title["boxes"][0]
        self.assertEqual(box["page_size"], {"width": 612.0, "height": 792.0})
        self.assertEqual(sorted(box["bbox"]), ["b", "l", "r", "t"])
        self.assertTrue(all(item["text"].strip() for item in self.paragraphs))

    def test_pictures_and_tables_contribute_their_boxes(self):
        # One picture on page two, one table on page one: the figure on page
        # one is a bordered plot, which Docling reports as a table.
        self.assertEqual(sorted(box["page"] for box in self.figure_boxes), [1, 2])

    def test_text_drawn_inside_a_figure_is_kept_out_of_the_reading_queue(self):
        inside = {"Accuracy", "Proposed", "Baseline", "Page width (mm)", "100"}
        by_text = {item["text"]: item for item in self.annotated}
        for value in inside:
            self.assertIn("figure_content", by_text[value]["filter_reasons"], value)
        # "Page width (mm)" is three words, so the isolated-token rule that was
        # the only guard before could never have reached it.
        self.assertNotIn("isolated_token", by_text["Page width (mm)"]["filter_reasons"])

        selected = content_for_preset(self.annotated, "prose")
        read = {item["text"] for item in selected["paragraphs"]}
        self.assertFalse(read & inside)
        self.assertEqual(selected["filter_summary"]["reasons"]["figure_content"], len(inside))
        # Nothing was deleted: the full preset still offers them.
        full = {item["text"] for item in content_for_preset(self.annotated, "full")["paragraphs"]}
        self.assertTrue(inside <= full)

    def test_a_caption_beside_a_figure_is_not_treated_as_figure_content(self):
        caption = next(item for item in self.annotated if item["text"].startswith("Figure 2."))
        self.assertEqual(caption["label"], "caption")
        self.assertNotIn("figure_content", caption["filter_reasons"])
        with_captions = content_for_preset(self.annotated, "prose_captions")
        self.assertIn(caption["text"], {item["text"] for item in with_captions["paragraphs"]})

    def test_body_prose_beside_a_figure_survives(self):
        prose = {item["text"] for item in content_for_preset(self.annotated, "prose")["paragraphs"]}
        self.assertTrue(any(value.startswith("The appendix reports the sensitivity") for value in prose))
        self.assertTrue(any(value.startswith("Nothing in the measurement suggests") for value in prose))


if __name__ == "__main__":
    unittest.main()
