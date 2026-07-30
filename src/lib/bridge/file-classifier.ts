import { supportedAudioFileTypeForPath } from "./audio-metadata";
import {
  supportedDocumentFileTypeForPath,
  supportedImageFileTypeForPath,
} from "./media-kind";
import { supportedVideoFileTypeForPath } from "./video-metadata";

export function classifyBridgeFileType(fileName: string) {
  return (
    supportedDocumentFileTypeForPath(fileName) ??
    supportedImageFileTypeForPath(fileName) ??
    supportedAudioFileTypeForPath(fileName) ??
    supportedVideoFileTypeForPath(fileName) ??
    "UNSUPPORTED"
  );
}

export function isSupportedBridgeFileType(fileType: string) {
  return fileType !== "UNSUPPORTED";
}
