#!/usr/bin/env python3
"""
BREACH AR — original sound set, synthesized from scratch (no samples).

Every clip is generated procedurally with numpy/scipy so the project owns
all audio rights outright. Output: Assets/BREACH/Resources/Audio/*.wav
(44.1 kHz, mono, 16-bit). Deterministic: same seeds -> same files.

    pip install numpy scipy
    python3 Tools/audio/generate_sfx.py
"""
import os
import wave
import numpy as np
from scipy.signal import butter, sosfilt

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "Assets", "BREACH", "Resources", "Audio")


def t_axis(seconds):
    return np.arange(int(seconds * SR)) / SR


def env_exp(n, tau, attack=0.0005):
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-6), 0, 1)
    return a * np.exp(-t / tau)


def noise(rng, n):
    return rng.standard_normal(n)


def bp(x, lo, hi, order=2):
    sos = butter(order, [lo, hi], btype="band", fs=SR, output="sos")
    return sosfilt(sos, x)


def lp(x, f, order=2):
    return sosfilt(butter(order, f, btype="low", fs=SR, output="sos"), x)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, btype="high", fs=SR, output="sos"), x)


def place(dst, src, at_seconds, gain=1.0):
    i = int(at_seconds * SR)
    end = min(len(dst), i + len(src))
    if i < len(dst):
        dst[i:end] += src[: end - i] * gain


def sine_sweep(f0, f1, seconds, curve=2.0):
    t = t_axis(seconds)
    k = (t / seconds) ** (1.0 / curve)
    f = f0 + (f1 - f0) * k
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def ping(freq, seconds, tau, rng=None, detune=0.0):
    t = t_axis(seconds)
    x = np.sin(2 * np.pi * freq * t) + 0.5 * np.sin(2 * np.pi * freq * 2.71 * t + 1.3)
    if detune:
        x += 0.4 * np.sin(2 * np.pi * freq * (1 + detune) * t)
    return x * np.exp(-t / tau)


def reverb(x, seconds=0.6, mix=0.25, rng=None, damp=2500):
    """Cheap small-room reverb: exponentially decaying filtered noise impulse."""
    rng = rng or np.random.default_rng(0)
    n = int(seconds * SR)
    ir = lp(noise(rng, n), damp) * np.exp(-np.arange(n) / SR / (seconds / 5))
    ir[0] = 0
    ir /= np.max(np.abs(ir)) + 1e-9
    wet = np.convolve(x, ir)[: len(x) + n]
    out = np.zeros(len(wet))
    out[: len(x)] = x
    return out * (1 - mix) + wet / (np.max(np.abs(wet)) + 1e-9) * np.max(np.abs(x)) * mix


def finish(x, peak_db=-1.0, fade_ms=8, softclip=1.0):
    if softclip > 0:
        x = np.tanh(x * softclip) / np.tanh(softclip)
    x = x - np.mean(x)
    fade = int(fade_ms / 1000 * SR)
    if fade > 0 and len(x) > fade:
        x[-fade:] *= np.linspace(1, 0, fade)
    peak = np.max(np.abs(x)) + 1e-9
    return x / peak * (10 ** (peak_db / 20))


def write(name, x):
    os.makedirs(OUT, exist_ok=True)
    data = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    path = os.path.join(OUT, name + ".wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())
    print(f"  {name:<22} {len(x) / SR:5.2f}s")


# ---------------------------------------------------------------- weapon

def rifle_shot(seed):
    rng = np.random.default_rng(seed)
    dur = 1.1
    out = np.zeros(int(dur * SR))
    j = lambda a: a * (1 + rng.uniform(-0.08, 0.08))
    # Supersonic crack / muzzle blast transient.
    n = int(0.012 * SR)
    crack = bp(noise(rng, n), j(1500), 6000, 2) * env_exp(n, j(0.0012), 0.0001)
    place(out, crack, 0, 0.8)
    # Blast body: dense low-mid pressure wave, fast decay.
    n = int(0.25 * SR)
    body = lp(noise(rng, n), j(1500), 4) * env_exp(n, j(0.026), 0.0004)
    place(out, body, 0.0005, 0.9)
    # The "bark": where a phone speaker actually lives (400 Hz - 3 kHz).
    bark = bp(noise(rng, n), j(380), j(2000), 2) * env_exp(n, j(0.035), 0.0005)
    place(out, bark, 0.0008, 2.6)
    # Low-frequency punch (felt on headphones, trimmed so it doesn't swamp the bark).
    thump = sine_sweep(j(150), 45, 0.18, 3.0) * env_exp(int(0.18 * SR), j(0.04), 0.001)
    place(out, thump, 0.0, 0.8)
    # Bolt carrier / action: tiny metallic tick a few ms later.
    tick = bp(noise(rng, int(0.01 * SR)), 3200, 6500) * env_exp(int(0.01 * SR), 0.0015)
    place(out, tick, j(0.009), 0.35)
    # Indoor slap-back and room tail.
    n = int(0.9 * SR)
    tail = lp(noise(rng, n), j(900), 4) * env_exp(n, j(0.24), 0.01)
    place(out, tail, 0.012, 0.42)
    for d, g in ((0.031, 0.25), (0.057, 0.16), (0.094, 0.1)):
        place(out, body[: int(0.05 * SR)] * 0.6, j(d), g)
    return finish(out, -0.8, 30, softclip=1.3)


def rifle_tail(seed):
    rng = np.random.default_rng(seed)
    n = int(1.2 * SR)
    x = bp(noise(rng, n), 250, 1400) * env_exp(n, 0.32, 0.02)
    out = np.zeros(n)
    for d, g in ((0.0, 1.0), (0.045, 0.6), (0.11, 0.45), (0.19, 0.3)):
        place(out, x, d, g)
    return finish(out, -6, 60, softclip=0.5)


def mech_click(seed, f1, f2, tau=0.006, gain2=0.7, dur=0.08):
    rng = np.random.default_rng(seed)
    out = np.zeros(int(dur * SR))
    place(out, ping(f1, 0.05, tau) + bp(noise(rng, int(0.05 * SR)), 2000, 8000) * env_exp(int(0.05 * SR), 0.002), 0)
    place(out, ping(f2, 0.05, tau * 0.8), 0.004, gain2)
    return out


def dry_fire():
    out = np.zeros(int(0.15 * SR))
    place(out, mech_click(3, 2600, 5100, 0.004), 0)
    place(out, mech_click(4, 1900, 4300, 0.003), 0.028, 0.5)
    return finish(out, -3, 10, 1.0)


def slide(seed, seconds, lo, hi):
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    env = np.sin(np.linspace(0, np.pi, n)) ** 1.5
    grain = bp(noise(rng, n), lo, hi) * env
    grain *= 1 + 0.5 * np.sin(2 * np.pi * 37 * t_axis(seconds))
    return grain


def mag_out():
    out = np.zeros(int(0.45 * SR))
    place(out, mech_click(11, 1700, 3900, 0.005), 0.0, 1.0)            # release button
    place(out, slide(12, 0.16, 1200, 4200), 0.02, 0.45)                 # mag sliding free
    place(out, mech_click(13, 900, 2100, 0.01, 0.5, 0.1), 0.19, 0.5)   # clears the well
    return finish(reverb(out, 0.3, 0.12), -2, 20)


def mag_in():
    rng = np.random.default_rng(21)
    out = np.zeros(int(0.45 * SR))
    place(out, slide(22, 0.12, 900, 3500), 0.0, 0.4)
    thud = lp(noise(rng, int(0.08 * SR)), 500) * env_exp(int(0.08 * SR), 0.018)
    place(out, thud, 0.12, 1.4)
    place(out, mech_click(23, 1400, 3300, 0.008, 0.9, 0.1), 0.121, 1.1)  # seats and locks
    place(out, mech_click(24, 2200, 4800, 0.004, 0.5, 0.06), 0.175, 0.4)
    return finish(reverb(out, 0.3, 0.12), -1.5, 20)


def bolt_release():
    rng = np.random.default_rng(31)
    out = np.zeros(int(0.5 * SR))
    place(out, mech_click(32, 2400, 5200, 0.004, 0.4, 0.05), 0.0, 0.5)
    slam = ping(1150, 0.3, 0.035, detune=0.013) + 0.6 * ping(2870, 0.3, 0.022)
    body = lp(noise(rng, int(0.1 * SR)), 1200) * env_exp(int(0.1 * SR), 0.02)
    place(out, slam, 0.035, 1.0)
    place(out, body, 0.035, 1.3)
    return finish(reverb(out, 0.35, 0.15), -1, 20, 1.2)


# ---------------------------------------------------------------- impacts & feedback

def impact_flesh(seed):
    rng = np.random.default_rng(seed)
    out = np.zeros(int(0.35 * SR))
    n = int(0.12 * SR)
    place(out, bp(noise(rng, n), 250, rng.uniform(900, 1300)) * env_exp(n, 0.03), 0, 2.2)
    place(out, sine_sweep(120, 60, 0.12) * env_exp(n, 0.035), 0, 0.4)
    m = int(0.2 * SR)
    wobble = 0.5 + 0.5 * np.sin(2 * np.pi * rng.uniform(18, 30) * np.arange(m) / SR)
    wet = bp(noise(rng, m), 350, 1200, 2) * env_exp(m, 0.045, 0.004) * wobble
    place(out, wet, 0.004, 1.4)
    return finish(out, -2, 20, 1.1)


def impact_surface(seed):
    rng = np.random.default_rng(seed)
    out = np.zeros(int(0.4 * SR))
    n = int(0.04 * SR)
    place(out, bp(noise(rng, n), 1400, 7000) * env_exp(n, 0.006), 0, 1.0)
    for _ in range(9):
        m = int(0.004 * SR)
        place(out, bp(noise(rng, m), 2500, 9000) * env_exp(m, 0.0008), rng.uniform(0.01, 0.25), rng.uniform(0.1, 0.35))
    place(out, lp(noise(rng, int(0.1 * SR)), 900) * env_exp(int(0.1 * SR), 0.02), 0, 0.5)
    return finish(out, -3, 20, 1.0)


def hit_confirm():
    t = t_axis(0.06)
    x = (np.sin(2 * np.pi * 1850 * t) + 0.35 * np.sin(2 * np.pi * 4100 * t)) * np.exp(-t / 0.009)
    return finish(x, -6, 5, 0.3)


def kill_confirm():
    out = np.zeros(int(0.35 * SR))
    place(out, sine_sweep(95, 45, 0.25) * env_exp(int(0.25 * SR), 0.07), 0, 1.0)
    place(out, sine_sweep(900, 520, 0.09, 1.0) * env_exp(int(0.09 * SR), 0.03), 0.01, 0.35)
    return finish(out, -4, 20, 0.8)


# ---------------------------------------------------------------- the Hunter

def formant_voice(rng, seconds, f0_start, f0_end, jitter=0.06, formants=((420, 1.0), (980, 0.6), (2450, 0.3)), rasp=0.5):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    f0 = np.linspace(f0_start, f0_end, n) * (1 + jitter * lp(noise(rng, n), 12))
    phase = np.cumsum(f0) / SR
    # Glottal-ish pulse train: skewed saw with irregular pulses.
    pulse = (phase % 1.0) ** 3
    pulse = pulse - np.mean(pulse)
    src = pulse + rasp * bp(noise(rng, n), 300, 5000)
    out = np.zeros(n)
    for f, g in formants:
        out += bp(src, f * 0.8, f * 1.25) * g
    # Subharmonic rattle — the inhuman part.
    out *= 1 + 0.6 * np.sin(2 * np.pi * (f0 * 0.5) * t / 1.0 * 0 + 2 * np.pi * 23 * t)
    return out


def hunter_growl(seed):
    rng = np.random.default_rng(seed)
    dur = rng.uniform(0.9, 1.4)
    n = int(dur * SR)
    v = formant_voice(rng, dur, rng.uniform(60, 75), rng.uniform(48, 60), rasp=0.8)
    env = np.minimum(1, np.arange(n) / (0.12 * SR)) * np.exp(-np.maximum(0, np.arange(n) / SR - dur * 0.55) / 0.18)
    breath = lp(noise(rng, n), 900) * 0.3
    t = np.arange(n) / SR
    rumble = np.sin(2 * np.pi * np.cumsum(np.full(n, rng.uniform(38, 46))) / SR) * (0.6 + 0.4 * np.sin(2 * np.pi * 9 * t))
    x = (v + breath + rumble * 0.12 * np.max(np.abs(v))) * env
    return finish(reverb(x, 0.5, 0.18, rng, 1800), -2, 60, 1.6)


def hunter_shriek():
    rng = np.random.default_rng(71)
    dur = 0.9
    n = int(dur * SR)
    a = formant_voice(rng, dur, 190, 430, jitter=0.1, formants=((700, 1.0), (1700, 0.8), (3100, 0.5)), rasp=1.2)
    b = formant_voice(rng, dur, 205, 455, jitter=0.12, formants=((760, 1.0), (1900, 0.7), (3400, 0.4)), rasp=1.0)
    t = np.arange(n) / SR
    ring = np.sin(2 * np.pi * 67 * t)
    env = np.minimum(1, t / 0.03) * np.exp(-np.maximum(0, t - 0.45) / 0.14)
    x = (a + 0.8 * b) * (0.7 + 0.3 * ring) * env
    return finish(reverb(x, 0.6, 0.22, rng, 3000), -1, 60, 2.2)


def hunter_step(seed):
    rng = np.random.default_rng(seed)
    out = np.zeros(int(0.18 * SR))
    n = int(0.06 * SR)
    place(out, lp(noise(rng, n), rng.uniform(300, 480)) * env_exp(n, 0.014), 0, 1.0)
    m = int(0.012 * SR)
    place(out, bp(noise(rng, m), 3000, 7000) * env_exp(m, 0.0015), rng.uniform(0.004, 0.02), rng.uniform(0.3, 0.6))
    return finish(out, -6, 10, 1.0)


def hunter_strike():
    rng = np.random.default_rng(81)
    dur = 0.45
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = noise(rng, n)
    # Swept band = whoosh.
    out = np.zeros(n)
    seg = 256
    for i in range(0, n, seg):
        k = min(1.0, i / (0.2 * SR))
        lo, hi = 300 + 1500 * k, 900 + 3500 * k
        out[i:i + seg] = bp(x[max(0, i - 2048):i + seg], lo, hi)[-len(out[i:i + seg]):]
    env = np.sin(np.clip(t / 0.22, 0, 1) * np.pi) ** 2
    out *= env
    scrape = bp(noise(rng, int(0.08 * SR)), 2500, 7500) * env_exp(int(0.08 * SR), 0.02)
    place(out, scrape, 0.2, 0.6)
    return finish(out, -2, 30, 1.2)


def hunter_death():
    rng = np.random.default_rng(91)
    dur = 1.9
    n = int(dur * SR)
    v = formant_voice(rng, 1.4, 130, 42, jitter=0.12, rasp=1.0)
    x = np.zeros(n)
    env = np.minimum(1, np.arange(len(v)) / (0.02 * SR)) * np.exp(-np.arange(len(v)) / SR / 0.55)
    place(x, v * env, 0, 1.0)
    m = int(0.25 * SR)
    fall = lp(noise(rng, m), 350) * env_exp(m, 0.06)
    place(x, fall, 0.95, 1.2)
    place(x, sine_sweep(80, 40, 0.25) * env_exp(m, 0.08), 0.95, 1.0)
    return finish(reverb(x, 0.7, 0.2, rng, 1500), -1, 80, 1.5)


# ---------------------------------------------------------------- player & UI

def player_hurt():
    rng = np.random.default_rng(101)
    out = np.zeros(int(0.8 * SR))
    place(out, sine_sweep(85, 38, 0.3) * env_exp(int(0.3 * SR), 0.09), 0, 1.0)
    place(out, lp(noise(rng, int(0.08 * SR)), 700) * env_exp(int(0.08 * SR), 0.02), 0, 0.8)
    t = t_axis(0.7)
    ring = np.sin(2 * np.pi * 3600 * t) * np.exp(-t / 0.25) * 0.05
    place(out, ring, 0.02, 1.0)
    return finish(out, -1.5, 40, 1.2)


def match_start():
    rng = np.random.default_rng(111)
    dur = 1.8
    n = int(dur * SR)
    t = np.arange(n) / SR
    drone = (np.sin(2 * np.pi * 48 * t) + 0.5 * np.sin(2 * np.pi * 96.4 * t)) * np.minimum(1, t / 0.6) * np.exp(-np.maximum(0, t - 0.8) / 0.4)
    hit = ping(420, 1.2, 0.35, detune=0.007) * 0.5 + lp(noise(rng, int(1.2 * SR)), 1500) * env_exp(int(1.2 * SR), 0.05) * 0.6
    out = drone * 0.8
    place(out, hit, 0.55, 1.0)
    return finish(reverb(out, 0.9, 0.25, rng, 2000), -2, 100, 1.0)


def countdown_tick():
    t = t_axis(0.08)
    x = np.sin(2 * np.pi * 980 * t) * np.exp(-t / 0.014) + 0.3 * np.sin(2 * np.pi * 2940 * t) * np.exp(-t / 0.006)
    return finish(x, -6, 5, 0.3)


def ui_select():
    t = t_axis(0.04)
    x = np.sin(2 * np.pi * 2200 * t) * np.exp(-t / 0.006)
    return finish(x, -10, 4, 0.2)


def boundary_warn():
    out = np.zeros(int(0.32 * SR))
    for i, f in enumerate((440, 330)):
        t = t_axis(0.12)
        tone = np.sin(2 * np.pi * f * t) * np.sin(np.pi * t / 0.12)
        place(out, tone, i * 0.15, 1.0)
    return finish(out, -8, 10, 0.3)


def main():
    print("BREACH SFX →", os.path.abspath(OUT))
    for i in range(1, 5):
        write(f"rifle_shot_{i}", rifle_shot(1000 + i))
    for i in range(1, 3):
        write(f"rifle_tail_{i}", rifle_tail(1100 + i))
    write("dry_fire", dry_fire())
    write("mag_out", mag_out())
    write("mag_in", mag_in())
    write("bolt_release", bolt_release())
    for i in range(1, 4):
        write(f"impact_flesh_{i}", impact_flesh(1200 + i))
        write(f"impact_surface_{i}", impact_surface(1300 + i))
    write("hit_confirm", hit_confirm())
    write("kill_confirm", kill_confirm())
    for i in range(1, 4):
        write(f"hunter_growl_{i}", hunter_growl(1400 + i))
    write("hunter_shriek", hunter_shriek())
    for i in range(1, 5):
        write(f"hunter_step_{i}", hunter_step(1500 + i))
    write("hunter_strike", hunter_strike())
    write("hunter_death", hunter_death())
    write("player_hurt", player_hurt())
    write("match_start", match_start())
    write("countdown_tick", countdown_tick())
    write("ui_select", ui_select())
    write("boundary_warn", boundary_warn())


if __name__ == "__main__":
    main()
