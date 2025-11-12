
import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { TileData, ImageDimensions, GeneratedImageData } from '../types';
import { TILE_SIZE } from '../types';
import { UploadIcon, DownloadIcon, InformationCircleIcon, ClipboardIcon, EyeIcon, XIcon } from './icons';

interface ImageSplitterProps {
  onTilesGenerated: (data: GeneratedImageData) => void;
}

interface ImageMetadata {
  resolution: string;
  type: string;
  size: string;
}

interface GeneratedImageBlobs {
    tiles: Record<number, Record<string, Blob>>;
    originalDimensions: ImageDimensions;
    numLevels: number;
}

type ProcessingMode = 'generate' | 'load';

const formatBytes = (bytes: number, decimals = 2) => {
    if (!+bytes) return '0 Bytes'
    const k = 1024
    const dm = decimals < 0 ? 0 : decimals
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}

// This script will be run in a separate thread as a Web Worker
const workerScript = `
const TILE_SIZE = 128;

self.onmessage = async (e) => {
    const imageFile = e.data;
    try {
        const image = await createImageBitmap(imageFile);
        const originalDimensions = { width: image.width, height: image.height };
        
        const maxDim = Math.max(originalDimensions.width, originalDimensions.height);
        const numLevels = Math.ceil(Math.log2(maxDim / TILE_SIZE)) + 1;

        const allTiles = {};
        
        let currentCanvas = new OffscreenCanvas(image.width, image.height);
        currentCanvas.getContext('2d').drawImage(image, 0, 0);

        for (let level = numLevels - 1; level >= 0; level--) {
            self.postMessage({ type: 'progress', message: \`Processing level \${level}/\${numLevels - 1}...\` });

            const levelWidth = currentCanvas.width;
            const levelHeight = currentCanvas.height;
            allTiles[level] = {};
            
            const cols = Math.ceil(levelWidth / TILE_SIZE);
            const rows = Math.ceil(levelHeight / TILE_SIZE);
            
            const tilePromises = [];

            for (let y = 0; y < rows; y++) {
                for (let x = 0; x < cols; x++) {
                    const tileCanvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
                    const tileCtx = tileCanvas.getContext('2d');

                    const sx = x * TILE_SIZE;
                    const sy = y * TILE_SIZE;
                    const sWidth = Math.min(TILE_SIZE, levelWidth - sx);
                    const sHeight = Math.min(TILE_SIZE, levelHeight - sy);
                    
                    tileCtx.drawImage(currentCanvas, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);
                    
                    const promise = tileCanvas.convertToBlob({ type: 'image/png' }).then(blob => {
                        allTiles[level][\`\${y}_\${x}\`] = blob;
                    });
                    tilePromises.push(promise);
                }
            }

            await Promise.all(tilePromises);

            if (level > 0) {
                const nextWidth = Math.floor(levelWidth / 2);
                const nextHeight = Math.floor(levelHeight / 2);
                const nextCanvas = new OffscreenCanvas(nextWidth, nextHeight);
                const nextCtx = nextCanvas.getContext('2d');
                if (nextCtx) {
                    nextCtx.imageSmoothingQuality = 'high';
                    nextCtx.drawImage(currentCanvas, 0, 0, nextWidth, nextHeight);
                }
                currentCanvas = nextCanvas;
            }
        }
        
        const data = {
            tiles: allTiles,
            originalDimensions,
            numLevels,
        };

        self.postMessage({ type: 'done', data });

    } catch (error) {
        self.postMessage({ type: 'error', message: "The image is too large for the browser to process. Please use the 'Load Pre-Tiled Set' option." });
    } finally {
        self.close();
    }
};
`;

const pythonScript = `
import sys
import os
import shutil
import json
import math
import zipfile
import pyvips

# --- Configuration ---
TILE_SIZE = 128
TEMP_DIR_BASENAME = "tiles_temp"

def generate_tiles_manually(image_path, temp_dir):
    """
    Generates an image pyramid matching the browser's implementation logic.
    """
    print("Opening image for manual tiling...")
    image = pyvips.Image.new_from_file(image_path)
    
    # Ensure the image has an alpha channel for consistent processing with transparency.
    if not image.hasalpha():
        image = image.addalpha()

    original_dimensions = {"width": image.width, "height": image.height}
    
    max_dim = max(original_dimensions["width"], original_dimensions["height"])
    num_levels = math.ceil(math.log2(max_dim / TILE_SIZE)) + 1 if max_dim > 0 else 1

    print(f"Calculated {num_levels} levels.")
    
    current_image = image

    for level in range(num_levels - 1, -1, -1):
        print(f"Processing level {level}...")
        level_dir = os.path.join(temp_dir, str(level))
        os.makedirs(level_dir, exist_ok=True)
        
        level_width = current_image.width
        level_height = current_image.height
        
        cols = math.ceil(level_width / TILE_SIZE)
        rows = math.ceil(level_height / TILE_SIZE)
        
        for y in range(rows):
            for x in range(cols):
                left = x * TILE_SIZE
                top = y * TILE_SIZE
                width = min(TILE_SIZE, level_width - left)
                height = min(TILE_SIZE, level_height - top)
                
                tile = current_image.crop(left, top, width, height)
                
                # Embed the potentially smaller tile onto a transparent TILE_SIZE x TILE_SIZE canvas
                # to match the browser's OffscreenCanvas behavior.
                final_tile = tile.embed(0, 0, TILE_SIZE, TILE_SIZE, extend='background', background=[0, 0, 0, 0])

                tile_path = os.path.join(level_dir, f"{y}_{x}.png")
                final_tile.write_to_file(tile_path)

        if level > 0:
            next_width = math.floor(level_width / 2)
            next_height = math.floor(level_height / 2)
            # Use high-quality lanczos3 kernel for downsampling, similar to 'imageSmoothingQuality = high'
            current_image = current_image.resize(next_width / level_width, vscale=next_height / level_height, kernel='lanczos3')

    return original_dimensions, num_levels

def create_tiles_zip(image_path):
    """
    Generates an image tile set and packages it into a ZIP file.
    """
    if not os.path.exists(image_path):
        print(f"Error: Image file not found at '{image_path}'")
        sys.exit(1)

    temp_files_dir = f"{TEMP_DIR_BASENAME}_files"
    js_file_path = "image_data.js"

    try:
        # 1. Clean up previous runs and create temp directory
        if os.path.exists(temp_files_dir):
            shutil.rmtree(temp_files_dir)
        os.makedirs(temp_files_dir)

        # 2. Generate tiles using a manual implementation that matches the browser's logic
        original_dimensions, num_levels = generate_tiles_manually(image_path, temp_files_dir)
        print(f"Image dimensions: {original_dimensions['width']}x{original_dimensions['height']}")

        # 3. Create image_data.js
        image_data = {
            "originalDimensions": original_dimensions,
            "numLevels": num_levels
        }
        
        js_content = f"window.imageData = {json.dumps(image_data, indent=2)};"
        
        with open(js_file_path, "w") as f:
            f.write(js_content)
        print(f"Created {js_file_path}")

        # 4. Create the ZIP file
        zip_filename = f"{os.path.splitext(os.path.basename(image_path))[0]}_tiles.zip"
        print(f"Creating ZIP file: {zip_filename}...")

        with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
            # Add image_data.js to the root of the zip
            zipf.write(js_file_path, arcname="image_data.js")

            # Add the generated tiles from the temp files directory
            for root, _, files in os.walk(temp_files_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    # Create a relative path for the archive, e.g., "tiles/6/0_0.png"
                    archive_path = os.path.join(
                        "tiles", 
                        os.path.relpath(file_path, temp_files_dir)
                    )
                    zipf.write(file_path, arcname=archive_path)

        print(f"\\nZIP file created successfully: {zip_filename}")

    except Exception as e:
        print(f"An error occurred: {e}")
    finally:
        # 5. Clean up temporary files
        print("Cleaning up temporary files...")
        if os.path.exists(temp_files_dir):
            shutil.rmtree(temp_files_dir)
        if os.path.exists(js_file_path):
            os.remove(js_file_path)
        print("Cleanup complete.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python generate_tiles.py <path_to_your_image>")
        sys.exit(1)
    
    input_image = sys.argv[1]
    create_tiles_zip(input_image)
`;


const InstructionsPanel = () => {
    const [showScriptPreview, setShowScriptPreview] = useState(false);
    const [copyButtonText, setCopyButtonText] = useState('Copy');

    const handleCopy = () => {
        navigator.clipboard.writeText(pythonScript.trim()).then(() => {
            setCopyButtonText('Copied!');
            setTimeout(() => setCopyButtonText('Copy'), 2000);
        }, (err) => {
            console.error('Could not copy text: ', err);
            alert('Failed to copy script.');
        });
    };

    const handleDownload = () => {
        const blob = new Blob([pythonScript.trim()], { type: 'text/python' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'generate_tiles.py';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    return (
        <>
        {showScriptPreview && (
            <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" onClick={() => setShowScriptPreview(false)}>
                <div className="bg-slate-800 rounded-lg shadow-2xl w-full max-w-4xl h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
                    <div className="flex justify-between items-center p-4 border-b border-slate-700 flex-shrink-0">
                        <h3 className="text-lg font-bold text-white">Python Script: generate_tiles.py</h3>
                        <button onClick={() => setShowScriptPreview(false)} className="p-1 rounded-full text-slate-400 hover:bg-slate-700 hover:text-white transition-colors">
                            <XIcon className="w-6 h-6" />
                        </button>
                    </div>
                    <div className="p-4 flex-grow overflow-hidden">
                        <pre className="h-full overflow-auto bg-slate-900 rounded text-sm text-cyan-300 p-4 text-left">
                            <code className="whitespace-pre-wrap">{pythonScript.trim()}</code>
                        </pre>
                    </div>
                </div>
            </div>
        )}
        <div className="mt-6 text-left bg-slate-700/50 rounded-lg p-4 text-sm text-slate-300 space-y-4">
            <div className="flex items-start space-x-3">
                <InformationCircleIcon className="w-6 h-6 text-cyan-400 flex-shrink-0 mt-0.5" />
                <div>
                    <h3 className="font-bold text-white">For images too large for the browser, use this Python script.</h3>
                    <p className="text-slate-400">This script automates tiling and packaging. It uses <code className="bg-slate-800 px-1 py-0.5 rounded">libvips</code> for fast, memory-efficient processing.</p>
                </div>
            </div>
            <div className="space-y-4 pl-9">
                <div>
                    <h4 className="font-semibold text-slate-200">1. Install Prerequisites</h4>
                    <p className="text-slate-400 text-xs mb-1">First, install the libvips library:</p>
                    <code className="block bg-slate-800 rounded p-2 text-xs text-cyan-300">
                        # On macOS with Homebrew<br/>
                        brew install vips<br/>
                        <br/>
                        # For Windows/Linux, see install instructions on the libvips website.
                    </code>
                    <p className="text-slate-400 text-xs mt-2 mb-1">Then, install the Python wrapper:</p>
                    <code className="block bg-slate-800 rounded p-2 text-xs text-cyan-300">
                        pip install pyvips
                    </code>
                </div>
                <div>
                    <h4 className="font-semibold text-slate-200 mb-2">2. Save the Script</h4>
                    <div className="flex flex-col space-y-2">
                         <button onClick={() => setShowScriptPreview(true)} className="flex items-center justify-center space-x-2 px-3 py-2 bg-slate-600 hover:bg-slate-500 rounded text-sm transition-colors w-full"><EyeIcon className="w-5 h-5" /><span>Preview Script</span></button>
                         <button onClick={handleCopy} className="flex items-center justify-center space-x-2 px-3 py-2 bg-slate-600 hover:bg-slate-500 rounded text-sm transition-colors w-full"><ClipboardIcon className="w-5 h-5" /><span>{copyButtonText} to Clipboard</span></button>
                         <button onClick={handleDownload} className="flex items-center justify-center space-x-2 px-3 py-2 bg-slate-600 hover:bg-slate-500 rounded text-sm transition-colors w-full"><DownloadIcon className="w-5 h-5" /><span>Download Script</span></button>
                    </div>
                     <p className="text-slate-400 text-xs mt-2">Save the script, then run it from your terminal.</p>
                </div>
                <div>
                    <h4 className="font-semibold text-slate-200">3. Run the Script</h4>
                    <p className="text-slate-400 text-xs">Run the script from your terminal, passing your image file as an argument. It will create the final ZIP file in the same directory.</p>
                    <code className="block bg-slate-800 rounded p-2 mt-1 text-xs text-cyan-300">
                        python generate_tiles.py /path/to/image.png
                    </code>
                </div>
            </div>
        </div>
        </>
    );
};


const ImageSplitter: React.FC<ImageSplitterProps> = ({ onTilesGenerated }) => {
  const [mode, setMode] = useState<ProcessingMode>('generate');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressMessage, setProgressMessage] = useState('');
  const [exportProgress, setExportProgress] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [generatedData, setGeneratedData] = useState<GeneratedImageData | null>(null);
  const [imageMetadata, setImageMetadata] = useState<ImageMetadata | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const generatedBlobsRef = useRef<Record<number, Record<string, Blob>> | null>(null);


  // Cleanup worker on component unmount
  useEffect(() => {
    return () => {
        workerRef.current?.terminate();
    }
  }, []);

  const resetState = () => {
    setGeneratedData(null);
    setImageFile(null);
    setImageMetadata(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    generatedBlobsRef.current = null;
  }

  const handleFileChange = (file: File | null) => {
    if (!file) return;
    
    resetState();

    if (mode === 'generate') {
        if (file.type.startsWith('image/')) {
            setImageFile(file);
            const url = URL.createObjectURL(file);
            setPreviewUrl(url);

            const img = new Image();
            img.onload = () => {
                setImageMetadata({
                    resolution: `${img.width} x ${img.height} px`,
                    type: file.type,
                    size: formatBytes(file.size)
                });
            };
            img.src = url;
        } else {
            alert('Please select a valid image file.');
        }
    } else { // mode === 'load'
        if (file.name.endsWith('.zip')) {
            setImageFile(file);
            handleZipFile(file);
        } else {
            alert('Please select a valid .zip file for this mode.');
        }
    }
  };
  
  const handleZipFile = async (file: File) => {
    setIsProcessing(true);
    setProgressMessage('Reading ZIP file...');
    
    // @ts-ignore
    const zip = new window.JSZip();

    try {
        const content = await zip.loadAsync(file);
        
        const imageDataFile = content.file('image_data.js');
        if (!imageDataFile) {
            throw new Error('image_data.js not found in the ZIP file.');
        }
        const imageDataStr = await imageDataFile.async('string');
        const jsonStr = imageDataStr.replace('window.imageData =', '').trim().replace(/;$/, '');
        const imageData = JSON.parse(jsonStr);
        const { originalDimensions, numLevels } = imageData;

        if (!originalDimensions || !numLevels) throw new Error('Invalid image_data.js format.');

        setProgressMessage('Extracting tiles...');
        
        const tileUrls: TileData = {};
        const tileBlobs: Record<number, Record<string, Blob>> = {};
        const tileFiles = content.file(/^tiles\//);
        
        const promises = tileFiles.map(async (tileFile) => {
            if (tileFile.dir) return;

            const pathParts = tileFile.name.split('/');
            if (pathParts.length !== 3) return;

            const level = Number(pathParts[1]);
            const key = pathParts[2].replace('.png', '');

            if (isNaN(level)) return;

            const blob = await tileFile.async('blob');
            const url = URL.createObjectURL(blob);

            if (!tileUrls[level]) tileUrls[level] = {};
            tileUrls[level][key] = url;

            if (!tileBlobs[level]) tileBlobs[level] = {};
            tileBlobs[level][key] = blob;
        });

        await Promise.all(promises);

        generatedBlobsRef.current = tileBlobs;
        const finalData: GeneratedImageData = { tiles: tileUrls, originalDimensions, numLevels };
        setGeneratedData(finalData);
        onTilesGenerated(finalData);

    } catch (error) {
        console.error('Error processing ZIP file:', error);
        alert(`Failed to load tile set: ${error.message}`);
    } finally {
        setIsProcessing(false);
        setProgressMessage('');
    }
  };


  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileChange(e.dataTransfer.files[0]);
    }
  }, [mode]);

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFileChange(e.target.files[0]);
    }
     // Reset file input to allow re-selection of the same file
    e.target.value = '';
  };
  
  const triggerFileSelect = () => fileInputRef.current?.click();

  const generateTiles = useCallback(() => {
    if (!imageFile) return;

    setIsProcessing(true);
    setGeneratedData(null);
    generatedBlobsRef.current = null;
    setProgressMessage('Initializing worker...');

    workerRef.current?.terminate();
    
    const workerBlob = new Blob([workerScript], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(workerBlob);
    const worker = new Worker(workerUrl);
    workerRef.current = worker;

    worker.onmessage = (e) => {
        const { type, message, data } = e.data;
        if (type === 'progress') {
            setProgressMessage(message);
        } else if (type === 'done') {
            const blobData: GeneratedImageBlobs = data;
            generatedBlobsRef.current = blobData.tiles;

            const tileUrls: TileData = {};
            Object.keys(blobData.tiles).forEach(level => {
                tileUrls[Number(level)] = {};
                Object.keys(blobData.tiles[Number(level)]).forEach(key => {
                    const blob = blobData.tiles[Number(level)][key];
                    tileUrls[Number(level)][key] = URL.createObjectURL(blob);
                });
            });

            const finalData: GeneratedImageData = {
                tiles: tileUrls,
                originalDimensions: blobData.originalDimensions,
                numLevels: blobData.numLevels,
            };

            setGeneratedData(finalData);
            onTilesGenerated(finalData);
            setIsProcessing(false);
            setProgressMessage('');
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
        } else if (type === 'error') {
            console.error('Worker error:', message);
            alert(`An error occurred during tiling: ${message}`);
            setIsProcessing(false);
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
        }
    };
    
    worker.onerror = (e) => {
        console.error('Worker error:', e);
        alert('A critical worker error occurred.');
        setIsProcessing(false);
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
    }
    
    worker.postMessage(imageFile);

  }, [imageFile, onTilesGenerated]);

  const handleExport = useCallback(async () => {
    if (!generatedData || !imageFile || !generatedBlobsRef.current) return;

    setProgressMessage('Preparing files...');
    setIsProcessing(true);
    setExportProgress(0);
    await new Promise(resolve => setTimeout(resolve, 10)); // allow UI update

    // @ts-ignore
    const zip = new window.JSZip();

    const imageData = {
        originalDimensions: generatedData.originalDimensions,
        numLevels: generatedData.numLevels,
    };
    zip.file('image_data.js', `window.imageData = ${JSON.stringify(imageData, null, 2)};`);

    const tilesFolder = zip.folder('tiles');
    if (tilesFolder) {
        for (const level in generatedBlobsRef.current) {
            const levelFolder = tilesFolder.folder(level);
            if (levelFolder) {
                for (const key in generatedBlobsRef.current[level]) {
                    const blob = generatedBlobsRef.current[level][key];
                    levelFolder.file(`${key}.png`, blob);
                }
            }
        }
    }
    
    zip.file('index.html', createStandaloneHtml());

    setProgressMessage('Compressing files...');
    
    const content = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: {
            level: 6, // A good balance between speed and size.
        },
    }, (metadata: { percent: number }) => {
        // This is the progress callback
        setExportProgress(metadata.percent);
        setProgressMessage(`Compressing... ${Math.floor(metadata.percent)}%`);
    });
    
    setProgressMessage('Saving file...');
    await new Promise(resolve => setTimeout(resolve, 10));

    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = `${imageFile.name.split('.')[0]}_deepzoom.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    
    setIsProcessing(false);
    setProgressMessage('');
    setExportProgress(0);
  }, [generatedData, imageFile]);
  
  const ModeButton = ({ value, label }: {value: ProcessingMode, label: string}) => (
      <button
        onClick={() => { setMode(value); resetState(); }}
        className={`px-4 py-2 text-sm font-semibold rounded-t-md transition-colors w-full ${mode === value ? 'bg-slate-700 text-cyan-400' : 'bg-slate-800 text-slate-400 hover:bg-slate-700/50'}`}
      >
        {label}
      </button>
  );

  return (
    <div className="flex flex-col h-full p-4 md:p-8 bg-slate-800">
      <div className="w-full max-w-2xl text-center mx-auto flex flex-col h-full">
        <div>
            <h1 className="text-3xl font-bold mb-2 text-cyan-400">Deep Zoom Tiler</h1>
            <p className="text-slate-400 mb-6">Process images or load pre-tiled sets.</p>
            
            <div className="grid grid-cols-2 gap-2">
                <ModeButton value="generate" label="Generate from Image" />
                <ModeButton value="load" label="Load Pre-Tiled Set" />
            </div>
        </div>

        <div className="bg-slate-700 p-6 rounded-b-lg flex-grow overflow-y-auto">
            {!isProcessing && (
              <div
                className={`relative border-2 border-dashed rounded-lg p-10 cursor-pointer transition-colors duration-300 ${isDragging ? 'border-cyan-400 bg-slate-700' : 'border-slate-600 hover:border-cyan-500'}`}
                onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} onClick={triggerFileSelect} >
                <div className="flex flex-col items-center justify-center space-y-4">
                  <UploadIcon className="w-16 h-16 text-slate-500"/>
                  <p className="text-slate-400">
                    <span className="font-semibold text-cyan-400">Click to upload</span> or drag and drop
                  </p>
                  <p className="text-xs text-slate-500">{mode === 'generate' ? 'Image File (PNG, JPG, etc.)' : 'Pre-Tiled .zip Archive'}</p>
                </div>
                <input ref={fileInputRef} type="file" className="hidden" accept={mode === 'generate' ? 'image/*' : '.zip'} onChange={onFileInputChange} />
              </div>
            )}

            {isProcessing && (
              <div className="flex flex-col items-center justify-center p-10 h-48">
                <div className="w-16 h-16 border-4 border-cyan-400 border-t-transparent rounded-full animate-spin"></div>
                <p className="mt-4 text-lg text-slate-300">{progressMessage}</p>
                {exportProgress > 0 && progressMessage.startsWith('Compressing') && (
                    <div className="w-full bg-slate-600 rounded-full h-4 mt-4">
                        <div 
                            className="bg-cyan-500 h-4 rounded-full transition-width duration-150" 
                            style={{ width: `${exportProgress}%` }}>
                        </div>
                    </div>
                )}
              </div>
            )}
            
            {mode === 'load' && !isProcessing && <InstructionsPanel />}
            
            {!isProcessing && imageFile && (
                <div className="mt-6">
                {mode === 'generate' && previewUrl && (
                    <>
                    <h3 className="text-lg font-semibold text-slate-300">Image Preview:</h3>
                    <img src={previewUrl} alt="Preview" className="mt-2 rounded-lg max-h-40 mx-auto shadow-lg" />
                    </>
                )}
                 {(imageMetadata || (mode === 'load' && imageFile)) && (
                    <div className="mt-4 text-left bg-slate-800 rounded-lg p-3 text-sm text-slate-300 font-mono space-y-1">
                       {imageMetadata && mode === 'generate' ? (
                        <>
                            <div className="flex justify-between items-center">
                                <span className="text-slate-400">Resolution:</span>
                                <span className="text-white font-semibold">{imageMetadata.resolution}</span>
                            </div>
                            <div className="flex justify-between items-center">
                                <span className="text-slate-400">File Type:</span>
                                <span className="text-white font-semibold">{imageMetadata.type}</span>
                            </div>
                        </>
                       ) : (
                        <div className="flex justify-between items-center">
                           <span className="text-slate-400">File Loaded:</span>
                           <span className="text-white font-semibold truncate" title={imageFile.name}>{imageFile.name}</span>
                        </div>
                       )}
                        <div className="flex justify-between items-center">
                            <span className="text-slate-400">File Size:</span>
                            <span className="text-white font-semibold">{formatBytes(imageFile.size)}</span>
                        </div>
                    </div>
                )}
              </div>
            )}
        </div>
        <div className="p-6 border-t border-slate-700 bg-slate-700 rounded-b-lg">
            <div className="flex space-x-4">
                {mode === 'generate' && (
                    <button
                        onClick={generateTiles}
                        className="flex-1 bg-cyan-500 hover:bg-cyan-600 text-white font-bold py-3 px-4 rounded-lg transition-transform transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
                        disabled={!imageFile || isProcessing} >
                        Generate Tiles
                    </button>
                )}
                <button
                    onClick={handleExport}
                    className="flex-1 bg-green-500 hover:bg-green-600 text-white font-bold py-3 px-4 rounded-lg transition-transform transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
                    disabled={!generatedData || isProcessing} >
                    <div className="flex items-center justify-center">
                       <DownloadIcon className="w-5 h-5 mr-2"/> Export ZIP
                    </div>
                </button>
            </div>
        </div>
      </div>
    </div>
  );
};


const createStandaloneHtml = () => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Deep Zoom Image Viewer</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <style> 
      body { overscroll-behavior: none; } 
      .cursor-zoom-in { cursor: zoom-in; }
      .cursor-zoom-out { cursor: zoom-out; }
    </style>
</head>
<body class="bg-slate-900 text-white antialiased">
    <div id="root" class="w-screen h-screen"></div>
    <script type="text/javascript" src="image_data.js"></script>
    <script type="text/babel">
        const { useState, useEffect, useRef, useCallback } = React;

        const TILE_SIZE = 128;

        const PlusIcon = ({ className }) => (
          <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
        );

        const MinusIcon = ({ className }) => (
          <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 12H6" />
          </svg>
        );

        const ArrowsExpandIcon = ({ className }) => (
            <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4h4 M20 8V4h-4 M4 16v4h4 M20 16v4h-4" />
            </svg>
        );
        
        const ChevronUpIcon = ({ className }) => (
            <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
            </svg>
        );

        const ChevronDownIcon = ({ className }) => (
            <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
        );

        const ChevronLeftIcon = ({ className }) => (
            <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
        );

        const ChevronRightIcon = ({ className }) => (
            <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
        );

        const PanButton = ({ direction, onClick, disabled }) => {
            const icons = {
                up: React.createElement(ChevronUpIcon, { className: "w-8 h-8" }),
                down: React.createElement(ChevronDownIcon, { className: "w-8 h-8" }),
                left: React.createElement(ChevronLeftIcon, { className: "w-8 h-8" }),
                right: React.createElement(ChevronRightIcon, { className: "w-8 h-8" }),
            };
            const positions = {
                up: 'top-2 left-1/2 -translate-x-1/2',
                down: 'bottom-2 left-1/2 -translate-x-1/2',
                left: 'left-2 top-1/2 -translate-y-1/2',
                right: 'right-2 top-1/2 -translate-y-1/2',
            };
            const baseClasses = 'absolute z-10 p-2 rounded-full transition-all duration-200';
            const activeClasses = 'bg-slate-800/60 hover:bg-slate-700/80 text-white';
            const disabledClasses = 'bg-slate-800/40 text-slate-500 cursor-not-allowed';

            return React.createElement('button', {
                onClick: onClick,
                disabled: disabled,
                className: \`\${baseClasses} \${positions[direction]} \${disabled ? disabledClasses : activeClasses}\`
            }, icons[direction]);
        }

        const ImageExplorer = ({ data }) => {
          const { originalDimensions, numLevels } = data;
          const [zoomIndex, setZoomIndex] = useState(0);
          const [minZoomIndex, setMinZoomIndex] = useState(0);
          const [pan, setPan] = useState({ x: 0, y: 0 });
          const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
          const [isInitialized, setIsInitialized] = useState(false);
          const [isShiftPressed, setIsShiftPressed] = useState(false);
          
          const containerRef = useRef(null);
          const wrapperRef = useRef(null);
          const canvasRef = useRef(null);
          const imageCache = useRef({});

          useEffect(() => {
            const handleKeyDown = (e) => {
                if (e.key === 'Shift') setIsShiftPressed(true);
            };
            const handleKeyUp = (e) => {
                if (e.key === 'Shift') setIsShiftPressed(false);
            };
            window.addEventListener('keydown', handleKeyDown);
            window.addEventListener('keyup', handleKeyUp);
            return () => {
                window.removeEventListener('keydown', handleKeyDown);
                window.removeEventListener('keyup', handleKeyUp);
            };
          }, []);

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

          const clampPan = useCallback((newPan, worldSize, viewSize) => {
            let { x, y } = newPan;
            if (worldSize.width < viewSize.width) x = (worldSize.width - viewSize.width) / 2;
            else x = Math.max(0, Math.min(x, worldSize.width - viewSize.width));
            if (worldSize.height < viewSize.height) y = (worldSize.height - viewSize.height) / 2;
            else y = Math.max(0, Math.min(y, worldSize.height - viewSize.height));
            return { x, y };
          }, []);

          const getInitialState = useCallback(() => {
            if (viewportSize.width === 0) return null;
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
            };
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

              const startCol = Math.floor(pan.x / TILE_SIZE);
              const endCol = Math.ceil((pan.x + viewportSize.width) / TILE_SIZE);
              const startRow = Math.floor(pan.y / TILE_SIZE);
              const endRow = Math.ceil((pan.y + viewportSize.height) / TILE_SIZE);

              for (let y = startRow; y < endRow; y++) {
                  for (let x = startCol; x < endCol; x++) {
                      const tileKey = \`\${zoomIndex}_\${y}_\${x}\`;
                      const tileSrc = \`tiles/\${zoomIndex}/\${y}_\${x}.png\`;

                      const draw = (img) => {
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
          }, [isInitialized, pan, zoomIndex, viewportSize]);

          const handleZoom = useCallback((newZoomIndex, screenPoint) => {
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

          const handlePan = useCallback((direction) => {
            const panAmount = 0.25;
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

          const onClick = (e) => {
            const rect = containerRef.current.getBoundingClientRect();
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
          const disableRight = !canPanX || pan.x >= worldWidth - viewportSize.width - 1;
          const disableUp = !canPanY || pan.y <= 0;
          const disableDown = !canPanY || pan.y >= worldHeight - viewportSize.height - 1;
          const showPanControls = displayedZoom > 1;

          let cursorClass = 'cursor-default';
          if (isShiftPressed && zoomIndex > minZoomIndex) {
              cursorClass = 'cursor-zoom-out';
          } else if (!isShiftPressed && zoomIndex < numLevels - 1) {
              cursorClass = 'cursor-zoom-in';
          }

          return React.createElement('div', { className: "relative w-full h-full flex flex-col bg-slate-900" },
            React.createElement('div', { ref: wrapperRef, className: "flex-grow w-full h-full flex items-center justify-center p-4" },
              React.createElement('div', { className: 'relative' },
                showPanControls && React.createElement(PanButton, { direction: 'up', onClick: () => handlePan('up'), disabled: disableUp }),
                showPanControls && React.createElement(PanButton, { direction: 'down', onClick: () => handlePan('down'), disabled: disableDown }),
                showPanControls && React.createElement(PanButton, { direction: 'left', onClick: () => handlePan('left'), disabled: disableLeft }),
                showPanControls && React.createElement(PanButton, { direction: 'right', onClick: () => handlePan('right'), disabled: disableRight }),
                React.createElement('div', { ref: containerRef, className: \`relative shadow-2xl bg-black \${cursorClass}\`,
                  style: { width: \`\${viewportSize.width}px\`, height: \`\${viewportSize.height}px\`, border: viewportSize.width > 0 ? '4px solid white' : 'none', overflow: 'hidden' },
                  onClick: onClick
                },
                  React.createElement('canvas', { ref: canvasRef, width: viewportSize.width, height: viewportSize.height })
                )
              )
            ),
            React.createElement('div', { className: "absolute bottom-0 left-1/2 -translate-x-1/2 p-2" },
              React.createElement('div', { className: "flex items-center space-x-4 bg-slate-800/80 backdrop-blur-sm text-white rounded-lg shadow-2xl px-4 py-2" },
                React.createElement('button', { onClick: handleZoomOutFully, className: "p-2 rounded-full hover:bg-slate-700 transition-colors", title: "Zoom Out Fully" },
                  React.createElement(ArrowsExpandIcon, { className: "w-6 h-6" })
                ),
                React.createElement('button', { onClick: () => handleZoom(zoomIndex - 1, { x: viewportSize.width / 2, y: viewportSize.height / 2 }), disabled: zoomIndex <= minZoomIndex, className: "p-2 rounded-full hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors" },
                  React.createElement(MinusIcon, { className: "w-6 h-6" })
                ),
                React.createElement('div', { className: "flex flex-col items-center" },
                  React.createElement('span', { className: "font-mono text-lg font-bold text-cyan-400" }, \`\${displayedZoom}x\`),
                  React.createElement('span', { className: "text-xs text-slate-400" }, "Zoom")
                ),
                React.createElement('button', { onClick: () => handleZoom(zoomIndex + 1, { x: viewportSize.width / 2, y: viewportSize.height / 2 }), disabled: zoomIndex >= numLevels - 1, className: "p-2 rounded-full hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors" },
                  React.createElement(PlusIcon, { className: "w-6 h-6" })
                ),
                React.createElement('div', { className: "w-px h-8 bg-slate-600" }),
                React.createElement('div', { className: "text-sm text-slate-400 font-mono hidden sm:block" }, \`\${displayedResolutionWidth} x \${displayedResolutionHeight} px\`)
              )
            )
          );
        };
        
        const App = () => React.createElement(ImageExplorer, { data: window.imageData });
        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(React.createElement(App));
    </script>
</body>
</html>
`;

export default ImageSplitter;
