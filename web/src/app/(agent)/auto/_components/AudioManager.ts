/**
 * AudioManager — singleton for reservation chime pre-arm and playback.
 *
 * Pre-arm pattern (RESEARCH §4.1):
 *   On the first user interaction, arm() loads + play()+pause() the audio
 *   element so future play() calls succeed without a user gesture.
 *   iOS AudioContext fallback is also supported.
 */

class AudioManager {
  private chime: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private volume: number = 0.7;
  private muted: boolean = false;
  private armed: boolean = false;
  private chimeSrc: string = "/sounds/reservation-chime.wav";

  /**
   * Arm the audio manager on the first user interaction.
   * Should be called from a click or keydown handler.
   */
  async arm(src?: string): Promise<void> {
    if (typeof window === "undefined") return;
    if (src) this.chimeSrc = src;

    try {
      // HTMLAudioElement path (most browsers)
      const el = new Audio(this.chimeSrc);
      el.volume = this.volume;
      el.preload = "auto";
      await el.play();
      el.pause();
      el.currentTime = 0;
      this.chime = el;
      this.armed = true;
    } catch {
      // iOS / strict autoplay policy: fallback to AudioContext
      await this._armAudioContext();
    }
  }

  private async _armAudioContext(): Promise<void> {
    try {
      const CtxClass =
        (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!CtxClass) return;

      const ctx = new CtxClass();
      // iOS requires resume from a user gesture
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      const res = await fetch(this.chimeSrc);
      const arrayBuf = await res.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuf);
      this.ctx = ctx;
      this.buffer = audioBuffer;
      this.armed = true;
    } catch {
      // Silently fail — visual fallback will handle it
    }
  }

  /** Play the chime. No-op if muted, not armed, or SSR. */
  async play(): Promise<void> {
    if (this.muted || !this.armed || typeof window === "undefined") return;

    if (this.chime) {
      try {
        this.chime.volume = this.volume;
        this.chime.currentTime = 0;
        await this.chime.play();
      } catch {
        // Autoplay blocked — visual alert fallback handles notification
      }
      return;
    }

    if (this.ctx && this.buffer) {
      try {
        const source = this.ctx.createBufferSource();
        source.buffer = this.buffer;
        const gainNode = this.ctx.createGain();
        gainNode.gain.value = this.volume;
        source.connect(gainNode);
        gainNode.connect(this.ctx.destination);
        source.start(0);
      } catch {
        // AudioContext in bad state — ignore
      }
    }
  }

  /** Set volume (0–1). Takes effect on next play(). */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.chime) this.chime.volume = this.volume;
  }

  /** Toggle chime mute (M hotkey — NOT mic mute, which is A05). */
  setMuted(m: boolean): void {
    this.muted = m;
  }

  /** Returns true if arm() has completed successfully. */
  isArmed(): boolean {
    return this.armed;
  }
}

/** Module-level singleton — survives re-renders. */
export const audioManager = new AudioManager();
