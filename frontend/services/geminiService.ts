import { GoogleGenAI, Modality } from '@google/genai';
import { ParsedChunk, GroundingSource } from '../types.ts';
import { extractYouTubeTranscript } from './youtubeService.ts';

const getAiClient = () => {
  // Използваме точния синтаксис, за да може bundler-ът да замести ключа успешно
  return new GoogleGenAI({apiKey: process.env.API_KEY, vertexai: true});
};

export const translateText = async (text: string, model: string): Promise<string> => {
  const ai = getAiClient();
  try {
    const response = await ai.models.generateContent({
      model: model,
      contents: {
        role: 'user',
        parts: [
          {
            text: `Translate the following text to Bulgarian. Only output the translated text, nothing else. Do not add quotes or explanations. Maintain any speaker labels (like "Speaker 1:", "John:") exactly as they are, just translate the names to Bulgarian if applicable.\n\nText to translate:\n${text}`
          }
        ]
      }
    });
    return response.text || text;
  } catch (error: any) {
    console.error("Translation error:", error);
    throw new Error(`Грешка при превод: ${error.message || error}`);
  }
};

export const processYouTubeUrl = async (url: string, model: string): Promise<{text: string, sources: GroundingSource[]}> => {
  const ai = getAiClient();
  
  // 1. Try to get exact transcript via external API
  const rawTranscript = await extractYouTubeTranscript(url);
  
  let promptText = "";
  let useSearch = false;

  if (rawTranscript) {
    promptText = `Ето транскрипция от видео. Моля, преведи я на български език. 
Ако текстът изглежда като диалог между няколко души, форматирай го СТРОГО по следния начин:
Глас 1: [текст]
Глас 2: [текст]
Ако е само един говорител или монолог, просто напиши преведения текст. Не добавяй никакви други коментари.

Транскрипция:
${rawTranscript.substring(0, 25000)}`; 
  } else {
    useSearch = true;
    promptText = `Моля, намери информация или детайлно резюме на диалога от това YouTube видео: ${url}.
Преведи го на български език.
Ако има повече от един говорител, форматирай го СТРОГО по следния начин:
Глас 1: [текст]
Глас 2: [текст]
Ако е само един говорител, просто напиши текста. Не добавяй никакви други коментари.`;
  }

  try {
    const response = await ai.models.generateContent({
      model: model,
      contents: {
        role: 'user',
        parts: [{ text: promptText }]
      },
      config: useSearch ? { tools: [{ googleSearch: {} }] } : undefined
    });
    
    const sources = (response.candidates?.[0]?.groundingMetadata?.groundingChunks as any) || [];
    return { text: response.text || '', sources };
  } catch (error: any) {
    console.error("YouTube processing error:", error);
    throw new Error(`Грешка при обработка на видео: ${error.message || error}`);
  }
};

export const generateAudioChunk = async (text: string, voice: string, model: string, customInstruction?: string): Promise<string | null> => {
  const ai = getAiClient();
  try {
    const defaultInstruction = "You are a high-quality Text-to-Speech engine. Your ONLY task is to read the user's text aloud exactly as written, in Bulgarian. Do not answer questions, do not add commentary, do not translate unless asked. Just read the text.";
    const systemInstruction = customInstruction?.trim() ? customInstruction : defaultInstruction;

    const response = await ai.models.generateContent({
      model: model,
      contents: {
        role: 'user',
        parts: [{ text: text }]
      },
      config: {
        systemInstruction: systemInstruction,
        responseModalities: [Modality.AUDIO], 
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
    
    throw new Error("Gemini API върна успешен отговор, но не съдържаше аудио данни (inlineData липсва).");
  } catch (error: any) {
    console.error("Audio generation error:", error);
    throw new Error(`Грешка от Gemini API: ${error.message || error}`);
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