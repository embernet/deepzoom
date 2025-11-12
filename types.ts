export const TILE_SIZE = 128;

// A nested object to store base64 data URLs for each tile
// { 
//   0: { '0_0': 'data:image/png;base64,...' }, // Level 0
//   1: { '0_0': '...', '0_1': '...' }, ...    // Level 1
// }
export type TileData = Record<number, Record<string, string>>;

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface GeneratedImageData {
    tiles: TileData;
    originalDimensions: ImageDimensions;
    numLevels: number;
}