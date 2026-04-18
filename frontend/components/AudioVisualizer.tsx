import React, { useEffect, useRef, useState } from 'react';
import { audioService } from '../services/audioService.ts';
import { Mic2 } from 'lucide-react';

interface AudioVisualizerProps {
  isActive: boolean;
}

export const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ isActive }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();
  const [currentSpeaker, setCurrentSpeaker] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const analyser = audioService.getAnalyser();
    if (!analyser) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      setCurrentSpeaker(audioService.getCurrentSpeaker());

      if (!isActive) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(59, 130, 246, 0.15)'; 
        ctx.fillRect(0, canvas.height / 2 - 1, canvas.width, 2);
        animationRef.current = requestAnimationFrame(draw);
        return;
      }

      animationRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2.5;
      let barHeight;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        barHeight = dataArray[i] / 2;

        const gradient = ctx.createLinearGradient(0, canvas.height, 0, canvas.height - barHeight);
        gradient.addColorStop(0, '#3b82f6'); // primary
        gradient.addColorStop(0.5, '#8b5cf6'); // accent
        gradient.addColorStop(1, '#ec4899'); // pink

        ctx.fillStyle = gradient;
        
        const y = (canvas.height - barHeight) / 2;
        
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth - 1, barHeight || 2, 4);
        ctx.fill();

        x += barWidth;
      }
    };

    draw();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isActive]);

  return (
    <div className="w-full flex flex-col gap-3">
      <div className="w-full h-20 bg-dark-900/60 rounded-2xl overflow-hidden border border-white/10 relative shadow-inner">
        <canvas 
          ref={canvasRef} 
          width={400} 
          height={80} 
          className="w-full h-full"
        />
        {!isActive && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500 font-bold tracking-widest uppercase">
            Аудио Визуализация
          </div>
        )}
      </div>
      
      {/* Speaker Indicator */}
      <div className={`flex items-center justify-center gap-2 transition-opacity duration-300 ${isActive && currentSpeaker ? 'opacity-100' : 'opacity-0 h-0 overflow-hidden'}`}>
        <div className="bg-gradient-to-r from-primary-500/20 to-accent/20 border border-white/10 px-4 py-1.5 rounded-full flex items-center gap-2">
          <Mic2 className="w-4 h-4 text-accent animate-pulse" />
          <span className="text-sm font-bold text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-300">
            {currentSpeaker}
          </span>
        </div>
      </div>
    </div>
  );
};