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
        ctx.fillStyle = 'rgba(59, 130, 246, 0.1)'; 
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
        barHeight = dataArray[i] / 2.5;

        ctx.fillStyle = '#3b82f6';
        const y = (canvas.height - barHeight) / 2;
        
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth - 1, barHeight || 2, 2);
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
    <div className="w-full flex flex-col gap-2">
      <div className="w-full h-12 bg-dark-900/50 rounded-lg overflow-hidden border border-white/5 relative">
        <canvas ref={canvasRef} width={300} height={48} className="w-full h-full" />
      </div>
      
      {isActive && currentSpeaker && (
        <div className="flex items-center justify-center gap-1.5 text-xs text-primary-400 font-medium animate-in fade-in">
          <Mic2 className="w-3.5 h-3.5 animate-pulse" />
          {currentSpeaker}
        </div>
      )}
    </div>
  );
};