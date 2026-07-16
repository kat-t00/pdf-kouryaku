#!/usr/bin/env python3
"""index.htmlをコピーして、ヘッダーのXクレジットバッジ（作成：ケアマネカトゥ）だけを
取り除いたpdf-kouryaku_事務所用.htmlを作る。

style.css・各.jsファイル・lib/はindex.htmlと共有（コピーしない）。
index.htmlと同じフォルダに置いてダブルクリックすれば動く。

開発（Claude Codeでの編集）は引き続きindex.html等の個別ファイルで行い、
変更したら最後にこのスクリプトを実行して作り直す。

実行方法: python3 build_office_html.py
"""
import re
from pathlib import Path

BASE_DIR = Path(__file__).parent
INDEX_HTML = BASE_DIR / "index.html"
OUTPUT_HTML = BASE_DIR / "pdf-kouryaku_事務所用.html"

# ヘッダー右上のXへの動線(app-credit)を丸ごと取り除くための正規表現。
# 事業所内部利用版では、外部SNSへの動線を含めない方針のため除去する。
APP_CREDIT_PATTERN = re.compile(
    r'\s*<a class="app-credit"[\s\S]*?</a>\n?'
)


def main():
    html = INDEX_HTML.read_text(encoding="utf-8")

    if not APP_CREDIT_PATTERN.search(html):
        raise RuntimeError("app-creditリンクが見つかりませんでした。index.htmlの構造が変わっていないか確認してください。")
    office_html = APP_CREDIT_PATTERN.sub("\n", html, count=1)

    OUTPUT_HTML.write_text(office_html, encoding="utf-8")
    print(f"作成しました: {OUTPUT_HTML}（Xへの動線なし）")


if __name__ == "__main__":
    main()
