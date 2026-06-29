On macOS the "like Docker or Node" answer is Homebrew — that's literally how people install Node (brew install node) and the Docker CLI. There are two tiers:

The proper, repeatable way — a Homebrew formula
You publish a small tap repo (homebrew-tinv) with a formula, then anyone (you included) installs with one command and ffmpeg comes along automatically:


# Formula/tinv.rb
class Tinv < Formula
  desc "Tiny AV1 video converter (.tinv)"
  homepage "https://github.com/zaahead/tinv"
  url "https://github.com/zaahead/tinv/archive/refs/tags/v0.1.0.tar.gz"
  depends_on "rust" => :build
  depends_on "ffmpeg"                       # ← system dependency handled for you

  def install
    system "cargo", "install", *std_cargo_args(path: "cli")
  end
end
Then it's exactly the Node/Docker experience:


brew tap zaahead/tinv
brew install tinv          # builds tinv + tinv-worker, pulls ffmpeg, puts it on PATH for all shells
tinv convert video.mp4
brew install lands it in /opt/homebrew/bin (already on every shell's PATH — no ~/.zshrc edits), and brew uninstall tinv cleanly removes it. This is the right "system tool" path.

Right now, on your Mac (no publishing) — install to /usr/local/bin
/usr/local/bin is on the default macOS PATH for every user and shell, so this makes tinv a true system command immediately:


cd ~/Documents/GitHub/tinv/cli && cargo build --release
sudo cp target/release/tinv target/release/tinv-worker /usr/local/bin/
brew install ffmpeg                         # or bundle it (below)
(ffmpeg self-contained instead of brew:)


sudo mkdir -p /usr/local/bin/ffmpeg
sudo cp ffmpeg/ffmpeg ffmpeg/ffprobe /usr/local/bin/ffmpeg/   # tinv auto-finds ffmpeg next to itself
Now tinv convert x.mp4 works for any user, any directory. (The sudo steps need your password, so you run those — I can't.)

Quick guidance: for a one-off on your machine, the /usr/local/bin copy is fine. If you want it to feel like a real installable tool (versioned, brew upgrade, deps managed, shareable), do the Homebrew tap — and I can scaffold the homebrew-tinv formula + a tagged release checklist for you right now. Want that?