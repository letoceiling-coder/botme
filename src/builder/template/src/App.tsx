import React from 'react';
import { Sparkles } from 'lucide-react';

export default function App() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-3xl text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-violet-500/15 border border-violet-400/30 text-violet-200 text-sm mb-6">
          <Sparkles className="w-4 h-4" />
          React + Tailwind, собрано через esbuild
        </div>
        <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight bg-gradient-to-br from-white to-violet-300 bg-clip-text text-transparent">
          Шаблон react-bundle
        </h1>
        <p className="mt-6 text-slate-300 text-lg leading-relaxed">
          Здесь стартует ваше React-приложение. Замените содержимое <code className="text-violet-300">src/App.tsx</code> и
          стартуйте — Tailwind, lucide-react и framer-motion уже подключены.
        </p>
      </div>
    </main>
  );
}
