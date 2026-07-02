#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
md-to-pdf.py —— 把 Markdown 转成排版精良的 PDF（中文/表格/代码/emoji 友好）。

管线：Python markdown(extra+toc) 生成 HTML → 套 CSS 模板 → 系统 Chromium
      (Chrome/Edge) headless --print-to-pdf 渲染。@page 控页边距，强制打印背景色。

用法：python md-to-pdf.py <输入.md> <输出.pdf> [标题] [副标题]
依赖：pip 的 markdown；本机装有 Chrome 或 Edge（自动探测）。
"""
import sys, os, tempfile, subprocess, shutil, html, datetime

def find_browser():
    cands = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    for c in cands:
        if os.path.exists(c):
            return c
    raise SystemExit("[X] 没找到 Chrome / Edge，无法渲染 PDF。")

CSS = """
@page { size: A4; margin: 18mm 15mm 16mm 15mm; }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
html { font-size: 13px; }
body {
  font-family: "Microsoft YaHei","微软雅黑","Segoe UI","Segoe UI Emoji",system-ui,sans-serif;
  color: #1f2937; line-height: 1.7; margin: 0;
}
.cover { text-align: center; padding: 40px 0 26px; border-bottom: 3px solid #4f46e5; margin-bottom: 26px; }
.cover h1 { font-size: 30px; color: #4338ca; margin: 0 0 8px; border: none; }
.cover .sub { font-size: 14px; color: #6b7280; margin: 4px 0; }
.cover .meta { font-size: 12px; color: #9ca3af; margin-top: 12px; }
h1,h2,h3,h4 { color: #111827; line-height: 1.35; page-break-after: avoid; font-weight: 700; }
h1 { font-size: 22px; border-bottom: 2px solid #e5e7eb; padding-bottom: 6px; margin: 26px 0 14px; }
h2 { font-size: 18px; border-bottom: 1px solid #eef2f7; padding-bottom: 5px; margin: 22px 0 12px; color:#3730a3; }
h3 { font-size: 15px; margin: 18px 0 9px; }
h4 { font-size: 13.5px; margin: 14px 0 7px; color:#374151; }
p { margin: 8px 0; }
a { color: #4f46e5; text-decoration: none; word-break: break-all; }
strong { color: #111827; }
ul,ol { margin: 8px 0; padding-left: 24px; }
li { margin: 3px 0; }
code { font-family: "Cascadia Code","Consolas","Courier New",monospace; font-size: 0.88em;
  background: #eef2ff; color: #3730a3; padding: 1px 5px; border-radius: 4px; }
pre { background: #0f172a; color: #e2e8f0; padding: 12px 14px; border-radius: 8px;
  overflow-x: auto; page-break-inside: avoid; font-size: 11px; line-height: 1.5; }
pre code { background: none; color: inherit; padding: 0; font-size: 11px; }
blockquote { border-left: 4px solid #a5b4fc; background: #f5f7ff; margin: 10px 0;
  padding: 6px 14px; color: #475569; border-radius: 0 6px 6px 0; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 11.5px;
  page-break-inside: avoid; }
th,td { border: 1px solid #d1d5db; padding: 6px 9px; text-align: left; vertical-align: top; word-break: break-word; }
th { background: #eef2ff; color: #3730a3; font-weight: 700; }
tr:nth-child(even) td { background: #fafbff; }
hr { border: none; border-top: 1px solid #e5e7eb; margin: 20px 0; }
img { max-width: 100%; }
"""

def main():
    if len(sys.argv) < 3:
        raise SystemExit("用法: python md-to-pdf.py <输入.md> <输出.pdf> [标题] [副标题]")
    src, out = sys.argv[1], sys.argv[2]
    title = sys.argv[3] if len(sys.argv) > 3 else os.path.splitext(os.path.basename(src))[0]
    subtitle = sys.argv[4] if len(sys.argv) > 4 else ""

    import markdown
    with open(src, "r", encoding="utf-8") as f:
        text = f.read()
    body = markdown.markdown(text, extensions=["extra", "toc", "sane_lists", "admonition"])

    today = datetime.date.today().isoformat()
    cover = (f'<div class="cover"><h1>{html.escape(title)}</h1>'
             + (f'<div class="sub">{html.escape(subtitle)}</div>' if subtitle else "")
             + f'<div class="meta">生成日期 {today}</div></div>')
    doc = (f'<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
           f'<title>{html.escape(title)}</title><style>{CSS}</style></head>'
           f'<body>{cover}{body}</body></html>')

    tmpdir = tempfile.mkdtemp(prefix="md2pdf_")
    tmp_html = os.path.join(tmpdir, "doc.html")
    tmp_pdf = os.path.join(tmpdir, "doc.pdf")
    with open(tmp_html, "w", encoding="utf-8") as f:
        f.write(doc)

    browser = find_browser()
    file_url = "file:///" + tmp_html.replace("\\", "/")
    cmd = [browser, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
           "--disable-extensions", "--no-pdf-header-footer",
           "--print-to-pdf=" + tmp_pdf, file_url]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if not os.path.exists(tmp_pdf):
        # 老版本 Chrome 用 --print-to-pdf-no-header
        cmd2 = [browser, "--headless", "--disable-gpu", "--no-sandbox",
                "--print-to-pdf-no-header", "--print-to-pdf=" + tmp_pdf, file_url]
        subprocess.run(cmd2, capture_output=True, text=True, timeout=120)
    if not os.path.exists(tmp_pdf):
        raise SystemExit("[X] 渲染失败：\n" + (r.stderr or "")[:2000])

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    shutil.move(tmp_pdf, out)
    shutil.rmtree(tmpdir, ignore_errors=True)
    size = os.path.getsize(out) / 1024
    print(f"✔ PDF 已生成: {out} ({size:.0f} KB)")

if __name__ == "__main__":
    main()
