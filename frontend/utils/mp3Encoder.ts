import lamejs from 'lamejs';

export function encodeMP3(samples: Float32Array, sampleRate: number): Blob {
  const channels = 1; // Gemini returns mono audio
  const kbps = 128;
  
  // Initialize the MP3 encoder
  const mp3encoder = new lamejs.Mp3Encoder(channels, sampleRate, kbps);
  const mp3Data: Int8Array[] = [];

  // Convert Float32Array (-1.0 to 1.0) to Int16Array (-32768 to 32767)
  const sampleBlockSize = 1152; // Must be a multiple of 576 for lamejs
  const int16Samples = new Int16Array(samples.length);
  
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    int16Samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  // Encode in chunks
  for (let i = 0; i < int16Samples.length; i += sampleBlockSize) {
    const sampleChunk = int16Samples.subarray(i, i + sampleBlockSize);
    const mp3buf = mp3encoder.encodeBuffer(sampleChunk);
    if (mp3buf.length > 0) {
      mp3Data.push(mp3buf);
    }
  }
  
  // Flush the encoder
  const mp3buf = mp3encoder.flush();
  if (mp3buf.length > 0) {
    mp3Data.push(mp3buf);
  }

  return new Blob(mp3Data, { type: 'audio/mp3' });
}