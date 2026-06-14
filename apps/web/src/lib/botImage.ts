export type BotImageUpload = { contentType: string; data: string; fileName: string };
export type BotImageCompressor = (file: File) => Promise<File>;

const botBackgroundAspectRatio = 16 / 9;
const botBackgroundMaxWidth = 1920;
const botBackgroundMaxHeight = 1080;
const botBackgroundJpegQuality = 0.86;

export async function fileToBotImageUpload(file: File, compress: BotImageCompressor = compressBotBackgroundImage): Promise<BotImageUpload> {
  const optimized = await compress(file);
  const bytes = new Uint8Array(await optimized.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    contentType: optimized.type,
    data: btoa(binary),
    fileName: optimized.name
  };
}

async function compressBotBackgroundImage(file: File): Promise<File> {
  const image = await createImageBitmap(file);
  const crop = coverCrop(image.width, image.height, botBackgroundAspectRatio);
  const target = targetBackgroundSize(crop.width, crop.height);
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Image compression is not supported in this browser.");
  context.fillStyle = "#111827";
  context.fillRect(0, 0, target.width, target.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, target.width, target.height);
  image.close();
  const blob = await canvasToBlob(canvas, "image/jpeg", botBackgroundJpegQuality);
  return new File([blob], optimizedJpegName(file.name), { type: "image/jpeg" });
}

function coverCrop(width: number, height: number, targetAspectRatio: number): { x: number; y: number; width: number; height: number } {
  const sourceAspectRatio = width / height;
  if (sourceAspectRatio > targetAspectRatio) {
    const cropWidth = Math.round(height * targetAspectRatio);
    return { x: Math.round((width - cropWidth) / 2), y: 0, width: cropWidth, height };
  }
  const cropHeight = Math.round(width / targetAspectRatio);
  return { x: 0, y: Math.round((height - cropHeight) / 2), width, height: cropHeight };
}

function targetBackgroundSize(cropWidth: number, cropHeight: number): { width: number; height: number } {
  const scale = Math.min(1, botBackgroundMaxWidth / cropWidth, botBackgroundMaxHeight / cropHeight);
  return {
    width: Math.max(1, Math.round(cropWidth * scale)),
    height: Math.max(1, Math.round(cropHeight * scale))
  };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("Image compression failed."));
    }, type, quality);
  });
}

function optimizedJpegName(fileName: string): string {
  const baseName = fileName.replace(/\.[^.]+$/, "").trim() || "bot-background";
  return `${baseName}-optimized.jpg`;
}
