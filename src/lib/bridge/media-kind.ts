export type ScannedFileMediaCategory =
  | "DOCUMENT"
  | "IMAGE"
  | "AUDIO"
  | "VIDEO"
  | "UNSUPPORTED";

const documentExtensions = new Map<string, string>([
  [".txt", "TEXT"],
  [".md", "MARKDOWN"],
  [".markdown", "MARKDOWN"],
  [".pdf", "PDF"],
  [".docx", "DOCX"],
  [".html", "HTML"],
  [".htm", "HTML"],
]);

const imageExtensions = new Map<string, string>([
  [".jpg", "IMAGE_JPG"],
  [".jpeg", "IMAGE_JPEG"],
  [".png", "IMAGE_PNG"],
  [".webp", "IMAGE_WEBP"],
  [".gif", "IMAGE_GIF"],
  [".tiff", "IMAGE_TIFF"],
  [".tif", "IMAGE_TIF"],
  [".heic", "IMAGE_HEIC"],
  [".heif", "IMAGE_HEIF"],
]);

function extensionFromPath(value: string) {
  const fileName = value
    .split(/[?#]/)[0]
    ?.split(/[\\/]/)
    .filter(Boolean)
    .at(-1);
  const dotIndex = fileName?.lastIndexOf(".") ?? -1;

  return dotIndex >= 0 ? fileName?.slice(dotIndex).toLowerCase() ?? "" : "";
}

export function supportedDocumentFileTypeForPath(fileName: string) {
  return documentExtensions.get(extensionFromPath(fileName)) ?? null;
}

export function supportedImageFileTypeForPath(fileName: string) {
  return imageExtensions.get(extensionFromPath(fileName)) ?? null;
}

export function imageMimeTypeForExtension(extension: string | null) {
  if (extension === "jpg" || extension === "jpeg") {
    return "image/jpeg";
  }

  if (extension === "png") {
    return "image/png";
  }

  if (extension === "webp") {
    return "image/webp";
  }

  if (extension === "gif") {
    return "image/gif";
  }

  if (extension === "tiff" || extension === "tif") {
    return "image/tiff";
  }

  if (extension === "heic") {
    return "image/heic";
  }

  if (extension === "heif") {
    return "image/heif";
  }

  return null;
}

export function isDocumentFileType(fileType: string) {
  return [...documentExtensions.values()].includes(fileType);
}

export function isImageFileType(fileType: string) {
  return fileType.startsWith("IMAGE_");
}

export function mediaCategoryForFileType(
  fileType: string,
): ScannedFileMediaCategory {
  if (isDocumentFileType(fileType)) {
    return "DOCUMENT";
  }

  if (isImageFileType(fileType)) {
    return "IMAGE";
  }

  if (fileType.startsWith("AUDIO_")) {
    return "AUDIO";
  }

  if (fileType.startsWith("VIDEO_")) {
    return "VIDEO";
  }

  return "UNSUPPORTED";
}
