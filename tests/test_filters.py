import unittest

from local_webui import annotate_filter_reasons, content_for_preset


def paragraph(identifier, text, label, page=1, top=100, bottom=140):
    return {
        "id": identifier,
        "text": text,
        "label": label,
        "boxes": [{
            "page": page,
            "bbox": {"l": 50, "t": top, "r": 500, "b": bottom},
            "page_size": {"width": 600, "height": 1000},
        }],
    }


class ProseFilteringTests(unittest.TestCase):
    def test_repeated_page_header_is_hidden_without_changing_source_ids(self):
        all_paragraphs = annotate_filter_reasons([
            paragraph("header-1", "A Practical Reader 1", "text", page=1, top=940, bottom=970),
            paragraph("body", "The body text must remain available for reading.", "text", page=1),
            paragraph("header-2", "A Practical Reader 2", "text", page=2, top=940, bottom=970),
        ])

        selected = content_for_preset(all_paragraphs, "prose")

        self.assertEqual([item["id"] for item in selected["paragraphs"]], ["body"])
        self.assertIn("header_footer", all_paragraphs[0]["filter_reasons"])
        self.assertEqual(selected["filter_summary"]["reasons"]["header_footer"], 2)

    def test_caption_preset_keeps_captions_but_prose_hides_them(self):
        all_paragraphs = annotate_filter_reasons([
            paragraph("body", "A readable body paragraph.", "text"),
            paragraph("caption", "Figure 1. An informative caption.", "caption"),
        ])

        prose = content_for_preset(all_paragraphs, "prose")
        with_captions = content_for_preset(all_paragraphs, "prose_captions")
        full = content_for_preset(all_paragraphs, "full")

        self.assertEqual([item["id"] for item in prose["paragraphs"]], ["body"])
        self.assertEqual([item["id"] for item in with_captions["paragraphs"]], ["body", "caption"])
        self.assertEqual([item["id"] for item in full["paragraphs"]], ["body", "caption"])

    def test_reference_section_and_isolated_figure_token_are_hidden_from_prose(self):
        all_paragraphs = annotate_filter_reasons([
            paragraph("body", "The main argument comes first.", "text"),
            paragraph("references", "References", "section_header"),
            paragraph("entry", "[1] Smith, A. Important work.", "list_item"),
            paragraph("figure-token", "3", "text", page=3),
        ])

        selected = content_for_preset(all_paragraphs, "prose")

        self.assertEqual([item["id"] for item in selected["paragraphs"]], ["body"])
        self.assertIn("reference_heading", all_paragraphs[1]["filter_reasons"])
        self.assertIn("reference_entry", all_paragraphs[2]["filter_reasons"])
        self.assertIn("isolated_token", all_paragraphs[3]["filter_reasons"])


if __name__ == "__main__":
    unittest.main()
