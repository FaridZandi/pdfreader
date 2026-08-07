"""The Python half of the shared reading-preset cases.

`webui/lib/text.mjs` reapplies a preset in the browser without re-extracting,
so it has to reach the same answer as the server did.  The cases live in
`tests/fixtures/preset_cases.json` and are run from here and from
`tests/unit/text.test.mjs` so the two implementations cannot drift apart
unnoticed.
"""

import json
import unittest
from pathlib import Path

from local_webui import content_for_preset

CASES = json.loads(
    (Path(__file__).resolve().parent / "fixtures" / "preset_cases.json").read_text(encoding="utf-8")
)["cases"]


class PresetParityTests(unittest.TestCase):
    def test_every_shared_case_selects_the_expected_paragraphs(self):
        for case in CASES:
            for preset, expected in case["expected"].items():
                with self.subTest(case=case["name"], preset=preset):
                    result = content_for_preset(case["paragraphs"], preset)
                    self.assertEqual([item["id"] for item in result["paragraphs"]], expected)
                    self.assertEqual(result["filter_summary"]["reasons"], case["reasons"][preset])
                    self.assertEqual(result["filter_summary"]["visible"], len(expected))
                    self.assertEqual(
                        result["filter_summary"]["hidden"],
                        len(case["paragraphs"]) - len(expected),
                    )

    def test_an_unknown_preset_is_refused(self):
        with self.assertRaises(ValueError):
            content_for_preset([], "everything-please")


if __name__ == "__main__":
    unittest.main()
