
import React, { useState, useCallback } from 'react';
import type { GeneratedImageData } from './types';
import ImageSplitter from './components/ImageSplitter';
import ImageExplorer from './components/ImageExplorer';

const App: React.FC = () => {
  const [generatedData, setGeneratedData] = useState<GeneratedImageData | null>(null);
  const [explorerKey, setExplorerKey] = useState(0);

  const handleTilesGenerated = useCallback((data: GeneratedImageData) => {
    setGeneratedData(data);
    setExplorerKey(prevKey => prevKey + 1); // Force remount of explorer
  }, []);

  return (
    <div className="w-screen h-screen bg-slate-900 text-white flex flex-row overflow-hidden">
      <div className="w-[40%] max-w-2xl h-full border-r border-slate-700 shadow-2xl z-10">
        <ImageSplitter onTilesGenerated={handleTilesGenerated} />
      </div>
      <div className="flex-grow h-full">
        {generatedData ? (
          <ImageExplorer 
            key={explorerKey}
            data={generatedData}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-center text-slate-500 p-8">
            <p className="text-xl">Generate image tiles to preview the explorer here.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;