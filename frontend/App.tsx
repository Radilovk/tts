import React, { useState, useEffect, useRef, useCallback } from 'react';
import { SettingsPanel } from './components/SettingsPanel.tsx';
import { AudioVisualizer } from './components/AudioVisualizer.tsx';
import { AppSettings, GroundingSource } from './types.ts';
import { audioService } from './services/audioService.ts';
import { translateText, generateAudioChunk, parseTextToChunks, processYouTubeUrl } from './services/geminiService.ts';
import { Play, Square, Download, Upload, Loader2, AlertCircle, Trash2, MonitorPlay, Type, FileAudio } from 'lucide-react';

const DEFAULT_SETTINGS: AppSettings = {
  voice1: 'Zephyr',
  voice2: 'Fenrir',
  speed: 1.0,
  translateToBg: false,
  model: 'gemini-2.5-flash',
  systemInstruction: ''
};

export default function App() {
  const [inputType, setInputType] = useState<'text' | 'youtube'>('text');
  const [text, setText] = useState(() => localStorage.getItem('tts_saved_text') || '');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  
  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem('tts_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });
  
  const [status, setStatus] = useState<'idle' | 'extracting' | 'translating' | 'generating' | 'playing'>('idle');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [hasAudioData, setHasAudioData] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem('tts_settings', JSON.stringify(settings));
    audioService.setPlaybackRate(settings.speed);
  }, [settings]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      localStorage.setItem('tts_saved_text', text);
    }, 500);
    return () => clearTimeout(timeout);
  }, [text]);

  useEffect(() => {
    audioService.onPlaybackEnd(() => {
      setStatus((prev) => prev === 'playing' ? 'idle' : prev);
    });
  }, []);

  const handleFile = (file: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result;
      if (typeof content === 'string') {
        setText(content);
        setInputType('text');
        setError(null);
      }
    };
    reader.onerror = () => setError("Грешка при четене на файла.");
    reader.readAsText(file);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      handleFile(e.target.files[0]);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const stopPlayback = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    audioService.stop();
    setStatus('idle');
    setProgress({ current: 0, total: 0 });
  }, []);

  const handlePlay = async () => {
    if (inputType === 'text' && !text.trim()) {
      setError("Въведете текст.");
      return;
    }
    if (inputType === 'youtube' && !youtubeUrl.trim()) {
      setError("Въведете YouTube линк.");
      return;
    }

    setError(null);
    stopPlayback();
    
    // Synchronously initialize AudioContext on user interaction
    audioService.initialize();
    audioService.clearHistory();
    setHasAudioData(false);
    
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    try {
      let textToProcess = text;

      if (inputType === 'youtube') {
        setStatus('extracting');
        const result = await processYouTubeUrl(youtubeUrl, settings.model);
        if (signal.aborted) return;
        textToProcess = result.text;
        setText(textToProcess);
        setInputType('text');
      } else if (settings.translateToBg) {
        setStatus('translating');
        textToProcess = await translateText(text, settings.model);
        if (signal.aborted) return;
        setText(textToProcess); 
      }

      setStatus('generating');
      const chunks = parseTextToChunks(textToProcess, settings.voice1, settings.voice2);
      setProgress({ current: 0, total: chunks.length });

      for (let i = 0; i < chunks.length; i++) {
        if (signal.aborted) break;
        
        setProgress(p => ({ ...p, current: i + 1 }));
        const base64Audio = await generateAudioChunk(chunks[i].text, chunks[i].voice, settings.model, settings.systemInstruction);
        
        if (signal.aborted) break;

        if (base64Audio) {
          const audioChunk = await audioService.decodeBase64Audio(base64Audio, chunks[i].speaker);
          if (audioChunk) {
            audioService.enqueueAndPlay(audioChunk);
            setHasAudioData(true);
            if (status !== 'playing') setStatus('playing');
          }
        }
      }
      
      if (!signal.aborted && audioService.getIsPlaying()) {
         setStatus('playing');
      } else if (!signal.aborted) {
         setStatus('idle');
      }

    } catch (err: any) {
      if (!signal.aborted) {
        setError(err.message || "Възникна неизвестна грешка.");
        setStatus('idle');
      }
    }
  };

  const handleSaveAudio = () => {
    const blob = audioService.exportMP3();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tts-${Date.now()}.mp3`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isBusy = status !== 'idle' && status !== 'playing';

  return (
    <div className="min-h-screen flex flex-col max-w-5xl mx-auto p-4 md:p-6 gap-6">
      {/* Header */}
      <header className="flex items-center justify-between pb-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <FileAudio className="w-6 h-6 text-primary-500" />
          <h1 className="text-xl font-semibold text-gray-100">Gemini TTS</h1>
        </div>

        {/* Input Toggle */}
        <div className="flex bg-dark-900 rounded-lg p-1 border border-white/5">
          <button
            onClick={() => setInputType('text')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              inputType === 'text' ? 'bg-dark-700 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <Type className="w-4 h-4" /> Текст
          </button>
          <button
            onClick={() => setInputType('youtube')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              inputType === 'youtube' ? 'bg-dark-700 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <MonitorPlay className="w-4 h-4" /> YouTube
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col md:flex-row gap-6">
        {/* Left: Input Area */}
        <div className="flex-1 flex flex-col gap-3">
          {inputType === 'youtube' ? (
            <div className="flex flex-col gap-2">
              <input
                type="url"
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
                placeholder="Поставете YouTube линк тук..."
                className="w-full bg-dark-900 border border-white/10 rounded-xl p-4 text-white placeholder-gray-500 focus:ring-1 focus:ring-primary-500 outline-none text-sm"
                disabled={isBusy}
              />
            </div>
          ) : (
            <div className="flex-1 flex flex-col gap-2 relative">
              <div className="absolute top-3 right-3 flex gap-2 z-10">
                <button 
                  onClick={() => setText('')}
                  disabled={!text || isBusy}
                  className="p-1.5 bg-dark-800/80 text-gray-400 hover:text-red-400 rounded-md transition-colors disabled:opacity-50"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                <input type="file" accept=".txt,.md" className="hidden" ref={fileInputRef} onChange={handleFileUpload} />
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isBusy}
                  className="p-1.5 bg-dark-800/80 text-gray-400 hover:text-white rounded-md transition-colors disabled:opacity-50"
                >
                  <Upload className="w-4 h-4" />
                </button>
              </div>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Въведете текст или диалог (напр. Иван: Здравей!)..."
                className="flex-1 w-full min-h-[300px] bg-dark-900 border border-white/10 rounded-xl p-4 pt-12 text-gray-200 placeholder-gray-600 focus:ring-1 focus:ring-primary-500 outline-none resize-none text-sm leading-relaxed"
                disabled={isBusy}
              />
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-300 p-4 rounded-lg flex items-start gap-3 text-sm shadow-lg">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <div className="flex flex-col gap-1">
                <span className="font-semibold">Възникна проблем:</span>
                <span className="opacity-90 break-words">{error}</span>
              </div>
            </div>
          )}
        </div>

        {/* Right: Controls */}
        <div className="w-full md:w-72 flex flex-col gap-4">
          <SettingsPanel settings={settings} onSettingsChange={setSettings} disabled={isBusy || status === 'playing'} />

          <div className="bg-dark-800/80 border border-white/10 rounded-xl p-4 flex flex-col gap-4">
            <AudioVisualizer isActive={status === 'playing'} />

            <div className="text-xs font-medium text-center text-gray-400 h-4">
              {status === 'extracting' && <span className="flex items-center justify-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Извличане...</span>}
              {status === 'translating' && <span className="flex items-center justify-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Превод...</span>}
              {status === 'generating' && <span className="flex items-center justify-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Генериране ({progress.current}/{progress.total})</span>}
              {status === 'playing' && <span className="text-primary-400">Възпроизвеждане...</span>}
            </div>

            {status === 'idle' ? (
              <button
                onClick={handlePlay}
                disabled={(inputType === 'text' && !text.trim()) || (inputType === 'youtube' && !youtubeUrl.trim())}
                className="w-full flex items-center justify-center gap-2 bg-primary-600 hover:bg-primary-500 text-white py-2.5 rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
              >
                <Play className="w-4 h-4" /> Чети
              </button>
            ) : (
              <button
                onClick={stopPlayback}
                className="w-full flex items-center justify-center gap-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 py-2.5 rounded-lg font-medium text-sm transition-colors"
              >
                <Square className="w-4 h-4" /> Спри
              </button>
            )}

            <button
              onClick={handleSaveAudio}
              disabled={!hasAudioData || isBusy}
              className="w-full flex items-center justify-center gap-2 bg-dark-900 hover:bg-dark-700 border border-white/10 text-gray-300 py-2.5 rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
            >
              <Download className="w-4 h-4" /> MP3
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}