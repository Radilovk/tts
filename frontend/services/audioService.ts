import { AudioChunk } from '../types.ts';
import { encodeMP3 } from '../utils/mp3Encoder.ts';

class AudioService {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private queue: AudioChunk[] = [];
  private isPlaying: boolean = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private playbackRate: number = 1.0;
  private allReceivedData: Float32Array[] = [];
  
  private onPlaybackEndCallback: (() => void) | null = null;
  private onChunkStartCallback: ((index: number, speaker: string | null) => void) | null = null;
  
  private currentChunkIndex: number = -1;
  private currentSpeaker: string | null = null;

  public initialize() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.connect(this.audioContext.destination);
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
  }

  public getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  public getCurrentSpeaker(): string | null {
    return this.currentSpeaker;
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  public setPlaybackRate(rate: number) {
    this.playbackRate = rate;
    if (this.currentSource) {
      this.currentSource.playbackRate.value = rate;
    }
  }

  public onPlaybackEnd(callback: () => void) {
    this.onPlaybackEndCallback = callback;
  }

  public onChunkStart(callback: (index: number, speaker: string | null) => void) {
    this.onChunkStartCallback = callback;
  }

  public async decodeBase64Audio(base64: string, speaker?: string | null): Promise<AudioChunk | null> {
    this.initialize();
    if (!this.audioContext) return null;

    try {
      const binaryString = atob(base64);
      const len = binaryString.length;
      
      // Ensure byte length is a multiple of 2 for Int16Array
      const validLen = len % 2 === 0 ? len : len - 1;
      const bytes = new Uint8Array(validLen);
      
      for (let i = 0; i < validLen; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const dataInt16 = new Int16Array(bytes.buffer);
      const frameCount = dataInt16.length;
      const audioBuffer = this.audioContext.createBuffer(1, frameCount, 24000);
      const channelData = audioBuffer.getChannelData(0);
      
      for (let i = 0; i < frameCount; i++) {
        channelData[i] = dataInt16[i] / 32768.0;
      }

      const rawFloatData = new Float32Array(channelData);

      return { buffer: audioBuffer, rawFloatData, speaker };
    } catch (error) {
      console.error("Error decoding audio:", error);
      return null;
    }
  }

  public enqueueAndPlay(chunk: AudioChunk) {
    this.queue.push(chunk);
    this.allReceivedData.push(chunk.rawFloatData);
    if (!this.isPlaying) {
      this.playNext();
    }
  }

  private playNext() {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      this.currentChunkIndex = -1;
      this.currentSpeaker = null;
      if (this.onPlaybackEndCallback) {
        this.onPlaybackEndCallback();
      }
      return;
    }

    this.initialize();
    if (!this.audioContext || !this.analyser) return;

    this.isPlaying = true;
    this.currentChunkIndex++;
    
    const chunk = this.queue.shift()!;
    this.currentSpeaker = chunk.speaker || null;

    if (this.onChunkStartCallback) {
      this.onChunkStartCallback(this.currentChunkIndex, this.currentSpeaker);
    }
    
    this.currentSource = this.audioContext.createBufferSource();
    this.currentSource.buffer = chunk.buffer;
    this.currentSource.playbackRate.value = this.playbackRate;
    
    this.currentSource.connect(this.analyser);
    
    this.currentSource.onended = () => {
      this.currentSource = null;
      this.playNext();
    };

    this.currentSource.start();
  }

  public stop() {
    this.queue = [];
    if (this.currentSource) {
      this.currentSource.stop();
      this.currentSource = null;
    }
    this.isPlaying = false;
    this.currentChunkIndex = -1;
    this.currentSpeaker = null;
    if (this.onPlaybackEndCallback) {
      this.onPlaybackEndCallback();
    }
  }

  public clearHistory() {
    this.allReceivedData = [];
    this.currentChunkIndex = -1;
    this.currentSpeaker = null;
  }

  public exportMP3(): Blob | null {
    if (this.allReceivedData.length === 0) return null;

    let totalLength = 0;
    for (const data of this.allReceivedData) {
      totalLength += data.length;
    }

    const combinedData = new Float32Array(totalLength);
    let offset = 0;
    for (const data of this.allReceivedData) {
      combinedData.set(data, offset);
      offset += data.length;
    }

    return encodeMP3(combinedData, 24000);
  }
}

export const audioService = new AudioService();