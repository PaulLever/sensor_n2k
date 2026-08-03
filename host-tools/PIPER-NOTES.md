# Piper TTS — install notes (2026-08-03)

`bt-speaker.js` uses Piper (neural TTS, CPU-only, offline) instead of
`espeak-ng` for alarm voice announcements — espeak-ng was intelligible but
sounded robotic/harsh; Piper is a material clarity improvement for the
same "must work with no internet" constraint (this is a boat alarm
system, not a cloud-TTS candidate).

Piper is **not** an apt package — installed manually to `/opt/piper`.
This isn't in any config file or automated by a script; if this board
image ever gets reflashed/rebuilt, redo it with the steps below.

## What's installed

- `/opt/piper/piper` — the CLI binary, plus its bundled shared libs
  (`libonnxruntime.so`, `libpiper_phonemize.so`, `libespeak-ng.so` — Piper
  uses espeak-ng's phonemizer for grapheme-to-phoneme conversion
  internally, but not its synthesizer) and `espeak-ng-data/` (needed by
  that phonemizer, found automatically relative to the binary — no
  `--espeak_data` flag needed).
- `/opt/piper/voices/en_US-lessac-medium.onnx` (+ `.onnx.json`) — the
  voice model, ~63MB.

Confirmed on this board (aarch64, 4 cores, 3.6GB RAM): real-time factor
~0.6 (faster than real-time), ~2s one-time model load + <1s inference for
a short alert phrase. That per-call ~2-3s latency (Piper has no
persistent "server mode" in this CLI — every invocation reloads the
model) is a deliberate tradeoff for simplicity; acceptable since alarms
here don't fire back-to-back-to-back. If that ever becomes a problem, the
fix is a warm/persistent Piper process (e.g. via the `piper-tts` Python
package) rather than re-installing the binary differently.

## Reinstall steps (fresh board image)

```bash
# 1. Binary (version pinned to what's actually installed — check
#    https://github.com/rhasspy/piper/releases for anything newer):
sudo mkdir -p /opt/piper
cd /opt/piper
sudo wget -q https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_aarch64.tar.gz -O /tmp/piper.tar.gz
sudo tar -xzf /tmp/piper.tar.gz --strip-components=1 -C /opt/piper
rm -f /tmp/piper.tar.gz

# 2. Voice model (en_US-lessac-medium — a reasonable clarity/size
#    tradeoff; browse https://huggingface.co/rhasspy/piper-voices for
#    other English voices/qualities if a different one sounds better):
sudo mkdir -p /opt/piper/voices
cd /opt/piper/voices
sudo wget -q https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
sudo wget -q https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json

sudo chown -R arduino:arduino /opt/piper
```

## Quick manual test (no alarm-server.js involved)

```bash
echo 'coolant engine temperature' | LD_LIBRARY_PATH=/opt/piper /opt/piper/piper \
  --model /opt/piper/voices/en_US-lessac-medium.onnx --output_file /tmp/test.wav
```

`bt-speaker.js`'s `speak()` does the same thing but with `--output_file -`
piped straight into `pw-cat --playback`, same pattern espeak-ng used
before it.

## Why `espeak-ng` is still installed too

Not removed — `espeak-ng-data` is bundled inside `/opt/piper` and used
internally by Piper's phonemizer regardless, and removing the system
`espeak-ng` package wasn't necessary for this switch, so it was left
alone rather than touching something unrelated to this change.
