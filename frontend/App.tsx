import React, { useState, useEffect, useRef, useCallback } from 'react';
import { SettingsPanel } from './components/SettingsPanel.tsx';
import { AudioVisualizer } from './components/AudioVisualizer.tsx';
import { AppSettings, GroundingSource } from './types.ts';
import { audioService } from './services/audioService.ts';
import { translateText, generateAudioChunk, parseTextToChunks, processYouTubeUrl } from './services/geminiService.ts';
import { Play, Square, Download, Upload, FileText, Loader2, AlertCircle, Trash2, CheckCircle2, MonitorPlay, Type, Sparkles, ExternalLink } from 'lucide-react';

const DEFAULT_SETTINGS: AppSettings = {
  voice1: 'Zephyr',
  voice2: 'Fenrir',
  speed: 1.0,
  translateToBg: false,
  model: 'gemini-2.5-flash'
};

export default function App() {
  const [inputType, setInputType] = useState<'text' | 'youtube'>('text');
  const [text, setText] = useState(() => localStorage.getItem('tts_saved_text') || '');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [groundingSources, setGroundingSources] = useState<GroundingSource[]>([]);
  
  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem('tts_settings');
    return saved ? JSON.parse(saved) : DEFAULT_SETTINGS;
  });
  
  const [status, setStatus] = useState<'idle' | 'extracting' | 'translating' | 'generating' | 'playing'>('idle');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [playingChunkIndex, setPlayingChunkIndex] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [hasAudioData, setHasAudioData] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

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
      setPlayingChunkIndex(-1);
    });
    audioService.onChunkStart((index) => {
      setPlayingChunkIndex(index);
    });
  }, []);

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  const handleFile = (file: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result;
      if (typeof content === 'string') {
        setText(content);
        setInputType('text');
        setError(null);
        showSuccess("Файлът е зареден успешно!");
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

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  };

  const stopPlayback = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    audioService.stop();
    setStatus('idle');
    setProgress({ current: 0, total: 0 });
    setPlayingChunkIndex(-1);
  }, []);

  const handlePlay = async () => {
    if (inputType === 'text' && !text.trim()) {
      setError("Моля, въведете текст за четене.");
      return;
    }
    if (inputType === 'youtube' && !youtubeUrl.trim()) {
      setError("Моля, въведете валиден YouTube линк.");
      return;
    }

    setError(null);
    setGroundingSources([]);
    stopPlayback();
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
        setGroundingSources(result.sources);
        setText(textToProcess); // Show the extracted text in the UI
        setInputType('text'); // Switch to text view to show result
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
        
        const base64Audio = await generateAudioChunk(chunks[i].text, chunks[i].voice, settings.model);
        
        if (signal.aborted) break;

        if (base64Audio) {
          const audioChunk = await audioService.decodeBase64Audio(base64Audio, chunks[i].speaker);
          if (audioChunk) {
            audioService.enqueueAndPlay(audioChunk);
            setHasAudioData(true);
            if (status !== 'playing') {
               setStatus('playing');
            }
          }
        } else {
          console.warn(`Failed to get audio for chunk ${i}`);
        }
      }
      
      if (!signal.aborted && audioService['isPlaying']) {
         setStatus('playing');
      } else if (!signal.aborted) {
         setStatus('idle');
      }

    } catch (err: any) {
      if (!signal.aborted) {
        setError(err.message || "Възникна грешка при обработката.");
        setStatus('idle');
      }
    }
  };

  const handleSaveAudio = () => {
    const blob = audioService.exportMP3();
    if (!blob) {
      setError("Няма налично аудио за запазване.");
      return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = `gemini-voice-${new Date().getTime()}.mp3`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
    showSuccess("Аудиото е запазено като MP3!");
  };

  const isBusy = status !== 'idle' && status !== 'playing';
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div className="min-h-screen flex flex-col max-w-7xl mx-auto p-4 md:p-6 lg:p-8 gap-8">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-center justify-between pb-6 border-b border-white/10 gap-4">
        <div className="flex items-center gap-4">
          <div className="relative">
            <div className="absolute inset-0 bg-primary-500 blur-xl opacity-50 rounded-full"></div>
            <div className="relative bg-gradient-to-br from-primary-400 to-accent p-3.5 rounded-2xl shadow-xl border border-white/20">
              <Sparkles className="w-8 h-8 text-white" />
            </div>
          </div>
          <div>
            <h1 className="text-3xl md:text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-white via-blue-100 to-gray-400 tracking-tight">
              Gemini Четец
            </h1>
            <p className="text-sm text-primary-400 font-semibold tracking-widest uppercase mt-1">AI Текст към Реч & Диалози</p>
          </div>
        </div>

        {/* Input Type Switcher */}
        <div className="flex p-1.5 bg-dark-900/80 backdrop-blur-md rounded-xl border border-white/10 shadow-inner w-fit">
          <button
            onClick={() => setInputType('text')}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium transition-all duration-300 ${
              inputType === 'text' 
                ? 'bg-white/10 text-white shadow-sm' 
                : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}
          >
            <Type className="w-4 h-4" /> Текст
          </button>
          <button
            onClick={() => setInputType('youtube')}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium transition-all duration-300 ${
              inputType === 'youtube' 
                ? 'bg-red-500/20 text-red-400 shadow-sm border border-red-500/30' 
                : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}
          >
            <MonitorPlay className="w-4 h-4" /> YouTube
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col lg:flex-row gap-8">
        
        {/* Left Column: Input */}
        <div className="flex-1 flex flex-col gap-5">
          
          {inputType === 'youtube' ? (
            <div className="glass-panel p-8 rounded-3xl border border-white/10 shadow-2xl flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-4">
              <div className="flex items-center gap-4 text-red-400 mb-2">
                <div className="p-3 bg-red-500/10 rounded-2xl">
                  <MonitorPlay className="w-8 h-8" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white">YouTube Извличане</h2>
                  <p className="text-sm text-gray-400">Поставете линк за автоматично извличане и превод на диалога.</p>
                </div>
              </div>
              
              <div className="space-y-2">
                <label className="text-sm font-semibold text-gray-300 tracking-wide uppercase ml-1">YouTube Линк</label>
                <input
                  type="url"
                  value={youtubeUrl}
                  onChange={(e) => setYoutubeUrl(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=..."
                  className="w-full bg-dark-900/80 border border-white/10 rounded-2xl p-5 text-white placeholder-gray-600 focus:ring-2 focus:ring-red-500/50 focus:border-red-500/50 outline-none transition-all text-lg shadow-inner"
                  disabled={isBusy}
                />
              </div>
              
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-2xl p-5 flex gap-4">
                <Sparkles className="w-6 h-6 text-blue-400 shrink-0" />
                <p className="text-sm text-blue-200 leading-relaxed">
                  AI ще анализира видеото, ще извлече транскрипцията, ще я преведе на български и автоматично ще разпредели ролите (Глас 1 и Глас 2), ако има диалог.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4 h-full animate-in fade-in slide-in-from-bottom-4">
              <div className="flex justify-between items-end px-1">
                <div>
                  <label className="text-sm font-semibold text-gray-300 tracking-wide uppercase">Текст за четене</label>
                  <p className="text-xs text-gray-500 mt-1 font-medium">{wordCount} думи • {text.length} символа</p>
                </div>
                <div className="flex gap-2">
                  <button 
                    onClick={() => setText('')}
                    disabled={!text || isBusy}
                    className="p-2.5 text-gray-400 hover:text-red-400 hover:bg-red-400/10 rounded-xl transition-colors disabled:opacity-50"
                    title="Изчисти текста"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                  <input
                    type="file"
                    accept=".txt,.md,.csv"
                    className="hidden"
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                  />
                  <button 
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isBusy}
                    className="flex items-center gap-2 text-sm bg-dark-800 hover:bg-dark-700 text-gray-200 px-5 py-2.5 rounded-xl transition-all border border-white/10 shadow-sm disabled:opacity-50 font-medium"
                  >
                    <Upload className="w-4 h-4" />
                    <span className="hidden sm:inline">Качи файл</span>
                  </button>
                </div>
              </div>
              
              <div 
                className={`relative flex-1 min-h-[400px] lg:min-h-[500px] rounded-3xl overflow-hidden transition-all duration-500 ${
                  isDragging ? 'ring-2 ring-primary-500 shadow-[0_0_40px_rgba(59,130,246,0.4)] scale-[1.01]' : 'ring-1 ring-white/10 shadow-2xl'
                }`}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
              >
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Въведете или поставете текст тук...&#10;&#10;За диалози използвайте формат:&#10;Иван: Здравей!&#10;Мария: Здрасти, как си?"
                  className="absolute inset-0 w-full h-full bg-dark-900/80 backdrop-blur-md p-8 text-gray-100 placeholder-gray-600 focus:ring-2 focus:ring-primary-500/50 outline-none resize-none text-lg leading-relaxed custom-scrollbar"
                  disabled={isBusy}
                />
                {isDragging && (
                  <div className="absolute inset-0 bg-primary-500/20 backdrop-blur-sm flex items-center justify-center pointer-events-none z-10">
                    <div className="bg-dark-800 text-primary-400 px-8 py-4 rounded-2xl font-bold text-lg flex items-center gap-3 shadow-2xl border border-primary-500/30 animate-bounce">
                      <Upload className="w-6 h-6" /> Пуснете файла тук
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Grounding Sources (if any) */}
          {groundingSources.length > 0 && (
            <div className="bg-dark-800/50 border border-white/10 rounded-2xl p-5 animate-in fade-in">
              <h3 className="text-sm font-bold text-gray-300 mb-3 flex items-center gap-2">
                <ExternalLink className="w-4 h-4" /> Източници на информация
              </h3>
              <ul className="space-y-2">
                {groundingSources.map((source, idx) => source.web?.uri && (
                  <li key={idx}>
                    <a href={source.web.uri} target="_blank" rel="noopener noreferrer" className="text-sm text-primary-400 hover:text-primary-300 hover:underline truncate block">
                      {source.web.title || source.web.uri}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Notifications */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/50 text-red-200 p-5 rounded-2xl flex items-start gap-3 text-sm animate-in fade-in slide-in-from-bottom-2 shadow-lg">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-red-400" />
              <p className="font-medium leading-relaxed">{error}</p>
            </div>
          )}
          {successMsg && (
            <div className="bg-green-500/10 border border-green-500/50 text-green-200 p-5 rounded-2xl flex items-center gap-3 text-sm animate-in fade-in slide-in-from-bottom-2 shadow-lg">
              <CheckCircle2 className="w-5 h-5 shrink-0 text-green-400" />
              <p className="font-medium">{successMsg}</p>
            </div>
          )}
        </div>

        {/* Right Column: Controls & Settings */}
        <div className="w-full lg:w-[400px] flex flex-col gap-6">
          <SettingsPanel 
            settings={settings} 
            onSettingsChange={setSettings} 
            disabled={isBusy || status === 'playing'}
          />

          {/* Action Card */}
          <div className="glass-panel p-6 rounded-3xl flex flex-col gap-6 sticky top-8 shadow-2xl border border-white/10">
            
            <AudioVisualizer isActive={status === 'playing'} />

            {/* Status Indicator */}
            <div className="h-10 flex items-center justify-center text-sm font-bold bg-dark-900/60 rounded-xl border border-white/5 shadow-inner">
              {status === 'extracting' && <span className="text-red-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Извличане от YouTube...</span>}
              {status === 'translating' && <span className="text-blue-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Превеждане...</span>}
              {status === 'generating' && <span className="text-yellow-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Генериране ({progress.current}/{progress.total})...</span>}
              {status === 'playing' && (
                <span className="text-green-400 flex items-center gap-2">
                  <Volume2 className="w-4 h-4 animate-pulse" /> 
                  Възпроизвеждане {progress.total > 0 ? `(${playingChunkIndex + 1}/${progress.total})` : ''}
                </span>
              )}
              {status === 'idle' && <span className="text-gray-500 tracking-widest uppercase text-xs">В готовност</span>}
            </div>

            <div className="grid grid-cols-1 gap-3">
              {status === 'idle' ? (
                <button
                  onClick={handlePlay}
                  disabled={(inputType === 'text' && !text.trim()) || (inputType === 'youtube' && !youtubeUrl.trim())}
                  className="group relative flex items-center justify-center gap-3 bg-gradient-to-r from-primary-600 via-primary-500 to-accent hover:from-primary-500 hover:to-purple-500 text-white py-4.5 rounded-2xl font-extrabold text-lg transition-all duration-300 shadow-[0_0_20px_rgba(59,130,246,0.4)] hover:shadow-[0_0_30px_rgba(139,92,246,0.6)] disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden hover:scale-[1.02]"
                >
                  <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out"></div>
                  <Play className="w-6 h-6 relative z-10 fill-current" />
                  <span className="relative z-10">
                    {inputType === 'youtube' ? 'Извлечи & Чети' : 'Чети на глас'}
                  </span>
                </button>
              ) : (
                <button
                  onClick={stopPlayback}
                  className="flex items-center justify-center gap-3 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/50 py-4.5 rounded-2xl font-extrabold text-lg transition-all duration-300 hover:scale-[1.02] shadow-lg shadow-red-500/10"
                >
                  <Square className="w-6 h-6 fill-current" />
                  Спри
                </button>
              )}
            </div>

            <button
              onClick={handleSaveAudio}
              disabled={!hasAudioData || isBusy}
              className="flex items-center justify-center gap-2 bg-dark-800/80 hover:bg-dark-700 border border-white/10 text-gray-200 py-4 rounded-2xl font-bold transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed group hover:border-white/20"
            >
              <Download className="w-5 h-5 text-gray-400 group-hover:text-white transition-colors" />
              Запази като MP3
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}