import React, { useState } from 'react';
import { AppSettings, VOICES, MODELS } from '../types.ts';
import { Settings2, Volume2, Gauge, Languages, Users, ChevronDown, ChevronUp, AlignLeft } from 'lucide-react';

interface SettingsPanelProps {
  settings: AppSettings;
  onSettingsChange: (newSettings: AppSettings) => void;
  disabled?: boolean;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ settings, onSettingsChange, disabled }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const handleChange = (key: keyof AppSettings, value: any) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  return (
    <div className="bg-dark-800/80 border border-white/10 rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between pb-2 border-b border-white/5">
        <div className="flex items-center gap-2 text-gray-200 font-medium">
          <Settings2 className="w-4 h-4" />
          <span>Настройки</span>
        </div>
        <button 
          onClick={() => setIsExpanded(!isExpanded)} 
          className="text-gray-400 hover:text-white transition-colors p-1 rounded-md hover:bg-white/5"
          title="Още настройки"
        >
          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {/* Always visible: Voices */}
      <div className="grid grid-cols-2 gap-4">
        {/* Voice 1 */}
        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs text-gray-400">
            <Volume2 className="w-3.5 h-3.5" /> Глас 1
          </label>
          <select
            disabled={disabled}
            value={settings.voice1}
            onChange={(e) => handleChange('voice1', e.target.value)}
            className="w-full bg-dark-900 border border-white/10 rounded-lg px-2.5 py-1.5 text-sm text-white focus:ring-1 focus:ring-primary-500 outline-none disabled:opacity-50"
          >
            {VOICES.map(v => <option key={`v1-${v}`} value={v}>{v}</option>)}
          </select>
        </div>

        {/* Voice 2 */}
        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs text-gray-400">
            <Users className="w-3.5 h-3.5" /> Глас 2
          </label>
          <select
            disabled={disabled}
            value={settings.voice2}
            onChange={(e) => handleChange('voice2', e.target.value)}
            className="w-full bg-dark-900 border border-white/10 rounded-lg px-2.5 py-1.5 text-sm text-white focus:ring-1 focus:ring-primary-500 outline-none disabled:opacity-50"
          >
            {VOICES.map(v => <option key={`v2-${v}`} value={v}>{v}</option>)}
          </select>
        </div>
      </div>

      {/* Collapsible Advanced Settings */}
      {isExpanded && (
        <div className="space-y-4 pt-4 border-t border-white/5 animate-in fade-in slide-in-from-top-2">
          {/* Speed */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span className="flex items-center gap-1.5"><Gauge className="w-3.5 h-3.5" /> Скорост</span>
              <span className="text-primary-400">{settings.speed.toFixed(1)}x</span>
            </div>
            <input
              type="range"
              min="0.5"
              max="2.0"
              step="0.1"
              disabled={disabled}
              value={settings.speed}
              onChange={(e) => handleChange('speed', parseFloat(e.target.value))}
              className="w-full h-1.5 bg-dark-900 rounded-lg appearance-none cursor-pointer accent-primary-500 disabled:opacity-50"
            />
          </div>

          {/* Translate Toggle */}
          <div className="flex items-center justify-between bg-dark-900/50 p-2.5 rounded-lg border border-white/5">
            <div className="flex items-center gap-2">
              <Languages className="w-4 h-4 text-gray-400" />
              <span className="text-sm text-gray-200">Превод на БГ</span>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={settings.translateToBg}
                disabled={disabled}
                onChange={(e) => handleChange('translateToBg', e.target.checked)}
              />
              <div className="w-9 h-5 bg-dark-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-500 disabled:opacity-50"></div>
            </label>
          </div>

          {/* System Instructions */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs text-gray-400">
              <AlignLeft className="w-3.5 h-3.5" /> Инструкции за стил
            </label>
            <textarea
              value={settings.systemInstruction || ''}
              onChange={(e) => handleChange('systemInstruction', e.target.value)}
              placeholder="Напр. Чети бавно, драматично и с паузи..."
              className="w-full bg-dark-900 border border-white/10 rounded-lg p-2.5 text-sm text-white placeholder-gray-600 focus:ring-1 focus:ring-primary-500 outline-none resize-none h-20"
              disabled={disabled}
            />
          </div>
        </div>
      )}
    </div>
  );
};