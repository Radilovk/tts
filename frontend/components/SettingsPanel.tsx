import React from 'react';
import { AppSettings, VOICES, MODELS } from '../types.ts';
import { Settings2, Volume2, Gauge, Languages, Cpu, Users } from 'lucide-react';

interface SettingsPanelProps {
  settings: AppSettings;
  onSettingsChange: (newSettings: AppSettings) => void;
  disabled?: boolean;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ settings, onSettingsChange, disabled }) => {
  const handleChange = (key: keyof AppSettings, value: any) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  return (
    <div className="glass-panel p-6 rounded-3xl space-y-6 shadow-2xl shadow-black/50 border border-white/10 relative overflow-hidden">
      <div className="absolute top-0 right-0 w-32 h-32 bg-primary-500/10 rounded-full blur-3xl -mr-10 -mt-10 pointer-events-none"></div>
      
      <div className="flex items-center gap-3 mb-4 relative z-10">
        <div className="p-2.5 bg-gradient-to-br from-primary-500/20 to-accent/20 rounded-xl border border-white/5">
          <Settings2 className="w-5 h-5 text-primary-400" />
        </div>
        <h2 className="text-xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400">Настройки</h2>
      </div>

      <div className="space-y-5 relative z-10">
        {/* Model Selection */}
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
            <Cpu className="w-4 h-4 text-primary-400" /> AI Модел
          </label>
          <div className="relative group">
            <select
              disabled={disabled}
              value={settings.model}
              onChange={(e) => handleChange('model', e.target.value)}
              className="w-full appearance-none bg-dark-900/60 border border-white/10 rounded-xl py-3 pl-4 pr-10 text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none disabled:opacity-50 transition-all group-hover:border-white/20"
            >
              {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-gray-400">
              <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/></svg>
            </div>
          </div>
        </div>

        {/* Voice 1 Selection */}
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
            <Volume2 className="w-4 h-4 text-primary-400" /> Основен глас (Глас 1)
          </label>
          <div className="grid grid-cols-3 gap-2">
            {VOICES.map(v => (
              <button
                key={`v1-${v}`}
                disabled={disabled}
                onClick={() => handleChange('voice1', v)}
                className={`py-2 px-1 text-sm rounded-xl border transition-all duration-300 ${
                  settings.voice1 === v 
                    ? 'bg-gradient-to-br from-primary-600 to-primary-500 border-transparent text-white shadow-lg shadow-primary-500/25 font-medium' 
                    : 'bg-dark-900/50 border-white/5 text-gray-400 hover:bg-dark-800 hover:text-gray-200 hover:border-white/10'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        {/* Voice 2 Selection */}
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
            <Users className="w-4 h-4 text-accent" /> Втори глас (Глас 2)
          </label>
          <div className="grid grid-cols-3 gap-2">
            {VOICES.map(v => (
              <button
                key={`v2-${v}`}
                disabled={disabled}
                onClick={() => handleChange('voice2', v)}
                className={`py-2 px-1 text-sm rounded-xl border transition-all duration-300 ${
                  settings.voice2 === v 
                    ? 'bg-gradient-to-br from-accent to-purple-500 border-transparent text-white shadow-lg shadow-accent/25 font-medium' 
                    : 'bg-dark-900/50 border-white/5 text-gray-400 hover:bg-dark-800 hover:text-gray-200 hover:border-white/10'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {v}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-500 mt-1">Използва се автоматично при диалози.</p>
        </div>

        {/* Speed Slider */}
        <div className="space-y-3 pt-3 border-t border-white/5">
          <label className="flex items-center justify-between text-sm font-medium text-gray-300">
            <span className="flex items-center gap-2"><Gauge className="w-4 h-4 text-primary-400" /> Скорост</span>
            <span className="bg-dark-900/80 px-2.5 py-1 rounded-md text-primary-400 font-mono text-xs border border-white/5">{settings.speed.toFixed(1)}x</span>
          </label>
          <input
            type="range"
            min="0.5"
            max="2.0"
            step="0.1"
            disabled={disabled}
            value={settings.speed}
            onChange={(e) => handleChange('speed', parseFloat(e.target.value))}
            className="w-full h-2 bg-dark-900 rounded-lg appearance-none cursor-pointer accent-primary-500 disabled:opacity-50"
          />
          <div className="flex justify-between text-xs text-gray-500 px-1 font-medium">
            <span>Бавно</span>
            <span>Нормално</span>
            <span>Бързо</span>
          </div>
        </div>

        {/* Translate Toggle */}
        <div className="pt-3 border-t border-white/5">
          <label className={`flex items-center justify-between p-4 rounded-2xl border transition-all duration-300 cursor-pointer ${settings.translateToBg ? 'bg-primary-500/10 border-primary-500/30 shadow-inner' : 'bg-dark-900/40 border-white/5 hover:bg-dark-800/60'}`}>
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-xl transition-colors ${settings.translateToBg ? 'bg-primary-500/20 text-primary-400' : 'bg-dark-800 text-gray-400'}`}>
                <Languages className="w-5 h-5" />
              </div>
              <div>
                <p className="text-sm font-bold text-white">Превод на БГ</p>
                <p className="text-xs text-gray-400 mt-0.5">От английски текст</p>
              </div>
            </div>
            <div className="relative inline-flex items-center">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={settings.translateToBg}
                disabled={disabled}
                onChange={(e) => handleChange('translateToBg', e.target.checked)}
              />
              <div className="w-12 h-6 bg-dark-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-500 disabled:opacity-50 shadow-inner"></div>
            </div>
          </label>
        </div>
      </div>
    </div>
  );
};