#!/usr/bin/env python3
"""Builds podcast-polish.html: the whole app in one file you can double-click.

    python3 build_single.py            -> podcast-polish.html
"""
import re, sys
from pathlib import Path

web = Path(__file__).parent / "web"
read = lambda p: (web / p).read_text(encoding="utf-8")

def build(lame_src=None):
    html = read("index.html")
    css = read("style.css")
    app = read("app.js")
    dsp = read("dsp.js")
    lame = lame_src if lame_src is not None else read("vendor/lame.min.js")
    # worker body without its importScripts line (everything is concatenated instead)
    worker = re.sub(r"importScripts\([^)]*\);\n?", "", read("worker.js"))
    engine = "\n".join([dsp, lame, worker])
    for name, text in (("engine", engine), ("app", app)):
        if "</script" in text.lower():
            sys.exit(f"{name} contains a closing script tag; cannot inline")
    html = html.replace('<link rel="stylesheet" href="style.css">', f"<style>\n{css}</style>")
    html = html.replace('<script src="app.js"></script>',
        f'<script type="text/plain" id="workerSrc">\n{engine}\n</script>\n<script>\n{app}\n</script>')
    return html

if __name__ == "__main__":
    out = Path(__file__).parent / "podcast-polish.html"
    out.write_text(build(), encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size // 1024} KB)")
