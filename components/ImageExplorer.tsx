
import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { GeneratedImageData } from '../types';
import { TILE_SIZE } from '../types';
import { PlusIcon, MinusIcon, ArrowsExpandIcon, ChevronUpIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from './icons';

interface ImageExplorerProps {
  data: GeneratedImageData;
}

interface PanButtonProps {
    direction: 'up' | 'down' | 'left' | 'right';
    onClick: () => void;
    disabled: boolean;
}

const PanButton: React.FC<PanButtonProps> = ({ direction, onClick, disabled }) => {
    const icons = {
        up: <ChevronUpIcon className="w-8 h-8"/>,
        down: <ChevronDownIcon className="w-8 h-8"/>,
        left: <ChevronLeftIcon className="w-8 h-8"/>,
        right: <ChevronRightIcon className="w-8 h-8"/>,
    }
    const positions = {
        up: 'top-2 left-1/2 -translate-x-1/2',
        down: 'bottom-2 left-1/2 -translate-x-1/2',
        left: 'left-2 top-1/2 -translate-y-1/2',
        right: 'right-2 top-1/2 -translate-y-1/2',
    }
    const baseClasses = 'absolute z-10 p-2 rounded-full transition-all duration-200';
    const activeClasses = 'bg-slate-800/60 hover:bg-slate-700/80 text-white';
    const disabledClasses = 'bg-slate-800/40 text-slate-500 cursor-not-allowed';

    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={`${baseClasses} ${positions[direction]} ${disabled ? disabledClasses : activeClasses}`}
        >
            {icons[direction]}
        </button>
    );
};


const ImageExplorer: React.FC<ImageExplorerProps> = ({ data }) => {
  const { tiles, originalDimensions, numLevels } = data;
  const [zoomIndex, setZoomIndex] = useState(0);
  const [minZoomIndex, setMinZoomIndex] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [isInitialized, setIsInitialized] = useState(false);
  const [isShiftPressed, setIsShiftPressed] = useState(false);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageCache = useRef<Record<string, HTMLImageElement>>({});

  // Listen for Shift key presses
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Shift') {
            setIsShiftPressed(true);
        }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
        if (e.key === 'Shift') {
            setIsShiftPressed(false);
        }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
        Object.values(tiles).forEach(level => {
            Object.values(level).forEach(url => {
                URL.revokeObjectURL(url);
            });
        });
        imageCache.current = {};
    };
  }, [tiles]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const resizeObserver = new ResizeObserver(entries => {
      if (entries[0]) {
        const { width: parentWidth, height: parentHeight } = entries[0].contentRect;
        const imageAspectRatio = originalDimensions.width / originalDimensions.height;
        let frameWidth = parentWidth * 0.95;
        let frameHeight = frameWidth / imageAspectRatio;

        if (frameHeight > parentHeight * 0.95) {
          frameHeight = parentHeight * 0.95;
          frameWidth = frameHeight * imageAspectRatio;
        }

        setViewportSize({ width: frameWidth, height: frameHeight });
        setIsInitialized(false);
      }
    });

    resizeObserver.observe(wrapper);
    return () => resizeObserver.disconnect();
  }, [originalDimensions]);

  const clampPan = useCallback((newPan: {x: number, y: number}, worldSize: {width: number, height: number}, viewSize: {width: number, height: number}) => {
    let x = newPan.x;
    let y = newPan.y;

    if (worldSize.width < viewSize.width) x = (worldSize.width - viewSize.width) / 2;
    else x = Math.max(0, Math.min(x, worldSize.width - viewSize.width));
    
    if (worldSize.height < viewSize.height) y = (worldSize.height - viewSize.height) / 2;
    else y = Math.max(0, Math.min(y, worldSize.height - viewSize.height));
    return { x, y };
  }, []);

  const getInitialState = useCallback(() => {
      if(viewportSize.width === 0) return null;

      let baseIndex = 0;
      for (let i = 0; i < numLevels; i++) {
        const scale = 2 ** (numLevels - 1 - i);
        const levelWidth = originalDimensions.width / scale;
        const levelHeight = originalDimensions.height / scale;
        if (levelWidth > viewportSize.width || levelHeight > viewportSize.height) break;
        baseIndex = i;
      }
      
      const scale = 2 ** (numLevels - 1 - baseIndex);
      const worldWidth = originalDimensions.width / scale;
      const worldHeight = originalDimensions.height / scale;

      return {
          zoomIndex: baseIndex,
          minZoomIndex: baseIndex,
          pan: clampPan({ x: 0, y: 0 }, { width: worldWidth, height: worldHeight }, viewportSize)
      }
  }, [viewportSize, originalDimensions, numLevels, clampPan]);

  useEffect(() => {
    if (!isInitialized) {
        const initialState = getInitialState();
        if(initialState) {
            setZoomIndex(initialState.zoomIndex);
            setMinZoomIndex(initialState.minZoomIndex);
            setPan(initialState.pan);
            setIsInitialized(true);
        }
    }
  }, [isInitialized, getInitialState]);
  
  useEffect(() => {
    if (!isInitialized || !canvasRef.current || viewportSize.width === 0) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const currentTiles = tiles[zoomIndex] || {};
    const startCol = Math.floor(pan.x / TILE_SIZE);
    const endCol = Math.ceil((pan.x + viewportSize.width) / TILE_SIZE);
    const startRow = Math.floor(pan.y / TILE_SIZE);
    const endRow = Math.ceil((pan.y + viewportSize.height) / TILE_SIZE);
    
    for (let y = startRow; y < endRow; y++) {
      for (let x = startCol; x < endCol; x++) {
        const tileKey = `${zoomIndex}_${y}_${x}`;
        const tileSrc = currentTiles[`${y}_${x}`];

        if (tileSrc) {
            const draw = (img: HTMLImageElement) => {
                 ctx.drawImage(
                    img,
                    Math.floor(x * TILE_SIZE - pan.x),
                    Math.floor(y * TILE_SIZE - pan.y),
                    TILE_SIZE,
                    TILE_SIZE
                );
            };

            if (imageCache.current[tileKey] && imageCache.current[tileKey].complete) {
                draw(imageCache.current[tileKey]);
            } else {
                const img = new Image();
                img.src = tileSrc;
                img.onload = () => {
                    imageCache.current[tileKey] = img;
                    draw(img);
                };
            }
        }
      }
    }
  }, [isInitialized, pan, zoomIndex, tiles, viewportSize]);

  const handleZoom = useCallback((newZoomIndex: number, screenPoint: { x: number, y: number }) => {
    const oldZoomIndex = zoomIndex;
    if (newZoomIndex === oldZoomIndex) return;

    const clampedNewZoomIndex = Math.max(minZoomIndex, Math.min(newZoomIndex, numLevels - 1));

    const oldScale = 2 ** (numLevels - 1 - oldZoomIndex);
    const newScale = 2 ** (numLevels - 1 - clampedNewZoomIndex);
    const zoomRatio = oldScale / newScale;

    const newWorldWidth = originalDimensions.width / newScale;
    const newWorldHeight = originalDimensions.height / newScale;
    
    const worldPointX = pan.x + screenPoint.x;
    const worldPointY = pan.y + screenPoint.y;
    const newWorldPointX = worldPointX * zoomRatio;
    const newWorldPointY = worldPointY * zoomRatio;
    const newPanX = newWorldPointX - screenPoint.x;
    const newPanY = newWorldPointY - screenPoint.y;
    
    setZoomIndex(clampedNewZoomIndex);
    setPan(clampPan({ x: newPanX, y: newPanY }, {width: newWorldWidth, height: newWorldHeight}, viewportSize));
  }, [zoomIndex, pan, originalDimensions, viewportSize, clampPan, numLevels, minZoomIndex]);

  const handlePan = useCallback((direction: 'up' | 'down' | 'left' | 'right') => {
      const panAmount = 0.25; // Pan by 25% of the viewport
      let newPan = { ...pan };
      
      if (direction === 'left') newPan.x -= viewportSize.width * panAmount;
      if (direction === 'right') newPan.x += viewportSize.width * panAmount;
      if (direction === 'up') newPan.y -= viewportSize.height * panAmount;
      if (direction === 'down') newPan.y += viewportSize.height * panAmount;

      const scale = 2 ** (numLevels - 1 - zoomIndex);
      const worldWidth = originalDimensions.width / scale;
      const worldHeight = originalDimensions.height / scale;

      setPan(clampPan(newPan, { width: worldWidth, height: worldHeight }, viewportSize));
  }, [pan, viewportSize, zoomIndex, numLevels, originalDimensions, clampPan]);

  const handleZoomOutFully = useCallback(() => setIsInitialized(false), []);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = containerRef.current!.getBoundingClientRect();
      const screenPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      
      if (e.shiftKey) {
          if (zoomIndex > minZoomIndex) {
              handleZoom(zoomIndex - 1, screenPoint);
          }
      } else {
          if (zoomIndex < numLevels - 1) {
              handleZoom(zoomIndex + 1, screenPoint);
          }
      }
  };

  const scale = 2 ** (numLevels - 1 - zoomIndex);
  const worldWidth = originalDimensions.width / scale;
  const worldHeight = originalDimensions.height / scale;
  const displayedZoom = 2 ** (zoomIndex - minZoomIndex);
  const visibleWorldWidth = Math.min(worldWidth, viewportSize.width);
  const visibleWorldHeight = Math.min(worldHeight, viewportSize.height);
  const displayedResolutionWidth = Math.round(visibleWorldWidth * scale);
  const displayedResolutionHeight = Math.round(visibleWorldHeight * scale);

  const canPanX = worldWidth > viewportSize.width;
  const canPanY = worldHeight > viewportSize.height;
  const disableLeft = !canPanX || pan.x <= 0;
  const disableRight = !canPanX || pan.x >= worldWidth - viewportSize.width - 1; // -1 for float precision
  const disableUp = !canPanY || pan.y <= 0;
  const disableDown = !canPanY || pan.y >= worldHeight - viewportSize.height - 1;
  const showPanControls = displayedZoom > 1;

  let cursorClass = 'cursor-default';
  if (isShiftPressed && zoomIndex > minZoomIndex) {
      cursorClass = 'cursor-zoom-out';
  } else if (!isShiftPressed && zoomIndex < numLevels - 1) {
      cursorClass = 'cursor-zoom-in';
  }

  return (
    <div className="relative w-full h-full flex flex-col bg-slate-900">
      <div ref={wrapperRef} className="flex-grow w-full h-full flex items-center justify-center p-4">
        <div className="relative">
            {showPanControls && <PanButton direction="up" onClick={() => handlePan('up')} disabled={disableUp} />}
            {showPanControls && <PanButton direction="down" onClick={() => handlePan('down')} disabled={disableDown} />}
            {showPanControls && <PanButton direction="left" onClick={() => handlePan('left')} disabled={disableLeft} />}
            {showPanControls && <PanButton direction="right" onClick={() => handlePan('right')} disabled={disableRight} />}
            
            <div ref={containerRef} className={`relative shadow-2xl bg-black ${cursorClass}`}
              style={{ width: `${viewportSize.width}px`, height: `${viewportSize.height}px`, border: viewportSize.width > 0 ? '4px solid white' : 'none', overflow: 'hidden' }}
              onClick={onClick} >
                <canvas 
                    ref={canvasRef}
                    width={viewportSize.width}
                    height={viewportSize.height}
                />
            </div>
        </div>
      </div>

      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 p-2">
        <div className="flex items-center space-x-4 bg-slate-800/80 backdrop-blur-sm text-white rounded-lg shadow-2xl px-4 py-2">
            <button 
                onClick={handleZoomOutFully}
                className="p-2 rounded-full hover:bg-slate-700 transition-colors"
                title="Zoom Out Fully" >
                <ArrowsExpandIcon className="w-6 h-6"/>
            </button>
            <button
                onClick={() => handleZoom(zoomIndex - 1, { x: viewportSize.width / 2, y: viewportSize.height / 2 })}
                disabled={zoomIndex <= minZoomIndex}
                className="p-2 rounded-full hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors" >
                <MinusIcon className="w-6 h-6" />
            </button>

            <div className="flex flex-col items-center">
                 <span className="font-mono text-lg font-bold text-cyan-400">
                  {displayedZoom}x
                 </span>
                 <span className="text-xs text-slate-400">Zoom</span>
            </div>
            
            <button
                onClick={() => handleZoom(zoomIndex + 1, { x: viewportSize.width / 2, y: viewportSize.height / 2 })}
                disabled={zoomIndex >= numLevels - 1}
                className="p-2 rounded-full hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors" >
                <PlusIcon className="w-6 h-6" />
            </button>
            <div className="w-px h-8 bg-slate-600"></div>
            <div className="text-sm text-slate-400 font-mono hidden sm:block">
                {displayedResolutionWidth} x {displayedResolutionHeight} px
            </div>
        </div>
      </div>
    </div>
  );
};

export default ImageExplorer;