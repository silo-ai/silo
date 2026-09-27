#!/usr/bin/env python3

import hashlib
import re
import sys
from pathlib import Path


TARGETS = {
    "mac_arm": "aarch64-apple-darwin",
    "mac_intel": "x86_64-apple-darwin",
    "linux_arm": "aarch64-unknown-linux-gnu",
    "linux_intel": "x86_64-unknown-linux-gnu",
}


def archive_hash(assets: Path, version: str, target: str) -> str:
    filename = f"silo-{version}-{target}.tar.gz"
    archive = assets / filename
    checksum = assets / f"{filename}.sha256"
    if not archive.is_file() or not checksum.is_file():
        raise SystemExit(f"Missing release archive or checksum: {filename}")

    expected = checksum.read_text().split()[0].lower()
    actual = hashlib.sha256(archive.read_bytes()).hexdigest()
    if not re.fullmatch(r"[0-9a-f]{64}", expected) or actual != expected:
        raise SystemExit(f"Checksum does not match release archive: {filename}")
    return actual


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: render-homebrew-formula.py VERSION ASSET_DIRECTORY")

    version = sys.argv[1]
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", version):
        raise SystemExit(f"Invalid release version: {version}")

    assets = Path(sys.argv[2])
    hashes = {name: archive_hash(assets, version, target) for name, target in TARGETS.items()}
    root = Path(__file__).resolve().parents[1]
    formula = f'''class Silo < Formula
  desc "Git-scoped SQLite workspaces with explicit checkpoint synchronization"
  homepage "https://github.com/silo-ai/silo"
  version "{version}"
  license "MIT OR Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/silo-ai/silo/releases/download/v#{{version}}/silo-#{{version}}-aarch64-apple-darwin.tar.gz"
      sha256 "{hashes["mac_arm"]}"
    end
    on_intel do
      url "https://github.com/silo-ai/silo/releases/download/v#{{version}}/silo-#{{version}}-x86_64-apple-darwin.tar.gz"
      sha256 "{hashes["mac_intel"]}"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/silo-ai/silo/releases/download/v#{{version}}/silo-#{{version}}-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "{hashes["linux_arm"]}"
    end
    on_intel do
      url "https://github.com/silo-ai/silo/releases/download/v#{{version}}/silo-#{{version}}-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "{hashes["linux_intel"]}"
    end
  end

  def install
    bin.install "silo"
  end

  test do
    assert_match version.to_s, shell_output("#{{bin}}/silo --version")
  end
end
'''

    formula_path = root / "Formula" / "silo.rb"
    formula_path.parent.mkdir(parents=True, exist_ok=True)
    formula_path.write_text(formula)


if __name__ == "__main__":
    main()
