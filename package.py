#!/usr/bin/env python3
"""只打包明确列出的插件文件，不收临时测试数据或凭据。"""
import hashlib
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'plugin.json').read_text(encoding='utf-8'))
out = root / 'dist'
out.mkdir(exist_ok=True)
archive = out / f"YesPlayMusic-{manifest['id']}-{manifest['version']}.zip"

files = [root / name for name in [
    'plugin.json', 'icon.png', 'index.js',
    'LICENSE-NETEASE', 'LICENSE-QQMUSIC', 'THIRD_PARTY_MIT_LICENSE',
    'README.md',
]]
for directory in ['locales', 'shared', 'providers', 'console', 'docs']:
    files.extend(p for p in (root / directory).rglob('*') if p.is_file())

missing = [p for p in files if not p.exists()]
if missing:
    raise SystemExit('缺少文件：' + ', '.join(str(p.relative_to(root)) for p in missing))

with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as zf:
    for path in sorted(files):
        zf.write(path, path.relative_to(root).as_posix())

digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(out / 'SHA256SUMS.txt').write_text(f'{digest}  {archive.name}\n', encoding='utf-8')
print(f'{archive.name}  {archive.stat().st_size} bytes')
print(f'sha256 {digest}')
