export interface AppSettings {
  voice1: string;
  voice2: string;
  speed: number;
  translateToBg: boolean;
  model: string;
}

export const VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'];
export const MODELS = ['gemini-2.5-flash'];

export interface AudioChunk {
  buffer: AudioBuffer;
  rawFloatData: Float32Array;
  speaker?: string | null;
}

export interface ParsedChunk {
  speaker: string | null;
  text: string;
  voice: string;
}

export interface GroundingSource {
  web?: {
    uri: string;
    title: string;
  };
}