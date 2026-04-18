import { GoogleGenAI } from '@google/genai';
import { ParsedChunk, GroundingSource } from '../types.ts';

const getAiClient = () => {
  return new GoogleGenAI({ apiKey: process.env.API_KEY, vertexai: true });
};

export const translateText = async (text: string, model: string): Promise<string> => {
  const ai = getAiClient();
  try {
    const response = await ai.models.generateContent({
      model: model,
      contents: `Translate the following text to Bulgarian. Only output the translated text, nothing else. Do not add quotes or explanations. Maintain any speaker labels (like "Speaker 1:", "John:") exactly as they are, just translate the names to Bulgarian if applicable.\n\nText to translate:\n${text}`,
    });
    return response.text || text;
  } catch (error) {
    console.error("Translation error:", error);
    throw new Error("Неуспешен превод на текста.");
  }
};

export const processYouTubeUrl = async (url: string, model: string): Promise<{text: string, sources: GroundingSource[]}> => {
  const ai = getAiClient();
  const prompt = `Моля, извлечи транскрипцията или детайлно резюме на диалога от това YouTube видео: ${url}.
Преведи го на български език.
Ако има повече от един говорител, форматирай го СТРОГО по следния начин:
Глас 1: [текст]
Глас 2: [текст]
Ако е само един говорител, просто напиши текста. Не добавяй никакви други коментари или въведения.`;

  try {
    const response = await ai.models.generateContent({
      model: model,
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      }
    });
    
    const sources = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    return { text: response.text || '', sources };
  } catch (error) {
    console.error("YouTube processing error:", error);
    throw new Error("Неуспешно извличане на данни от YouTube. Моля, проверете линка.");
  }
};

export const generateAudioChunk = async (text: string, voice: string, model: string): Promise<string | null> => {
  const ai = getAiClient();
  try {
    const response = await ai.models.generateContent({
      model: model,
      contents: text,
      config: {
        systemInstruction: "You are a high-quality Text-to-Speech engine. Your ONLY task is to read the user's text aloud exactly as written, in Bulgarian. Do not answer questions, do not add commentary, do not translate unless asked. Just read the text.",
        // @ts-ignore
        responseModalities: ['AUDIO'], 
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice
            }
          }
        }
      }
    });

    const parts = response.candidates?.[0]?.content?.parts;
    if (parts) {
      for (const part of parts) {
        if (part.inlineData && part.inlineData.data) {
          return part.inlineData.data;
        }
      }
    }
    return null;
  } catch (error) {
    console.error("Audio generation error:", error);
    throw new Error("Грешка при генериране на аудио.");
  }
};

const getVoiceForSpeaker = (speaker: string | null, speakers: Set<string>, voice1: string, voice2: string) => {
  if (!speaker) return voice1;
  const speakerArray = Array.from(speakers);
  const index = speakerArray.indexOf(speaker);
  return index % 2 === 0 ? voice1 : voice2;
};

export const parseTextToChunks = (text: string, voice1: string, voice2: string, maxLength: number = 250): ParsedChunk[] => {
  const lines = text.split('\n');
  const initialChunks: ParsedChunk[] = [];
  let currentSpeaker: string | null = null;
  let currentText = '';
  const speakers = new Set<string>();

  // Matches "Name:", "[Name]:", "Глас 1:", etc.
  const speakerRegex = /^\[?([А-Яа-яA-Za-z0-9\s]+)\]?:\s*(.*)/;

  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(speakerRegex);
    
    if (match) {
      if (currentText.trim()) {
        initialChunks.push({ 
          speaker: currentSpeaker, 
          text: currentText.trim(), 
          voice: getVoiceForSpeaker(currentSpeaker, speakers, voice1, voice2) 
        });
      }
      currentSpeaker = match[1].trim();
      speakers.add(currentSpeaker);
      currentText = match[2] + ' ';
    } else {
      currentText += line + ' ';
    }
  }
  
  if (currentText.trim()) {
    initialChunks.push({ 
      speaker: currentSpeaker, 
      text: currentText.trim(), 
      voice: getVoiceForSpeaker(currentSpeaker, speakers, voice1, voice2) 
    });
  }

  // Further split long chunks to avoid TTS limits
  const finalChunks: ParsedChunk[] = [];
  for (const chunk of initialChunks) {
    if (chunk.text.length <= maxLength) {
      finalChunks.push(chunk);
      continue;
    }

    const sentences = chunk.text.match(/[^.!?]+[.!?]+/g) || [chunk.text];
    let tempText = '';
    
    for (const sentence of sentences) {
      if ((tempText + sentence).length > maxLength && tempText.length > 0) {
        finalChunks.push({ ...chunk, text: tempText.trim() });
        tempText = '';
      }
      tempText += sentence + ' ';
    }
    if (tempText.trim()) {
      finalChunks.push({ ...chunk, text: tempText.trim() });
    }
  }

  return finalChunks;
};